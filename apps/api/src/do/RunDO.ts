import {
  createDoMemoryBudget,
  type GitStorageContext,
  type Job,
  type JobHandler,
  type JobKind,
  JobQueue,
  type SliceResult,
} from "@fyrden/adapters-cloudflare/git";
import {
  countSubrequests,
  createLogger,
  createMetrics,
  measureInvocation,
} from "@fyrden/adapters-cloudflare/obs";
import { checkNameKey, MAX_CHECK_BATCH } from "@fyrden/domain";
import {
  type AttemptConclusion,
  effectiveScope,
  type InstanceConclusion,
  type JobAction,
  type JobsTold,
  jobMoves,
  jobOrder,
  jobPayload,
  jobsDoneTo,
  labelsFreeOfOutputs,
  MAX_RUN_TITLE_LENGTH,
  type NeedResult,
  nodeOutcome,
  type RunFacts,
  type RunnerResult,
  runFacts,
  runPhase,
  runStateSeq,
  type SecretMaskOffer,
  type SecretReferences,
  type Step,
  secretReferences,
  shown,
  type TokenScope,
  toPayloadInstance,
} from "@fyrden/domain/ci";
import { jobPolicy } from "../invocation-calls.js";
import { MigratingDO } from "./base/MigratingDO.js";
import type { RepoDO } from "./RepoDO.js";
import type { CheckStart, CheckUpdate } from "./repo/checks.js";
import { REPO_DELETED } from "./repo/events.js";
import {
  type AttemptEnd,
  type JobReport,
  MAX_JOB_LABELS,
  MAX_JOB_REPORTS,
  type RunReport,
} from "./repo/run-history.js";
import { planCheckKey } from "./run/check-key.js";
import { decodeInstance } from "./run/codec.js";
import {
  type AssignTaskAnswer,
  DISPATCH_RESYNC_MS,
  type DispatchHooks,
  type ReportTaskAnswer,
  RunDispatch,
} from "./run/dispatch.js";
import {
  type AttemptRow,
  DEFAULT_TIMEOUT_MINUTES,
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
import { type LogPageAnswer, type LogPageQuery, LogPages } from "./run/log-pages.js";
import {
  type AppendLogAnswer,
  LOG_LATE_MS,
  type LogHooks,
  type MaskSource,
  NO_MASK_SOURCE,
  RunLogs,
  type SecretMasksAnswer,
} from "./run/logs.js";
import { MASK_CACHE_BYTES } from "./run/mask-cache.js";
import { loadModel, type RunModel } from "./run/model.js";
import {
  type ReservationHooks,
  type ReservationView,
  RunReservations,
  runCiPolicy,
  type WaitingFor,
} from "./run/reservations.js";
import { runRetentionMs } from "./run/retention.js";
import { type JobStep, jobSteps } from "./run/steps.js";
import { StoredLogs } from "./run/stored-logs.js";
import { LogViewers, type StoreTicketAnswer } from "./run/viewers.js";

/** A scope's grant is trusted until this long before the repository said it ends. Proposed. */
const LEASE_MARGIN_MS = 60_000;
/** How often an owner renews its grant and a pending scope reads its receipt. Proposed. */
const RENEW_EVERY_MS = 3 * 60_000;

/** A stored variables snapshot as a task's map of strings (a value of another type, never stored, as its JSON). */
function stringValues(vars: unknown): Record<string, string> {
  if (vars === null || typeof vars !== "object" || Array.isArray(vars)) return {};
  return Object.fromEntries(
    Object.entries(vars).map(([name, value]) => [
      name,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
}

import { APPROVAL_EXPIRY_MS, approvalBinding } from "../ci/approval.js";
import { ciEnv } from "../ci/budget.js";
import { chargeLogReads } from "../ci/log-reads.js";
import { workflowFileCheckName } from "./run/plan-check.js";
import {
  isPrincipalId,
  MAX_RUN_CONTEXTS_BYTES,
  type RunSpec,
  specDigest,
  validateRunSpec,
} from "./run/spec.js";
import { runSchema } from "./schema/run.js";

/** The secret names a task's job token fills, as references fold them. */
const JOB_TOKEN_NAMES: ReadonlySet<string> = new Set(["GITHUB_TOKEN", "GITEA_TOKEN"]);

/** How long one alarm runs job slices. */
const ALARM_BUDGET_MS = 5_000;

/** A task as the runner protocol names it: the instance and its task number in this run. */
export interface TaskRef {
  readonly jobId: number;
  readonly task: number;
}

export interface RunView extends RunFacts {
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
  /** Whether the run's code is trusted (from its trigger). */
  readonly trust: "trusted" | "untrusted";
  /** Whether the run is a fork job (its pull request's head is in another repository). */
  readonly fork: boolean;
  /** Why the workflow could not run, when it could not. */
  readonly errors: readonly RunError[];
  /** The maintainer's approval the run waits for, or got; null for a run that needs none. */
  readonly approval: {
    readonly state: ApprovalRow["state"];
    readonly decidedBy: string | null;
    readonly decidedAt: number | null;
  } | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  /** Background work that exhausted its attempts and is still being retried. */
  readonly faults: readonly { kind: string; error: string; since: number; count: number }[];
}

/** A held run's approval (`run_approval`). */
interface ApprovalRow {
  binding: string;
  state: "waiting" | "approved" | "cancelled" | "superseded" | "expired";
  decided_by: string | null;
  decided_at: number | null;
  expires_at: number;
  notified: number;
}

export type ApproveAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "not_waiting" | "approval_stale" | "run_not_found" };

/** One error of a workflow that could not run, as the parser and planner name it. */
export interface RunError {
  readonly code: string;
  readonly feature: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** Stored errors: objects, or (rows written before they were) messages alone. */
function storedErrors(text: string | null): RunError[] {
  if (!text) return [];
  return (JSON.parse(text) as (RunError | string)[]).map((e) =>
    typeof e === "string" ? { code: "", feature: "", path: "", line: 0, column: 0, message: e } : e,
  );
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
  readonly steps: readonly JobStep[];
  /** Why a queued job is not offered to runners yet: its CI minutes or the day's capacity; null otherwise. */
  readonly waitingFor: WaitingFor | null;
}

type JobRow = InstanceRow & {
  check_desired: string | null;
  parked: string | null;
  waiting_for: WaitingFor | null;
};

/** A job of the workflow in an attempt's graph. */
export interface GraphJob {
  readonly key: string;
  readonly name: string;
  readonly needs: readonly string[];
  readonly status: NodeRow["status"];
  /** As its dependents see it; null until it is terminal. */
  readonly outcome: NeedResult | null;
  /** The attempt's instances of this job, by id; none until its needs end. */
  readonly jobs: readonly GraphInstance[];
}

export type GraphInstance = Pick<
  JobView,
  "jobId" | "name" | "status" | "conclusion" | "startedAt" | "completedAt" | "error" | "waitingFor"
>;

export type CreateAnswer =
  | { readonly ok: true; readonly created: boolean; readonly run: RunView }
  | { readonly ok: false; readonly code: "run_exists" | "run_erased" };

export type ReserveAnswer =
  | { readonly ok: true }
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
      /**
       * The job token's scopes, from the immutable workflow and the run's trust: empty when the
       * job is granted none, and then it gets no token (an empty list on a token means its
       * principal's full rights).
       */
      readonly tokenScopes: readonly TokenScope[];
      /** The task's variables: the run's snapshot, none for an untrusted run. */
      readonly vars: Readonly<Record<string, string>>;
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

/** Pause or fail points around each call to the repository and in the runner protocol's work, for tests. */
export interface RunHooks extends DispatchHooks, LogHooks, ReservationHooks {
  beforeRepoCall?: (op: string) => Promise<void> | void;
  afterRepoCall?: (op: string) => Promise<void> | void;
  /** Before each call of an erased run's log purge (a throw fails that slice). */
  beforeLogPurgeCall?: () => Promise<void> | void;
}

/** R2 calls (a list and a delete per 1,000 chunks) one slice of an erased run's log purge makes at most. Proposed. */
export const LOG_PURGE_CALLS = 20;

const REPORTS_OWED = new Uint8Array([1]);

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
  /** Values to mask in job logs that are fetched rather than stored (none yet). */
  maskSource: MaskSource = NO_MASK_SOURCE;
  /** R2 calls one log-purge slice makes at most. Tests may lower it. */
  logPurgeCalls = LOG_PURGE_CALLS;
  /** The most the tasks' kept log-mask matchers may hold. Tests may lower it. */
  maskCacheBytes = MASK_CACHE_BYTES;

  readonly context: GitStorageContext;
  readonly jobs: JobQueue;
  readonly engine: RunEngine;
  readonly #dispatch: RunDispatch;
  readonly #logs: RunLogs;
  readonly #reservations: RunReservations;
  readonly storedLogs: StoredLogs;
  readonly #logPages: LogPages;
  readonly #steps = new Map<number, string>();
  /** The job logs' live sockets. */
  readonly viewers: LogViewers;
  /**
   * The object's memory pool (NetworkDO's size and a full-size log request's mask headroom,
   * proposed): job slices and log requests reserve from it.
   */
  readonly memory = createDoMemoryBudget(17 * 1024 * 1024);
  readonly #log = createLogger({ do: "RunDO" });
  #model: { source: string; model: RunModel } | undefined;
  /** The run's facts, read from its contexts once a wake-up. */
  #facts: { readonly runId: string; readonly facts: RunFacts } | undefined;
  /** The state the repository last took (`runStateSeq`); lost with the instance, which reports again. */
  #reported = 0;
  #jobsReported: JobsTold = { done: 0, live: {} };
  #repoEpoch: number | undefined;

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
    this.policy = {
      ...RUN_DEFAULTS,
      retentionMs: runRetentionMs(env, (message) => this.#log.warn(message)),
    };
    const host = this;
    this.engine = new RunEngine({
      storage: ctx.storage,
      jobs: this.jobs,
      get policy() {
        return host.policy;
      },
      now: () => host.context.now(),
      model: () => host.#loadModel(),
      logEnded: (task, completedAt) => host.#logs.taskEnded(task, completedAt),
      logComplete: (task) => host.#logs.complete(task),
      jobEnded: (jobId) => host.viewers.jobEnded(jobId),
      takeSteps: (task) => {
        const steps = host.#steps.get(task);
        host.#steps.delete(task);
        return steps;
      },
      maxJobMinutes: () => host.#ci().maxJobMinutes,
      reservationWanted: (jobId) => host.#reservations.want(jobId),
      reservationEnded: (jobId, at) => host.#reservations.end(jobId, at),
    });
    this.#reservations = new RunReservations({
      env,
      engine: this.engine,
      get hooks() {
        return host.hooks;
      },
      metrics: this.context.metrics,
      log: this.#log,
      get policy() {
        return host.policy;
      },
      now: () => host.context.now(),
      tx: (fn) => host.#tx(fn),
      guarded: (job, fn) => host.#current(job, fn),
      ci: () => host.#ci(),
      ensureSlice: (runAt) =>
        host.jobs.ensure("ci_reserve", RUN_JOB.reserve, runAt === undefined ? {} : { runAt }),
      ensureResync: () =>
        host.jobs.ensure("ci_dispatch", RUN_JOB.dispatch, {
          runAt: host.context.now() + DISPATCH_RESYNC_MS,
        }),
    });
    this.#dispatch = new RunDispatch({
      env,
      engine: this.engine,
      get hooks() {
        return host.hooks;
      },
      metrics: this.context.metrics,
      log: this.#log,
      now: () => host.context.now(),
      erased: () => host.#erased(),
      tx: (fn) => host.#tx(fn),
      guarded: (job, fn) => host.#current(job, fn),
      ensureDispatch: () => host.jobs.ensure("ci_dispatch", RUN_JOB.dispatch),
      queued: (limit, accountId) => host.queued(limit, accountId),
      ownedBy: (accountId) => host.#reservations.ownedBy(accountId),
      reservationsWaiting: () => host.#reservations.waiting(),
      assign: (jobId, key, accountId) => host.assign(jobId, key, accountId),
      taskLive: (ref) => host.taskLive(ref),
      updateTask: (ref, steps) => host.updateTask(ref, steps),
      completeTask: (ref, report) => host.completeTask(ref, report),
      logComplete: (task) => host.#logs.complete(task),
      addJobTokenMask: (task, token) => host.#logs.addMask(task, token),
      jobTokensFull: (task) => host.#logs.jobTokensFull(task),
      jobTokenMasksOpen: (task) => host.#logs.jobTokensOpen(task),
      secretsRequest: (jobId) => host.secretsRequest(jobId),
      addSecretMasks: (task, secrets) => host.#logs.addSecretMasks(task, secrets),
      ensureRecovery: (runAt) => host.jobs.ensure("ci_delivery", RUN_JOB.delivery, { runAt }),
      durable: () => ctx.storage.sync(),
      failTask: (ref, error) => host.failTask(ref, error),
      requeueTask: (ref) => host.requeueTask(ref),
      get memory() {
        return host.memory;
      },
      dropMaskCaches: () => host.#logs.dropMaskCaches(),
    });
    this.storedLogs = new StoredLogs({
      engine: this.engine,
      memory: this.memory,
      now: () => host.context.now(),
      dropViewerCaches: () => host.viewers.dropCaches(),
      dropMaskCaches: () => host.#logs.dropMaskCaches(),
    });
    this.viewers = new LogViewers({
      env,
      engine: this.engine,
      metrics: this.context.metrics,
      log: this.#log,
      memory: this.memory,
      now: () => host.context.now(),
      erased: () => host.#hidden(),
      tx: (fn) => host.#tx(fn),
      sockets: (tag) => ctx.getWebSockets(tag),
      accept: (ws, tags) => ctx.acceptWebSocket(ws, tags),
      ensureSlice: () => host.jobs.ensure("ci_log_viewers", RUN_JOB.logViewers),
      stored: this.storedLogs,
    });
    this.#logPages = new LogPages({
      env,
      engine: this.engine,
      metrics: this.context.metrics,
      log: this.#log,
      stored: this.storedLogs,
      hidden: () => host.#hidden(),
      uploadWaiting: () => host.viewers.uploadWaiting(),
      charge: async (chunks) => {
        try {
          host.context.metrics.count("d1.query", { db: "directory", op: "ci_log_reads" });
          return await chargeLogReads(ciEnv(env), env.DIRECTORY, chunks);
        } catch (error) {
          host.#log.error("a log page was not read: the directory did not answer", { error });
          return { status: "unavailable" };
        }
      },
    });
    // A viewer's keepalive, answered by the runtime without a message for the object to handle.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.#logs = new RunLogs({
      env,
      engine: this.engine,
      get hooks() {
        return host.hooks;
      },
      metrics: this.context.metrics,
      log: this.#log,
      memory: this.memory,
      get maskCacheBytes() {
        return host.maskCacheBytes;
      },
      now: () => host.context.now(),
      erased: () => host.#erased(),
      tx: (fn) => host.#tx(fn),
      confirm: (wireId, runnerId) => host.#dispatch.confirm(wireId, runnerId),
      updateTask: (ref) => host.updateTask(ref),
      markLogComplete: (ref) => host.markLogComplete(ref),
      ensureLogClose: (runAt) => host.jobs.ensure("ci_log_close", RUN_JOB.logClose, { runAt }),
      get masks() {
        return host.maskSource;
      },
      viewers: this.viewers,
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

  #written(jobKey: string): readonly Step[] {
    return this.#loadModel().workflow.jobs.find((j) => j.id.value === jobKey)?.steps ?? [];
  }

  /** The estimates of the tasks' kept log-mask matchers, in bytes (for tests). */
  maskCacheBytesHeld(): number {
    return this.#logs.maskCacheBytes();
  }

  #erased(): boolean {
    return this.engine.rows("SELECT 1 FROM run_erasure WHERE id = 1").length > 0;
  }

  /**
   * When the run's retention ends: `retentionMs` after its latest attempt
   * completed; undefined while that attempt has not. Derived, never stored,
   * so a re-run restarts it.
   */
  #expiresAt(): number | undefined {
    const [latest] = this.engine.rows<{ status: string; completed_at: number | null }>(
      "SELECT status, completed_at FROM run_attempts ORDER BY attempt DESC LIMIT 1",
    );
    if (latest?.status !== "completed" || latest.completed_at === null) return undefined;
    return latest.completed_at + this.policy.retentionMs;
  }

  /**
   * Whether the run's retention ended. Once its retirement began, it stays
   * ended whatever the retention becomes: the repository may have forgotten
   * the run already, so it must not run again.
   */
  #expired(): boolean {
    if (this.#retiring()) return true;
    const at = this.#expiresAt();
    return at !== undefined && at <= this.context.now();
  }

  /** Whether the run's retirement began (its job is queued) and has not ended. */
  #retiring(): boolean {
    return (
      this.engine.rows(
        "SELECT 1 FROM jobs WHERE job_id = ? AND state IN ('queued', 'running')",
        RUN_JOB.retire,
      ).length > 0
    );
  }

  /** Whether the run is answered as no run: erased, or expired and about to be. */
  #hidden(): boolean {
    return this.#erased() || this.#expired();
  }

  #ci() {
    return runCiPolicy(ciEnv(this.env));
  }

  #tx<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(fn);
  }

  // ------------------------------------------------------------------ creation

  #reserve(spec: RunSpec, digest: string): ReserveAnswer {
    if (this.#erased()) return { ok: false, code: "run_erased" };
    if (this.#expired()) {
      // Erased in all but storage: a retried start must not record it again. Its retirement
      // begins here, so it holds once the caller has the repository forget the run.
      this.jobs.ensure("run_retire", RUN_JOB.retire);
      return { ok: false, code: "run_erased" };
    }
    const existing = this.engine.rows<{ repo_id: string; spec_digest: string | null }>(
      "SELECT repo_id, spec_digest FROM run_identity WHERE id = 1",
    )[0];
    if (existing)
      return existing.repo_id === spec.repoId && existing.spec_digest === digest
        ? { ok: true }
        : { ok: false, code: "run_exists" };
    this.engine.exec(
      "INSERT INTO run_identity (id, repo_id, spec_digest) VALUES (1, ?, ?)",
      spec.repoId,
      digest,
    );
    return { ok: true };
  }

  /** Binds the run id before a repository records it; retries must use the same spec. */
  async reserve(spec: RunSpec): Promise<ReserveAnswer> {
    const digest = await specDigest(spec, validateRunSpec(spec));
    return this.#tx(() => this.#reserve(spec, digest));
  }

  /**
   * Creates the run from `spec`; the same spec again returns it, another is
   * refused. `ownerId`, the account that owned the repository when the spec
   * was built, is kept with a new run: only that account's secrets are ever
   * delivered to its jobs. A run created without one is given no secrets.
   */
  async create(spec: RunSpec, ownerId?: string): Promise<CreateAnswer> {
    if (ownerId !== undefined && !isPrincipalId(ownerId)) throw new TypeError("invalid run owner");
    const contexts = validateRunSpec(spec);
    const digest = await specDigest(spec, contexts);
    const planCheck = await workflowFileCheckName(spec.workflow.path);
    const binding = await approvalBinding(spec);
    return this.#tx((): CreateAnswer => {
      const reserved = this.#reserve(spec, digest);
      if (!reserved.ok) return reserved;
      const existing = this.engine.run();
      if (existing)
        return existing.spec_digest === digest
          ? { ok: true, created: false, run: this.#view() as RunView }
          : { ok: false, code: "run_exists" };
      const now = this.context.now();
      this.engine.exec(
        `INSERT INTO runs (id, run_id, repo_id, sha, ref, event, actor_id, workflow_path,
           workflow_source, contexts, spec_digest, attempt, created_at, updated_at, trust, fork,
           owner_id)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
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
        spec.trust,
        spec.fork ? 1 : 0,
        ownerId ?? null,
      );
      const loaded = loadModel(spec.workflow.path, spec.workflow.source);
      // Variables too large for the contexts fail the run as a workflow that does not plan does.
      const errors: readonly RunError[] | undefined = !loaded.ok
        ? loaded.errors.map(({ code, feature, path, line, column, message }) => ({
            code,
            feature,
            path,
            line,
            column,
            message,
          }))
        : spec.varsError
          ? [
              {
                code: spec.varsError,
                feature: "vars",
                path: "",
                line: 0,
                column: 0,
                message: `The run's variables, encoded as JSON with its other contexts, would exceed ${MAX_RUN_CONTEXTS_BYTES} bytes; values with many characters JSON escapes (control characters) take up to six bytes each.`,
              },
            ]
          : undefined;
      // A workflow that fails to plan runs nothing: it needs no approval, and fails at once.
      if (binding !== null && !errors) {
        // Held: no attempt is admitted (no concurrency group, no job, no check) until approved.
        const expires = now + APPROVAL_EXPIRY_MS;
        this.engine.exec(
          "INSERT INTO run_approval (id, binding, state, expires_at) VALUES (1, ?, 'waiting', ?)",
          binding,
          expires,
        );
        this.jobs.ensure("run_deadlines", RUN_JOB.deadlines, { runAt: expires });
      }
      this.engine.insertAttempt(1, spec.actor, loaded.ok && !errors ? loaded.model : undefined);
      const attempt = this.engine.attempt(1) as AttemptRow;
      if (errors) {
        this.engine.exec(
          "UPDATE run_attempts SET errors = ? WHERE attempt = 1",
          JSON.stringify(errors),
        );
        this.engine.advanceAttempt(attempt, { kind: "plan_failed" });
        this.#publishPlanFailure(spec.runId, planCheck);
      } else this.#admit(attempt);
      this.jobs.ensure("run_reconcile", RUN_JOB.reconcile, {
        runAt: now + this.policy.reconcileMs,
      });
      return { ok: true, created: true, run: this.#view() as RunView };
    });
  }

  /**
   * Queues the failed plan's one check in the outbox (it has no job: id 0),
   * so the commit shows the workflow file that could not run.
   */
  #publishPlanFailure(runId: string, name: string): void {
    this.engine.exec(
      `INSERT INTO run_checks (attempt, name_key, name, start_key, job_id, desired, rev)
       VALUES (1, ?, ?, ?, 0, 'failure', 1)`,
      checkNameKey(name),
      name,
      planCheckKey(runId),
    );
    this.jobs.ensure("run_checks", RUN_JOB.checks, {
      runAt: this.context.now() + this.policy.checkFlushMs,
    });
  }

  /**
   * Lets an attempt start, at once or once it owns its workflow's
   * concurrency group: every admission (the first attempt, a re-run, an
   * approval) passes here, and a run waiting for approval, or whose
   * approval ended without one, admits nothing.
   */
  #admit(attempt: AttemptRow): void {
    const approval = this.#approvalRow();
    if (approval && approval.state !== "approved") return;
    this.engine.admitOrQueue(attempt);
  }

  #approvalRow(): ApprovalRow | undefined {
    return this.engine.rows<ApprovalRow & Record<string, SqlStorageValue>>(
      "SELECT * FROM run_approval WHERE id = 1",
    )[0];
  }

  /**
   * A maintainer's approval, delivered by the repository with the binding it
   * recorded: a waiting run whose binding is the same is approved and its
   * current attempt admitted in the same transaction. Approved already: the
   * same answer. Ended (cancelled, superseded, expired): `not_waiting`. A
   * waiting approval past its expiry, which the deadline has not processed
   * yet, expires here as the deadline would expire it.
   */
  approve(binding: string, approver: string): ApproveAnswer {
    return this.#tx((): ApproveAnswer => {
      if (this.#hidden() || !this.engine.run()) return { ok: false, code: "run_not_found" };
      this.#expireApproval();
      const approval = this.#approvalRow();
      if (!approval) return { ok: false, code: "not_waiting" };
      if (approval.binding !== binding) return { ok: false, code: "approval_stale" };
      if (approval.state === "approved") return { ok: true };
      if (approval.state !== "waiting") return { ok: false, code: "not_waiting" };
      this.engine.exec(
        "UPDATE run_approval SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = 1",
        approver,
        this.context.now(),
      );
      this.engine.stateMoved();
      const current = this.engine.current();
      if (current && current.attempt.status === "queued") this.#admit(current.attempt);
      return { ok: true };
    });
  }

  /**
   * A newer run of the same pull request and workflow waits instead: a
   * waiting run ends cancelled, its approval superseded. The repository,
   * which decided it, is not told back.
   */
  supersede(): ApproveAnswer {
    return this.#tx((): ApproveAnswer => {
      if (this.#hidden() || !this.engine.run()) return { ok: false, code: "run_not_found" };
      const approval = this.#approvalRow();
      if (approval?.state === "superseded") return { ok: true };
      if (approval?.state !== "waiting") return { ok: false, code: "not_waiting" };
      this.engine.exec(
        "UPDATE run_approval SET state = 'superseded', decided_at = ? WHERE id = 1",
        this.context.now(),
      );
      this.engine.cancel("system", "graceful");
      return { ok: true };
    });
  }

  /** In a change's transaction: a waiting approval ended here, which the repository must hear of. */
  #endApproval(state: "cancelled" | "expired"): void {
    const approval = this.#approvalRow();
    if (approval?.state !== "waiting") return;
    this.engine.exec(
      "UPDATE run_approval SET state = ?, decided_at = ?, notified = 0 WHERE id = 1",
      state,
      this.context.now(),
    );
    this.jobs.ensure("run_approval", RUN_JOB.approval);
  }

  /** A waiting approval past its expiry: the run fails, named; when the next expiry falls otherwise. */
  #expireApproval(): number | undefined {
    const approval = this.#approvalRow();
    if (approval?.state !== "waiting") return undefined;
    if (approval.expires_at > this.context.now()) return approval.expires_at;
    const current = this.engine.current();
    if (current && current.attempt.status !== "completed") {
      this.engine.exec(
        "UPDATE run_attempts SET errors = ? WHERE attempt = ?",
        JSON.stringify([
          {
            code: "approval_expired",
            feature: "",
            path: "",
            line: 0,
            column: 0,
            message: "No maintainer approved the run within 30 days.",
          },
        ]),
        current.attempt.attempt,
      );
      this.engine.advanceAttempt(current.attempt, { kind: "plan_failed" });
    }
    this.#endApproval("expired");
    return undefined;
  }

  /**
   * Tells the repository of an approval this object ended (a user's cancel,
   * the expiry), until it answers: never exhausts, as the repository's item
   * must not stay open.
   */
  async #notifyApproval(): Promise<
    { done: true } | { done: false; cursor: null; runAfterMs: number }
  > {
    const run = this.engine.run();
    const approval = this.#approvalRow();
    if (!run || !approval || approval.notified === 1) return { done: true };
    if (approval.state !== "cancelled" && approval.state !== "expired") return { done: true };
    try {
      const answer = await this.#repoCall(
        "settleApproval",
        (repo) =>
          repo.settleApproval({
            runId: run.run_id,
            outcome: approval.state as "cancelled",
          }) as unknown as Promise<Awaited<ReturnType<RepoDO["settleApproval"]>>>,
      );
      if (!answer.ok && answer.code !== "run_not_found")
        return { done: false, cursor: null, runAfterMs: this.policy.sweepMs };
    } catch (error) {
      this.#log.warn("telling the repository of an approval failed", { error });
      return { done: false, cursor: null, runAfterMs: this.policy.sweepMs };
    }
    this.#tx(() => this.engine.exec("UPDATE run_approval SET notified = 1 WHERE id = 1"));
    return { done: true };
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
      ...this.#runFacts(run),
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
      trust: run.trust,
      fork: run.fork !== 0,
      errors: storedErrors(attempt.errors),
      approval: ((a) =>
        a ? { state: a.state, decidedBy: a.decided_by, decidedAt: a.decided_at } : null)(
        this.#approvalRow(),
      ),
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

  #runFacts(run: RunRow): RunFacts {
    if (this.#facts?.runId !== run.run_id) {
      let runName: string | undefined;
      try {
        runName = this.engine.runName();
      } catch {
        // The workflow does not plan, so the run has no name of its own.
      }
      this.#facts = {
        runId: run.run_id,
        facts: runFacts((JSON.parse(run.contexts) as { github?: unknown }).github, {
          event: run.event,
          ref: run.ref,
          workflowPath: run.workflow_path,
          runName,
        }),
      };
    }
    return this.#facts.facts;
  }

  /** The run as it is reported to its repository; undefined when there is none. */
  runReport(): RunReport | undefined {
    const current = this.engine.current();
    if (!current) return undefined;
    const { run, attempt } = current;
    return {
      ...this.#runFacts(run),
      runId: run.run_id,
      sha: run.sha,
      path: run.workflow_path,
      event: run.event,
      actor: run.actor_id,
      fork: run.fork !== 0,
      createdAt: run.created_at,
      attempt: attempt.attempt,
      phase: runPhase(attempt.status, this.#approvalRow()?.state === "waiting"),
      conclusion: attempt.conclusion,
      triggeringActor: attempt.triggering_actor_id,
      updatedAt: run.updated_at,
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
    };
  }

  /** Forgets which state the repository last took, as a new instance has (for tests). */
  forgetReported(): void {
    this.#reported = 0;
    this.#jobsReported = { done: 0, live: {} };
    this.#repoEpoch = undefined;
  }

  jobReports(): JobReport[] {
    const rows = this.engine.rows<
      Pick<
        InstanceRow,
        | "job_id"
        | "attempt"
        | "job_key"
        | "name"
        | "instance"
        | "status"
        | "conclusion"
        | "started_at"
        | "completed_at"
      > & { triggering_actor_id: string }
    >(
      // Told and not ended are only the current attempt's, the last and 256 at most: what is owed
      // is within the first 512.
      `SELECT i.job_id, i.attempt, i.job_key, i.name, i.instance, i.status, i.conclusion, i.started_at,
         i.completed_at, a.triggering_actor_id
       FROM run_instances i JOIN run_attempts a ON a.attempt = i.attempt
       WHERE i.job_id > ? AND i.status <> 'blocked' ORDER BY i.job_id LIMIT ?`,
      this.#jobsReported.done,
      2 * MAX_JOB_REPORTS,
    );
    const owed = rows
      .map((row) => ({
        jobId: row.job_id,
        attempt: row.attempt,
        triggeringActor: row.triggering_actor_id,
        key: row.job_key.slice(0, MAX_RUN_TITLE_LENGTH),
        name: shown(row.name) ?? row.job_key.slice(0, MAX_RUN_TITLE_LENGTH),
        jobKey: row.job_key,
        instance: row.instance,
        action: row.status === "cancelling" ? "in_progress" : (row.status as JobAction),
        conclusion: row.conclusion,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      }))
      .filter((job) => jobOrder(job.action) > jobOrder(this.#jobsReported.live[job.jobId]))
      .slice(0, MAX_JOB_REPORTS);
    if (owed.length === 0) return [];
    const free = this.#jobsWithFreeLabels();
    return owed.map(({ instance, jobKey, ...job }) => ({
      ...job,
      labels:
        instance !== null && free.has(jobKey)
          ? decodeInstance(instance)
              .runsOn.slice(0, MAX_JOB_LABELS)
              .flatMap((label) => shown(label) ?? [])
          : null,
    }));
  }

  #jobsWithFreeLabels(): ReadonlySet<string> {
    try {
      const { jobs } = this.#loadModel().workflow;
      return new Set(jobs.filter(labelsFreeOfOutputs).map((job) => job.id.value));
    } catch {
      return new Set();
    }
  }

  /** The run as its current attempt stands; undefined when there is none (or it was erased). */
  get(): RunView | undefined {
    return this.#hidden() ? undefined : this.#view();
  }

  /** A page of an attempt's jobs (the current one by default), by job id after `after`. */
  listJobs(
    attempt?: number,
    after = 0,
    limit = 100,
  ): { jobs: JobView[]; next: number | null } | undefined {
    if (this.#hidden()) return undefined;
    const run = this.engine.run();
    if (!run) return undefined;
    const rows = this.#jobRows(
      "i.attempt = ? AND i.job_id > ? ORDER BY i.job_id LIMIT ?",
      attempt ?? run.attempt,
      after,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      jobs: page.map((row) => this.#jobView(row)),
      next: rows.length > limit ? (page.at(-1) as InstanceRow).job_id : null,
    };
  }

  /** Job `jobId` of whichever attempt it ran in. */
  getJob(
    jobId: number,
  ):
    | { readonly ok: true; readonly job: JobView }
    | { readonly ok: false; readonly code: "run_not_found" | "job_not_found" } {
    if (this.#hidden() || !this.engine.run()) return { ok: false, code: "run_not_found" };
    const [row] = this.#jobRows("i.job_id = ?", jobId);
    return row ? { ok: true, job: this.#jobView(row) } : { ok: false, code: "job_not_found" };
  }

  #jobRows(where: string, ...params: (string | number)[]) {
    return this.engine.rows<JobRow>(
      `SELECT i.*, c.desired AS check_desired, c.parked AS parked, r.waiting_for AS waiting_for
       FROM run_instances i
       LEFT JOIN run_checks c ON c.attempt = i.attempt AND c.job_id = i.job_id
       LEFT JOIN ci_reservations r ON r.job_id = i.job_id
       WHERE ${where}`,
      ...params,
    );
  }

  #jobView(row: JobRow): JobView {
    return {
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
      steps:
        row.steps === null
          ? []
          : jobSteps(row.steps, this.#written(row.job_key), row.status === "completed"),
      waitingFor: row.status === "queued" ? row.waiting_for : null,
    };
  }

  /**
   * The jobs of an attempt of repository `repoId`'s run (the current attempt
   * by default) as its workflow writes them, each after the jobs it needs.
   * Instance names and errors are read as their first `prefixes` characters
   * (code points), which hold at least as many UTF-16 units.
   */
  graph(
    repoId: string,
    attempt: number | undefined,
    prefixes: { readonly name: number; readonly error: number },
  ):
    | { readonly ok: true; readonly attempt: number; readonly jobs: readonly GraphJob[] }
    | { readonly ok: false; readonly code: "run_not_found" | "attempt_not_found" } {
    const run = this.engine.run();
    if (this.#hidden() || run?.repo_id !== repoId) return { ok: false, code: "run_not_found" };
    const n = attempt ?? run.attempt;
    if (!this.engine.attempt(n)) return { ok: false, code: "attempt_not_found" };
    const nodes = this.engine.nodes(n);
    // A workflow that could not run has no jobs, and does not plan.
    const graph = nodes.length > 0 ? this.#loadModel().plan.graph : undefined;
    const instances = Map.groupBy(this.#graphInstances(n, prefixes), (row) => row.job_key);
    return {
      ok: true,
      attempt: n,
      jobs: nodes.map((node) => ({
        key: node.job_key,
        name: node.name,
        needs: graph?.job(node.job_key)?.needs ?? [],
        status: node.status,
        outcome: nodeOutcome(node) ?? null,
        jobs: (instances.get(node.job_key) ?? []).map((row) => ({
          jobId: row.job_id,
          name: codePointPrefix(row.name, prefixes.name),
          status: row.status,
          conclusion: row.conclusion,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          error: row.error === null ? null : codePointPrefix(row.error, prefixes.error),
          waitingFor: row.status === "queued" ? row.waiting_for : null,
        })),
      })),
    };
  }

  #graphInstances(attempt: number, prefixes: { readonly name: number; readonly error: number }) {
    return this.engine.rows<
      Pick<
        JobRow,
        | "job_id"
        | "job_key"
        | "status"
        | "conclusion"
        | "started_at"
        | "completed_at"
        | "waiting_for"
      > & { readonly name: ArrayBuffer; readonly error: ArrayBuffer | null }
    >(
      `SELECT i.job_id, i.job_key, substr(CAST(i.name AS BLOB), 1, ?) AS name, i.status, i.conclusion,
         i.started_at, i.completed_at, substr(CAST(i.error AS BLOB), 1, ?) AS error,
         r.waiting_for AS waiting_for
       FROM run_instances i
       LEFT JOIN ci_reservations r ON r.job_id = i.job_id
       WHERE i.attempt = ? ORDER BY i.job_id`,
      utf8Bound(prefixes.name),
      utf8Bound(prefixes.error),
      attempt,
    );
  }

  // ------------------------------------------------------------------ cancel and re-run

  cancel(
    by: string,
    mode: "graceful" | "force",
  ): { ok: true } | { ok: false; code: "run_not_found" | "run_not_cancellable" } {
    return this.#tx(() => {
      if (this.#hidden() || !this.engine.run()) return { ok: false, code: "run_not_found" };
      if (!this.engine.cancel(by, mode)) return { ok: false, code: "run_not_cancellable" };
      this.#endApproval("cancelled");
      return { ok: true };
    });
  }

  rerun(by: string):
    | { ok: true; attempt: number }
    | {
        ok: false;
        code: "run_not_found" | "run_not_completed" | "rerun_limit" | "approval_required";
      } {
    return this.#tx(() => {
      if (this.#hidden()) return { ok: false, code: "run_not_found" };
      const current = this.engine.current();
      if (!current) return { ok: false, code: "run_not_found" };
      // A run never approved stays unapproved: re-running it would start code no one approved.
      const approval = this.#approvalRow();
      if (approval && approval.state !== "approved")
        return { ok: false, code: "approval_required" };
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

  /**
   * Instances waiting for a runner, oldest first: those whose CI minutes are
   * reserved, inside their start window, for `accountId` when given, and
   * priced by the ledger when the deployment has one.
   */
  queued(
    limit = 100,
    accountId?: string,
  ): { jobId: number; attempt: number; name: string; runsOn: string[]; queuedAt: number }[] {
    if (this.#erased()) return [];
    return this.engine
      .rows<InstanceRow>(
        `SELECT i.* FROM run_instances i JOIN ci_reservations r ON r.job_id = i.job_id
         WHERE i.status = 'queued' AND r.state = 'reserved' AND r.window_until > ?
           AND (? IS NULL OR r.account_id = ?) AND (? = 0 OR r.price IS NOT NULL)
         ORDER BY i.queued_at, i.job_id LIMIT ?`,
        this.context.now(),
        accountId ?? null,
        accountId ?? null,
        this.#ci().ledger === null ? 0 : 1,
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
   * Hands a queued instance to a runner (of account `accountId`, when given).
   * The same key while its task lives gets the same answer and writes
   * nothing, whatever its reservation; after it completed, `task_finished`.
   * A new assignment needs the instance's CI minutes reserved, inside their
   * start window, for the runner's account.
   */
  assign(jobId: number, assignKey: string, accountId?: string): AssignAnswer {
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
      if (!this.#reservations.admits(jobId, accountId)) return { ok: false, code: "not_queued" };
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
      this.#reservations.started(jobId, now);
      this.engine.applyInstance(row, { kind: "assign" });
      return this.#assignment(current.run, this.engine.instance(jobId) as InstanceRow);
    });
  }

  #assignment(run: RunRow, row: InstanceRow): AssignAnswer {
    const model = this.#loadModel();
    const node = this.engine.node(row.attempt, row.job_key) as NodeRow;
    const decoded = this.engine.decode(row);
    if (!decoded) return { ok: false, code: "not_queued" };
    // A timeout clamped below the job's own (Free) reaches the runner, which enforces it.
    const timeoutMinutes = Math.round(row.timeout_ms / 60_000);
    const instance =
      timeoutMinutes < (decoded.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES)
        ? { ...decoded, timeoutMinutes }
        : decoded;
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
    const contexts = JSON.parse(run.contexts) as { github: unknown; vars?: unknown };
    return {
      ok: true,
      task: { jobId: row.job_id, task: row.task as number },
      payload,
      needs,
      attempt: row.attempt,
      repoId: run.repo_id,
      actorId: run.actor_id,
      triggeringActorId: attempt.triggering_actor_id,
      github: contexts.github,
      timeoutMinutes: Math.round(row.timeout_ms / 60_000),
      tokenScopes: effectiveScope({
        workflowPermissions: model.workflow.permissions,
        jobPermissions: model.workflow.jobs.find((j) => j.id.value === row.job_key)?.permissions,
        trust: run.trust,
      }),
      vars: run.trust === "trusted" ? stringValues(contexts.vars) : {},
    };
  }

  /**
   * Read only: which secrets job `jobId` would be given, read from the
   * immutable workflow, and whether its run is trusted (an untrusted run's
   * jobs get none); undefined for a job the run does not have.
   */
  secretsRequest(jobId: number): { trusted: boolean; refs: SecretReferences } | undefined {
    if (this.#erased()) return undefined;
    const run = this.engine.run();
    const row = this.engine.instance(jobId);
    if (!run || !row) return undefined;
    if (run.trust !== "trusted") return { trusted: false, refs: { kind: "names", names: [] } };
    const refs = secretReferences(this.#loadModel().workflow, row.job_key);
    // The job token's names are always the minted token, never a stored secret (a write refuses
    // both names), so a job reading only them reads no secret of its account.
    if (refs.kind === "all") return { trusted: true, refs };
    return {
      trusted: true,
      refs: { kind: "names", names: refs.names.filter((name) => !JOB_TOKEN_NAMES.has(name)) },
    };
  }

  /**
   * Ends task `ref`'s instance as failed with `error`, before any runner was
   * given it (its secrets could not be delivered, and the run ended its offer
   * in the directory while it was never recorded); false when the task is
   * not current or has ended. Its local mapping, if any, is kept, the
   * task's end spends no runner's credential for an offer the directory
   * never recorded, and its reservation is released unused.
   */
  failTask(ref: TaskRef, error: string): boolean {
    return this.#tx(() => {
      const found = this.#task(ref);
      if (!("row" in found) || found.row.status === "completed") return false;
      const failed = this.engine.applyInstance(
        found.row,
        { kind: "complete", result: "failure" },
        { error },
      );
      if (failed) this.#reservations.neverGiven(found.row.job_id);
      return failed;
    });
  }

  /**
   * Puts task `ref`'s instance back in the queue: its offer was given up in
   * the directory before this assignment was recorded there, so no runner
   * was given it, and none ever can be. It keeps the time it was first
   * queued (its queue deadline does not move); the task, never handed out,
   * is dropped and its log closed. False when the task is not current or
   * not in progress.
   */
  requeueTask(ref: TaskRef): boolean {
    return this.#tx(() => {
      const found = this.#task(ref);
      if (!("row" in found) || found.row.status !== "in_progress") return false;
      const { row } = found;
      if (!this.engine.applyInstance(row, { kind: "unassign" })) return false;
      this.engine.exec(
        `UPDATE run_instances SET task = NULL, assign_key = NULL, started_at = NULL,
           heartbeat_at = NULL, steps = NULL, queued_at = ?
         WHERE job_id = ?`,
        row.queued_at,
        row.job_id,
      );
      this.#reservations.unassigned(row.job_id);
      this.#steps.delete(ref.task);
      this.#logs.taskEnded(ref.task, this.context.now());
      this.engine.ensureDeadlines();
      return true;
    });
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
    this.hooks.onTaskLive?.();
    const found = this.#task(ref);
    return (
      "row" in found && (found.row.status === "in_progress" || found.row.status === "cancelling")
    );
  }

  /**
   * Read only: for a task in progress or cancelling, its run's repository
   * and checkout commit, which the task's job token may fetch even once no
   * ref reaches it; null otherwise.
   */
  liveTaskCheckout(ref: TaskRef): { readonly repoId: string; readonly sha: string } | null {
    if (!this.taskLive(ref)) return null;
    const run = this.engine.run();
    return run ? { repoId: run.repo_id, sha: run.sha } : null;
  }

  /** A heartbeat; `cancel` tells the runner to stop. */
  updateTask(ref: TaskRef, steps?: string | null): TaskAnswer<{ cancel: boolean }> {
    return this.#tx((): TaskAnswer<{ cancel: boolean }> => {
      const found = this.#task(ref);
      if (!("row" in found)) return { ok: false, code: found.code };
      const { row } = found;
      if (row.status === "completed") return { ok: false, code: "task_finished" };
      const now = this.context.now();
      if (steps) this.#steps.set(ref.task, steps);
      // Heartbeats come every few seconds; writing each would cost a row each.
      if ((row.heartbeat_at ?? 0) + this.policy.heartbeatWriteMs <= now) {
        this.engine.exec(
          "UPDATE run_instances SET heartbeat_at = ?, steps = COALESCE(?, steps) WHERE job_id = ?",
          now,
          this.#steps.get(ref.task) ?? null,
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
    report: {
      result: RunnerResult;
      outputs?: Record<string, string>;
      logComplete: boolean;
      steps?: string | null;
    },
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
          steps: report.steps ?? null,
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

  /**
   * The runner protocol's assignment: job `jobId` as the directory's task
   * `wireId`, offered to runner `runnerId` of account `accountId` (refused
   * unless that account owns the run's repository now); the encoded `Task` with its job
   * token, or why it was refused. The same wire id again (a lost answer)
   * gets the same task and a new token.
   */
  assignTask(
    wireId: number,
    jobId: number,
    runnerId: number,
    accountId: string,
  ): Promise<AssignTaskAnswer> {
    return this.#dispatch.assignTask(wireId, jobId, runnerId, accountId);
  }

  /**
   * The Worker's `assignTask` call for `wireId` failed. Safe at any time, any
   * number of times: the directory decides what becomes of the job.
   */
  assignmentLost(wireId: number, jobId: number): void {
    this.#dispatch.assignmentLost(wireId, jobId);
  }

  /** A runner's UpdateTask for wire task `wireId`, as the Worker received it. */
  reportTask(wireId: number, body: Uint8Array, runnerId: number): Promise<ReportTaskAnswer> {
    return this.#dispatch.reportTask(wireId, body, runnerId);
  }

  /**
   * A runner's UpdateLog for wire task `wireId`, as the Worker received it
   * (`truncated`: the first 4 MiB of a longer body). New rows are stored
   * before they are acked; the answer carries the stored ack.
   */
  appendLog(
    wireId: number,
    body: Uint8Array,
    truncated: boolean,
    runnerId: number,
  ): Promise<AppendLogAnswer> {
    return this.#logs.append(wireId, body, truncated, runnerId);
  }

  /**
   * Registers the secrets delivered to task `task` to be masked in its log,
   * sealed, in one transaction, within the task's secret budget; called at
   * assignment before the task is answered. Refused for a task of an
   * untrusted run, which gets no secrets.
   */
  addSecretMasks(task: number, secrets: readonly SecretMaskOffer[]): Promise<SecretMasksAnswer> {
    return this.#logs.addSecretMasks(task, secrets);
  }

  // ------------------------------------------------------------------ live log sockets

  /**
   * Stores a live log ticket's hash for job `jobId` (its credential and
   * principal, redeemable through repository `repoId` only); refused for an
   * erased or unknown run, an unknown job, or past the run's unredeemed tickets.
   */
  storeLogTicket(input: {
    hash: string;
    repoId: string;
    jobId: number;
    credentialId: string;
    principalId: string;
    budget: { readonly maxActiveMs: number } | null;
  }): StoreTicketAnswer {
    return this.viewers.storeTicket(input);
  }

  /** A page of job `jobId`'s log, as stored; the run must be repository `repoId`'s. */
  readLog(repoId: string, jobId: number, query: LogPageQuery): Promise<LogPageAnswer> {
    return this.#logPages.read(repoId, jobId, query);
  }

  dropLogTicket(hash: string): void {
    this.viewers.dropTicket(hash);
  }

  /** A live log upgrade, as the Worker's route forwards it with the credential it verified. */
  override async fetch(request: Request): Promise<Response> {
    return this.viewers.redeem(request);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.viewers.message(ws, message);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.viewers.gone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.viewers.gone(ws);
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
    if (!owner || owner.state === "ended") return;
    if (!receipt) {
      if (owner.state === "pending")
        this.engine.exec(
          `UPDATE run_owners SET state = 'admitting', outcome = NULL, generation = NULL,
             lease_valid_until = NULL, renew_at = NULL WHERE owner_key = ?`,
          key,
        );
      return;
    }
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

  /**
   * Runs the reserve slice now, every refused reservation asked again as at
   * its retry time: what the alarm would do, early (a local check that a
   * refused job is admitted after the day turns). No route of the Worker
   * reaches it.
   */
  async ciReserveNow(): Promise<ReservationView[]> {
    if (this.#erased() || !this.engine.run()) return [];
    this.#tx(() => this.#reservations.retryNow());
    const handler = this.#handlers().ci_reserve;
    if (handler)
      await this.jobs.runJob(
        RUN_JOB.reserve,
        handler,
        this.memory,
        this.context.now() + ALARM_BUDGET_MS,
      );
    return this.#reservations.views();
  }

  // ------------------------------------------------------------------ erasure

  /**
   * Erases the reserved repository's run, retaining its identity and a tombstone,
   * and leaves one job: the purge of its log chunks from R2, once a write that
   * was in flight has landed. Returns false for another repository; repeating
   * an authorized erasure succeeds, and purges again if no purge is pending.
   */
  async erase(repoId: string): Promise<boolean> {
    const erased = this.#tx(() => {
      const identity = this.engine.rows<{ repo_id: string }>(
        "SELECT repo_id FROM run_identity WHERE id = 1",
      )[0];
      if (identity && identity.repo_id !== repoId) return false;
      if (this.#erased()) {
        // A tombstone from before the purge existed, or whose purge ended: purged (again).
        if (!this.#purging()) this.#ensurePurge();
        return true;
      }
      if (!identity)
        this.engine.exec("INSERT INTO run_identity (id, repo_id) VALUES (1, ?)", repoId);
      for (const table of [
        "runs",
        "run_attempts",
        "run_nodes",
        "run_instances",
        "run_checks",
        "run_owners",
        "run_faults",
        "ci_tasks",
        "ci_logs",
        "ci_log_chunks",
        "ci_log_masks",
        "ci_log_tickets",
        "run_approval",
        "ci_reservations",
        "ci_delivery_failures",
        "jobs",
      ])
        this.engine.exec(`DELETE FROM ${table}`);
      this.engine.exec("INSERT INTO run_erasure (id, erased_at) VALUES (1, ?)", this.context.now());
      this.#ensurePurge();
      return true;
    });
    if (!erased) return false;
    this.#steps.clear();
    this.viewers.erased();
    this.#logs.erased();
    this.#model = undefined;
    return true;
  }

  /** Whether the erased run's log purge is pending. */
  #purging(): boolean {
    return (
      this.engine.rows(
        "SELECT 1 FROM jobs WHERE job_id = ? AND state IN ('queued', 'running')",
        RUN_JOB.logPurge,
      ).length > 0
    );
  }

  /**
   * Queues the log purge `LOG_LATE_MS` from now: a log write in flight at the
   * erasure has landed by then (or deleted its own object), so the purge finds it.
   */
  #ensurePurge(): void {
    this.jobs.ensure("run_log_purge", RUN_JOB.logPurge, {
      runAt: this.context.now() + LOG_LATE_MS,
    });
  }

  /**
   * One slice of the erased run's log purge: lists `runs/<run id>/` and deletes
   * what it lists, at most `logPurgeCalls` R2 calls, until nothing is left. The
   * prefix also finds chunks no index named (a write whose request failed). A
   * failure is retried at the sweep's interval and never ends the job: an erased
   * run has no sweep to restart it.
   */
  async #purgeSlice(): Promise<SliceResult> {
    const runId = this.ctx.id.name;
    if (!runId) {
      this.#log.error("an erased run's log purge has no run id");
      return { done: true };
    }
    const prefix = `runs/${runId}/`;
    try {
      for (let calls = 0; calls + 2 <= this.logPurgeCalls; calls += 2) {
        await this.hooks.beforeLogPurgeCall?.();
        // A list is a Class A operation (https://developers.cloudflare.com/r2/pricing/#class-a-operations).
        this.context.metrics.count("r2.class_a", { bucket: "fyrden-ci", op: "log_purge_list" });
        const page = await this.env.CI.list({ prefix, limit: 1000 });
        if (page.objects.length === 0) return { done: true };
        await this.hooks.beforeLogPurgeCall?.();
        // R2 deletes are free (not Class A: https://developers.cloudflare.com/r2/pricing/#free-operations),
        // but each is still a call against the invocation's internal budget.
        countSubrequests("internal");
        await this.env.CI.delete(page.objects.map((object) => object.key));
      }
      return { done: false, cursor: null, runAfterMs: 0 };
    } catch (error) {
      this.#log.warn("an erased run's log chunks not purged", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { done: false, cursor: null, runAfterMs: this.policy.sweepMs };
    }
  }

  /**
   * An erased run's alarm: its log purge, then, with nothing left pending, the
   * finished job rows and the alarm go too, so the object holds only its
   * identity and tombstone.
   */
  async #erasedAlarm(): Promise<void> {
    // Any other job queued since the erasure has nothing to act on, and one due with no handler
    // here would re-arm the alarm at once, again and again, until the purge ends.
    this.engine.exec("DELETE FROM jobs WHERE job_id <> ?", RUN_JOB.logPurge);
    await this.jobs.runDue(
      { run_log_purge: { runSlice: () => this.#purgeSlice() } },
      this.memory,
      this.context.now() + ALARM_BUDGET_MS,
    );
    await this.#settleErased();
  }

  /** On an erased object with no purge pending: deletes the finished job rows and the alarm. */
  async #settleErased(): Promise<void> {
    const settled = this.#tx(() => {
      if (this.#purging()) return false;
      this.engine.exec("DELETE FROM jobs");
      return true;
    });
    if (settled) await this.ctx.storage.deleteAlarm();
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
    const run = this.engine.run();
    if (run) await this.erase(run.repo_id);
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
          if (repoGone(message) && (await this.#register()) === "gone") {
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
          const next = this.#tx(() => {
            const expiry = this.#expireApproval();
            const due = this.engine.applyDeadlines();
            return expiry === undefined || (due !== undefined && due < expiry) ? due : expiry;
          });
          return next === undefined
            ? { done: true }
            : { done: false, cursor: null, runAfterMs: Math.max(0, next - this.context.now()) };
        },
      },
      run_checks: { runSlice: (job) => this.#tellRepository(job) },
      run_sweep: { runSlice: async () => this.#sweep() },
      run_concurrency: { runSlice: (job) => this.#concurrencySlice(job) },
      ci_dispatch: { runSlice: (job) => this.#dispatch.dispatchSlice(job) },
      ci_task_end: { runSlice: (job) => this.#dispatch.taskEndSlice(job) },
      ci_delivery: { runSlice: (job) => this.#dispatch.recoverySlice(job) },
      ci_reserve: { runSlice: (job) => this.#reservations.slice(job) },
      ci_log_close: { runSlice: async () => this.#logs.closeSlice() },
      ci_log_viewers: { runSlice: () => this.viewers.slice() },
    };
    for (const [kind, handler] of Object.entries(handlers) as [JobKind, JobHandler][])
      handlers[kind] = this.#marked(kind, handler);
    // Never exhausts, so never marked: nothing else would visit a finished run again.
    handlers.run_reconcile = { runSlice: () => this.#reconcile() };
    handlers.run_retire = { runSlice: (job) => this.#retire(job) };
    handlers.run_approval = { runSlice: () => this.#notifyApproval() };
    return handlers;
  }

  /**
   * Sends the repository the run's checks, then its state when that moved
   * since it was last sent. Done once neither has anything left: what moves
   * during a call here is sent by the next slice, as a running job is not
   * queued again.
   */
  async #tellRepository(
    job: Job,
  ): Promise<{ done: true } | { done: false; cursor: null; runAfterMs: number }> {
    const checks = await this.#flushChecks(job);
    await this.#reportState();
    const left =
      !checks.done ||
      this.#reportOwed() ||
      this.engine.rows("SELECT 1 FROM run_checks WHERE parked IS NULL AND sent_rev < rev LIMIT 1")
        .length > 0;
    return left
      ? { done: false, cursor: null, runAfterMs: this.policy.checkFlushMs }
      : { done: true };
  }

  /** The run's report, when the repository has not taken its state from this instance. */
  #stateOwed(): RunReport | undefined {
    const report = this.runReport();
    return report && runStateSeq(report.attempt, report.phase) > this.#reported
      ? report
      : undefined;
  }

  #takeRepository(answer: {
    readonly jobsDone?: number | undefined;
    readonly epoch?: number | undefined;
    readonly inserted?: boolean | undefined;
  }): void {
    const { jobsDone: done, epoch } = answer;
    if (done === undefined) return;
    const restored =
      answer.inserted === true ||
      (epoch !== undefined && this.#repoEpoch !== undefined && epoch !== this.#repoEpoch);
    if (epoch !== undefined) this.#repoEpoch = epoch;
    if (restored) this.#reported = 0;
    this.#jobsReported =
      restored || done < this.#jobsReported.done
        ? { done, live: {} }
        : jobsDoneTo(this.#jobsReported, done);
  }

  #reportOwed(): boolean {
    return this.#stateOwed() !== undefined || this.jobReports().length > 0;
  }

  #earlierEnds(attempt: number): AttemptEnd[] {
    return this.engine
      .rows<AttemptRow>("SELECT * FROM run_attempts WHERE attempt < ? ORDER BY attempt", attempt)
      .map((row) => ({
        attempt: row.attempt,
        conclusion: row.conclusion as AttemptConclusion,
        triggeringActor: row.triggering_actor_id,
        startedAt: row.started_at,
        completedAt: row.completed_at as number,
      }));
  }

  async #reportState(): Promise<void> {
    const jobs = this.jobReports();
    const report = this.#stateOwed() ?? (jobs.length > 0 ? this.runReport() : undefined);
    if (!report) return;
    const earlier = this.#earlierEnds(report.attempt);
    const answer = await this.#repoCall(
      "reportRun",
      (repo) =>
        // The RPC stub's type of a union answer is not assignable to the union; it is the union.
        repo.reportRun(report, { earlier, jobs }) as unknown as ReturnType<RepoDO["reportRun"]>,
    );
    // Retried: a transfer ends, and a deleted repository erases the run (`#marked`).
    if (!answer.ok) throw new Error(answer.code);
    // By the greatest: a slice taken over may be answered after the one that took over.
    this.#reported = Math.max(this.#reported, runStateSeq(report.attempt, report.phase));
    this.#jobsReported = jobMoves(this.#jobsReported, jobs).told;
    this.#takeRepository(answer);
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
    if (!this.engine.run()) return { done: true };
    if (this.#expired()) {
      // Its retention ended: retired from here on, by a job of its own that never gives up.
      this.jobs.ensure("run_retire", RUN_JOB.retire);
      return { done: true };
    }
    const outcome = await this.#register();
    if (outcome === "gone") {
      await this.#repositoryGone();
      return { done: true };
    }
    if (outcome !== "ok") return { done: false, cursor: null, runAfterMs: this.policy.sweepMs };
    // Checked again at its expiry, when that comes before the next week's check.
    const expiresAt = this.#expiresAt();
    const untilExpiry = expiresAt === undefined ? Infinity : expiresAt - this.context.now();
    return {
      done: false,
      cursor: null,
      // Past it already (the registration's await crossed it): at once, so the check retires it.
      runAfterMs: Math.max(0, Math.min(this.policy.reconcileMs, untilExpiry)),
    };
  }

  /**
   * Writes the run's record and state into its repository, which also answers whether the
   * repository is deleted: `gone` only then. Other calls refuse a repository still being generated
   * from its template as not found too, so a run asks here before erasing itself over such a
   * refusal.
   */
  async #register(): Promise<"ok" | "gone" | "retry"> {
    const run = this.engine.run();
    if (!run) return "gone";
    try {
      const state = this.runReport();
      const answer = await this.#repoCall(
        "registerRun",
        (repo) =>
          // The RPC stub's type of a union answer is not assignable to the union; it is the union.
          repo.registerRun({
            runId: run.run_id,
            sha: run.sha,
            path: run.workflow_path,
            ...(state && { state }),
          }) as unknown as ReturnType<RepoDO["registerRun"]>,
      );
      if (!answer.ok) return answer.code === "repo_not_found" ? "gone" : "retry";
      this.#takeRepository(answer);
      if (this.#reportOwed()) this.jobs.ensure("run_checks", RUN_JOB.checks);
      return "ok";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (repoGone(message)) return "gone";
      this.#log.warn("run record not written", { error: message });
      return "retry";
    }
  }

  /**
   * Retires the expired run: sends its check outbox and reports its state
   * once (best effort), so a required check is not left pending; asks the repository to forget it;
   * then erases it. A failure is retried at the sweep's interval, the run
   * kept and answered as no run, and never ends the job: once begun, the
   * retirement holds whatever the retention becomes. Work still owed then
   * is dropped, with a warning naming it.
   */
  async #retire(
    job: Job,
  ): Promise<{ done: true } | { done: false; cursor: Uint8Array | null; runAfterMs: number }> {
    const run = this.engine.run();
    if (!run) return { done: true };
    const owedBefore = (job.cursor?.length ?? 0) > 0;
    let reportsOwed = owedBefore;
    const retry = () => ({
      done: false as const,
      cursor: reportsOwed ? REPORTS_OWED : null,
      runAfterMs: this.policy.sweepMs,
    });
    // Answered as no run already: its live log sockets close now, not once the erasure succeeds.
    this.viewers.erased();
    try {
      await this.#flushChecks(job);
    } catch (error) {
      this.#log.warn("check updates of a retiring run not sent", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      while (this.#reportOwed()) await this.#reportState();
    } catch (error) {
      reportsOwed = true;
      this.#log.warn("state of a retiring run not reported", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Once forgotten, the repository accepts reports and tells no one: whether it took them before
    // is kept across retries.
    if (!this.jobs.checkpoint(job, reportsOwed ? REPORTS_OWED : new Uint8Array())) return retry();
    try {
      const answer = await this.#repoCall(
        "forgetRun",
        (repo) =>
          // The RPC stub's type of a union answer is not assignable to the union; it is the union.
          repo.forgetRun({ runId: run.run_id }) as unknown as ReturnType<RepoDO["forgetRun"]>,
      );
      if (!answer.ok && answer.code !== "repo_not_found") {
        this.#log.warn("retiring run not forgotten by its repository", { code: answer.code });
        reportsOwed = owedBefore;
        return retry();
      }
      if (!answer.ok) reportsOwed = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!repoGone(message)) {
        this.#log.warn("retiring run not forgotten by its repository", { error: message });
        return retry();
      }
      reportsOwed = false;
    }
    try {
      const owed = this.#owedNames();
      if (reportsOwed) owed.push("reports");
      await this.erase(run.repo_id);
      // Counted once, when the run is gone: a retry before then may still deliver the work.
      if (owed.length > 0) {
        this.#log.warn("a run retired with work still owed", { owed });
        for (const kind of owed) this.context.metrics.count("ci.run_retired_owed", { owed: kind });
      }
    } catch (error) {
      // Its repository forgot it: retried until erased, never given up as a failed job.
      this.#log.warn("retiring run not erased", {
        error: error instanceof Error ? error.message : String(error),
      });
      return retry();
    }
    return { done: true };
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
    if (this.engine.rows("SELECT 1 FROM ci_delivery_failures LIMIT 1").length > 0) {
      this.jobs.ensure("ci_delivery", RUN_JOB.delivery);
      return true;
    }
    return this.#reservations.owed();
  }

  /** What the run still owes outside the object, by name; nothing scheduled (unlike `#owed`). */
  #owedNames(): string[] {
    const run = this.engine.run();
    if (!run) return [];
    const owed: string[] = [];
    if (
      this.engine.rows("SELECT 1 FROM run_checks WHERE parked IS NULL AND sent_rev < rev LIMIT 1")
        .length > 0
    )
      owed.push("checks");
    if (run.queue_synced_rev < run.queue_rev) owed.push("dispatch");
    if (
      this.engine.rows("SELECT 1 FROM run_owners WHERE state IN ('admitting', 'releasing') LIMIT 1")
        .length > 0
    )
      owed.push("concurrency");
    if (run.task_end_acked < run.task_end_seq) owed.push("task_end");
    // Any not settled, due now or later (`RunReservations.owed` counts only the due, and schedules).
    if (
      this.engine.rows("SELECT 1 FROM ci_reservations WHERE state <> 'settled' LIMIT 1").length > 0
    )
      owed.push("reservations");
    return owed;
  }

  override async alarm(): Promise<void> {
    // Measured either way: the invocation's call budget bounds an erased run's purge too.
    await measureInvocation(
      this.context.metrics,
      { where: "do", op: "alarm", doClass: "RunDO" },
      async () => {
        if (this.#erased()) await this.#erasedAlarm();
        else await this.jobs.runDue(this.#due(), this.memory, this.context.now() + ALARM_BUDGET_MS);
      },
    );
  }

  /**
   * The handlers an alarm runs. Once the run retires, only its retirement
   * acts: any other job's slice ends it at once (the erasure deletes it
   * anyway), so none acts for a run its repository may have forgotten, such
   * as a concurrency request replayed after the coordinator forgot the run.
   */
  #due(): Partial<Record<JobKind, JobHandler>> {
    const handlers = this.#handlers();
    for (const kind of Object.keys(handlers) as JobKind[]) {
      const handler = handlers[kind] as JobHandler;
      // Decided as each slice starts: a retirement may begin within this alarm.
      if (kind !== "run_retire")
        handlers[kind] = {
          ...handler,
          runSlice: (job) =>
            this.#retiring() ? Promise.resolve({ done: true }) : handler.runSlice(job),
        };
    }
    return handlers;
  }

  /**
   * Runs the run's weekly check as at `at` (never earlier than now), then a
   * retirement it began, slice by slice: what the alarm would do at `at`
   * (a local check of retention). No route of the Worker reaches it.
   */
  async ciReconcileAt(
    at: number,
  ): Promise<{ erased: boolean; jobs: string[]; alarm: number | null }> {
    const clock = this.context as { now: () => number };
    const real = clock.now;
    clock.now = () => Math.max(at, real());
    try {
      const handlers = this.#handlers();
      for (const [jobId, kind] of [
        [RUN_JOB.reconcile, "run_reconcile"],
        [RUN_JOB.retire, "run_retire"],
      ] as const) {
        const handler = handlers[kind];
        if (handler && !this.#erased())
          await this.jobs.runJob(jobId, handler, this.memory, real() + ALARM_BUDGET_MS);
      }
      // Erased: its log purge now rather than once a late write would have landed.
      if (this.#erased()) {
        await this.jobs.runJob(
          RUN_JOB.logPurge,
          { runSlice: () => this.#purgeSlice() },
          this.memory,
          real() + ALARM_BUDGET_MS,
        );
        await this.#settleErased();
      }
    } finally {
      clock.now = real;
    }
    return {
      erased: this.#erased(),
      jobs: this.engine
        .rows<{ job_id: string; state: string }>(
          "SELECT job_id, state FROM jobs WHERE state IN ('queued', 'running') ORDER BY job_id",
        )
        .map((row) => `${row.job_id}:${row.state}`),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
}

/**
 * Bytes of UTF-8 that hold `points` whole code points whatever they are, read
 * as a blob: SQLite's text `substr` stops at an embedded NUL (measured in workerd).
 */
const utf8Bound = (points: number) => 4 * points + 3;

function codePointPrefix(bytes: ArrayBuffer, points: number): string {
  let out = "";
  let n = 0;
  for (const point of new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)) {
    if (n === points) break;
    out += point;
    n++;
  }
  return out;
}
