import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  type BlockCache,
  type MemoryBudget,
  ObjectReader,
  type ReaderWork,
} from "@fyrden/git-core";
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
    /**
     * Bytes the reader may build, objects a delta chain builds on the way
     * included; past them a read throws `ReaderWorkSpent`. Unlimited by default.
     */
    readonly maxBuiltBytes?: number;
    /** A push's own packs, not live yet, read too (its commit point). */
    readonly extraPacks?: readonly string[];
    /**
     * The largest object the reader may build, entry or delta result; past it a
     * read throws `PackError` `object-too-large`. The reader's default otherwise.
     */
    readonly maxObjectBytes?: number;
    /** The delta-base cache keeps exact-sized buffers and charges what they hold. Off by default. */
    readonly strictDeltaCache?: boolean;
    /** Where the reader reserves its memory, in place of the repository's budget. */
    readonly memory?: MemoryBudget;
    /** Charged before each decoding primitive; a throw stops the read. Off by default. */
    readonly work?: ReaderWork;
  },
): Promise<ObjectReader | undefined> {
  const { git } = deps;
  const counts = limits.counts ?? { reads: 0 };
  const maxReads = limits.maxReads ?? Number.POSITIVE_INFINITY;
  const spend = () => {
    if (counts.reads >= maxReads) throw new ReadBudgetError(maxReads);
    counts.reads++;
  };
  const view = liveView(
    git,
    () => {
      spend();
      git.context.metrics.count("r2.class_b", { bucket: "fyrden-git", op: "get_idx" });
    },
    limits.extraPacks,
  );
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
    memory: limits.memory ?? git.memory,
    blockCache: blocks.cache,
    limits: {
      deltaBaseCacheBytes: limits.deltaBaseCacheBytes,
      ...(limits.maxBuiltBytes !== undefined && { maxBuiltBytes: limits.maxBuiltBytes }),
      ...(limits.maxObjectBytes !== undefined && { maxObjectBytes: limits.maxObjectBytes }),
    },
    ...(limits.strictDeltaCache !== undefined && { strictDeltaCache: limits.strictDeltaCache }),
    ...(limits.work !== undefined && { work: limits.work }),
  });
}

/** A request needed more R2 reads than its budget allows. */
export class ReadBudgetError extends Error {
  override name = "ReadBudgetError";
  constructor(readonly maxReads: number) {
    super(`more than ${maxReads} storage reads`);
  }
}
