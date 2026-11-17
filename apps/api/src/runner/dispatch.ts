// FetchTask's work in the Worker: offer a lost answer again, answer an idle
// poll from the directory alone, or claim the account's oldest eligible
// pending job and have its run assign it. A pending row is only leased here;
// its run withdraws it once the job has left the queue.

import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { AssignTaskAnswer } from "../do/run/dispatch.js";
import { clock } from "../services.js";
import { encodeFetchTaskAnswer } from "./proto/messages.js";
import {
  type AuthenticatedRunner,
  claimPending,
  clearLapsedClaims,
  type DispatchView,
  refuseTask,
  releaseClaim,
} from "./registry.js";

/** Pause or fail points for tests. */
export const dispatchHooks: {
  beforeClaim?: () => Promise<void> | void;
  afterClaim?: () => Promise<void> | void;
} = {};

/** The pinned runner's FetchTask deadline when it sends none (measured: it sends 4999). */
const RUNNER_DEADLINE_MS = 4_999;
/** Kept back from the runner's deadline for the answer to reach it. Proposed. */
const ANSWER_MARGIN_MS = 1_500;
/** Claims one FetchTask makes at most. */
const MAX_CLAIMS = 3;

export interface FetchContext {
  readonly env: Env;
  readonly metrics: Metrics;
  readonly log: Logger;
  /** When the request arrived. */
  readonly now: number;
  /** The request's `connect-timeout-ms` header. */
  readonly timeoutHeader: string | undefined;
}

/** A failure to reach the run after its job was claimed: the runner retries, and is offered the task again. */
export class TaskUnavailable extends Error {}

/** No new claim or assignment starts after this. */
export function fetchDeadline(arrival: number, timeoutHeader: string | undefined): number {
  const asked = Number(timeoutHeader);
  const budget =
    timeoutHeader !== undefined && Number.isFinite(asked) && asked > 0
      ? Math.min(asked, RUNNER_DEADLINE_MS)
      : RUNNER_DEADLINE_MS;
  return arrival + budget - ANSWER_MARGIN_MS;
}

/** FetchTask's answer, encoded, once the runner is authenticated and the switch is on. */
export async function dispatchTask(
  call: FetchContext,
  runner: AuthenticatedRunner,
  view: DispatchView,
  requestVersion: number,
): Promise<Uint8Array> {
  const db = call.env.DIRECTORY;
  const deadline = fetchDeadline(call.now, call.timeoutHeader);
  const answer = (task: Uint8Array | undefined, version: number) =>
    encodeFetchTaskAnswer(task, version);

  // The runner repeats the version its task was offered with: it never read that answer. An
  // ephemeral runner that already holds a task is offered only that task again, never another.
  const reoffer =
    view.reoffer &&
    !(runner.ephemeral && !view.reoffer.assigned && (runner.taskConfirmed || view.liveOffers > 1))
      ? view.reoffer
      : undefined;
  if (reoffer) {
    // No time left to answer: nothing is touched, and the runner asks again with the same version.
    if (clock() >= deadline) return answer(undefined, requestVersion);
    const offered = reoffer;
    const assigned = await assignTask(call, runner, offered.runId, offered.id, offered.jobId);
    if ("task" in assigned) {
      call.log.info("task offered again", { taskId: offered.id, runId: offered.runId });
      return answer(assigned.task, requestVersion);
    }
    if (assigned.refused === "confirmed") return answer(undefined, requestVersion);
    await refuseTask(
      db,
      {
        taskId: offered.id,
        code: assigned.refused,
        runId: offered.runId,
        jobId: offered.jobId,
        now: clock(),
      },
      call.metrics,
    );
  }
  // Lapsed claims go first, so a claim of a Worker that died never holds a job, whoever polls.
  if (view.expiredClaims) await clearLapsedClaims(db, runner.accountId, clock(), call.metrics);
  // An ephemeral runner gets one task (the claim enforces it too, for polls that overlap).
  if (runner.ephemeral && (runner.taskConfirmed || view.liveOffers > 0))
    return answer(undefined, requestVersion);
  if (!view.expiredClaims && view.tasksVersion === requestVersion)
    return answer(undefined, view.tasksVersion);

  for (let claims = 0; claims < MAX_CLAIMS && clock() < deadline; claims++) {
    await dispatchHooks.beforeClaim?.();
    const claimed = await claimPending(
      db,
      {
        accountId: runner.accountId,
        runnerId: runner.id,
        labels: runner.labels,
        ephemeral: runner.ephemeral,
        version: requestVersion,
        now: clock(),
      },
      call.metrics,
    );
    // Searched and found nothing: the version read with the runner.
    if (!claimed) return answer(undefined, view.tasksVersion);
    await dispatchHooks.afterClaim?.();
    if (clock() >= deadline) {
      // Never assigned: the task row is superseded and the job free for the next poll at once.
      await releaseClaim(
        db,
        { ...claimed, now: clock(), accountId: runner.accountId },
        call.metrics,
      );
      break;
    }
    const assigned = await assignTask(call, runner, claimed.runId, claimed.taskId, claimed.jobId);
    if ("task" in assigned) {
      call.log.info("task assigned", {
        taskId: claimed.taskId,
        runId: claimed.runId,
        jobId: claimed.jobId,
      });
      return answer(assigned.task, requestVersion);
    }
    call.log.info("task refused by its run", {
      taskId: claimed.taskId,
      runId: claimed.runId,
      code: assigned.refused,
    });
    await refuseTask(
      db,
      {
        taskId: claimed.taskId,
        code: assigned.refused,
        runId: claimed.runId,
        jobId: claimed.jobId,
        now: clock(),
      },
      call.metrics,
    );
  }
  // Out of claims or time: the runner's own version, so it searches again.
  return answer(undefined, requestVersion);
}

async function assignTask(
  call: FetchContext,
  runner: AuthenticatedRunner,
  runId: string,
  taskId: number,
  jobId: number,
): Promise<AssignTaskAnswer> {
  call.metrics.count("do.request", { class: "RunDO", method: "assignTask" });
  try {
    return await call.env.RUN.getByName(runId).assignTask(
      taskId,
      jobId,
      runner.id,
      runner.accountId,
    );
  } catch (error) {
    call.log.warn("task assignment failed", {
      taskId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new TaskUnavailable();
  }
}
