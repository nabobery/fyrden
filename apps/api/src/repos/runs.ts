import { isUlid, newUlid } from "@fyrden/adapters-cloudflare/git";
import {
  type approveWorkflowRun,
  type cancelWorkflowRun,
  type dispatchWorkflow,
  type forceCancelWorkflowRun,
  GRAPH_ERROR_UNITS,
  GRAPH_NAME_UNITS,
  type getWorkflowRun,
  type getWorkflowRunGraph,
  type getWorkflowRunJob,
  type Input,
  type listRunsOfWorkflow,
  type listWorkflowRunJobs,
  type listWorkflowRuns,
  type listWorkflows,
  type Output,
  type rerunWorkflowRun,
} from "@fyrden/api-contract";
import { parseCreatedFilter, runPhase, WORKFLOW_DIRECTORIES } from "@fyrden/domain/ci";
import type { RepoDO } from "../do/RepoDO.js";
import type { GraphJob, JobView, RunDO, RunView } from "../do/RunDO.js";
import type { DispatchAnswer } from "../do/repo/ci-triggers.js";
import type { RunFilter, RunPage, WorkflowPage } from "../do/repo/run-history.js";
import { publicOrigin } from "../email/notifications.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeCursor, encodeCursor, invalidCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { runSummary } from "./ci-shapes.js";
import { type RepoEntry, settledRepo } from "./directory.js";
import { principalsByLogin } from "./reviews.js";

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
export async function runOf(ctx: OpContext, entry: RepoEntry, runId: string): Promise<RunView> {
  const view = (await runStub(ctx, runId, "get").get()) as RunView | undefined;
  if (!view || view.repoId !== entry.id) throw runNotFound();
  return view;
}

/** Who acts: the agent for a token it uses for a user, else the principal. */
function actingPrincipal(ctx: OpContext): string {
  return ctx.auth.act?.[0] ?? ctx.auth.principalId;
}

function runOutput(view: RunView): Output<typeof getWorkflowRun> {
  return {
    ...runSummary({
      ...view,
      path: view.workflowPath,
      phase: runPhase(view.status, view.approval?.state === "waiting"),
    }),
    approval: view.approval && {
      state: view.approval.state,
      decided_by: view.approval.decidedBy === null ? null : { id: view.approval.decidedBy },
      decided_at: view.approval.decidedAt,
    },
    errors: view.errors.map((e) => ({ ...e })),
    faults: view.faults.map((f) => ({ ...f })),
  };
}

/** GitHub's job statuses: a job waiting for a slot or its group is `pending`; one stopping is `in_progress`. */
function jobStatus(status: JobView["status"]): Output<typeof getWorkflowRunJob>["status"] {
  switch (status) {
    case "blocked":
      return "pending";
    case "cancelling":
      return "in_progress";
    default:
      return status;
  }
}

function workflowJob(runId: string, job: JobView): Output<typeof getWorkflowRunJob> {
  return {
    id: job.jobId,
    run_id: runId,
    run_attempt: job.attempt,
    name: job.name,
    job_key: job.jobKey,
    status: jobStatus(job.status),
    conclusion: job.conclusion,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    check: { state: job.check.state, code: job.check.code },
    log_complete: job.logComplete,
    error: job.error,
    steps: job.steps.map((step) => ({
      number: step.number,
      name: step.name,
      stage: step.stage,
      status: step.status,
      conclusion: step.conclusion,
      started_at: step.startedAt,
      completed_at: step.completedAt,
      log: step.log && { ...step.log },
    })),
    waiting_for: job.waitingFor,
  };
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
    jobs: page.jobs.map((job) => workflowJob(view.runId, job)),
    next_cursor: page.next === null ? null : encodeCursor(`${attempt}:${page.next}`),
  };
}

