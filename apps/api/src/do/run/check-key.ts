/*
 * The keys a run starts its checks with: the repository answers one key
 * once, and reads from it which run and job a check came from.
 */

export interface CheckOrigin {
  readonly runId: string;
  readonly attempt: number;
  /** Null for a check no job of the attempt published. */
  readonly jobId: number | null;
}

export const jobCheckKey = (runId: string, attempt: number, jobId: number): string =>
  `${runId}/a${attempt}/j${jobId}`;

/** A name job `jobId` of an earlier attempt published, which this attempt settles and has no job for. */
export const settledCheckKey = (runId: string, attempt: number, jobId: number): string =>
  `${runId}/a${attempt}/x${jobId}`;

/** The check of a workflow file that could not run. */
export const planCheckKey = (runId: string): string => `${runId}/a1/plan`;

const KEY =
  /^([0-9A-HJKMNP-TV-Z]{26})\/a([1-9][0-9]?)\/(?:j([1-9][0-9]{0,9})|x[1-9][0-9]{0,9}|plan)$/;

/** The origin a key names; undefined for a key of none of these shapes. */
export function parseCheckKey(key: string): CheckOrigin | undefined {
  const match = KEY.exec(key);
  if (!match) return undefined;
  const [, runId = "", attempt, jobId] = match;
  return { runId, attempt: Number(attempt), jobId: jobId === undefined ? null : Number(jobId) };
}
