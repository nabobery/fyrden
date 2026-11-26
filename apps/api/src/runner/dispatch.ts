// FetchTask's work in the Worker: offer a lost answer again while its job
// may still be given to a runner, answer an idle poll from the directory
// alone, or claim the account's oldest eligible pending job and have its run
// assign it. A pending row is only leased here; its run withdraws it once
// the job has left the queue.

import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import { ciSecretKeys } from "../ci/envelope.js";
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
  supersedeOffer,
} from "./registry.js";

/** Pause or fail points for tests. */
export const dispatchHooks: {
  beforeClaim?: () => Promise<void> | void;
  afterClaim?: () => Promise<void> | void;
  /** Before the directory records a run's refusal of a task. */
  beforeRefuse?: () => Promise<void> | void;
} = {};

/**
 * A job released because its secrets could not be read now is not claimed again for this long,
 * so the polls in between reach other jobs (it holds no runner meanwhile). Proposed.
 */
export const SECRETS_RETRY_MS = 10_000;

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
  /** Keeps `work` running once the runner is answered, or has gone. */
  waitUntil(work: Promise<void>): void;
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

  const exhausted: { runId: string; jobId: number }[] = [];
  // A job skipped for a retryable reason (its secrets could not be read or delivered now): an
  // answer with no task keeps the runner's version, so it asks again (and is offered a skipped
  // re-offer again).
  let retry = false;
  const refuse = async (refused: Parameters<typeof refuseTask>[1]) => {
    await dispatchHooks.beforeRefuse?.();
    await refuseTask(db, refused, call.metrics);
  };

  // The runner repeats the version its task was offered with: it never read that answer. An
  // ephemeral runner that already holds a task is offered only that task again, never another.
  let liveOffers = view.liveOffers;
  if (view.reoffer && !view.reoffer.eligible) {
    // Its job may no longer be given to this runner (its access was narrowed, its repository was
    // made public, or it was written before eligibility was recorded), as the authentication read
    // saw it.
    const { id, runId, assigned } = view.reoffer;
    if (!assigned) {
      // Never assigned: superseded, so the job stays queued in its run and its pending row,
      // which no claim takes while the job is ineligible, ends with run state's queue deadline.
      // An assignment that won the race since the read keeps it live.
      if (await supersedeOffer(db, { taskId: id, now: clock() }, call.metrics)) liveOffers--;
    }
    // Assigned (its answer was lost): not delivered, and kept as a live offer, so an ephemeral
    // runner takes no other job. Nobody runs the task, so run state's heartbeat deadline ends
    // it, and its end revokes the token and settles the runner as for any vanished runner.
    call.log.info("task withheld: its job may not be given to this runner", {
      taskId: id,
      runId,
      assigned,
    });
  }
  const reoffer =
    view.reoffer?.eligible &&
    !(runner.ephemeral && !view.reoffer.assigned && (runner.tookTask || liveOffers > 1))
      ? view.reoffer
      : undefined;
  // Without a CI master key no task's masks can be sealed, so no task is handed out: nothing is
  // claimed, re-offered or released (a lapsed claim, which any poll clears, waits too), and the
  // caller's own version keeps it searching once there is a key. The run checks again before it
  // assigns, for a key that goes after this check.
  const searches =
    !(runner.ephemeral && (runner.tookTask || liveOffers > 0)) &&
    view.tasksVersion !== requestVersion;
  if ((reoffer || searches || view.expiredClaims) && !(await ciSecretKeys(call.env)).current) {
    call.log.warn("no task searched for: there is no CI master key", {
      runnerId: runner.id,
      ...(reoffer && { taskId: reoffer.id, runId: reoffer.runId }),
    });
    return answer(undefined, requestVersion);
  }
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
    // The key went after the check above: the offer stands (a runner may be running it on an
    // earlier answer) and nothing else can be handed out either, so no task now and the same
    // version again.
    if (assigned.refused === "ci_key_unavailable") {
      keyUnavailable(call, offered.id, offered.runId);
      return answer(undefined, requestVersion);
    }
    // The account did not answer for the job's secrets: nothing was assigned or minted, and the
    // offer stands. The runner searches for other work and, given none, asks again at the same
    // version.
    if (assigned.refused === "secrets_unreachable") {
      secretsUnreachable(call, offered.id, offered.runId);
      exhausted.push({ runId: offered.runId, jobId: offered.jobId });
      retry = true;
    } else if (assigned.refused === "secrets_undeliverable") {
      // Its secrets no longer open or fit: an earlier answer may be running it, so the offer and
      // its earlier token stand, the runner searches for other work and, given none, asks again
      // at the same version.
      secretsUndeliverable(call, offered.id, offered.runId);
      exhausted.push({ runId: offered.runId, jobId: offered.jobId });
      retry = true;
    } else if (assigned.refused === "masks_unreadable") {
      // The task's stored masks do not open: the offer and its earlier token stand, and the
      // runner searches for other work and, given none, asks again at the same version, at
      // which the offer is made again.
      masksUnreadable(call, offered.id, offered.runId);
      exhausted.push({ runId: offered.runId, jobId: offered.jobId });
      retry = true;
    } else if (assigned.refused === "tokens_exhausted")
      exhausted.push({ runId: offered.runId, jobId: offered.jobId });
    else
      await refuse({
        taskId: offered.id,
        code: assigned.refused,
        runId: offered.runId,
        jobId: offered.jobId,
        now: clock(),
      });
  }
  // Lapsed claims go first, so a claim of a Worker that died never holds a job, whoever polls.
  if (view.expiredClaims) await clearLapsedClaims(db, runner.accountId, clock(), call.metrics);
  // An ephemeral runner gets one task (the claim enforces it too, for polls that overlap).
  if (runner.ephemeral && (runner.tookTask || liveOffers > 0))
    return answer(undefined, requestVersion);
  if (exhausted.length === 0 && !view.expiredClaims && view.tasksVersion === requestVersion)
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
        skipJobs: exhausted,
      },
      call.metrics,
    );
    // Searched and found nothing: the version read with the runner (its own, after a job skipped
    // for a retryable reason, so it asks again).
    if (!claimed) return answer(undefined, retry ? requestVersion : view.tasksVersion);
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
    if (assigned.refused === "confirmed") return answer(undefined, requestVersion);
    // The key went after the check above, or the account did not answer for the job's secrets.
    // A claim never assigned is given up, so the job is free for any poll, a poll at version 0
    // too (which is never re-offered a claim): at once without a key, after `SECRETS_RETRY_MS`
    // when its secrets could not be read, so the polls in between reach other jobs. One the run
    // assigned before is kept by the release's fence: it is a live offer, made again at its
    // version. Without a key nothing else can be handed out either; a job whose secrets could not
    // be read is skipped, and the search goes on.
    if (assigned.refused === "ci_key_unavailable" || assigned.refused === "secrets_unreachable") {
      const unreachable = assigned.refused === "secrets_unreachable";
      if (unreachable) secretsUnreachable(call, claimed.taskId, claimed.runId);
      else keyUnavailable(call, claimed.taskId, claimed.runId);
      const now = clock();
      await releaseClaim(
        db,
        {
          ...claimed,
          now,
          accountId: runner.accountId,
          ...(unreachable && { notBefore: now + SECRETS_RETRY_MS }),
        },
        call.metrics,
      );
      if (!unreachable) return answer(undefined, requestVersion);
      exhausted.push({ runId: claimed.runId, jobId: claimed.jobId });
      retry = true;
      continue;
    }
    // An offer of this claim another poll had assigned (its answer may be running the job), or one
    // whose end the run could not write. The claim is kept (its lease holds the job from other
    // polls meanwhile), and the offer is made again.
    if (assigned.refused === "secrets_undeliverable") {
      secretsUndeliverable(call, claimed.taskId, claimed.runId);
      exhausted.push({ runId: claimed.runId, jobId: claimed.jobId });
      retry = true;
      continue;
    }
    // An offer another poll answered, whose stored masks do not open: kept as it is, and given none,
    // the runner asks again at the same version, at which the offer is made again.
    if (assigned.refused === "masks_unreadable") {
      masksUnreadable(call, claimed.taskId, claimed.runId);
      exhausted.push({ runId: claimed.runId, jobId: claimed.jobId });
      retry = true;
      continue;
    }
    if (assigned.refused === "tokens_exhausted") {
      exhausted.push({ runId: claimed.runId, jobId: claimed.jobId });
      continue;
    }
    call.log.info("task refused by its run", {
      taskId: claimed.taskId,
      runId: claimed.runId,
      code: assigned.refused,
    });
    await refuse({
      taskId: claimed.taskId,
      code: assigned.refused,
      runId: claimed.runId,
      jobId: claimed.jobId,
      now: clock(),
    });
  }
  // Out of claims or time: the runner's own version, so it searches again.
  return answer(undefined, requestVersion);
}