/** The `actions.runs.jobs.get` operation: job ids are per run, whatever the attempt. */
export async function getWorkflowRunJobOperation(
  ctx: OpContext,
  input: Input<typeof getWorkflowRunJob>,
): Promise<Output<typeof getWorkflowRunJob>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:read");
  const view = await runOf(ctx, entry, input.run_id);
  const answer = (await runStub(ctx, input.run_id, "getJob").getJob(
    input.job_id,
  )) as unknown as ReturnType<RunDO["getJob"]>;
  if (answer.ok) return workflowJob(view.runId, answer.job);
  if (answer.code === "run_not_found") throw runNotFound();
  throw new OperationError(404, "job_not_found", "The run has no such job.");
}

const repoGone = (entry: RepoEntry) =>
  new OperationError(
    404,
    "repo_not_found",
    `No repository ${entry.ownerHandle}/${entry.name} was found.`,
  );

/** What a `status` filter asks of a run; undefined for a value no run here has. */
const STATUS_FILTERS: Readonly<
  Partial<
    Record<
      NonNullable<Input<typeof listWorkflowRuns>["status"]>,
      Pick<RunFilter, "phases" | "conclusion">
    >
  >
> = {
  queued: { phases: ["queued"] },
  pending: { phases: ["pending"] },
  in_progress: { phases: ["in_progress"] },
  completed: { phases: ["completed", "waiting"] },
  action_required: { phases: ["waiting"] },
  success: { conclusion: "success" },
  failure: { conclusion: "failure" },
  cancelled: { conclusion: "cancelled" },
};

/**
 * The runs a list's input asks for, of workflow files `paths` when given;
 * undefined when none can match (a status no run has, an actor no one is).
 */
async function runFilter(
  ctx: OpContext,
  input: Input<typeof listWorkflowRuns>,
  paths: RunFilter["paths"],
): Promise<RunFilter | undefined> {
  const status = input.status === undefined ? {} : STATUS_FILTERS[input.status];
  if (!status) return undefined;
  const triggered = input.created === undefined ? undefined : parseCreatedFilter(input.created);
  if (input.created !== undefined && !triggered)
    throw new OperationError(
      422,
      "invalid_filter",
      "created takes a date, a time or a range in GitHub's syntax, such as >=2026-11-20.",
    );
  let actor: string | undefined;
  if (input.actor !== undefined) {
    actor = (await principalsByLogin(ctx, [input.actor], true)).get(input.actor.toLowerCase());
    if (actor === undefined) return undefined;
  }
  return {
    ...status,
    ...(paths && { paths }),
    ...(triggered && { triggered }),
    ...(actor !== undefined && { actor }),
    ...(input.head_sha !== undefined && { sha: input.head_sha }),
    ...(input.branch !== undefined && { branch: input.branch }),
    ...(input.event !== undefined && { event: input.event }),
  };
}

async function listRuns(
  ctx: OpContext,
  input: Input<typeof listWorkflowRuns>,
  paths?: RunFilter["paths"],
): Promise<Output<typeof listWorkflowRuns>> {
  for (const name of ["check_suite_id", "exclude_pull_requests"] as const)
    if (input[name] !== undefined)
      throw new OperationError(422, "unsupported_parameter", `${name} is not supported.`);
  const before = decodeCursor(input.cursor, isUlid);
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:read");
  const filter = await runFilter(ctx, input, paths);
  if (!filter) return { workflow_runs: [], next_cursor: null };
  ctx.metrics.count("do.request", { class: "RepoDO", method: "listRuns" });
  const page = (await ctx.env.REPO.getByName(entry.id).listRuns(
    filter,
    before === "" ? null : before,
    input.per_page,
  )) as RunPage | null;
  if (!page) throw repoGone(entry);
  return {
    workflow_runs: page.runs.map(runSummary),
    next_cursor: page.next === null ? null : encodeCursor(page.next),
  };
}

/** The `actions.runs.list` operation. The cursor is the last run id read. */
export function listWorkflowRunsOperation(
  ctx: OpContext,
  input: Input<typeof listWorkflowRuns>,
): Promise<Output<typeof listWorkflowRuns>> {
  return listRuns(ctx, input);
}

