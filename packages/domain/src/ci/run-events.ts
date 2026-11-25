import { type RunPhase, runStateSeq } from "./run-summary.js";
import type { Job } from "./workflow-schema.js";

export type RunAction = "requested" | "in_progress" | "completed";

export interface RunMove {
  readonly attempt: number;
  readonly action: RunAction;
}

/**
 * What a run's report tells after `told` (a `runStateSeq`, 0 for nothing):
 * the ends of `earlier` attempts not told yet, then the reported attempt's
 * state. `told` in the answer never goes back.
 */
export function runMoves(
  told: number,
  report: { readonly attempt: number; readonly phase: RunPhase },
  earlier: readonly number[],
): { readonly told: number; readonly moves: readonly RunMove[] } {
  const moves: RunMove[] = [];
  let at = told;
  const tell = (attempt: number, phase: RunPhase) => {
    const seq = runStateSeq(attempt, phase);
    if (seq <= at) return;
    if (at === 0) moves.push({ attempt, action: "requested" });
    if (phase === "in_progress" || phase === "completed") moves.push({ attempt, action: phase });
    at = seq;
  };
  for (const attempt of earlier.toSorted((a, b) => a - b)) tell(attempt, "completed");
  tell(report.attempt, report.phase);
  return { told: at, moves };
}

export const JOB_ACTIONS = ["queued", "in_progress", "completed"] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

export const jobOrder = (action: JobAction | undefined): number =>
  action === undefined ? -1 : JOB_ACTIONS.indexOf(action);

/**
 * What was told of a run's jobs: every job id up to `done` was told
 * complete, and `live` holds what was told of later ones. A run's job ids
 * are one sequence from 1, over all its attempts.
 */
export interface JobsTold {
  readonly done: number;
  readonly live: Readonly<Record<number, JobAction>>;
}

/** What reported job states tell after `told`: each job only ever moves on, to its latest state. */
export function jobMoves<J extends { readonly jobId: number; readonly action: JobAction }>(
  told: JobsTold,
  jobs: readonly J[],
): { readonly told: JobsTold; readonly moves: readonly J[] } {
  const live: Record<number, JobAction> = { ...told.live };
  const moves = jobs.filter(({ jobId, action }) => {
    if (jobId <= told.done || jobOrder(action) <= jobOrder(live[jobId])) return false;
    live[jobId] = action;
    return true;
  });
  return { told: jobsDoneTo({ done: told.done, live }, told.done), moves };
}

/** `told` with every job id up to `done` complete too. */
export function jobsDoneTo(told: JobsTold, done: number): JobsTold {
  let at = Math.max(told.done, done);
  while (told.live[at + 1] === "completed") at++;
  const live = Object.entries(told.live).filter(([jobId]) => Number(jobId) > at);
  return { done: at, live: Object.fromEntries(live) };
}

/**
 * Whether no other job's outputs can be in the job's labels: outputs are not
 * searched for secrets, and only a job's `needs` bring any to it, through
 * the `needs` context or a matrix made from it.
 */
export function labelsFreeOfOutputs(job: Pick<Job, "needs" | "runsOn">): boolean {
  if (job.needs.length === 0) return true;
  return (
    job.runsOn.kind === "literal" && job.runsOn.value.every((label) => !label.value.includes("${{"))
  );
}