function keyUnavailable(call: FetchContext, taskId: number, runId: string): void {
  call.log.warn("task not handed out: there is no CI master key", { taskId, runId });
}

function masksUnreadable(call: FetchContext, taskId: number, runId: string): void {
  call.log.warn("task not handed out: its stored masks do not open", { taskId, runId });
}

function secretsUnreachable(call: FetchContext, taskId: number, runId: string): void {
  call.log.warn("task not handed out: its secrets could not be read", { taskId, runId });
}

function secretsUndeliverable(call: FetchContext, taskId: number, runId: string): void {
  call.log.warn("task not handed out again: its secrets cannot be delivered", { taskId, runId });
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
    // Never retry an overloaded object (verified: https://developers.cloudflare.com/durable-objects/best-practices/error-handling/).
    if ((error as { overloaded?: unknown } | null)?.overloaded !== true)
      call.waitUntil(assignmentLost(call, runId, taskId, jobId));
    throw new TaskUnavailable();
  }
}

// A new stub: one that threw stays broken (verified: https://developers.cloudflare.com/durable-objects/best-practices/error-handling/).
async function assignmentLost(
  call: FetchContext,
  runId: string,
  taskId: number,
  jobId: number,
): Promise<void> {
  call.metrics.count("do.request", { class: "RunDO", method: "assignmentLost" });
  try {
    await call.env.RUN.getByName(runId).assignmentLost(taskId, jobId);
  } catch (error) {
    call.log.warn("failed assignment not reported", {
      taskId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
