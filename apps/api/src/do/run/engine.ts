import type { JobQueue } from "@fyrden/adapters-cloudflare/git";
import { type CheckConclusion, checkNameKey, isFailing } from "@fyrden/domain";
import {
  type AttemptConclusion,
  type AttemptEvent,
  type AttemptState,
  advanceAttempt,
  advanceInstance,
  attemptConclusion,
  type CancelMode,
  type CancelReason,
  concurrencyGroupKey,
  type ExpressionScope,
  type ExprValue,
  evaluateField,
  evaluateJobCondition,
  expandJob,
  exprObject,
  failFastVictims,
  type InstanceConclusion,
  type InstanceEvent,
  type InstanceState,
  type InstanceStatus,
  instanceCheck,
  isTruthy,
  MAX_CONCURRENCY_GROUP_LENGTH,
  MAX_EXPRESSION_WORK,
  MAX_RUN_JOBS,
  type NeedResult,
  type NodeStatus,
  newWorkBudget,
  nodeOutcome,
  nodeResultOf,
  promotable,
  type RunnerResult,
  readyNodes,
  strategyContext,
  toExprString,
  unreadyNodeStatus,
  type WorkBudget,
} from "@fyrden/domain/ci";
import { decodeInstance, encodeInstance, exprFromJson, outputsExpr } from "./codec.js";
import { nodeName, type RunModel } from "./model.js";

/*
 * A run's state in its object's SQLite: every transition reads its guard
 * and writes its result in the caller's transaction, through the domain's
 * rules (`run-state.ts`). Effects outside the object (the repository's
 * checks, a runner) happen only in `JobQueue` slices, which this engine
 * schedules by fixed job id.
 */

/** Fixed `JobQueue` ids, one job each. */
export const RUN_JOB = {
  advance: "advance",
  checks: "checks",
  deadlines: "deadlines",
  sweep: "sweep",
  dispatch: "dispatch",
  taskEnd: "task-end",
  concurrency: "concurrency",
  reconcile: "reconcile",
} as const;

export interface RunPolicy {
  /** A job that no runner took is cancelled after this. GitHub: 24 hours. */
  readonly queueTimeoutMs: number;
  /** A cancelling instance whose runner does not answer is completed after this. Proposed: 2 min. */
  readonly cancelGraceMs: number;
  /** A running instance whose runner stopped reporting fails after this. Proposed: 10 min. */
  readonly heartbeatTimeoutMs: number;
  /** Heartbeats closer together than this write nothing. Proposed: 30 s. */
  readonly heartbeatWriteMs: number;
  /** Check transitions within this window go to the repository in one batch. Proposed: 1 s. */
  readonly checkFlushMs: number;
  /** How often the sweep retries work that exhausted its attempts. Proposed: 30 min. */
  readonly sweepMs: number;
  /**
   * How often a run writes its record into its repository again, finished or not, so that a
   * restore of the repository that dropped the record cannot hide the run from the
   * repository's erasure. It bounds how long a run outlives such an erasure. Proposed: 7 days.
   */
  readonly reconcileMs: number;
  /** Nodes one scheduling step decides at most, before it ends its invocation. Proposed. */
  readonly nodesPerStep: number;
  /** Expression work one step spends at most before it ends its invocation: four full budgets. */
  readonly stepWork: number;
  /** Outputs of one instance, as UTF-8 bytes of their JSON. Proposed: GitHub's 1 MB per job. */
  readonly maxInstanceOutputBytes: number;
  /** Outputs of one attempt. Proposed (GitHub: 50 MB a run; a needs context is built in one isolate). */
  readonly maxAttemptOutputBytes: number;
}

const MIN = 60_000;

export const RUN_DEFAULTS: RunPolicy = {
  queueTimeoutMs: 24 * 60 * MIN,
  cancelGraceMs: 2 * MIN,
  heartbeatTimeoutMs: 10 * MIN,
  heartbeatWriteMs: 30_000,
  checkFlushMs: 1_000,
  sweepMs: 30 * MIN,
  reconcileMs: 7 * 24 * 60 * MIN,
  nodesPerStep: 32,
  stepWork: 4 * MAX_EXPRESSION_WORK,
  maxInstanceOutputBytes: 1024 * 1024,
  maxAttemptOutputBytes: 8 * 1024 * 1024,
};

/** Grace added to an owner's hold before a cancelled owner is evicted. Proposed (5 minutes). */
export const HOLD_GRACE_MS = 5 * 60_000;

/** The scope key of an attempt's workflow group. */
export function workflowScope(attempt: number): string {
  return `a${attempt}`;
}

/** The scope key of one instance's job group. */
export function jobScope(attempt: number, jobId: number): string {
  return `a${attempt}/j${jobId}`;
}

export interface OwnerRow {
  owner_key: string;
  group_key: string;
  group_name: string;
  state: "admitting" | "pending" | "owner" | "releasing" | "ended";
  outcome: string | null;
  cancel_in_progress: number;
  generation: number | null;
  lease_valid_until: number | null;
  renew_at: number | null;
  hold_ms: number | null;
}

/** GitHub's default `timeout-minutes`. */
export const DEFAULT_TIMEOUT_MINUTES = 360;
/** The longest a job may run: GitHub's self-hosted limit of 5 days. */
export const MAX_TIMEOUT_MINUTES = 7_200;
/** Attempts of one run: the first and 50 re-runs (GitHub's limit). */
export const MAX_RUN_ATTEMPTS = 51;