/** The `actions.workflows.runs.list` operation. */
export function listRunsOfWorkflowOperation(
  ctx: OpContext,
  input: Input<typeof listRunsOfWorkflow>,
): Promise<Output<typeof listRunsOfWorkflow>> {
  const [first, second] = WORKFLOW_DIRECTORIES;
  return listRuns(ctx, input, [`${first}/${input.workflow_id}`, `${second}/${input.workflow_id}`]);
}

/** The `actions.workflows.list` operation. The cursor is the last path read. */
export async function listWorkflowsOperation(
  ctx: OpContext,
  input: Input<typeof listWorkflows>,
): Promise<Output<typeof listWorkflows>> {
  const after = decodeCursor(input.cursor, (path) => path.length > 0 && path.length <= 1024);
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "listRunWorkflows" });
  const page = (await ctx.env.REPO.getByName(entry.id).listRunWorkflows(
    after,
    input.per_page,
  )) as WorkflowPage | null;
  if (!page) throw repoGone(entry);
  return {
    workflows: page.workflows.map(({ path, name, latest }) => ({
      id: path.slice(path.lastIndexOf("/") + 1),
      path,
      name,
      latest_run: latest && runSummary(latest),
    })),
    next_cursor: page.next === null ? null : encodeCursor(page.next),
  };
}

/** A workflow job as GitHub's statuses name it; `pending` while the jobs it needs have not ended. */
function graphStatus(job: GraphJob) {
  switch (job.status) {
    case "waiting":
      return "pending" as const;
    case "running":
      return "in_progress" as const;
    default:
      return "completed" as const;
  }
}

function cutText(text: string, units: number): { text: string; cut: boolean } {
  if (text.length <= units) return { text, cut: false };
  const high = text.charCodeAt(units - 1);
  const low = text.charCodeAt(units);
  const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  return { text: text.slice(0, splitsPair ? units - 1 : units), cut: true };
}

function cutName(name: string): { name: string; name_cut: boolean } {
  const { text, cut } = cutText(name, GRAPH_NAME_UNITS);
  return { name: text, name_cut: cut };
}

/** The `actions.runs.graph.get` operation. */
export async function getWorkflowRunGraphOperation(
  ctx: OpContext,
  input: Input<typeof getWorkflowRunGraph>,
): Promise<Output<typeof getWorkflowRunGraph>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:read");
  const answer = (await runStub(ctx, input.run_id, "graph").graph(entry.id, input.attempt, {
    name: GRAPH_NAME_UNITS + 1,
    error: GRAPH_ERROR_UNITS + 1,
  })) as unknown as ReturnType<RunDO["graph"]>;
  if (!answer.ok) {
    if (answer.code === "run_not_found") throw runNotFound();
    throw new OperationError(404, "attempt_not_found", "The run has no such attempt.");
  }
  return {
    run_id: input.run_id,
    run_attempt: answer.attempt,
    jobs: answer.jobs.map((job) => ({
      key: job.key,
      ...cutName(job.name),
      needs: [...job.needs],
      status: graphStatus(job),
      conclusion: job.outcome,
      jobs: job.jobs.map((instance) => ({
        id: instance.jobId,
        ...cutName(instance.name),
        status: jobStatus(instance.status),
        conclusion: instance.conclusion,
        started_at: instance.startedAt,
        completed_at: instance.completedAt,
        waiting_for: instance.waitingFor,
        error: instance.error === null ? null : cutText(instance.error, GRAPH_ERROR_UNITS).text,
      })),
    })),
  };
}

const attemptChanged = () =>
  new OperationError(
    409,
    "attempt_changed",
    "The run has a newer attempt; review it before acting.",
  );

