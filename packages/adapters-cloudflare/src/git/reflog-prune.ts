import type { JobHandler, JobQueue } from "./jobs.js";
import { countRowsWritten, first, type GitStorageContext } from "./sql.js";

/** Reflog entries are kept this long. Proposed default (90 days). */
export const REFLOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Rows deleted per slice. Proposed default. */
export const REFLOG_PRUNE_BATCH = 1_000;
/** The repository's prune job: one per repository, keyed by this id. */
export const REFLOG_PRUNE_JOB_ID = "reflog-prune";
/** Least time from a commit to the prune pass it schedules, so passes stay rare. Proposed: one day. */
export const REFLOG_PRUNE_MIN_DELAY_MS = 24 * 60 * 60 * 1000;

function encodeCutoff(cutoff: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, cutoff);
  return bytes;
}

function decodeCutoff(cursor: Uint8Array): number {
  if (cursor.length !== 8) throw new Error("reflog prune job has a malformed cutoff");
  return new DataView(cursor.buffer, cursor.byteOffset, 8).getFloat64(0);
}

/**
 * Schedules a prune of reflog entries older than the retention, with its
 * cutoff fixed now, so a resumed job deletes exactly what the original run
 * would have.
 */
export function enqueueReflogPrune(
  jobs: JobQueue,
  now: number,
  retentionMs: number = REFLOG_RETENTION_MS,
): string {
  return jobs.enqueue("reflog_prune", encodeCutoff(now - retentionMs));
}

/**
 * Schedules the repository's prune pass (the singleton job
 * `REFLOG_PRUNE_JOB_ID`) for when its oldest reflog entry passes the
 * retention, and no sooner than `minDelayMs` from now. Called after every
 * commit: one indexed read, and a write only when no pass is pending. A
 * pass already queued keeps the earlier time; a finished one is queued
 * again with a fresh cutoff.
 */
export function scheduleReflogPrune(
  jobs: JobQueue,
  context: GitStorageContext,
  options: { retentionMs?: number; minDelayMs?: number } = {},
): void {
  const oldest = first<{ at: number | null }>(context.storage, "SELECT min(at) AS at FROM reflog");
  if (oldest?.at == null) return;
  const retentionMs = options.retentionMs ?? REFLOG_RETENTION_MS;
  const runAt = Math.max(
    oldest.at + retentionMs,
    context.now() + (options.minDelayMs ?? REFLOG_PRUNE_MIN_DELAY_MS),
  );
  jobs.ensure("reflog_prune", REFLOG_PRUNE_JOB_ID, { runAt });
}

/**
 * Deletes one batch per slice; deleting is idempotent, so a slice cut short
 * is simply redone. A pass started without a cutoff (the scheduled job)
 * takes `now - retentionMs` and keeps it in its cursor until the pass ends.
 */
export function reflogPruneHandler(
  context: GitStorageContext,
  batch: number = REFLOG_PRUNE_BATCH,
  retentionMs: number = REFLOG_RETENTION_MS,
): JobHandler {
  return {
    async runSlice(job) {
      const cursor = job.cursor ?? encodeCutoff(context.now() - retentionMs);
      const deleted = context.storage.sql.exec(
        `DELETE FROM reflog WHERE seq IN
           (SELECT seq FROM reflog WHERE at < ? ORDER BY seq LIMIT ?)`,
        decodeCutoff(cursor),
        batch,
      );
      deleted.toArray();
      countRowsWritten(context, "reflog.prune", deleted.rowsWritten);
      // Done once a slice finds nothing left to delete.
      return deleted.rowsWritten === 0 ? { done: true } : { done: false, cursor };
    },
  };
}