export interface RunRow {
  run_id: string;
  repo_id: string;
  sha: string;
  ref: string;
  event: string;
  actor_id: string;
  workflow_path: string;
  workflow_source: string;
  contexts: string;
  spec_digest: string;
  attempt: number;
  task_seq: number;
  job_seq: number;
  task_end_seq: number;
  task_end_acked: number;
  queue_rev: number;
  queue_synced_rev: number;
  created_at: number;
  updated_at: number;
}

export interface AttemptRow {
  attempt: number;
  status: AttemptState["status"];
  conclusion: AttemptConclusion | null;
  cancel: CancelMode;
  cancelled_by: string | null;
  triggering_actor_id: string;
  group_key: string | null;
  group_name: string | null;
  cancel_in_progress: number | null;
  errors: string | null;
  used_instances: number;
  output_bytes: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface NodeRow {
  attempt: number;
  job_key: string;
  ord: number;
  name: string;
  status: NodeStatus;
  result: NeedResult | null;
  reserved: number;
  fail_fast: number | null;
  max_parallel: number | null;
  declares: string | null;
  error: string | null;
  output_bytes: number;
}

export interface InstanceRow {
  job_id: number;
  attempt: number;
  job_key: string;
  idx: number;
  total: number;
  name: string;
  name_key: string;
  instance: string | null;
  status: InstanceStatus;
  conclusion: InstanceConclusion | null;
  cancel_reason: CancelReason | null;
  continue_on_error: number;
  timeout_ms: number;
  group_key: string | null;
  group_name: string | null;
  group_cancel: number | null;
  task: number | null;
  assign_key: string | null;
  task_end_seq: number | null;
  queued_at: number | null;
  started_at: number | null;
  heartbeat_at: number | null;
  cancel_at: number | null;
  completed_at: number | null;
  outputs: string | null;
  error: string | null;
  log_complete: number | null;
  check_code: string | null;
}

/** What the engine needs from its object. */
export interface EngineHost {
  readonly storage: DurableObjectStorage;
  readonly jobs: JobQueue;
  readonly policy: RunPolicy;
  now(): number;
  /** The run's workflow, parsed and planned (the run's plan succeeded). */
  model(): RunModel;
}

type Bindable = string | number | null;
const utf8 = new TextEncoder();

export class RunEngine {
  constructor(private readonly host: EngineHost) {}

  // ---------------------------------------------------------------- rows

  rows<T>(query: string, ...bindings: Bindable[]): T[] {
    return this.host.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  exec(query: string, ...bindings: Bindable[]): void {
    this.host.storage.sql.exec(query, ...bindings);
  }

  run(): RunRow | undefined {
    return this.rows<RunRow>("SELECT * FROM runs WHERE id = 1")[0];
  }

  attempt(n: number): AttemptRow | undefined {
    return this.rows<AttemptRow>("SELECT * FROM run_attempts WHERE attempt = ?", n)[0];
  }

  current(): { run: RunRow; attempt: AttemptRow } | undefined {
    const run = this.run();
    const attempt = run && this.attempt(run.attempt);
    return run && attempt ? { run, attempt } : undefined;
  }

  nodes(attempt: number): NodeRow[] {
    return this.rows<NodeRow>("SELECT * FROM run_nodes WHERE attempt = ? ORDER BY ord", attempt);
  }

  node(attempt: number, jobKey: string): NodeRow | undefined {
    return this.rows<NodeRow>(
      "SELECT * FROM run_nodes WHERE attempt = ? AND job_key = ?",
      attempt,
      jobKey,
    )[0];
  }

  instances(attempt: number, jobKey?: string): InstanceRow[] {
    return jobKey === undefined
      ? this.rows<InstanceRow>(
          "SELECT * FROM run_instances WHERE attempt = ? ORDER BY job_id",
          attempt,
        )
      : this.rows<InstanceRow>(
          "SELECT * FROM run_instances WHERE attempt = ? AND job_key = ? ORDER BY idx",
          attempt,
          jobKey,
        );
  }

  instance(jobId: number): InstanceRow | undefined {
    return this.rows<InstanceRow>("SELECT * FROM run_instances WHERE job_id = ?", jobId)[0];
  }

  /** Instances that hold or may get a runner: queued, in progress, cancelling. */
  liveInstances(): InstanceRow[] {
    return this.rows<InstanceRow>(
      `SELECT * FROM run_instances WHERE status IN ('queued', 'in_progress', 'cancelling')
       ORDER BY job_id`,
    );
  }

  #touch(): void {
    this.exec("UPDATE runs SET updated_at = ? WHERE id = 1", this.host.now());
  }

  #ensure(kind: Parameters<JobQueue["ensure"]>[0], id: string, delayMs = 0): void {
    this.host.jobs.ensure(kind, id, { runAt: this.host.now() + delayMs });
  }

  /** Schedules the next scheduling step. */
  wake(): void {
    this.#ensure("run_advance", RUN_JOB.advance);
  }

  // ---------------------------------------------------------------- attempts

  /** Applies `event` to the current attempt; false when refused. */
  advanceAttempt(attempt: AttemptRow, event: AttemptEvent): boolean {
    const step = advanceAttempt(attempt, event);
    if (!step.ok) return false;
    const now = this.host.now();
    const { status, conclusion, cancel } = step.state;
    this.exec(
      `UPDATE run_attempts SET status = ?, conclusion = ?, cancel = ?,
         started_at = CASE WHEN ? = 'in_progress' AND started_at IS NULL THEN ? ELSE started_at END,
         completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
       WHERE attempt = ?`,
      status,
      conclusion,
      cancel,
      status,
      now,
      status,
      now,
      attempt.attempt,
    );
    this.#touch();
    if (status === "completed") this.#onAttemptCompleted(attempt.attempt);
    return true;
  }