async function cancel(
  ctx: OpContext,
  input: { owner: string; repo: string; run_id: string; attempt?: number | undefined },
  mode: "graceful" | "force",
): Promise<Record<string, never>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:write");
  await runOf(ctx, entry, input.run_id);
  const result = await runStub(ctx, input.run_id, "cancel").cancel(
    actingPrincipal(ctx),
    mode,
    input.attempt,
  );
  if (result.ok) return {};
  if (result.code === "run_not_found") throw runNotFound();
  if (result.code === "attempt_changed") throw attemptChanged();
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
  const result = await runStub(ctx, input.run_id, "rerun").rerun(
    actingPrincipal(ctx),
    input.attempt,
  );
  if (result.ok) return { run_attempt: result.attempt };
  switch (result.code) {
    case "run_not_found":
      throw runNotFound();
    case "attempt_changed":
      throw attemptChanged();
    case "rerun_limit":
      throw new OperationError(409, "rerun_limit", "The run has been re-run 50 times, its limit.");
    case "approval_required":
      throw new OperationError(
        409,
        "approval_required",
        "The run ended without the approval it waited for; it cannot be re-run.",
      );
    default:
      throw new OperationError(
        409,
        "run_not_completed",
        "The run has not completed, or its workflow could not run, which a re-run cannot change.",
      );
  }
}

const notPending = () =>
  new OperationError(
    409,
    "approval_not_pending",
    "The run does not wait for approval: it needed none, or it was superseded, cancelled or expired.",
  );

/**
 * The `actions.runs.approve` operation: the repository records the
 * approval (checking the approver again), then the run is told at once,
 * with the approver the repository recorded (the first, if two approve
 * before it is told); a failure there is left to the repository's delivery
 * job. A run whose approval ended unapproved (cancelled, expired,
 * superseded) is refused before anything is recorded; one the run refuses
 * on the fast path settles the repository's record as the run ended.
 */
export async function approveWorkflowRunOperation(
  ctx: OpContext,
  input: Input<typeof approveWorkflowRun>,
): Promise<Output<typeof approveWorkflowRun>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "actions:write");
  const view = await runOf(ctx, entry, input.run_id);
  if (view.approval && view.approval.state !== "waiting" && view.approval.state !== "approved")
    throw notPending();
  const repo = ctx.env.REPO.getByName(entry.id);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "approveRun" });
  const recorded = (await repo.approveRun({
    runId: input.run_id,
    approver: actingPrincipal(ctx),
  })) as unknown as Awaited<ReturnType<RepoDO["approveRun"]>>;
  if (!recorded.ok) {
    if (recorded.code === "approval_not_pending") throw notPending();
    if (recorded.code === "run_not_found") throw runNotFound();
    throw new OperationError(
      404,
      "repo_not_found",
      `No repository ${input.owner}/${input.repo} was found.`,
    );
  }
  let answer: Awaited<ReturnType<RunDO["approve"]>>;
  try {
    answer = (await runStub(ctx, input.run_id, "approve").approve(
      recorded.binding,
      recorded.approver,
    )) as unknown as Awaited<ReturnType<RunDO["approve"]>>;
  } catch {
    // The repository's job delivers it.
    return {};
  }
  if (answer.ok) return {};
  if (answer.code === "run_not_found") throw runNotFound();
  // The run ended unapproved in between: the repository records how, and nothing was approved.
  const ended = ((await runStub(ctx, input.run_id, "get").get()) as RunView | undefined)?.approval;
  if (ended && (ended.state === "cancelled" || ended.state === "expired")) {
    ctx.metrics.count("do.request", { class: "RepoDO", method: "settleApproval" });
    await repo.settleApproval({ runId: input.run_id, outcome: ended.state });
  }
  throw notPending();
}

/**
 * A dispatch refused for a transfer or rename: its key's answer is stored,
 * so the same `Idempotency-Key` replays this refusal.
 */
const DISPATCH_TRANSFERRING =
  "The repository is being transferred, or was transferred or renamed after this request was authorized. Once any active transfer ends, look the repository up again (its owner or name may have changed) and dispatch with a new Idempotency-Key: the same key answers this refusal again.";

const DISPATCH_REFUSALS: Record<
  Exclude<DispatchAnswer, { ok: true }>["code"],
  { status: 404 | 409 | 422 | 503; detail: string }
