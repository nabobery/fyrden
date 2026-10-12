import { oidToHex } from "../object/oid.js";
import {
  duplicateObjectCount,
  planVerbatimPack,
  rangeStreamFromStore,
  streamVerbatimPack,
  type VerbatimSource,
} from "../pack-write/verbatim.js";
import type { PackId } from "../ports/pack-store.js";
import type { FetchArgs } from "../protocol/v2-command.js";
import { framedCopyKey } from "./cache-key.js";
import type { PlannedPack, UploadPackRepository } from "./fetch.js";
import { materialise, writeFramed } from "./materialise.js";

/** What the pack registry knows about one pack of the view, for verbatim plans. */
export interface VerbatimCandidate {
  readonly packId: PackId;
  /** The count in the pack's header. */
  readonly objectCount: number;
  /**
   * Every object in the pack is reachable from the current refs (the
   * registry's `all_reachable`, recomputed by maintenance after each
   * non-fast-forward update).
   */
  readonly allReachable: boolean;
  /** The pack's sorted oid table (`PackIdx.oidTable()`), for the duplicate check. */
  readonly oidTable: () => Uint8Array | Promise<Uint8Array>;
}

/**
 * A full clone served from the stored packs, or undefined
 * when one is not safe. It is used only when:
 * - the caller has ruled out common haves and shallow requests;
 * - the client asked for `ofs-delta` (stored packs may hold OFS_DELTAs);
 * - the wants include every branch tip (every ref, when there are no
 *   branches), so the client wants the repository, not a part of it;
 * - every pack of the view, at most `maxPacks`, is flagged all-reachable,
 *   so nothing outside this repository's closure is sent (a pack shared
 *   in a fork network that holds a sibling's objects is never flagged);
 * - no object is in two packs (`git index-pack --strict` refuses that).
 * Objects reachable only from refs the client did not ask for may be sent
 * too; they are this repository's objects.
 */
export async function planVerbatim(
  repo: UploadPackRepository,
  args: FetchArgs,
  maxPacks: number,
  framed: number | undefined,
): Promise<PlannedPack | undefined> {
  const candidates = repo.verbatim;
  const packs = repo.view.packs;
  if (!candidates || !args.ofsDelta || packs.length === 0 || packs.length > maxPacks) {
    return undefined;
  }
  const wanted = new Set(args.wants.map(oidToHex));
  const refs = [...repo.refs.refs];
  const branches = refs.filter(([name]) => name.startsWith("refs/heads/"));
  const required = branches.length > 0 ? branches : refs;
  if (!required.every(([, oid]) => wanted.has(oidToHex(oid)))) return undefined;

  const byId = new Map(candidates.map((c) => [c.packId, c]));
  const sources: VerbatimSource[] = [];
  const tables: Uint8Array[] = [];
  for (const pack of packs) {
    const candidate = byId.get(pack.packId);
    if (!candidate?.allReachable) return undefined;
    sources.push({
      packId: pack.packId,
      packLength: pack.bytes,
      objectCount: candidate.objectCount,
    });
    tables.push(await candidate.oidTable());
  }
  if (duplicateObjectCount(tables) > 0) return undefined;

  const plan = planVerbatimPack(sources);
  const kind = plan.kind;
  if (framed === undefined) {
    return {
      parts:
        plan.kind === "as-is"
          ? [{ kind: "pack", packId: plan.packId, offset: 0, length: plan.length, framed: false }]
          : [{ kind: "stitched", plan }],
      pack: { kind, objectCount: plan.objectCount, cached: false },
      leasePacks: sources.map((s) => s.packId),
    };
  }
  // Workers Free: one side-band framed copy of the whole answer, written once per pack set.
  const key = framedCopyKey(
    sources.map((s) => s.packId),
    framed,
  );
  let info = await repo.materialised.find(key);
  const cached = info !== undefined;
  info ??= await materialise(repo.materialised, key, (sink) =>
    writeFramed(streamVerbatimPack(plan, rangeStreamFromStore(repo.packStore)), sink, framed),
  );
  return {
    parts: [{ kind: "pack", packId: info.packId, offset: 0, length: info.bytes, framed: true }],
    pack: { kind, objectCount: plan.objectCount, cached },
    leasePacks: [info.packId],
  };
}
