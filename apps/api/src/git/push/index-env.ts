import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import { packObjectKey, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { BlockCache, PackId, PushIndexEnv } from "@fyrden/git-core";
import { openRequestBlockCache } from "../cache/pack-blocks.js";
import { liveView } from "../pack-view.js";
import { BUCKET_NAME } from "./scratch.js";

/**
 * External calls (Cache API and outbound fetches) the invocation an
 * indexing phase runs in may have made before the phase's block tier stops
 * using the Cache API. Proposed 40: Free allows 50 per invocation, shared
 * with outbound fetches (verified, developers.cloudflare.com/workers/
 * platform/limits/). The allowance is the invocation's, so the phases a
 * request or an alarm runs back to back share it.
 */
const PUSH_CACHE_API_CALLS = 40;

/**
 * What the indexing job needs from the repository: the received pack is
 * written to the upload's preallocated pack id (again from the start after
 * an interrupted parse); a completion pack joins the upload's pack unit;
 * each new pack's `.idx` is stored beside it; thin bases and link targets
 * are looked up in the live packs only, through the object's in-memory
 * block tier and the network's Cache API tier (`memoryBlocks`); objects
 * found only in borrowed packs are proven reachable from the refs first.
 */
export async function pushIndexEnv(
  git: RepoGitStorage,
  upload: { readonly uploadId: string; readonly packId: PackId },
  metrics: Metrics,
  memoryBlocks: BlockCache,
): Promise<PushIndexEnv> {
  const networkId = git.networkId();
  // Pack blocks are cached per network; a push reads only its own network's packs.
  const blocks = await openRequestBlockCache(memoryBlocks, {
    scope: networkId,
    maxCalls: PUSH_CACHE_API_CALLS,
  });
  const idxKey = (packId: PackId) => packObjectKey(networkId, packId, "idx");
  return {
    zlib: createWorkersZlib(),
    memory: git.memory,
    commitGraph: git.commitGraph,
    packStore: git.packStore,
    beginPack: (role) =>
      role === "received"
        ? git.packStore.rewritePack(upload.packId)
        : git.packStore.beginUnitPack({
            kind: "completion",
            unitId: upload.uploadId,
            uploadId: upload.uploadId,
          }),
    async storeIdx(packId, idx) {
      metrics.count("r2.class_a", { bucket: BUCKET_NAME, op: "put_idx" });
      await git.bucket.put(idxKey(packId), idx);
    },
    async loadIdx(packId) {
      metrics.count("r2.class_b", { bucket: BUCKET_NAME, op: "get_idx" });
      const object = await git.bucket.get(idxKey(packId));
      if (!object) throw new Error(`the index of pack ${packId} is missing`);
      return new Uint8Array(await object.arrayBuffer());
    },
    view: liveView(git, () => metrics.count("r2.class_b", { bucket: BUCKET_NAME, op: "get_idx" })),
    refStore: git.refStore,
    blockCache: blocks.cache,
  };
}
