import type {
  cancelWorkflowRun,
  forceCancelWorkflowRun,
  getWorkflowRun,
  Input,
  listWorkflowRunJobs,
  Output,
  rerunWorkflowRun,
} from "@fyrden/api-contract";
import type { JobView, RunDO, RunView } from "../do/RunDO.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeCursor, encodeCursor, invalidCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import type { RepoEntry } from "./directory.js";

/*
 * The Worker side of the `actions.runs.*` operations. A run's object owns
 * the run (`do/RunDO.ts`); the operation checks the caller's repository
 * permission, then that the run belongs to this repository, so another
 * repository's run looks missing.
 */

const runNotFound = () =>
  new OperationError(404, "run_not_found", "The repository has no such run.");

function runStub(ctx: OpContext, runId: string, method: string): DurableObjectStub<RunDO> {
  ctx.metrics.count("do.request", { class: "RunDO", method });
  return ctx.env.RUN.getByName(runId);
}

/** The run, when it exists and is this repository's. */
async function runOf(ctx: OpContext, entry: RepoEntry, runId: string): Promise<RunView> {
  const view = (await runStub(ctx, runId, "get").get()) as RunView | undefined;
  if (!view || view.repoId !== entry.id) throw runNotFound();
  return view;
}

/** Who acts: the agent for a token it uses for a user, else the principal. */
function actingPrincipal(ctx: OpContext): string {
  return ctx.auth.act?.[0] ?? ctx.auth.principalId;
}

const BRANCH = "refs/heads/";

function runOutput(view: RunView): Output<typeof getWorkflowRun> {
  return {
    id: view.runId,
    run_attempt: view.attempt,
    head_sha: view.sha,
    head_branch: view.ref.startsWith(BRANCH) ? view.ref.slice(BRANCH.length) : null,
    event: view.event,
    path: view.workflowPath,
    status: view.status,
    conclusion: view.conclusion,
    actor: { id: view.actor },
    triggering_actor: { id: view.triggeringActor },
    created_at: view.createdAt,
    updated_at: view.updatedAt,
    run_started_at: view.startedAt,
    completed_at: view.completedAt,
    errors: [...view.errors],
    faults: view.faults.map((f) => ({ ...f })),
  };
}

/** GitHub's job statuses: a job waiting for a slot or its group is `pending`; one stopping is `in_progress`. */
function jobStatus(
  status: JobView["status"],
): Output<typeof listWorkflowRunJobs>["jobs"][number]["status"] {
  switch (status) {
    case "blocked":
      return "pending";
    case "cancelling":
      return "in_progress";
    default:
      return status;
  }
}

/** The `actions.runs.get` operation. */
export async function getWorkflowRunOperation(
  ctx: OpContext,
  input: Input<typeof getWorkflowRun>,
): Promise<Output<typeof getWorkflowRun>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:read");
  return runOutput(await runOf(ctx, entry, input.run_id));
}

/**
 * The `actions.runs.jobs.list` operation. The cursor is the attempt and the
 * last job's id, so a re-run between pages does not switch attempts.
 */
export async function listWorkflowRunJobsOperation(
  ctx: OpContext,
  input: Input<typeof listWorkflowRunJobs>,
): Promise<Output<typeof listWorkflowRunJobs>> {
  const cursor = decodeCursor(input.cursor, (text) => /^[1-9][0-9]?:[1-9][0-9]{0,8}$/.test(text));
  const [cursorAttempt, after] = cursor === "" ? [undefined, 0] : cursor.split(":").map(Number);
  if (cursorAttempt !== undefined && input.attempt !== undefined && input.attempt !== cursorAttempt)
    throw invalidCursor();
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:read");
  const view = await runOf(ctx, entry, input.run_id);
  const attempt = cursorAttempt ?? input.attempt ?? view.attempt;
  if (attempt > view.attempt)
    throw new OperationError(404, "attempt_not_found", "The run has no such attempt.");
  const page = await runStub(ctx, input.run_id, "listJobs").listJobs(
    attempt,
    after ?? 0,
    input.per_page,
  );
  if (!page) throw runNotFound();
  return {
    jobs: page.jobs.map((job) => ({
      id: job.jobId,
      run_id: view.runId,
      run_attempt: job.attempt,
      name: job.name,
      status: jobStatus(job.status),
      conclusion: job.conclusion,
      started_at: job.startedAt,
      completed_at: job.completedAt,
      check: { state: job.check.state, code: job.check.code },
      log_complete: job.logComplete,
      error: job.error,
    })),
    next_cursor: page.next === null ? null : encodeCursor(`${attempt}:${page.next}`),
  };
}

async function cancel(
  ctx: OpContext,
  input: { owner: string; repo: string; run_id: string },
  mode: "graceful" | "force",
): Promise<Record<string, never>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:write");
  await runOf(ctx, entry, input.run_id);
  const result = await runStub(ctx, input.run_id, "cancel").cancel(actingPrincipal(ctx), mode);
  if (result.ok) return {};
  if (result.code === "run_not_found") throw runNotFound();
  throw new OperationError(409, "run_not_cancellable", "The run has completed.");
}

/** The `actions.runs.cancel` operation. */
export function cancelWorkflowRunOperation(
  ctx: OpContext,
  input: Input<typeof cancelWorkflowRun>,
): Promise<Output<typeof cancelWorkflowRun>> {
  return cancel(ctx, input, "graceful");
}

/** The `actions.runs.force_cancel` operation. */
export function forceCancelWorkflowRunOperation(
  ctx: OpContext,
  input: Input<typeof forceCancelWorkflowRun>,
): Promise<Output<typeof forceCancelWorkflowRun>> {
  return cancel(ctx, input, "force");
}

/** The `actions.runs.rerun` operation. */
export async function rerunWorkflowRunOperation(
  ctx: OpContext,
  input: Input<typeof rerunWorkflowRun>,
): Promise<Output<typeof rerunWorkflowRun>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:write");
  await runOf(ctx, entry, input.run_id);
  const result = await runStub(ctx, input.run_id, "rerun").rerun(actingPrincipal(ctx));
  if (result.ok) return { run_attempt: result.attempt };
  switch (result.code) {
    case "run_not_found":
      throw runNotFound();
    case "rerun_limit":
      throw new OperationError(409, "rerun_limit", "The run has been re-run 50 times, its limit.");
    default:
      throw new OperationError(
        409,
        "run_not_completed",
        "The run has not completed, or its workflow could not run, which a re-run cannot change.",
      );
  }
}
