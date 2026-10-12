import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import { type PackRow, packObjectKey, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  type CompactionSource,
  compactPacks,
  type ExternalBaseLookup,
  ObjectReader,
  type PackId,
  PackIdx,
  type PackWriter,
} from "@fyrden/git-core";
import { BUCKET_NAME } from "../push/scratch.js";
import { type CapUnit, type PackCapPolicy, selectTailMerge } from "./tail-merge-plan.js";

/*
 * The synchronous tail merge of the pack-count cap. It runs
 * under the repository's ref-commit lock, just before the commit that needs
 * it: the chosen live packs (and usually the push's own pack unit) are
 * compacted into one new self-contained pack with its `.idx`, which waits
 * in `indexing` until the commit transaction swaps it in (the compacted
 * pack goes live, the sources are superseded). Nothing is live until that
 * transaction, so a merge that is never committed changes nothing a reader
 * sees; `discardTailMerge` removes it.
 *
 * The swap must not supersede a pack that gained a lease after the choice
 * (a clone that started meanwhile): the commit checks `anyLeased` inside its
 * transaction and refuses.
 */

/** A compacted pack waiting for its commit. */
export interface TailMerge {
  /** The new pack, in `indexing`. */
  readonly packId: PackId;
  /** Live packs it replaces (whole units). */
  readonly removePacks: readonly PackId[];
  /** Whether it holds the push's pack unit, which is then superseded instead of going live. */
  readonly withIncoming: boolean;
  readonly sourceBytes: number;
  readonly objectCount: number;
}

export type TailMergeOutcome =
  | { readonly kind: "within-cap" }
  | { readonly kind: "merged"; readonly merge: TailMerge }
  | { readonly kind: "over-budget"; readonly reason: "budget" | "leased" };

export interface TailMergeRequest {
  readonly policy: PackCapPolicy;
  /** The push whose pack unit commits next; its unit counts and may be merged. */
  readonly uploadId?: string;
  /** Live packs to leave at most; default the cap. */
  readonly target?: number;
}

/** The repository's own live packs as cap units (a pack unit together), with their leases. */
export function liveCapUnits(git: RepoGitStorage): CapUnit[] {
  const live = git.registry.liveOwn();
  const leased = git.leases.leased(live.map((p) => p.packId));
  const units = new Map<string, (typeof live)[number][]>();
  for (const pack of live) {
    const key = pack.unitId ?? pack.packId;
    units.set(key, [...(units.get(key) ?? []), pack]);
  }
  return [...units].map(([id, packs]) => ({
    id,
    packIds: packs.map((p) => p.packId),
    bytes: packs.reduce((n, p) => n + (p.bytes ?? 0), 0),
    objects: packs.reduce((n, p) => n + (p.objectCount ?? 0), 0),
    createdAt: Math.max(...packs.map((p) => p.createdAt)),
    leased: packs.some((p) => leased.has(p.packId)),
  }));
}

/** The upload's pack unit as it will commit (packs written and indexed), or undefined when empty. */
function incomingUnit(
  git: RepoGitStorage,
  uploadId: string,
): { unit: CapUnit; rows: PackRow[] } | undefined {
  const upload = git.uploads.get(uploadId);
  const pack = upload?.packId ? git.registry.get(upload.packId) : undefined;
  if (!pack) return undefined;
  const rows = git.registry.unitOf(pack).filter((p) => p.state === "indexed");
  if (rows.length === 0) return undefined;
  return {
    rows,
    unit: {
      id: uploadId,
      packIds: rows.map((p) => p.packId),
      bytes: rows.reduce((n, p) => n + (p.bytes ?? 0), 0),
      // The received pack's row carries the unit's object count.
      objects: rows.reduce((n, p) => n + (objectCountOf(git, p.packId) ?? 0), 0),
      createdAt: Number.MAX_SAFE_INTEGER,
      leased: false,
    },
  };
}

function objectCountOf(git: RepoGitStorage, packId: string): number | null {
  return (
    git.context.storage.sql
      .exec<{ object_count: number | null }>(
        "SELECT object_count FROM packs WHERE pack_id = ?",
        packId,
      )
      .toArray()[0]?.object_count ?? null
  );
}

/**
 * Whether the commit about to happen would leave more live packs than the
 * cap and, if so, the compacted pack that brings it back under: written to
 * R2 with its `.idx`, in `indexing`, carrying the upload's id (so aborting
 * the upload discards it too). Nothing changes when the cap cannot be met
 * within the policy's budget.
 */