> = {
  busy: { status: 503, detail: "The repository is busy. Try again shortly." },
  ci_off: { status: 409, detail: "This deployment runs no CI." },
  repo_not_ready: { status: 409, detail: "The repository cannot run workflows yet." },
  repo_transferring: { status: 409, detail: DISPATCH_TRANSFERRING },
  owner_changed: {
    status: 409,
    detail:
      "The repository changed owner before the run started, so the run was dropped and never runs. Dispatch again with a new Idempotency-Key.",
  },
  commit_unreachable: {
    status: 409,
    detail:
      "The ref's commit was deleted from the repository's history before the run started, so the run was dropped and never runs. Dispatch again with a new Idempotency-Key.",
  },
  ref_not_found: { status: 422, detail: "No branch or tag has that name." },
  workflow_not_found: {
    status: 404,
    detail: "No workflow file has that name at the ref and on the default branch.",
  },
  workflow_not_dispatchable: {
    status: 422,
    detail: "The workflow has no workflow_dispatch trigger.",
  },
  invalid_inputs: { status: 422, detail: "The inputs do not match the workflow's." },
  invalid_workflow: { status: 422, detail: "The workflow file's triggers cannot be read." },
};

/** Test seams: between the dispatch's access decision and its second ownership check. */
export const dispatchHooks: { afterAuthorize?: () => Promise<void> } = {};

/**
 * The `actions.workflows.dispatch` operation. The dispatch is recorded
 * under the request's idempotency claim (a later request with the same
 * key past its window is a new claim, so a new run), or under a fresh id
 * without a key, as GitHub makes one run per such request.
 */
export async function dispatchWorkflowOperation(
  ctx: OpContext,
  input: Input<typeof dispatchWorkflow>,
): Promise<Output<typeof dispatchWorkflow>> {
  // Authorized under settled ownership: a decision the repository object made for the former
  // owner while the directory named the new one is never sent on under the new one's identity.
  const entry = await settledRepo(ctx.env, ctx.auth, input.owner, input.repo, "actions:write", {
    transferring: DISPATCH_TRANSFERRING,
    sameName: true,
    metrics: ctx.metrics,
    afterAuthorize: () => dispatchHooks.afterAuthorize?.() ?? Promise.resolve(),
  });
  ctx.metrics.count("do.request", { class: "RepoDO", method: "dispatchWorkflow" });
  const answer = (await ctx.env.REPO.getByName(entry.id).dispatchWorkflow({
    file: input.workflow_id,
    ref: input.ref,
    inputs: input.inputs,
    // The token's principal, as a push by the same token records: a delegated agent acts for its
    // user, whose role the run's job token reads with (the agent alone may have none).
    actor: ctx.auth.principalId,
    // A keyed call (REST's Idempotency-Key, MCP's idempotency_key) dispatches under its claim, so
    // a retry answers the same run; a call without a key is a dispatch of its own.
    key: ctx.idempotencyClaim ?? newUlid(Date.now()),
    // Read from the directory's primary: the repository refuses if it is no longer so.
    authorized: { ownerId: entry.ownerId, nameGen: entry.nameGen },
  })) as unknown as DispatchAnswer;
  if (!answer.ok) {
    const refusal = DISPATCH_REFUSALS[answer.code];
    throw new OperationError(
      refusal.status,
      answer.code,
      refusal.detail,
      undefined,
      undefined,
      refusal.status === 503 ? 1 : undefined,
      undefined,
      undefined,
      "errors" in answer ? answer.errors : undefined,
    );
  }
  const path = `${entry.ownerHandle}/${entry.name}/actions/runs/${answer.runId}`;
  return {
    workflow_run_id: answer.runId,
    run_url: `${ctx.requestOrigin}/api/repos/${path}`,
    // No run page exists yet: where it will be, on the deployment's public origin.
    html_url: `${publicOrigin(ctx.env) ?? ctx.requestOrigin}/${path}`,
  };
}
