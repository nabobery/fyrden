import { createWorkersZlib, DEFAULT_CACHE_API_CALLS } from "@fyrden/adapters-cloudflare";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  type BlockCache,
  encodeRefAdvertisement,
  type LsRefsArgs,
  ObjectReader,
  type Oid,
} from "@fyrden/git-core";
import { openRequestBlockCache } from "./cache/pack-blocks.js";
import { encodeLsRefs, peelCandidates, selectRefs } from "./ls-refs.js";
import { liveView } from "./pack-view.js";
import { peelAll } from "./peel.js";
import { RECEIVE_PACK_CAPABILITIES } from "./protocol.js";

const encoder = new TextEncoder();

/**
 * Delta-base cache for peeling: a few tag objects, never a long chain of
 * deltas. Proposed; tuned under load.
 */
const PEEL_DELTA_CACHE_BYTES = 1024 * 1024;

export interface AdvertiseDeps {
  readonly git: RepoGitStorage;
  /** The Durable Object's long-lived in-memory block tier. */
  readonly memoryBlocks: BlockCache;
}

async function peeledFor(deps: AdvertiseDeps, oids: readonly Oid[]): Promise<Map<string, Oid>> {
  const { git } = deps;
  return peelAll(
    oids,
    (list) => git.commitGraph.readSync(list, "verified").map((row) => row !== undefined),
    async () => {
      const view = liveView(git, () =>
        git.context.metrics.count("r2.class_b", { bucket: "fyrden-git", op: "get_idx" }),
      );
      if (view.packs.length === 0) return undefined;
      const reader = await ObjectReader.open({
        view,
        packStore: git.packStore,
        zlib: createWorkersZlib(),
        memory: git.memory,
        blockCache: (
          await openRequestBlockCache(deps.memoryBlocks, {
            scope: view.scope,
            maxCalls: DEFAULT_CACHE_API_CALLS,
          })
        ).cache,
        limits: { deltaBaseCacheBytes: PEEL_DELTA_CACHE_BYTES },
      });
      return { reader, close: () => reader.release() };
    },
  );
}

/** The ls-refs response for the repository's current refs. */
export async function lsRefsResponse(
  deps: AdvertiseDeps,
  args: LsRefsArgs,
): Promise<Uint8Array<ArrayBuffer>> {
  const snapshot = deps.git.refStore.readRefsSync();
  const peeled = await peeledFor(deps, peelCandidates(snapshot, args));
  return encodeLsRefs(snapshot, args, peeled);
}

/**
 * The receive-pack ref advertisement (v0, or v1 with its `version 1` line),
 * as `git receive-pack --advertise-refs` writes it: refs sorted by name, no
 * HEAD, no peeled lines, and `capabilities^{}` with the zero id when there
 * are no refs.
 */
export function receivePackAdvertisement(
  git: RepoGitStorage,
  version: 0 | 1,
): Uint8Array<ArrayBuffer> {
  const snapshot = git.refStore.readRefsSync();
  return encodeRefAdvertisement({
    version,
    capabilities: RECEIVE_PACK_CAPABILITIES,
    refs: selectRefs(snapshot, []).map((ref) => ({ oid: ref.oid, name: encoder.encode(ref.name) })),
  });
}
