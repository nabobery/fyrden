import {
  createDoMemoryBudget,
  type GitStorageContext,
  type Job,
  type JobHandler,
  type JobKind,
  JobQueue,
} from "@fyrden/adapters-cloudflare/git";
import { createLogger, createMetrics, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { MAX_CHECK_BATCH } from "@fyrden/domain";
import {
  type InstanceConclusion,
  jobPayload,
  type NeedResult,
  nodeOutcome,
  type RunnerResult,
  toPayloadInstance,
} from "@fyrden/domain/ci";
import { jobPolicy } from "../invocation-calls.js";
import { MigratingDO } from "./base/MigratingDO.js";
import type { RepoDO } from "./RepoDO.js";
import type { CheckStart, CheckUpdate } from "./repo/checks.js";
import { REPO_DELETED } from "./repo/events.js";
import {
  type AttemptRow,
  type InstanceRow,
  MAX_RUN_ATTEMPTS,
  type NodeRow,
  type OwnerRow,
  RUN_DEFAULTS,
  RUN_JOB,
  RunEngine,
  type RunPolicy,
  type RunRow,
} from "./run/engine.js";
import { loadModel, type RunModel } from "./run/model.js";

/** A scope's grant is trusted until this long before the repository said it ends. Proposed. */
const LEASE_MARGIN_MS = 60_000;
/** How often an owner renews its grant and a pending scope reads its receipt. Proposed. */
const RENEW_EVERY_MS = 3 * 60_000;

import { type RunSpec, specDigest, validateRunSpec } from "./run/spec.js";
import { runSchema } from "./schema/run.js";

/** How long one alarm runs job slices. */
const ALARM_BUDGET_MS = 5_000;

/** A task as the runner protocol names it: the instance and its task number in this run. */
export interface TaskRef {
  readonly jobId: number;
  readonly task: number;
}

export interface RunView {
  readonly runId: string;
  readonly repoId: string;
  readonly sha: string;
  readonly ref: string;
  readonly event: string;
  readonly workflowPath: string;
  /** The original trigger: the execution authority on every attempt. */
  readonly actor: string;
  readonly attempt: number;
  readonly status: AttemptRow["status"];
  readonly conclusion: AttemptRow["conclusion"];
  readonly cancel: AttemptRow["cancel"];
  /** Who started the current attempt. */
  readonly triggeringActor: string;
  readonly errors: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  /** Background work that exhausted its attempts and is still being retried. */
  readonly faults: readonly { kind: string; error: string; since: number; count: number }[];
}

export interface JobView {
  readonly jobId: number;
  readonly attempt: number;
  readonly jobKey: string;
  readonly name: string;
  readonly status: InstanceRow["status"];
  readonly conclusion: InstanceConclusion | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly check: { readonly state: string | null; readonly code: string | null };
  readonly logComplete: boolean | null;
  readonly error: string | null;
}

export type CreateAnswer =
  | { readonly ok: true; readonly created: boolean; readonly run: RunView }
  | { readonly ok: false; readonly code: "run_exists" | "run_erased" };

export type AssignAnswer =
  | {
      readonly ok: true;
      readonly task: TaskRef;
      readonly payload: Uint8Array;
      readonly needs: Record<string, { result: NeedResult; outputs: Record<string, string> }>;
      readonly attempt: number;
      readonly repoId: string;
      /** The run's original actor: the job token's principal, kept across re-runs. */
      readonly actorId: string;
      /** Who started this attempt, for audit. */
      readonly triggeringActorId: string;
      readonly github: unknown;
      readonly timeoutMinutes: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | "not_queued"
        | "unknown_job"
        | "run_cancelled"
        | "task_finished"
        | "run_not_found";
    };

export type TaskAnswer<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly code: "task_finished" | "unknown_task" | "run_not_found" };

/** Pause or fail points around each call to the repository, for tests. */
export interface RunHooks {
  beforeRepoCall?: (op: string) => Promise<void> | void;
  afterRepoCall?: (op: string) => Promise<void> | void;
}

/**
 * What the repository answers once it is deleted: a refused change, or any call at all while
 * it erases itself (a deletion is never undone, so neither answer is transient).
 */
const repoGone = (message: string): boolean =>
  /^repo_not_found\b/.test(message) || message === REPO_DELETED;

/**
 * One CI run: its attempts, job graph, job instances and their checks,
 * driven by alarms through the job queue. Keyed by the run id. The trigger
 * creates it through `startRun`; the runner protocol assigns and reports
 * tasks; the repository's operations read, cancel and re-run it.
 */
export class RunDO extends MigratingDO {
  static readonly schema = runSchema;

  /** Timings and budgets. Tests may replace them. */
  policy: RunPolicy = RUN_DEFAULTS;
  /** Pause points for tests. */
  hooks: RunHooks = {};

