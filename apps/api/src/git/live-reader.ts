import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { type BlockCache, ObjectReader } from "@fyrden/git-core";
import { openRequestBlockCache } from "./cache/pack-blocks.js";
import { liveView } from "./pack-view.js";

export interface LiveReaderDeps {
  readonly git: RepoGitStorage;
  /** The repository object's long-lived in-memory block tier. */
  readonly memoryBlocks: BlockCache;
}

/**
 * An object reader over the repository's live packs for one request, or
 * undefined when it has none. Pack blocks come from the object's memory
 * tier, then the Cache API (at most `maxCacheCalls` calls), then R2. The
 * caller releases it.
 */
export async function openLiveReader(
  deps: LiveReaderDeps,
  limits: {
    readonly deltaBaseCacheBytes: number;
    readonly maxCacheCalls: number;
    /**
     * R2 reads (`.idx` and pack ranges) the reader may make; the one past
     * it throws `ReadBudgetError` instead. `counts.reads` tells how many
     * were made. Unlimited by default.
     */
    readonly maxReads?: number;
    readonly counts?: { reads: number };
  },
): Promise<ObjectReader | undefined> {
  const { git } = deps;
  const counts = limits.counts ?? { reads: 0 };
  const maxReads = limits.maxReads ?? Number.POSITIVE_INFINITY;
  const spend = () => {
    if (counts.reads >= maxReads) throw new ReadBudgetError(maxReads);
    counts.reads++;
  };
  const view = liveView(git, () => {
    spend();
    git.context.metrics.count("r2.class_b", { bucket: "fyrden-git", op: "get_idx" });
  });
  if (view.packs.length === 0) return undefined;
  const blocks = await openRequestBlockCache(deps.memoryBlocks, {
    scope: view.scope,
    maxCalls: limits.maxCacheCalls,
  });
  return ObjectReader.open({
    view,
    packStore: {
      openRange: (packId, offset, length) => {
        spend();
        return git.packStore.openRange(packId, offset, length);
      },
    },
    zlib: createWorkersZlib(),
    memory: git.memory,
    blockCache: blocks.cache,
    limits: { deltaBaseCacheBytes: limits.deltaBaseCacheBytes },
  });
}

/** A request needed more R2 reads than its budget allows. */
export class ReadBudgetError extends Error {
  override name = "ReadBudgetError";
  constructor(readonly maxReads: number) {
    super(`more than ${maxReads} storage reads`);
  }
}