export async function prepareTailMerge(
  git: RepoGitStorage,
  request: TailMergeRequest,
): Promise<TailMergeOutcome> {
  const incoming = request.uploadId ? incomingUnit(git, request.uploadId) : undefined;
  const live = liveCapUnits(git);
  const selection = selectTailMerge(
    live,
    incoming?.unit,
    request.policy,
    request.target === undefined ? {} : { target: request.target },
  );
  git.context.metrics.count("git.pack_cap", {
    outcome:
      selection.kind === "within-cap"
        ? "within"
        : selection.kind === "merge"
          ? "merged"
          : `refused_${selection.reason}`,
  });
  if (selection.kind !== "merge") return selection;

  const chosen = new Set(selection.units.flatMap((u) => u.packIds));
  // Oldest first, the push's unit last: the output keeps history order.
  const sources: PackRow[] = git.registry.liveOwn().filter((p) => chosen.has(p.packId));
  if (selection.withIncoming && incoming) sources.push(...incoming.rows);

  const writer =
    request.uploadId !== undefined
      ? git.packStore.beginUploadPack("compact", request.uploadId)
      : git.packStore.beginObject("compact");
  const packId = writer.packId;
  try {
    const objectCount = await writeCompacted(git, sources, writer);
    return {
      kind: "merged",
      merge: {
        packId,
        removePacks: sources.filter((p) => chosen.has(p.packId)).map((p) => p.packId),
        withIncoming: selection.withIncoming,
        sourceBytes: selection.bytes,
        objectCount,
      },
    };
  } catch (error) {
    await discardTailMerge(git, packId);
    throw error;
  }
}

/** Compacts `sources` through `writer`, stores the `.idx` and records the pack. Returns its object count. */
async function writeCompacted(
  git: RepoGitStorage,
  sources: readonly PackRow[],
  writer: PackWriter,
): Promise<number> {
  const inputs: CompactionSource[] = [];
  for (const row of sources) {
    if (row.bytes === null) throw new Error(`pack ${row.packId} has no length`);
    inputs.push({ packId: row.packId, packLength: row.bytes, idx: await loadIdx(git, row) });
  }
  const zlib = createWorkersZlib();
  const resolver = lazyResolver(git, inputs, zlib);
  let finished: Awaited<ReturnType<typeof compactPacks>>;
  try {
    finished = await compactPacks(inputs, {
      read: (packId, offset, length) => git.packStore.openRange(packId, offset, length),
      sink: writer,
      zlib,
      memory: git.memory,
      resolveObject: resolver.lookup,
    });
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  } finally {
    resolver.release();
  }
  try {
    const info = await writer.finish();
    if (info.bytes !== finished.packLength)
      throw new Error(
        `compacted pack ${writer.packId}: wrote ${info.bytes} of ${finished.packLength} bytes`,
      );
    git.context.metrics.count("r2.class_a", { bucket: BUCKET_NAME, op: "put_idx" });
    await git.bucket.put(packObjectKey(git.networkId(), writer.packId, "idx"), finished.idx.bytes);
    git.registry.transition(writer.packId, ["indexing"], "indexing", {
      objectCount: finished.objectCount,
      trailerSha: new Uint8Array(finished.checksum).buffer,
    });
    return finished.objectCount;
  } finally {
    finished.release();
  }
}

async function loadIdx(git: RepoGitStorage, row: PackRow): Promise<PackIdx> {
  git.context.metrics.count("r2.class_b", { bucket: BUCKET_NAME, op: "get_idx" });
  const object = await git.bucket.get(packObjectKey(row.networkId, row.packId, "idx"));
  if (!object) throw new Error(`the index of pack ${row.packId} is missing`);
  return PackIdx.parse(new Uint8Array(await object.arrayBuffer()));
}

/**
 * Whole objects for the entries compaction must rewrite (a delta whose
 * base copy was dropped), read from the sources only. Opened on first use:
 * most merges never need it.
 */
function lazyResolver(
  git: RepoGitStorage,
  sources: readonly CompactionSource[],
  zlib: ReturnType<typeof createWorkersZlib>,
): { lookup: ExternalBaseLookup; release(): void } {
  let opened: Promise<ObjectReader> | undefined;
  return {
    async lookup(oid) {
      opened ??= ObjectReader.open({
        view: {
          scope: git.networkId(),
          packs: sources.map((s) => ({ packId: s.packId, bytes: s.packLength, idx: s.idx })),
        },
        packStore: git.packStore,
        zlib,
        memory: git.memory,
      });
      const found = await (await opened).readObject(oid);
      return found && { type: found.type, data: found.bytes };
    },
    release() {
      void opened?.then((reader) => reader.release()).catch(() => {});
    },
  };
}

/**
 * Removes a compacted pack that will not be committed: its row is
 * discarded and its bytes deleted (what fails here, the reaper removes).
 */
export async function discardTailMerge(git: RepoGitStorage, packId: PackId): Promise<void> {
  const row = git.registry.get(packId);
  if (!row) return;
  git.registry.transition(packId, ["pending", "indexing"], "discarded");
  await git.bucket.delete([row.r2Key, packObjectKey(row.networkId, packId, "idx")]).catch(() => {});
}

/** Whether any of `packIds` has an unexpired lease (synchronous, for the commit transaction). */
export function anyLeased(git: RepoGitStorage, packIds: readonly PackId[]): boolean {
  return packIds.length > 0 && git.leases.leased(packIds).size > 0;
}