  /** New attempt rows: its nodes from the plan, its instance budget at the plan's static count. */
  insertAttempt(n: number, triggeringActor: string, model: RunModel | undefined): void {
    const now = this.host.now();
    this.exec(
      `INSERT INTO run_attempts (attempt, status, triggering_actor_id, used_instances, created_at)
       VALUES (?, 'queued', ?, ?, ?)`,
      n,
      triggeringActor,
      model?.plan.staticInstances ?? 0,
      now,
    );
    if (!model) return;
    model.plan.graph.order.forEach(({ id: jobKey }, ord) => {
      const reserved = model.plan.jobs.get(jobKey)?.instances ?? 1;
      this.exec(
        `INSERT INTO run_nodes (attempt, job_key, ord, name, status, reserved)
         VALUES (?, ?, ?, ?, 'waiting', ?)`,
        n,
        jobKey,
        ord,
        nodeName(model.workflow, jobKey),
        reserved,
      );
    });
  }

  // ---------------------------------------------------------------- instances

  #stateOf(row: InstanceRow): InstanceState {
    return {
      status: row.status,
      conclusion: row.conclusion,
      cancelReason: row.cancel_reason,
      continueOnError: row.continue_on_error === 1,
    };
  }

  /**
   * Applies `event` to an instance with every consequence: its check, the
   * queue revision, the task-end sequence, fail-fast, deadlines and the next
   * scheduling step. False when refused.
   */
  applyInstance(
    row: InstanceRow,
    event: InstanceEvent,
    extra: { outputs?: string | null; error?: string | null; logComplete?: boolean } = {},
  ): boolean {
    const step = advanceInstance(this.#stateOf(row), event);
    if (!step.ok) return false;
    const next = step.state;
    const now = this.host.now();
    const completed = next.status === "completed";
    const forced =
      completed &&
      (event.kind === "grace_expired" ||
        event.kind === "heartbeat_lost" ||
        event.kind === "force_cancel");
    let taskEnd: number | null = row.task_end_seq;
    if (completed && row.task !== null && taskEnd === null) {
      this.exec("UPDATE runs SET task_end_seq = task_end_seq + 1 WHERE id = 1");
      taskEnd = (this.run() as RunRow).task_end_seq;
      this.#ensure("ci_task_end", RUN_JOB.taskEnd);
    }
    // Complete stays complete: rows that reached durable storage do not leave it.
    let log = row.log_complete;
    if (completed && row.task !== null && log !== 1) {
      if (extra.logComplete === true) log = 1;
      else if (extra.logComplete === false || forced) log = 0;
    }
    this.exec(
      `UPDATE run_instances SET status = ?, conclusion = ?, cancel_reason = ?,
         queued_at = CASE WHEN ? = 'queued' THEN ? ELSE queued_at END,
         cancel_at = CASE WHEN ? = 'cancelling' AND cancel_at IS NULL THEN ? ELSE cancel_at END,
         completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
         task_end_seq = ?, log_complete = ?,
         outputs = CASE WHEN ? THEN ? ELSE outputs END,
         error = COALESCE(?, error)
       WHERE job_id = ?`,
      next.status,
      next.conclusion,
      next.cancelReason,
      next.status,
      now,
      next.status,
      now,
      completed ? 1 : 0,
      now,
      taskEnd,
      log,
      extra.outputs !== undefined ? 1 : 0,
      extra.outputs ?? null,
      extra.error ?? null,
      row.job_id,
    );
    if ((row.status === "queued") !== (next.status === "queued")) this.bumpQueue();
    const updated = this.instance(row.job_id) as InstanceRow;
    this.publishCheck(updated);
    if (completed) {
      if (updated.group_key !== null) this.endScope(jobScope(updated.attempt, updated.job_id));
      this.#failFast(updated);
      this.wake();
    }
    this.ensureDeadlines();
    this.#touch();
    return true;
  }

  /** The queued set changed: the dispatch index must catch up. */
  bumpQueue(): void {
    this.exec("UPDATE runs SET queue_rev = queue_rev + 1 WHERE id = 1");
    this.#ensure("ci_dispatch", RUN_JOB.dispatch);
  }

  #failFast(row: InstanceRow): void {
    const node = this.node(row.attempt, row.job_key);
    if (!node || node.fail_fast === 0) return;
    const siblings = this.instances(row.attempt, row.job_key);
    const index = siblings.findIndex((s) => s.job_id === row.job_id);
    for (const victim of failFastVictims(
      siblings.map((s) => this.#stateOf(s)),
      index,
      node.fail_fast !== 0,
    )) {
      const target = siblings[victim];
      if (target) this.applyInstance(target, { kind: "cancel", reason: "fail_fast" });
    }
  }

  /** Inserts an instance row and returns it. */
  insertInstance(input: {
    attempt: number;
    jobKey: string;
    idx: number;
    total: number;
    name: string;
    instance: string | null;
    status: InstanceStatus;
    conclusion: InstanceConclusion | null;
    continueOnError: boolean;
    timeoutMs: number;
    error?: string | null;
  }): InstanceRow {
    this.exec("UPDATE runs SET job_seq = job_seq + 1 WHERE id = 1");
    const jobId = (this.run() as RunRow).job_seq;
    const now = this.host.now();
    this.exec(
      `INSERT INTO run_instances (job_id, attempt, job_key, idx, total, name, name_key, instance,
         status, conclusion, continue_on_error, timeout_ms, completed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      jobId,
      input.attempt,
      input.jobKey,
      input.idx,
      input.total,
      input.name,
      checkNameKey(input.name),
      input.instance,
      input.status,
      input.conclusion,
      input.continueOnError ? 1 : 0,
      input.timeoutMs,
      input.status === "completed" ? now : null,
      input.error ?? null,
    );
    return this.instance(jobId) as InstanceRow;
  }

  // ---------------------------------------------------------------- checks

  /**
   * Records the check `row` should show now. One check per name per
   * attempt: a second instance whose name folds equal publishes nothing.
   */
  publishCheck(row: InstanceRow): void {
    const check = instanceCheck(this.#stateOf(row));
    if (!check) return;
    const desired = check.status === "completed" ? (check.conclusion as string) : check.status;
    const [existing] = this.rows<{ job_id: number; desired: string }>(
      "SELECT job_id, desired FROM run_checks WHERE attempt = ? AND name_key = ?",
      row.attempt,
      row.name_key,
    );
    if (existing && existing.job_id !== row.job_id) {
      if (row.check_code === null)
        this.exec(
          "UPDATE run_instances SET check_code = 'duplicate_check' WHERE job_id = ?",
          row.job_id,
        );
      return;
    }
    if (existing?.desired === desired) return;
    const run = this.run() as RunRow;
    if (existing)
      this.exec(
        "UPDATE run_checks SET desired = ?, rev = rev + 1 WHERE attempt = ? AND name_key = ?",
        desired,
        row.attempt,
        row.name_key,
      );
    else
      this.exec(
        `INSERT INTO run_checks (attempt, name_key, name, start_key, job_id, desired, rev)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        row.attempt,
        row.name_key,
        row.name,
        `${run.run_id}/a${row.attempt}/j${row.job_id}`,
        row.job_id,
        desired,
      );
    this.#ensure("run_checks", RUN_JOB.checks, this.host.policy.checkFlushMs);
  }

  /**
   * At the end of attempt `n` (a re-run): a name an earlier attempt published
   * as failing that this attempt did not produce is settled `cancelled`
   * under this attempt, guarded so another run's newer check stays.
   */
  #settleObsoleteChecks(n: number): void {
    if (n <= 1) return;
    const run = this.run() as RunRow;
    const previous = this.rows<{
      name_key: string;
      name: string;
      start_key: string;
      job_id: number;
      desired: string;
    }>(
      `SELECT c.name_key, c.name, c.start_key, c.job_id, c.desired FROM run_checks c
       WHERE c.attempt < ? AND c.parked IS NULL
         AND c.attempt = (SELECT max(attempt) FROM run_checks d
                          WHERE d.name_key = c.name_key AND d.attempt < ?)
         AND NOT EXISTS (SELECT 1 FROM run_checks e WHERE e.attempt = ? AND e.name_key = c.name_key)`,
      n,
      n,
      n,
    );
    let added = false;
    for (const row of previous) {
      if (!isFailing(row.desired as CheckConclusion)) continue;
      this.exec(
        `INSERT INTO run_checks (attempt, name_key, name, start_key, job_id, supersedes, desired, rev)
         VALUES (?, ?, ?, ?, ?, ?, 'cancelled', 1)`,
        n,
        row.name_key,
        row.name,
        `${run.run_id}/a${n}/x${row.job_id}`,
        row.job_id,
        row.start_key,
      );
      added = true;
    }
    if (added) this.#ensure("run_checks", RUN_JOB.checks, this.host.policy.checkFlushMs);
  }

  // ---------------------------------------------------------------- scheduling

  #contexts(): { github: unknown; inputs: unknown; vars: unknown } {
    return JSON.parse((this.run() as RunRow).contexts);
  }

  /** The `needs` context of job `jobKey`: each direct need's result and its merged outputs. */
  #needsContext(attempt: number, jobKey: string): ExprValue {
    const model = this.host.model();
    const entries: [string, ReturnType<typeof exprObject>][] = [];
    for (const need of model.plan.graph.job(jobKey)?.needs ?? []) {
      const node = this.node(attempt, need);
      if (!node) continue;
      entries.push([
        need,
        exprObject([
          ["result", nodeOutcome(node) ?? "skipped"],
          ["outputs", outputsExpr(this.mergedOutputs(attempt, need))],
        ]),
      ]);
    }
    return exprObject(entries);
  }

  /** A job's outputs over its instances in completion order; an empty value never overrides. */
  mergedOutputs(attempt: number, jobKey: string): Record<string, string> {
    // A map, then fromEntries: an output named `__proto__` stays an own key (an assignment
    // would hit the prototype setter), and the object still crosses RPC (a null prototype would not).
    const merged = new Map<string, string>();
    for (const row of this.rows<{ outputs: string | null }>(
      `SELECT outputs FROM run_instances WHERE attempt = ? AND job_key = ? AND outputs IS NOT NULL
       ORDER BY completed_at, job_id`,
      attempt,
      jobKey,
    ))
      for (const [key, value] of Object.entries(
        JSON.parse(row.outputs as string) as Record<string, string>,
      ))
        if (value !== "") merged.set(key, value);
    return Object.fromEntries(merged);
  }

  scopeFor(attempt: number, jobKey: string): ExpressionScope {
    const contexts = this.#contexts();
    return {
      github: exprFromJson(contexts.github),
      inputs: exprFromJson(contexts.inputs),
      vars: exprFromJson(contexts.vars),
      needs: this.#needsContext(attempt, jobKey),
    };
  }

  /** Whether job `jobKey`'s `if:` holds now (`cancelled` as the attempt says); an error is false. */
  conditionHolds(
    attempt: AttemptRow,
    jobKey: string,
    budget: WorkBudget = newWorkBudget(),
  ): { ok: boolean; holds: boolean; error?: string } {
    const model = this.host.model();
    const ancestors = model.plan.graph
      .ancestors(jobKey)
      .map((id) => nodeOutcome(this.node(attempt.attempt, id) as NodeRow) ?? "skipped");
    const result = evaluateJobCondition(
      model.fields.get(`jobs.${jobKey}.if`),
      this.scopeFor(attempt.attempt, jobKey),
      { cancelled: attempt.cancel !== "none", ancestors },
      budget,
    );
    if (!result.ok) return { ok: false, holds: false, error: result.error.message };
    return { ok: true, holds: result.value };
  }

  /** A node decided without running: one completed instance carries its check. */
  #concludeNode(
    attempt: number,
    jobKey: string,
    status: "skipped" | "failed" | "cancelled",
    error: string | null,
  ): void {
    // The node now holds one instance (the row below), not what the plan reserved for it, so
    // the rest of its reservation goes back to the attempt for later jobs to expand into.
    const reserved = this.node(attempt, jobKey)?.reserved ?? 1;
    this.exec(
      "UPDATE run_nodes SET status = ?, error = ?, reserved = 1 WHERE attempt = ? AND job_key = ?",
      status,
      error,
      attempt,
      jobKey,
    );
    this.exec(
      "UPDATE run_attempts SET used_instances = used_instances - ? WHERE attempt = ?",
      reserved - 1,
      attempt,
    );
    const conclusion: InstanceConclusion =
      status === "failed" ? "failure" : status === "skipped" ? "skipped" : "cancelled";
    const row = this.insertInstance({
      attempt,
      jobKey,
      idx: 0,
      total: 1,
      // Stored with the node: a cancel must not need the workflow to parse again.
      name: this.node(attempt, jobKey)?.name ?? jobKey,
      instance: null,
      status: "completed",
      conclusion,
      continueOnError: false,
      timeoutMs: 0,
      error,
    });
    this.publishCheck(row);
  }

  /**
   * One scheduling step: decide ready nodes (their `if:`, then expansion),
   * queue what max-parallel allows, complete nodes and the attempt. Returns
   * whether more nodes were ready than one step decides.
   */
  step(): { more: boolean } {
    const current = this.current();
    if (current?.attempt.status !== "in_progress") return { more: false };
    const n = current.attempt.attempt;
    // Rows alone settle nodes, and an attempt that is finished or force-cancelled (whose waiting
    // nodes the cancel concluded): ending it must not need the workflow to load again.
    this.#completeNodes(n);
    if (current.attempt.cancel === "force") {
      this.#completeAttempt(n);
      return { more: false };
    }
    const model = this.host.model();
    const order = model.plan.graph.order.map((job) => job.id);
    const statusOf = (id: string) => (this.node(n, id) as NodeRow).status;
    let nodesLeft = this.host.policy.nodesPerStep;
    let work = 0;
    // A decision can make more nodes ready (a skipped job's dependents), so decide until none
    // is, or the step's node count or expression work is spent (then it ends its invocation).
    for (;;) {
      this.#completeNodes(n);
      const ready = readyNodes(order, (id) => model.plan.graph.job(id)?.needs ?? [], statusOf);
      if (ready.length === 0) break;
      for (const jobKey of ready) {
        if (nodesLeft <= 0 || work >= this.host.policy.stepWork) return { more: true };
        work += this.#decide(this.attempt(n) as AttemptRow, jobKey);
        nodesLeft--;
      }
    }
    for (const node of this.nodes(n)) if (node.status === "running") this.#promote(node);
    this.#completeNodes(n);
    this.#completeAttempt(n);
    return { more: false };
  }

  /** Decides one ready node with one expression budget for its `if:` and expansion; returns the work spent. */
  #decide(attempt: AttemptRow, jobKey: string): number {
    const budget = newWorkBudget();
    this.#decideWithin(attempt, jobKey, budget);
    return budget.spent;
  }

  #decideWithin(attempt: AttemptRow, jobKey: string, budget: WorkBudget): void {
    const n = attempt.attempt;
    if (attempt.cancel === "force") {
      this.#concludeNode(n, jobKey, "cancelled", null);
      return;
    }
    const condition = this.conditionHolds(attempt, jobKey, budget);
    if (!condition.ok) {
      this.#concludeNode(n, jobKey, "failed", condition.error ?? null);
      return;
    }
    if (!condition.holds) {
      this.#concludeNode(n, jobKey, unreadyNodeStatus(attempt.cancel), null);
      return;
    }
    const model = this.host.model();
    const node = this.node(n, jobKey) as NodeRow;
    const plan = model.plan.jobs.get(jobKey);
    const expanded = expandJob(model.workflow, jobKey, this.scopeFor(n, jobKey), {
      remainingRunJobs: MAX_RUN_JOBS - attempt.used_instances + node.reserved,
      invariantPayloadBytes: plan?.invariantPayloadBytes ?? 0,
      budget,
    });
    if (!expanded.ok) {
      this.#concludeNode(n, jobKey, "failed", expanded.errors.map((e) => e.message).join("\n"));
      return;
    }
    const job = expanded.job;
    this.exec(
      `UPDATE run_nodes SET status = 'running', fail_fast = ?, max_parallel = ?, declares = ?
       WHERE attempt = ? AND job_key = ?`,
      job.failFast ? 1 : 0,
      job.maxParallel ?? null,
      JSON.stringify(job.declares),
      n,
      jobKey,
    );
    this.exec(
      "UPDATE run_attempts SET used_instances = used_instances + ? WHERE attempt = ?",
      job.instances.length - node.reserved,
      n,
    );
    const rows = job.instances.map((instance) =>
      this.insertInstance({
        attempt: n,
        jobKey,
        idx: instance.index,
        total: instance.total,
        name: instance.name,
        instance: encodeInstance(instance),
        status: "blocked",
        conclusion: null,
        continueOnError: instance.continueOnError,
        timeoutMs:
          Math.min(instance.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES) * MIN,
      }),
    );
    const concurrency = model.workflow.jobs.find((j) => j.id.value === jobKey)?.concurrency;
    if (!concurrency) return;
    // Every instance exists before any is failed, so fail-fast reaches all its siblings.
    const scope = this.scopeFor(n, jobKey);
    job.instances.forEach((instance, i) => {
      const inserted = rows[i] as InstanceRow;
      const row = this.instance(inserted.job_id) as InstanceRow;
      if (row.status === "completed") return; // cancelled by a sibling's failure
      // Job-level groups read matrix and strategy, so each instance has its own.
      const instanceScope: ExpressionScope = {
        ...scope,
        matrix: exprObject([...(instance.matrix ?? new Map())]),
        strategy: strategyContext(
          job.failFast,
          instance.index,
          instance.total,
          instance.matrix !== null,
          job.maxParallel,
        ),
      };
      const group = this.#evaluateGroup(
        `jobs.${jobKey}.concurrency`,
        concurrency,
        instanceScope,
        budget,
      );
      if (!group.ok) {
        this.applyInstance(row, { kind: "fail" }, { error: group.error });
        return;
      }
      const attempt = this.attempt(n) as AttemptRow;
      if (attempt.group_key !== null && attempt.group_key === concurrencyGroupKey(group.name)) {
        this.applyInstance(
          row,
          { kind: "fail" },
          {
            error: `concurrency_deadlock: job concurrency group "${group.name}" is the workflow's own group, which this run holds while the job waits for it`,
          },
        );
        return;
      }
      this.exec(
        "UPDATE run_instances SET group_key = ?, group_name = ?, group_cancel = ? WHERE job_id = ?",
        concurrencyGroupKey(group.name),
        group.name,
        group.cancel ? 1 : 0,
        row.job_id,
      );
      this.addScope(jobScope(n, row.job_id), group.name, group.cancel);
    });
  }

  /** Queues the node's blocked instances that max-parallel allows (a cancelling one keeps its slot). */
  #promote(node: NodeRow): void {
    // Only instances whose groups are held compete for slots; live ones still count against them.
    const candidates = this.instances(node.attempt, node.job_key).filter(
      (row) => row.status !== "blocked" || this.instanceReady(row),
    );
    const states = candidates.map((row) => this.#stateOf(row));
    for (const index of promotable(states, node.max_parallel ?? undefined)) {
      const target = candidates[index];
      if (target) this.applyInstance(target, { kind: "queue" });
    }
  }

  #completeNodes(attempt: number): void {
    for (const node of this.nodes(attempt)) {
      if (node.status !== "running") continue;
      const siblings = this.instances(attempt, node.job_key);
      if (siblings.length === 0 || siblings.some((s) => s.status !== "completed")) continue;
      this.exec(
        "UPDATE run_nodes SET status = 'done', result = ? WHERE attempt = ? AND job_key = ?",
        nodeResultOf(siblings.map((s) => this.#stateOf(s))),
        attempt,
        node.job_key,
      );
    }
  }

  #completeAttempt(n: number): void {
    const nodes = this.nodes(n);
    const outcomes = nodes.map((node) => nodeOutcome(node));
    if (outcomes.some((o) => o === undefined)) return;
    const attempt = this.attempt(n) as AttemptRow;
    this.advanceAttempt(attempt, {
      kind: "finished",
      conclusion: attemptConclusion(attempt.cancel, outcomes as NeedResult[]),
    });
  }

  #onAttemptCompleted(n: number): void {
    this.endScope(workflowScope(n));
    for (const row of this.rows<{ owner_key: string }>(
      "SELECT owner_key FROM run_owners WHERE owner_key LIKE ? AND state <> 'ended'",
      `${workflowScope(n)}/%`,
    ))
      this.endScope(row.owner_key);
    this.#settleObsoleteChecks(n);
    this.#ensure("run_checks", RUN_JOB.checks, this.host.policy.checkFlushMs);
    this.#ensure("run_sweep", RUN_JOB.sweep, this.host.policy.sweepMs);
  }

  // ---------------------------------------------------------------- cancellation

  /** Cancels the current attempt; false when it already completed. */
  cancel(by: string, mode: "graceful" | "force"): boolean {
    const current = this.current();
    if (!current || current.attempt.status === "completed") return false;
    const n = current.attempt.attempt;
    const started = current.attempt.status === "in_progress";
    this.exec(
      "UPDATE run_attempts SET cancelled_by = COALESCE(cancelled_by, ?) WHERE attempt = ?",
      by,
      n,
    );
    this.advanceAttempt(current.attempt, { kind: "cancel", mode });
    if (!started) return true;
    const attempt = this.attempt(n) as AttemptRow;
    if (attempt.cancel === "force") {
      for (const row of this.instances(n))
        if (row.status !== "completed") this.applyInstance(row, { kind: "force_cancel" });
      for (const node of this.nodes(n))
        if (node.status === "waiting") this.#concludeNode(n, node.job_key, "cancelled", null);
    } else {
      // GitHub's algorithm: running jobs whose `if:` still holds with cancelled() keep running.
      for (const node of this.nodes(n)) {
        if (node.status !== "running") continue;
        let holds = false;
        try {
          const condition = this.conditionHolds(attempt, node.job_key);
          holds = condition.ok && condition.holds;
        } catch {
          // The workflow no longer loads: nothing can keep running on its conditions.
        }
        if (holds) continue;
        for (const row of this.instances(n, node.job_key))
          if (row.status !== "completed")
            this.applyInstance(row, { kind: "cancel", reason: "cancel" });
      }
    }
    this.wake();
    return true;
  }

  // ---------------------------------------------------------------- concurrency scopes

  owner(key: string): OwnerRow | undefined {
    return this.rows<OwnerRow>("SELECT * FROM run_owners WHERE owner_key = ?", key)[0];
  }

  /** A scope that will ask for `group`: the next concurrency slice requests it. */
  addScope(key: string, group: string, cancelInProgress: boolean): void {
    this.exec(
      `INSERT OR IGNORE INTO run_owners (owner_key, group_key, group_name, state, cancel_in_progress)
       VALUES (?, ?, ?, 'admitting', ?)`,
      key,
      concurrencyGroupKey(group),
      group,
      cancelInProgress ? 1 : 0,
    );
    this.#ensure("run_concurrency", RUN_JOB.concurrency);
  }

  /** The scope's work is over: whatever it holds or asked for is given back. */
  endScope(key: string): void {
    const owner = this.owner(key);
    if (!owner || owner.state === "ended" || owner.state === "releasing") return;
    this.exec("UPDATE run_owners SET state = 'releasing' WHERE owner_key = ?", key);
    this.#ensure("run_concurrency", RUN_JOB.concurrency);
  }

  /** Whether `key` owns its group with a grant still valid here. */
  scopeValid(key: string): boolean {
    const owner = this.owner(key);
    return (
      owner?.state === "owner" &&
      owner.lease_valid_until !== null &&
      owner.lease_valid_until > this.host.now()
    );
  }

  /** Whether an instance may be queued or assigned: every group it needs is held with a valid grant. */
  instanceReady(row: InstanceRow): boolean {
    const attempt = this.attempt(row.attempt);
    if (attempt?.group_key && !this.scopeValid(workflowScope(row.attempt))) return false;
    if (row.group_key !== null && !this.scopeValid(jobScope(row.attempt, row.job_id))) return false;
    return true;
  }

  /** The longest a scope may still need: its unfinished instances' timeouts, plus grace. */
  holdFor(key: string): number {
    const now = this.host.now();
    const [, attemptText, jobText] = /^a(\d+)(?:\/j(\d+))?$/.exec(key) ?? [];
    const rows = jobText
      ? [this.instance(Number(jobText))].filter((r): r is InstanceRow => r !== undefined)
      : this.instances(Number(attemptText));
    let longest = rows.length === 0 ? DEFAULT_TIMEOUT_MINUTES * MIN : 0;
    for (const row of rows) {
      if (row.status === "completed") continue;
      const left =
        row.started_at === null
          ? row.timeout_ms
          : Math.max(0, row.started_at + row.timeout_ms - now);
      longest = Math.max(longest, left);
    }
    return Math.min(longest, MAX_TIMEOUT_MINUTES * MIN) + HOLD_GRACE_MS;
  }

  #evaluateGroup(
    path: string,
    concurrency: { group: { value: string }; cancelInProgress?: { kind: string; value?: unknown } },
    scope: ExpressionScope,
    budget: WorkBudget,
  ): { ok: true; name: string; cancel: boolean } | { ok: false; error: string } {
    const model = this.host.model();
    let name = concurrency.group.value;
    const groupField = model.fields.get(`${path}.group`);
    if (groupField) {
      const value = evaluateField(groupField, scope, budget);
      if (!value.ok) return { ok: false, error: value.error.message };
      name = toExprString(value.value);
    }
    if (name.length === 0)
      return { ok: false, error: "concurrency_group: the concurrency group is empty" };
    if (name.length > MAX_CONCURRENCY_GROUP_LENGTH)
      return {
        ok: false,
        error: `concurrency_group: a concurrency group holds at most ${MAX_CONCURRENCY_GROUP_LENGTH} characters`,
      };
    let cancel = false;
    const cancelValue = concurrency.cancelInProgress;
    if (cancelValue?.kind === "literal") cancel = cancelValue.value === true;
    else if (cancelValue) {
      const field = model.fields.get(`${path}.cancel-in-progress`);
      if (field) {
        const value = evaluateField(field, scope, budget);
        if (!value.ok) return { ok: false, error: value.error.message };
        cancel = isTruthy(value.value);
      }
    }
    return { ok: true, name, cancel };
  }

  /**
   * Starts an attempt: at once when its workflow has no concurrency group;
   * otherwise its group is requested first and the attempt waits (queued, then
   * pending) until it owns the group.
   */
  admitOrQueue(attempt: AttemptRow): void {
    const model = this.host.model();
    const concurrency = model.workflow.concurrency;
    if (!concurrency) {
      this.advanceAttempt(attempt, { kind: "admitted" });
      this.wake();
      return;
    }
    const contexts = this.#contexts();
    const group = this.#evaluateGroup(
      "concurrency",
      concurrency,
      {
        github: exprFromJson(contexts.github),
        inputs: exprFromJson(contexts.inputs),
        vars: exprFromJson(contexts.vars),
      },
      newWorkBudget(),
    );
    if (!group.ok) {
      this.exec(
        "UPDATE run_attempts SET errors = ? WHERE attempt = ?",
        JSON.stringify([group.error]),
        attempt.attempt,
      );
      this.advanceAttempt(attempt, { kind: "plan_failed" });
      return;
    }
    this.exec(
      "UPDATE run_attempts SET group_key = ?, group_name = ?, cancel_in_progress = ? WHERE attempt = ?",
      concurrencyGroupKey(group.name),
      group.name,
      group.cancel ? 1 : 0,
      attempt.attempt,
    );
    this.addScope(workflowScope(attempt.attempt), group.name, group.cancel);
  }

  // ---------------------------------------------------------------- deadlines

  /** When `row` next has a deadline, and the event it brings. */
  deadlineOf(row: InstanceRow): { at: number; event: InstanceEvent } | undefined {
    const p = this.host.policy;
    switch (row.status) {
      case "queued":
        return { at: (row.queued_at ?? 0) + p.queueTimeoutMs, event: { kind: "queue_expired" } };
      case "in_progress": {
        const timeout = (row.started_at ?? 0) + row.timeout_ms;
        const lost = (row.heartbeat_at ?? row.started_at ?? 0) + p.heartbeatTimeoutMs;
        return timeout <= lost
          ? { at: timeout, event: { kind: "cancel", reason: "timeout" } }
          : { at: lost, event: { kind: "heartbeat_lost" } };
      }
      case "cancelling": {
        const grace = (row.cancel_at ?? 0) + p.cancelGraceMs;
        const lost = (row.heartbeat_at ?? row.started_at ?? 0) + p.heartbeatTimeoutMs;
        return grace <= lost
          ? { at: grace, event: { kind: "grace_expired" } }
          : { at: lost, event: { kind: "heartbeat_lost" } };
      }
      default:
        return undefined;
    }
  }

  /** Schedules the deadlines job at the earliest deadline, if any. */
  ensureDeadlines(): void {
    let earliest: number | undefined;
    for (const row of this.liveInstances()) {
      const due = this.deadlineOf(row);
      if (due && (earliest === undefined || due.at < earliest)) earliest = due.at;
    }
    if (earliest !== undefined)
      this.host.jobs.ensure("run_deadlines", RUN_JOB.deadlines, { runAt: earliest });
  }

  /** Applies every deadline due now; returns when the next one falls, if any. */
  applyDeadlines(): number | undefined {
    const now = this.host.now();
    for (const row of this.liveInstances()) {
      const due = this.deadlineOf(row);
      if (due && due.at <= now) this.applyInstance(row, due.event);
    }
    let next: number | undefined;
    for (const row of this.liveInstances()) {
      const due = this.deadlineOf(row);
      if (due && (next === undefined || due.at < next)) next = due.at;
    }
    return next;
  }

  // ---------------------------------------------------------------- outputs

  /** The outputs to store for a completed task, or why they are refused. */
  acceptOutputs(
    attempt: AttemptRow,
    outputs: unknown,
  ): { ok: true; text: string | null; bytes: number } | { ok: false; error: string } {
    if (outputs === undefined || outputs === null) return { ok: true, text: null, bytes: 0 };
    if (
      typeof outputs !== "object" ||
      Array.isArray(outputs) ||
      Object.values(outputs).some((v) => typeof v !== "string")
    )
      return { ok: false, error: "outputs_invalid: job outputs must be strings" };
    const text = JSON.stringify(outputs);
    const bytes = utf8.encode(text).length;
    const p = this.host.policy;
    if (bytes > p.maxInstanceOutputBytes)
      return {
        ok: false,
        error: `outputs_too_large: a job's outputs hold at most ${p.maxInstanceOutputBytes} bytes; these are ${bytes}`,
      };
    if (attempt.output_bytes + bytes > p.maxAttemptOutputBytes)
      return {
        ok: false,
        error: `outputs_too_large: a run attempt's outputs hold at most ${p.maxAttemptOutputBytes} bytes`,
      };
    return { ok: true, text, bytes };
  }

  // ---------------------------------------------------------------- reads used by tasks

  stateOf(row: InstanceRow): InstanceState {
    return this.#stateOf(row);
  }

  decode(row: InstanceRow) {
    return row.instance ? decodeInstance(row.instance) : undefined;
  }

  /** A runner result as the domain names it. */
  static isRunnerResult(value: unknown): value is RunnerResult {
    return (
      value === "success" || value === "failure" || value === "cancelled" || value === "skipped"
    );
  }
}
