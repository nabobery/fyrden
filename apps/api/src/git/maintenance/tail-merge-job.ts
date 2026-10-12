import {
  type JobHandler,
  LOCK_REF_COMMIT,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import { anyLeased, discardTailMerge, prepareTailMerge } from "./tail-merge.js";
import type { PackCapPolicy } from "./tail-merge-plan.js";

/** The one background pack-cap compaction job of a repository. */
export const PACK_CAP_JOB_ID = "compact:pack-cap";

/** Proposed: how long the job waits for the commit lock, and how long it holds it. */
const LOCK_WAIT_MS = 10_000;
const LOCK_TTL_MS = 30_000;
/** Proposed: when to try again after leases or a busy repository got in the way. */
const RETRY_BUSY_MS = 5_000;
const RETRY_LEASED_MS = 60_000;
const MAX_VERSION_RETRIES = 3;

type Ran = "done" | "busy" | "leased" | "budget";

/**
 * The compaction a push schedules when it was refused at the pack-count
 * cap: the same tail merge, without a push, down to one pack below the cap
 * so the next push fits without merging. It retries while leases keep the
 * smallest packs in use. When the budget is the obstacle (every pack is
 * already large), this job cannot help and ends; the repository's full
 * repack is the remedy.
 */
export function packCapCompactionHandler(
  git: RepoGitStorage,
  policy: () => PackCapPolicy,
  log: Logger,
): JobHandler {
  return {
    runSlice: async () => {
      const ran = await git.locks.withLock(
        LOCK_REF_COMMIT,
        PACK_CAP_JOB_ID,
        { ttlMs: LOCK_TTL_MS, waitMs: LOCK_WAIT_MS },
        async (lock): Promise<Ran> => {
          const current = policy();
          const prepared = await prepareTailMerge(git, {
            policy: current,
            target: current.cap - 1,
          });
          if (prepared.kind === "within-cap") return "done";
          if (prepared.kind === "over-budget") return prepared.reason;
          const { merge } = prepared;
          git.locks.renew(lock, LOCK_TTL_MS);
          for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
            const result = git.refStore.commitSync({
              addPacks: [merge.packId],
              removePacks: [...merge.removePacks],
              refUpdates: [],
              expectedVersion: git.refStore.state().version,
              authorize: () =>
                !git.locks.isHeld(lock)
                  ? "the compaction lost the commit lock"
                  : anyLeased(git, merge.removePacks)
                    ? "a merged pack was leased meanwhile"
                    : undefined,
            });
            if (result.ok) return "done";
            if (result.reason !== "version-conflict") break;
          }
          await discardTailMerge(git, merge.packId);
          return "leased";
        },
      );
      const outcome: Ran = ran.ok ? ran.value : "busy";
      switch (outcome) {
        case "done":
          return { done: true };
        case "budget":
          log.warn("pack-cap compaction cannot make room within its budget", {});
          return { done: true };
        case "busy":
          return { done: false, cursor: null, runAfterMs: RETRY_BUSY_MS };
        case "leased":
          return { done: false, cursor: null, runAfterMs: RETRY_LEASED_MS };
      }
    },
  };
}