  readonly context: GitStorageContext;
  readonly jobs: JobQueue;
  readonly engine: RunEngine;
  readonly #memory = createDoMemoryBudget(16 * 1024 * 1024);
  readonly #log = createLogger({ do: "RunDO" });
  #model: { source: string; model: RunModel } | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.context = {
      storage: ctx.storage,
      now: () => Date.now(),
      metrics: createMetrics(env.METRICS),
      doClass: "RunDO",
    };
    this.jobs = new JobQueue(
      this.context,
      (at) => {
        void ctx.storage.setAlarm(at);
      },
      jobPolicy(env),
    );
    const host = this;
    this.engine = new RunEngine({
      storage: ctx.storage,
      jobs: this.jobs,
      get policy() {
        return host.policy;
      },
      now: () => host.context.now(),
      model: () => host.#loadModel(),
    });
  }

  #loadModel(): RunModel {
    const run = this.engine.run();
    if (!run) throw new Error("no run");
    if (this.#model?.source !== run.workflow_source) {
      const loaded = loadModel(run.workflow_path, run.workflow_source);
      if (!loaded.ok) throw new Error("the run's workflow no longer plans");
      this.#model = { source: run.workflow_source, model: loaded.model };
    }
    return this.#model.model;
  }

  #erased(): boolean {
    return this.engine.rows("SELECT 1 FROM run_erasure WHERE id = 1").length > 0;
  }

  #tx<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(fn);
  }

  // ------------------------------------------------------------------ creation

  /** Creates the run from `spec`; the same spec again returns it, another is refused. */
  async create(spec: RunSpec): Promise<CreateAnswer> {
    const contexts = validateRunSpec(spec);
    const digest = await specDigest(spec, contexts);
    return this.#tx((): CreateAnswer => {
      if (this.#erased()) return { ok: false, code: "run_erased" };
      const existing = this.engine.run();
      if (existing)
        return existing.spec_digest === digest
          ? { ok: true, created: false, run: this.#view() as RunView }
          : { ok: false, code: "run_exists" };
      const now = this.context.now();
      this.engine.exec(
        `INSERT INTO runs (id, run_id, repo_id, sha, ref, event, actor_id, workflow_path,
           workflow_source, contexts, spec_digest, attempt, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        spec.runId,
        spec.repoId,
        spec.sha,
        spec.ref,
        spec.event,
        spec.actor,
        spec.workflow.path,
        spec.workflow.source,
        contexts,
        digest,
        now,
        now,
      );
      const loaded = loadModel(spec.workflow.path, spec.workflow.source);
      this.engine.insertAttempt(1, spec.actor, loaded.ok ? loaded.model : undefined);
      const attempt = this.engine.attempt(1) as AttemptRow;
      if (!loaded.ok) {
        this.engine.exec(
          "UPDATE run_attempts SET errors = ? WHERE attempt = 1",
          JSON.stringify(loaded.errors.map((e) => e.message)),
        );
        this.engine.advanceAttempt(attempt, { kind: "plan_failed" });
      } else this.#admit(attempt);
      this.jobs.ensure("run_reconcile", RUN_JOB.reconcile, {
        runAt: now + this.policy.reconcileMs,
      });
      return { ok: true, created: true, run: this.#view() as RunView };
    });
  }

  /** Lets an attempt start, at once or once it owns its workflow's concurrency group. */
  #admit(attempt: AttemptRow): void {
    this.engine.admitOrQueue(attempt);
  }

  // ------------------------------------------------------------------ reads

  #view(): RunView | undefined {
    const current = this.engine.current();
    if (!current) return undefined;
    const { run, attempt } = current;
    const faults = this.engine.rows<{
      kind: string;
      error: string;
      first_at: number;
      count: number;
    }>(
      "SELECT kind, error, first_at, count FROM run_faults WHERE resolved_at IS NULL ORDER BY first_at",
    );
    return {
      runId: run.run_id,
      repoId: run.repo_id,
      sha: run.sha,
      ref: run.ref,
      event: run.event,
      workflowPath: run.workflow_path,
      actor: run.actor_id,
      attempt: attempt.attempt,
      status: attempt.status,
      conclusion: attempt.conclusion,
      cancel: attempt.cancel,
      triggeringActor: attempt.triggering_actor_id,
      errors: attempt.errors ? (JSON.parse(attempt.errors) as string[]) : [],
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
      faults: faults.map((f) => ({
        kind: f.kind,
        error: f.error,
        since: f.first_at,
        count: f.count,
      })),
    };
  }

  /** The run as its current attempt stands; undefined when there is none (or it was erased). */
  get(): RunView | undefined {
    return this.#erased() ? undefined : this.#view();
  }

  /** A page of an attempt's jobs (the current one by default), by job id after `after`. */
  listJobs(
    attempt?: number,
    after = 0,
    limit = 100,
  ): { jobs: JobView[]; next: number | null } | undefined {
    if (this.#erased()) return undefined;
    const run = this.engine.run();
    if (!run) return undefined;
    const n = attempt ?? run.attempt;
    const rows = this.engine.rows<
      InstanceRow & { check_desired: string | null; parked: string | null }
    >(
      `SELECT i.*, c.desired AS check_desired, c.parked AS parked FROM run_instances i
       LEFT JOIN run_checks c ON c.attempt = i.attempt AND c.job_id = i.job_id
       WHERE i.attempt = ? AND i.job_id > ? ORDER BY i.job_id LIMIT ?`,
      n,
      after,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      jobs: page.map((row) => ({
        jobId: row.job_id,
        attempt: row.attempt,
        jobKey: row.job_key,
        name: row.name,
        status: row.status,
        conclusion: row.conclusion,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        check: { state: row.check_desired, code: row.parked ?? row.check_code },
        logComplete: row.log_complete === null ? null : row.log_complete === 1,
        error: row.error,
      })),
      next: rows.length > limit ? (page.at(-1) as InstanceRow).job_id : null,
    };
  }

  // ------------------------------------------------------------------ cancel and re-run

  cancel(
    by: string,
    mode: "graceful" | "force",
  ): { ok: true } | { ok: false; code: "run_not_found" | "run_not_cancellable" } {
    return this.#tx(() => {
      if (this.#erased() || !this.engine.run()) return { ok: false, code: "run_not_found" };
      return this.engine.cancel(by, mode)
        ? { ok: true }
        : { ok: false, code: "run_not_cancellable" };
    });
  }

  rerun(
    by: string,
  ):
    | { ok: true; attempt: number }
    | { ok: false; code: "run_not_found" | "run_not_completed" | "rerun_limit" } {
    return this.#tx(() => {
      if (this.#erased()) return { ok: false, code: "run_not_found" };
      const current = this.engine.current();
      if (!current) return { ok: false, code: "run_not_found" };
      if (current.attempt.status !== "completed") return { ok: false, code: "run_not_completed" };
      if (current.attempt.errors) return { ok: false, code: "run_not_completed" };
      const n = current.attempt.attempt + 1;
      if (n > MAX_RUN_ATTEMPTS) return { ok: false, code: "rerun_limit" };
      this.engine.exec(
        "UPDATE runs SET attempt = ?, updated_at = ? WHERE id = 1",
        n,
        this.context.now(),
      );
      this.engine.insertAttempt(n, by, this.#loadModel());
      this.#admit(this.engine.attempt(n) as AttemptRow);
      return { ok: true, attempt: n };
    });
  }

  // ------------------------------------------------------------------ the runner's calls

  /** Instances waiting for a runner, oldest first. */
  queued(
    limit = 100,
  ): { jobId: number; attempt: number; name: string; runsOn: string[]; queuedAt: number }[] {
    if (this.#erased()) return [];
    return this.engine
      .rows<InstanceRow>(
        "SELECT * FROM run_instances WHERE status = 'queued' ORDER BY queued_at, job_id LIMIT ?",
        Math.min(limit, 256),
      )
      .map((row) => ({
        jobId: row.job_id,
        attempt: row.attempt,
        name: row.name,
        runsOn: [...(this.engine.decode(row)?.runsOn ?? [])],
        queuedAt: row.queued_at as number,
      }));
  }

  /**
   * Hands a queued instance to a runner. The same key while its task lives
   * gets the same answer and writes nothing; after it completed, `task_finished`.
   */
  assign(jobId: number, assignKey: string): AssignAnswer {
    return this.#tx((): AssignAnswer => {
      if (this.#erased()) return { ok: false, code: "run_not_found" };
      const current = this.engine.current();
      let row = this.engine.instance(jobId);
      if (!current || !row) return { ok: false, code: "unknown_job" };
      if (row.assign_key !== null && row.assign_key === assignKey) {
        if (row.status === "completed") return { ok: false, code: "task_finished" };
        return this.#assignment(current.run, row);
      }
      if (current.attempt.cancel === "force" && row.attempt === current.attempt.attempt)
        return { ok: false, code: "run_cancelled" };
      if (row.status !== "queued") return { ok: false, code: "not_queued" };
      // Nothing starts on a concurrency grant this object cannot vouch for.
      if (!this.engine.instanceReady(row)) return { ok: false, code: "not_queued" };
      this.engine.exec("UPDATE runs SET task_seq = task_seq + 1 WHERE id = 1");
      const task = (this.engine.run() as RunRow).task_seq;
      const now = this.context.now();
      this.engine.exec(
        "UPDATE run_instances SET task = ?, assign_key = ?, started_at = ?, heartbeat_at = ? WHERE job_id = ?",
        task,
        assignKey,
        now,
        now,
        jobId,
      );
      row = this.engine.instance(jobId) as InstanceRow;
      this.engine.applyInstance(row, { kind: "assign" });
      return this.#assignment(current.run, this.engine.instance(jobId) as InstanceRow);
    });
  }

  #assignment(run: RunRow, row: InstanceRow): AssignAnswer {
    const model = this.#loadModel();
    const node = this.engine.node(row.attempt, row.job_key) as NodeRow;
    const instance = this.engine.decode(row);
    if (!instance) return { ok: false, code: "not_queued" };
    const declares = node.declares
      ? (JSON.parse(node.declares) as { strategy: boolean; continueOnError: boolean })
      : { strategy: false, continueOnError: false };
    const payload = jobPayload(
      model.workflow,
      row.job_key,
      toPayloadInstance(
        {
          jobId: row.job_key,
          failFast: node.fail_fast !== 0,
          ...(node.max_parallel === null ? {} : { maxParallel: node.max_parallel }),
          declares,
          instances: [instance],
        },
        instance,
      ),
    );
    const needs: Record<string, { result: NeedResult; outputs: Record<string, string> }> = {};
    for (const need of model.plan.graph.job(row.job_key)?.needs ?? []) {
      const needNode = this.engine.node(row.attempt, need);
      needs[need] = {
        result: (needNode && nodeOutcome(needNode)) ?? "skipped",
        outputs: this.engine.mergedOutputs(row.attempt, need),
      };
    }
    const attempt = this.engine.attempt(row.attempt) as AttemptRow;
    return {
      ok: true,
      task: { jobId: row.job_id, task: row.task as number },
      payload,
      needs,
      attempt: row.attempt,
      repoId: run.repo_id,
      actorId: run.actor_id,
      triggeringActorId: attempt.triggering_actor_id,
      github: JSON.parse(run.contexts).github,
      timeoutMinutes: Math.round(row.timeout_ms / 60_000),
    };
  }

  #task(
    ref: TaskRef,
  ): { row: InstanceRow } | { code: "task_finished" | "unknown_task" | "run_not_found" } {
    if (this.#erased()) return { code: "run_not_found" };
    const row = this.engine.instance(ref.jobId);
    if (!row || row.task === null || row.task !== ref.task) return { code: "unknown_task" };
    return { row };
  }

  /** Read only: whether the task's instance is in progress or cancelling. */
  taskLive(ref: TaskRef): boolean {
    const found = this.#task(ref);
    return (
      "row" in found && (found.row.status === "in_progress" || found.row.status === "cancelling")
    );
  }

  /** A heartbeat; `cancel` tells the runner to stop. */
  updateTask(ref: TaskRef): TaskAnswer<{ cancel: boolean }> {
    return this.#tx((): TaskAnswer<{ cancel: boolean }> => {
      const found = this.#task(ref);
      if (!("row" in found)) return { ok: false, code: found.code };
      const { row } = found;
      if (row.status === "completed") return { ok: false, code: "task_finished" };
      const now = this.context.now();
      // Heartbeats come every few seconds; writing each would cost a row each.
      if ((row.heartbeat_at ?? 0) + this.policy.heartbeatWriteMs <= now) {
        this.engine.exec(
          "UPDATE run_instances SET heartbeat_at = ? WHERE job_id = ?",
          now,
          row.job_id,
        );
        this.engine.ensureDeadlines();
      }
      return { ok: true, cancel: row.status === "cancelling" };
    });
  }

  /** The runner's final result. A task that is not current is refused: the fence after cancel and re-run. */
  completeTask(
    ref: TaskRef,
    report: { result: RunnerResult; outputs?: Record<string, string>; logComplete: boolean },
  ): TaskAnswer<{ conclusion: InstanceConclusion }> {
    return this.#tx((): TaskAnswer<{ conclusion: InstanceConclusion }> => {
      const found = this.#task(ref);
      if (!("row" in found)) return { ok: false, code: found.code };
      const { row } = found;
      if (row.status === "completed") return { ok: false, code: "task_finished" };
      if (!RunEngine.isRunnerResult(report.result)) throw new TypeError("invalid runner result");
      const attempt = this.engine.attempt(row.attempt) as AttemptRow;
      const accepted = this.engine.acceptOutputs(attempt, report.outputs);
      if (accepted.ok && accepted.bytes > 0) {
        this.engine.exec(
          "UPDATE run_attempts SET output_bytes = output_bytes + ? WHERE attempt = ?",
          accepted.bytes,
          row.attempt,
        );
        this.engine.exec(
          "UPDATE run_nodes SET output_bytes = output_bytes + ? WHERE attempt = ? AND job_key = ?",
          accepted.bytes,
          row.attempt,
          row.job_key,
        );
      }
      this.engine.applyInstance(
        row,
        { kind: "complete", result: accepted.ok ? report.result : "failure" },
        {
          outputs: accepted.ok ? accepted.text : null,
          error: accepted.ok ? null : accepted.error,
          logComplete: report.logComplete,
        },
      );
      const done = this.engine.instance(row.job_id) as InstanceRow;
      return { ok: true, conclusion: done.conclusion as InstanceConclusion };
    });
  }

  /** The log layer gave up on a task's rows; never undoes `markLogComplete`. */
  markLogIncomplete(ref: TaskRef): void {
    this.#tx(() => {
      const found = this.#task(ref);
      if ("row" in found && found.row.log_complete !== 1)
        this.engine.exec(
          "UPDATE run_instances SET log_complete = 0 WHERE job_id = ?",
          found.row.job_id,
        );
    });
  }

  /** Every row of a task is durable (also after completion); final. */
  markLogComplete(ref: TaskRef): void {
    this.#tx(() => {
      const found = this.#task(ref);
      if ("row" in found)
        this.engine.exec(
          "UPDATE run_instances SET log_complete = 1 WHERE job_id = ?",
          found.row.job_id,
        );
    });
  }

  // ------------------------------------------------------------------ concurrency

  /**
   * A hint from the repository that a scope's receipt changed. It only wakes
   * the concurrency slice, which acts through fenced calls.
   */
  concurrencySignal(signal: {
    ownerKey: string;
    group: string;
    kind: string;
    generation: number;
  }): void {
    this.#tx(() => {
      if (this.#erased() || !this.engine.owner(signal.ownerKey)) return;
      this.engine.exec(
        "UPDATE run_owners SET renew_at = ? WHERE owner_key = ? AND state IN ('pending', 'owner')",
        this.context.now(),
        signal.ownerKey,
      );
      this.jobs.ensure("run_concurrency", RUN_JOB.concurrency);
    });
  }

  /**
   * One concurrency step: request new scopes, read pending ones, renew owned
   * ones and give finished ones back, each kind in one repository call, and
   * record every answer (for a scope no longer wanted too, then released).
   */
  async #concurrencySlice(
    job: Job,
  ): Promise<{ done: true } | { done: false; cursor: null; runAfterMs: number }> {
    const run = this.engine.run();
    if (!run) return { done: true };
    const owners = this.engine.rows<OwnerRow>("SELECT * FROM run_owners WHERE state <> 'ended'");
    if (owners.length === 0) return { done: true };
    const now = this.context.now();
    // A job's group is asked for only while its attempt's workflow grant is valid here: asking
    // can cancel another owner (cancel-in-progress), which this run may not do on a lapsed grant.
    const admitting = owners.filter(
      (o) => o.state === "admitting" && this.#mayRequest(o.owner_key),
    );
    const pending = owners.filter((o) => o.state === "pending" && (o.renew_at ?? 0) <= now);
    const renewing = owners.filter((o) => o.state === "owner" && (o.renew_at ?? 0) <= now);
    const releasing = owners.filter((o) => o.state === "releasing");
    if (admitting.length > 0) {
      const sentAt = this.context.now();
      const answers = await this.#repoCall("acquireConcurrency", (repo) =>
        repo.acquireConcurrency(
          admitting.map((o) => ({
            group: o.group_name,
            runId: run.run_id,
            ownerKey: o.owner_key,
            cancelInProgress: o.cancel_in_progress === 1,
            holdMs: this.engine.holdFor(o.owner_key),
          })),
        ),
      );
      this.#current(job, () => {
        admitting.forEach((o, i) => {
          this.#receive(o.owner_key, answers[i] ?? null, sentAt);
        });
      });
    }
    if (pending.length > 0) {
      const sentAt = this.context.now();
      const answers = await this.#repoCall("concurrencyStatus", (repo) =>
        repo.concurrencyStatus(
          pending.map((o) => ({ group: o.group_name, runId: run.run_id, ownerKey: o.owner_key })),
        ),
      );
      this.#current(job, () => {
        pending.forEach((o, i) => {
          this.#receive(o.owner_key, answers[i] ?? null, sentAt);
        });
      });
    }
    if (renewing.length > 0) {
      const sentAt = this.context.now();
      const answers = await this.#repoCall("renewConcurrency", (repo) =>
        repo.renewConcurrency(
          run.run_id,
          renewing.map((o) => ({
            group: o.group_name,
            ownerKey: o.owner_key,
            generation: o.generation as number,
            holdMs: this.engine.holdFor(o.owner_key),
          })),
        ),
      );
      this.#current(job, () =>
        renewing.forEach((o, i) => {
          const answer = answers[i];
          if (!answer) return;
          if (answer.ok)
            this.#receive(
              o.owner_key,
              {
                outcome: "owner",
                generation: o.generation,
                leaseRemainingMs: answer.leaseRemainingMs,
                cancelRequested: answer.cancelRequested,
              },
              sentAt,
            );
          else
            this.#receive(
              o.owner_key,
              answer.receipt ?? {
                outcome: "evicted",
                generation: o.generation,
                leaseRemainingMs: null,
                cancelRequested: false,
              },
              sentAt,
            );
        }),
      );
    }
    if (releasing.length > 0) {
      await this.#repoCall("releaseConcurrency", (repo) =>
        repo.releaseConcurrency(
          releasing.map((o) => ({
            group: o.group_name,
            runId: run.run_id,
            ownerKey: o.owner_key,
            ...(o.generation === null ? {} : { generation: o.generation }),
          })),
        ),
      );
      this.#current(job, () => {
        for (const o of releasing)
          this.engine.exec(
            "UPDATE run_owners SET state = 'ended', outcome = 'released' WHERE owner_key = ? AND state = 'releasing'",
            o.owner_key,
          );
      });
    }
    const left = this.engine.rows<OwnerRow>("SELECT * FROM run_owners WHERE state <> 'ended'");
    if (left.length === 0) return { done: true };
    if (
      left.some(
        (o) =>
          o.state === "releasing" || (o.state === "admitting" && this.#mayRequest(o.owner_key)),
      )
    )
      return { done: false, cursor: null, runAfterMs: 0 };
    const next = Math.min(
      ...left.filter((o) => o.state !== "admitting").map((o) => o.renew_at ?? now),
      now + RENEW_EVERY_MS,
    );
    return { done: false, cursor: null, runAfterMs: Math.max(0, next - this.context.now()) };
  }

  /** A job scope may be requested only while its attempt's workflow grant (if any) is valid. */
  #mayRequest(key: string): boolean {
    const [, attemptText, jobText] = /^a(\d+)(?:\/j(\d+))?$/.exec(key) ?? [];
    if (!jobText) return true;
    const attempt = this.engine.attempt(Number(attemptText));
    return !attempt?.group_key || this.engine.scopeValid(`a${attemptText}`);
  }

  /** Records a scope's receipt and what follows from it. */
  #receive(
    key: string,
    receipt: {
      outcome: string;
      generation: number | null;
      leaseRemainingMs: number | null;
      cancelRequested: boolean;
    } | null,
    sentAt: number,
  ): void {
    const owner = this.engine.owner(key);
    if (!owner || owner.state === "ended" || !receipt) return;
    const now = this.context.now();
    const wanted = owner.state !== "releasing";
    const workflow = !key.includes("/");
    const attemptNumber = Number(/^a(\d+)/.exec(key)?.[1]);
    const attempt = this.engine.attempt(attemptNumber);
    switch (receipt.outcome) {
      case "owner": {
        const valid =
          receipt.leaseRemainingMs === null
            ? null
            : sentAt + receipt.leaseRemainingMs - LEASE_MARGIN_MS;
        this.engine.exec(
          `UPDATE run_owners SET state = ?, outcome = 'owner', generation = ?, lease_valid_until = ?,
             renew_at = ? WHERE owner_key = ?`,
          wanted ? "owner" : "releasing",
          receipt.generation,
          valid,
          now + RENEW_EVERY_MS,
          key,
        );
        if (!wanted) break;
        const unstarted = attempt && (attempt.status === "queued" || attempt.status === "pending");
        if (workflow && unstarted && receipt.cancelRequested) {
          // Promoted and cancelled in one answer: it never started, so it ends, and gives back
          // the grant it holds (recorded above, released by the completion).
          this.engine.cancel("concurrency", "graceful");
          break;
        }
        if (workflow && attempt && unstarted)
          this.engine.advanceAttempt(attempt, { kind: "admitted" });
        if (receipt.cancelRequested) this.#cancelScope(key, "cancel");
        this.engine.wake();
        break;
      }
      case "pending":
        this.engine.exec(
          "UPDATE run_owners SET state = ?, outcome = 'pending', renew_at = ? WHERE owner_key = ?",
          wanted ? "pending" : "releasing",
          now + RENEW_EVERY_MS,
          key,
        );
        if (wanted && workflow && attempt?.status === "queued")
          this.engine.advanceAttempt(attempt, { kind: "pending" });
        break;
      case "displaced":
      case "evicted":
        this.engine.exec(
          "UPDATE run_owners SET state = 'ended', outcome = ? WHERE owner_key = ?",
          receipt.outcome,
          key,
        );
        if (wanted) this.#cancelScope(key, receipt.outcome === "evicted" ? "evicted" : "displaced");
        break;
      default:
        this.engine.exec(
          "UPDATE run_owners SET state = 'ended', outcome = ? WHERE owner_key = ?",
          receipt.outcome,
          key,
        );
    }
  }

  /**
   * Cancels what a scope covers: a workflow scope its attempt (graceful on a
   * cancel request; an attempt that never started ends; an evicted one is
   * forced), a job scope its instance.
   */
  #cancelScope(key: string, reason: "cancel" | "displaced" | "evicted"): void {
    const [, attemptText, jobText] = /^a(\d+)(?:\/j(\d+))?$/.exec(key) ?? [];
    if (jobText) {
      const row = this.engine.instance(Number(jobText));
      if (!row || row.status === "completed") return;
      this.engine.applyInstance(
        row,
        reason === "evicted" ? { kind: "force_cancel" } : { kind: "cancel", reason },
      );
      return;
    }
    const attempt = this.engine.attempt(Number(attemptText));
    if (!attempt || attempt.status === "completed") return;
    if (reason === "displaced" && attempt.status !== "in_progress")
      this.engine.advanceAttempt(attempt, { kind: "displaced" });
    else if (attempt.attempt === this.engine.run()?.attempt)
      this.engine.cancel("concurrency", reason === "evicted" ? "force" : "graceful");
  }

  // ------------------------------------------------------------------ erasure

  /**
   * Erases the run: a tombstone and the removal of every row in one
   * transaction, so nothing can recreate its data. Repeating it succeeds.
   */
  async erase(): Promise<void> {
    this.#tx(() => {
      if (this.#erased()) return;
      for (const table of [
        "runs",
        "run_attempts",
        "run_nodes",
        "run_instances",
        "run_checks",
        "run_owners",
        "run_faults",
        "jobs",
      ])
        this.engine.exec(`DELETE FROM ${table}`);
      this.engine.exec("INSERT INTO run_erasure (id, erased_at) VALUES (1, ?)", this.context.now());
    });
    this.#model = undefined;
    await this.ctx.storage.deleteAlarm();
  }

  // ------------------------------------------------------------------ background work

  async #repoCall<T>(
    op: string,
    call: (repo: DurableObjectStub<RepoDO>) => Promise<T>,
  ): Promise<T> {
    const run = this.engine.run();
    if (!run) throw new Error("no run");
    await this.hooks.beforeRepoCall?.(op);
    const result = await call(this.env.REPO.getByName(run.repo_id));
    await this.hooks.afterRepoCall?.(op);
    return result;
  }

  /**
   * The repository is gone for good: the run is erased (its tasks then answer
   * `run_not_found`), needing nothing else to succeed first.
   */
  async #repositoryGone(): Promise<void> {
    await this.erase();
  }

  /** Records a fault on the attempt that exhausts a job, and clears its faults when it succeeds. */
  #marked(kind: JobKind, handler: JobHandler): JobHandler {
    return {
      runSlice: async (job: Job) => {
        try {
          const result = await handler.runSlice(job);
          this.#current(job, () =>
            this.engine.exec(
              "UPDATE run_faults SET resolved_at = ? WHERE kind = ? AND job_id = ? AND resolved_at IS NULL",
              this.context.now(),
              kind,
              job.jobId,
            ),
          );
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (repoGone(message)) {
            await this.#repositoryGone();
            return { done: true };
          }
          if (job.attempts + 1 >= jobPolicy(this.env).maxAttempts)
            this.#current(job, () => {
              const now = this.context.now();
              this.engine.exec(
                `INSERT INTO run_faults (kind, job_id, error, first_at, last_at, count)
                 VALUES (?, ?, ?, ?, ?, 1)
                 ON CONFLICT (kind, job_id) DO UPDATE SET error = excluded.error,
                   last_at = excluded.last_at, count = count + 1, resolved_at = NULL`,
                kind,
                job.jobId,
                message.slice(0, 1000),
                now,
                now,
              );
              this.jobs.ensure("run_sweep", RUN_JOB.sweep, { runAt: now + this.policy.sweepMs });
              this.#log.warn("run job exhausted its attempts", { kind, error: message });
            });
          throw error;
        }
      },
    };
  }

  /**
   * Writes `fn` only while the run exists and `job`'s slice still holds its
   * claim: a slice that was taken over, or whose run was erased while it
   * awaited, writes nothing.
   */
  #current(job: Job, fn: () => void): void {
    this.#tx(() => {
      if (!this.#erased() && this.jobs.checkpoint(job, job.cursor ?? new Uint8Array())) fn();
    });
  }

  #handlers(): Partial<Record<JobKind, JobHandler>> {
    const handlers: Partial<Record<JobKind, JobHandler>> = {
      run_advance: {
        runSlice: async () => {
          const { more } = this.#tx(() => this.engine.step());
          return more ? { done: false, cursor: null, endInvocation: true } : { done: true };
        },
      },
      run_deadlines: {
        runSlice: async () => {
          const next = this.#tx(() => this.engine.applyDeadlines());
          return next === undefined
            ? { done: true }
            : { done: false, cursor: null, runAfterMs: Math.max(0, next - this.context.now()) };
        },
      },
      run_checks: { runSlice: (job) => this.#flushChecks(job) },
      run_sweep: { runSlice: async () => this.#sweep() },
      run_concurrency: { runSlice: (job) => this.#concurrencySlice(job) },
      // The runner protocol's slices; until they exist there is nothing to sync or revoke.
      ci_dispatch: {
        runSlice: async (job) => {
          this.#tx(() => {
            if (this.jobs.checkpoint(job, new Uint8Array()))
              this.engine.exec("UPDATE runs SET queue_synced_rev = queue_rev WHERE id = 1");
          });
          return { done: true };
        },
      },
      ci_task_end: {
        runSlice: async (job) => {
          this.#tx(() => {
            if (this.jobs.checkpoint(job, new Uint8Array()))
              this.engine.exec("UPDATE runs SET task_end_acked = task_end_seq WHERE id = 1");
          });
          return { done: true };
        },
      },
    };
    for (const [kind, handler] of Object.entries(handlers) as [JobKind, JobHandler][])
      handlers[kind] = this.#marked(kind, handler);
    // Never exhausts, so never marked: nothing else would visit a finished run again.
    handlers.run_reconcile = { runSlice: () => this.#reconcile() };
    return handlers;
  }

  /**
   * Sends the check outbox to the repository: at most one batch of starts
   * and one of updates, each acknowledged only up to the revision it sent.
   */
  async #flushChecks(
    job: Job,
  ): Promise<{ done: true } | { done: false; cursor: null; runAfterMs: number }> {
    const run = this.engine.run();
    if (!run) return { done: true };
    type Dirty = {
      attempt: number;
      name_key: string;
      name: string;
      start_key: string;
      job_id: number;
      supersedes: string | null;
      check_attempt: number | null;
      desired: string;
      rev: number;
      triggering_actor_id: string;
    };
    const dirty = this.engine.rows<Dirty>(
      // One row per name per flush, the oldest attempt first: a re-run's start of a name must
      // follow the earlier attempt's, or the repository refuses the pair as one duplicate call.
      `SELECT c.*, a.triggering_actor_id FROM run_checks c JOIN run_attempts a ON a.attempt = c.attempt
       WHERE c.parked IS NULL AND c.sent_rev < c.rev
         AND c.attempt = (SELECT min(d.attempt) FROM run_checks d
                          WHERE d.name_key = c.name_key AND d.parked IS NULL AND d.sent_rev < d.rev)
       ORDER BY c.attempt, c.name_key LIMIT ?`,
      MAX_CHECK_BATCH,
    );
    if (dirty.length === 0) return { done: true };
    const guarded = (write: () => void) => this.#current(job, write);
    const unstarted = dirty.filter((d) => d.check_attempt === null);
    const attempts = new Map<string, number>();
    if (unstarted.length > 0) {
      const items: CheckStart[] = unstarted.map((d) => ({
        name: d.name,
        startKey: d.start_key,
        actor: d.triggering_actor_id,
        ...(d.supersedes ? { supersedes: d.supersedes } : {}),
      }));
      const answers = await this.#repoCall("startCheckAttempts", (repo) =>
        repo.startCheckAttempts(run.sha, items),
      );
      guarded(() =>
        unstarted.forEach((d, i) => {
          const answer = answers[i];
          if (!answer) return;
          if (answer.ok && answer.current) {
            attempts.set(`${d.attempt}:${d.name_key}`, answer.attempt);
            this.engine.exec(
              "UPDATE run_checks SET check_attempt = ? WHERE attempt = ? AND name_key = ?",
              answer.attempt,
              d.attempt,
              d.name_key,
            );
          } else {
            const code = answer.ok ? "superseded" : answer.code;
            this.engine.exec(
              "UPDATE run_checks SET parked = ? WHERE attempt = ? AND name_key = ? AND rev = ?",
              code,
              d.attempt,
              d.name_key,
              d.rev,
            );
            this.engine.exec(
              "UPDATE run_instances SET check_code = ? WHERE job_id = ? AND attempt = ?",
              code,
              d.job_id,
              d.attempt,
            );
          }
        }),
      );
    }
    const updatable = dirty
      .map((d) => ({
        ...d,
        check_attempt: d.check_attempt ?? attempts.get(`${d.attempt}:${d.name_key}`) ?? null,
      }))
      .filter((d): d is Dirty & { check_attempt: number } => d.check_attempt !== null);
    if (updatable.length > 0) {
      const updates: CheckUpdate[] = updatable.map((d) => {
        const live = d.desired === "queued" || d.desired === "in_progress";
        return {
          sha: run.sha,
          name: d.name,
          attempt: d.check_attempt,
          status: live ? (d.desired as "queued" | "in_progress") : "completed",
          conclusion: live ? null : (d.desired as NonNullable<CheckUpdate["conclusion"]>),
        };
      });
      const results = await this.#repoCall("recordCheckUpdates", (repo) =>
        repo.recordCheckUpdates(updates),
      );
      guarded(() =>
        updatable.forEach((d, i) => {
          const result = results[i];
          if (result === "applied" || result === "unchanged")
            this.engine.exec(
              "UPDATE run_checks SET sent_rev = max(sent_rev, ?) WHERE attempt = ? AND name_key = ?",
              d.rev,
              d.attempt,
              d.name_key,
            );
          else if (result) {
            const code = result === "stale_attempt" ? "superseded" : result;
            // A refusal of a state that has moved on answers obsolete state: the row stays dirty.
            this.engine.exec(
              "UPDATE run_checks SET parked = ? WHERE attempt = ? AND name_key = ? AND rev = ?",
              code,
              d.attempt,
              d.name_key,
              d.rev,
            );
            if (code !== "superseded")
              this.#log.warn("check update refused", { code, check: d.name });
          }
        }),
      );
    }
    const left = this.engine.rows(
      "SELECT 1 FROM run_checks WHERE parked IS NULL AND sent_rev < rev LIMIT 1",
    );
    return left.length > 0
      ? { done: false, cursor: null, runAfterMs: this.policy.checkFlushMs }
      : { done: true };
  }

  /**
   * Writes the run's record into its repository again. Erasing the repository finds runs only
   * by that record, and a restore of the repository from before the run started drops it, so
   * every run checks weekly for as long as it exists. A deleted repository erases the run; any
   * other refusal or failure is retried at the sweep's interval and never ends the job.
   */
  async #reconcile(): Promise<{ done: true } | { done: false; cursor: null; runAfterMs: number }> {
    const run = this.engine.run();
    if (!run) return { done: true };
    let gone: boolean;
    let ok = false;
    try {
      // The RPC stub's type of a union answer is not assignable to the union; it is the union.
      const answer = await this.#repoCall(
        "registerRun",
        (repo) =>
          repo.registerRun({
            runId: run.run_id,
            sha: run.sha,
            path: run.workflow_path,
          }) as unknown as ReturnType<RepoDO["registerRun"]>,
      );
      ok = answer.ok;
      gone = !answer.ok && answer.code === "repo_not_found";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      gone = repoGone(message);
      if (!gone) this.#log.warn("run record not written", { error: message });
    }
    if (gone) {
      await this.#repositoryGone();
      return { done: true };
    }
    return {
      done: false,
      cursor: null,
      runAfterMs: ok ? this.policy.reconcileMs : this.policy.sweepMs,
    };
  }

  /** Retries exhausted jobs while anything is owed; ends when nothing is. */
  #sweep(): { done: true } | { done: false; cursor: null; runAfterMs: number } {
    const faults = this.engine.rows<{ kind: JobKind; job_id: string }>(
      "SELECT kind, job_id FROM run_faults WHERE resolved_at IS NULL",
    );
    for (const fault of faults) this.jobs.ensure(fault.kind, fault.job_id);
    if (this.#owed() || faults.length > 0)
      return { done: false, cursor: null, runAfterMs: this.policy.sweepMs };
    return { done: true };
  }

  /** Whether the run still owes work outside the object: checks unsent, scopes to give back, hooks behind. */
  #owed(): boolean {
    const run = this.engine.run();
    if (!run) return false;
    const checks = this.engine.rows(
      "SELECT 1 FROM run_checks WHERE parked IS NULL AND sent_rev < rev LIMIT 1",
    );
    if (checks.length > 0) {
      this.jobs.ensure("run_checks", RUN_JOB.checks);
      return true;
    }
    if (run.queue_synced_rev < run.queue_rev) {
      this.jobs.ensure("ci_dispatch", RUN_JOB.dispatch);
      return true;
    }
    const scopes = this.engine.rows(
      "SELECT 1 FROM run_owners WHERE state IN ('admitting', 'releasing') LIMIT 1",
    );
    if (scopes.length > 0) {
      this.jobs.ensure("run_concurrency", RUN_JOB.concurrency);
      return true;
    }
    if (run.task_end_acked < run.task_end_seq) {
      this.jobs.ensure("ci_task_end", RUN_JOB.taskEnd);
      return true;
    }
    return false;
  }

  override async alarm(): Promise<void> {
    if (this.#erased()) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await measureInvocation(
      this.context.metrics,
      { where: "do", op: "alarm", doClass: "RunDO" },
      () => this.jobs.runDue(this.#handlers(), this.#memory, this.context.now() + ALARM_BUDGET_MS),
    );
  }
}
