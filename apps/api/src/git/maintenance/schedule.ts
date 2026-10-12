import {
  type RepoGitStorage,
  schedulePackRetire,
  scheduleReflogPrune,
} from "@fyrden/adapters-cloudflare/git";

const DAY = 24 * 60 * 60 * 1000;

import type { MaintenancePolicy } from "./policy.js";

/** The maintenance jobs of a repository, one of each (job ids). */
export const REPACK_JOB_ID = "repack";
export const GC_JOB_ID = "gc";
export const REACHABILITY_JOB_ID = "reachability";

/**
 * Schedules what a commit calls for: a check for packs to flag
 * all-reachable and a geometric repack check, shortly after; a collection
 * after a non-fast-forward update (which may leave objects unreachable);
 * a retire pass within a day; a reflog prune once the oldest entry passes
 * the retention (at most daily).
 * A job already scheduled sooner keeps its time, so a burst of pushes is
 * handled once.
 */
export function scheduleAfterCommit(
  git: RepoGitStorage,
  policy: MaintenancePolicy,
  nonFastForward: boolean,
): void {
  const now = git.context.now();
  // At least daily on an active repository: the retire job also removes
  // what a maintenance run that died left behind.
  schedulePackRetire(git.jobs, now + DAY);
  git.jobs.ensure("reachability", REACHABILITY_JOB_ID, { runAt: now + policy.reachabilityDelayMs });
  git.jobs.ensure("repack", REPACK_JOB_ID, { runAt: now + policy.repackDelayMs });
  if (nonFastForward) scheduleGc(git, now + policy.gcDelayMs);
  scheduleReflogPrune(git.jobs, git.context, { retentionMs: policy.reflogRetentionMs });
}

export function scheduleGc(git: RepoGitStorage, at: number): void {
  git.jobs.ensure("gc", GC_JOB_ID, { runAt: at });
}

/** Whether a job is part-way through a run (queued or running, with a cursor). */
export function inProgress(git: RepoGitStorage, jobId: string): boolean {
  const job = git.jobs.get(jobId);
  return (
    job !== undefined && (job.state === "queued" || job.state === "running") && job.cursor !== null
  );
}
