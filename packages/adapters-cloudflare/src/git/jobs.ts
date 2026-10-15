import type { MemoryReservation } from "@fyrden/git-core";
import { currentInvocation } from "../obs/invocation.js";
import { newUlid } from "./keys.js";
import type { DoMemoryBudget } from "./memory-budget.js";
import { countRowsWritten, first, type GitStorageContext, rows, run } from "./sql.js";

export const JOB_KINDS = [
  "index",
  "compact",
  "mergeability",
  "merge_saga",
  "search_index",
  "reflog_prune",
  "reachability",
  "detach",
  "fork_graph_copy",
  "archive",
  "audit_archive",
  "reap_orphans",
  "import",
  "repack",
  "gc",
  "retire_packs",
  "network_gc",
  "network_delete",
  "storage_confirm",
  "pull_notices",
  "revision_import",
  "pull_follow",
  "view_compact",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface Job {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly cursor: Uint8Array | null;
  readonly attempts: number;
  /** The run's claim on the job (see `JobQueue`); `checkpoint` writes under it. */
  readonly claim: number;
}

/** Where a job stands after `runJob`: `busy` when another run holds it. */
export type RunJobState = "done" | "queued" | "failed" | "busy" | "missing";

/** What one slice of a job did. */
export type SliceResult =
  | { readonly done: true }
  | { readonly done: false; readonly cursor: Uint8Array | null; readonly runAfterMs?: number };

export interface JobHandler {
  /** Bytes to reserve from the operation pool for one slice (0 or absent: none). */
  readonly memoryBytes?: number;
  /** Runs one bounded slice. Throwing counts as a failed attempt. */
  runSlice(job: Job): Promise<SliceResult>;
}

export interface JobPolicy {
  /** How long a running slice owns its job before another run may take it over. */
  readonly leaseMs: number;
  /** Attempts before a job is marked failed. */
  readonly maxAttempts: number;
  /** Delay before retrying a failed slice; doubles per attempt. */
  readonly backoffMs: number;
  /** Delay before trying again when the operation pool is short. */
  readonly memoryRetryMs: number;
  /**
   * Calls to internal services (R2, D1, Durable Objects) the invocation may
   * have made for the queue to start another slice; past it, the rest waits
   * for the alarm, a new invocation with a fresh budget. Free allows 1,000
   * per invocation (measured on Workers Free, 2026-10-10). Default 800
   * (Proposed): one slice must stay within the rest.
   */
  readonly maxInternalCalls?: number;
}

/** Proposed defaults, tuned once alarm CPU budgets are measured. */
const DEFAULT_MAX_INTERNAL_CALLS = 800;

export const DEFAULT_JOB_POLICY: JobPolicy = {
  leaseMs: 60_000,
  maxAttempts: 10,
  backoffMs: 1_000,
  memoryRetryMs: 5_000,
  maxInternalCalls: DEFAULT_MAX_INTERNAL_CALLS,
};

/** Internal-service calls the current platform invocation has made (0 outside any measured invocation). */
const invocationInternalCalls = (): number => currentInvocation()?.tally.internal ?? 0;

type RawJob = {
  job_id: string;
  kind: string;
  cursor: ArrayBuffer | null;
  attempts: number;
  claim: number;
};

/**
 * Resumable background work. A Durable Object has one alarm, so this table
 * is the scheduler: `runDue` runs due jobs slice by slice, each slice saving
 * its cursor, and the alarm is set to the earliest `next_run_at`. A slice
 * that dies with the object (eviction, reset) leaves its cursor and lease
 * behind; the job is taken over when the lease expires.
 *
 * Every claim increments the job's `claim` number, and a slice's result is
 * recorded only while its claim is still the job's: a runner that outlives
 * its lease (a slow R2 call) and was taken over cannot overwrite the cursor,
 * attempts or final state its successor recorded.
 */
export class JobQueue {
  constructor(
    private readonly context: GitStorageContext,
    /** Arms the object's alarm (`ctx.storage.setAlarm`). */
    private readonly setAlarm: (at: number) => void,
    private readonly policy: JobPolicy = DEFAULT_JOB_POLICY,
    /** Internal-service calls made so far in the current invocation. */
    private readonly internalCalls: () => number = invocationInternalCalls,
  ) {}

  /** Whether the invocation has nearly spent its internal-call budget: no slice starts. */
  #callsSpent(): boolean {
    return this.internalCalls() >= (this.policy.maxInternalCalls ?? DEFAULT_MAX_INTERNAL_CALLS);
  }

  /** Whether the time (`deadline`) or the internal-call budget leaves no room for another slice. */
  #outOfBudget(deadline: number): boolean {
    return this.context.now() >= deadline || this.#callsSpent();
  }

  enqueue(kind: JobKind, cursor: Uint8Array | null = null, runAt?: number): string {
    if (!JOB_KINDS.includes(kind)) throw new RangeError(`unknown job kind ${kind}`);
    const now = this.context.now();
    const jobId = newUlid(now);
    const at = runAt ?? now;
    const written = run(
      this.context.storage,
      `INSERT INTO jobs (job_id, kind, state, cursor, next_run_at, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
      jobId,
      kind,
      cursor ? new Uint8Array(cursor).buffer : null,
      at,
      now,
      now,
    );
    countRowsWritten(this.context, "jobs.enqueue", written);
    this.rearm();
    return jobId;
  }

  /**
   * Schedules the job with this id unless it is already scheduled: a new
   * job is queued at `runAt`; a queued one runs at the earlier of its time
   * and `runAt`; a finished or failed one is queued again from `cursor`; a
   * running one is left to its slice, which reschedules it. Returns true
   * when this call queued the job. For singleton jobs and jobs keyed by
   * what they work on (`indexJobId`).
   */
  ensure(
    kind: JobKind,
    jobId: string,
    options: { runAt?: number; cursor?: Uint8Array | null } = {},
  ): boolean {
    if (!JOB_KINDS.includes(kind)) throw new RangeError(`unknown job kind ${kind}`);
    const { storage } = this.context;
    const now = this.context.now();
    const at = options.runAt ?? now;
    const cursor = options.cursor ? new Uint8Array(options.cursor).buffer : null;
    const outcome = storage.transactionSync(() => {
      const row = first<{ kind: string; state: string }>(
        storage,
        "SELECT kind, state FROM jobs WHERE job_id = ?",
        jobId,
      );
      if (row && row.kind !== kind) throw new Error(`job ${jobId} is a ${row.kind} job`);
      if (!row)
        return {
          queued: true,
          written: run(
            storage,
            `INSERT INTO jobs (job_id, kind, state, cursor, next_run_at, created_at, updated_at)
             VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
            jobId,
            kind,
            cursor,
            at,
            now,
            now,
          ),
        };
      if (row.state === "queued")
        return {
          queued: false,
          written: run(
            storage,
            `UPDATE jobs SET next_run_at = ?, updated_at = ?
             WHERE job_id = ? AND next_run_at > ?`,
            at,
            now,
            jobId,
            at,
          ),
        };
      if (row.state === "running") return { queued: false, written: 0 };
      return {
        queued: true,
        written: run(
          storage,
          `UPDATE jobs SET state = 'queued', cursor = ?, attempts = 0, next_run_at = ?,
             lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE job_id = ?`,
          cursor,
          at,
          now,
          jobId,
        ),
      };
    });
    countRowsWritten(this.context, "jobs.ensure", outcome.written);
    if (outcome.written > 0) this.rearm();
    return outcome.queued;
  }

  /**
   * Saves a running slice's cursor before the slice ends, under its claim,
   * for a slice whose effect and checkpoint must commit together: called
   * inside the slice's own transaction, the cursor is saved with its
   * writes or not at all. A slice that then fails is retried from this
   * cursor, not the one it started with. False when the claim is no longer
   * the job's (the slice was taken over): the caller rolls back.
   */
  checkpoint(job: Job, cursor: Uint8Array): boolean {
    const written = run(
      this.context.storage,
      `UPDATE jobs SET cursor = ?, updated_at = ?
       WHERE job_id = ? AND state = 'running' AND claim = ?`,
      new Uint8Array(cursor).buffer,
      this.context.now(),
      job.jobId,
      job.claim,
    );
    countRowsWritten(this.context, "jobs.checkpoint", written);
    return written > 0;
  }

  get(jobId: string): { state: string; attempts: number; cursor: Uint8Array | null } | undefined {
    const row = first<{ state: string; attempts: number; cursor: ArrayBuffer | null }>(
      this.context.storage,
      "SELECT state, attempts, cursor FROM jobs WHERE job_id = ?",
      jobId,
    );
    return (
      row && {
        state: row.state,
        attempts: row.attempts,
        cursor: row.cursor ? new Uint8Array(row.cursor) : null,
      }
    );
  }

  /**
   * Runs every due job, one slice at a time, until none is due, `deadline`
   * (a time from `now`) passes or the invocation's internal-call budget is
   * nearly spent, then re-arms the alarm.
   */
  async runDue(
    handlers: Partial<Record<JobKind, JobHandler>>,
    memory: DoMemoryBudget,
    deadline: number,
  ): Promise<number> {
    let slices = 0;
    for (;;) {
      if (this.#outOfBudget(deadline)) break;
      const next = this.#nextDue(Object.keys(handlers) as JobKind[]);
      if (!next) break;
      const handler = handlers[next.kind] as JobHandler;
      // Memory first: a job is claimed only once its slice can run, so a
      // run whose lease expired keeps its claim while the pool is short.
      const reservation = this.#admit(handler, memory);
      if (reservation === "short") {
        this.#postpone(next);
        continue;
      }
      const job = this.#releasingOnThrow(reservation, () => this.#claimDue(next.job_id));
      if (!job) {
        reservation?.release();
        continue;
      }
      if ((await this.#runClaimed(job, handler, reservation)) === "ran") slices++;
    }
    this.rearm();
    return slices;
  }

  /**
   * Runs the job `jobId` now, whatever its scheduled time, slice by slice
   * until it finishes, `deadline` passes or the invocation's internal-call
   * budget is nearly spent (then the job stays `queued`; a slice is started
   * only within the call budget), then re-arms the alarm, which continues
   * it. For work a request starts and the alarm finishes (a push's index
   * job). A job another run holds (an unexpired lease) is left alone: `busy`.
   */
  async runJob(
    jobId: string,
    handler: JobHandler,
    memory: DoMemoryBudget,
    deadline: number,
  ): Promise<{ slices: number; state: RunJobState }> {
    let slices = 0;
    let state = "missing" as RunJobState;
    try {
      for (;;) {
        if (this.#callsSpent()) {
          if (slices === 0) state = this.#stateOf(jobId);
          break;
        }
        const reservation = this.#admit(handler, memory);
        if (reservation === "short") {
          // The pool is short: the job stays as it is, for a later run.
          state = this.#stateOf(jobId);
          break;
        }
        const job = this.#releasingOnThrow(reservation, () => this.#claim(jobId));
        if (!job) {
          reservation?.release();
          if (slices === 0) state = this.get(jobId) ? "busy" : "missing";
          break;
        }
        const ran = await this.#runClaimed(job, handler, reservation);
        if (ran === "taken-over") {
          state = "busy";
          break;
        }
        slices++;
        state = this.#stateOf(jobId);
        // A slice that asked to go on later is not run again now.
        if (state !== "queued" || this.#outOfBudget(deadline) || this.#later(jobId)) break;
      }
    } finally {
      this.rearm();
    }
    return { slices, state };
  }

  /** Runs `claim`, giving `reservation` back if it throws. */
  #releasingOnThrow<T>(reservation: MemoryReservation | undefined, claim: () => T): T {
    try {
      return claim();
    } catch (error) {
      reservation?.release();
      throw error;
    }
  }

  /** The memory a slice of `handler` needs, reserved; "short" when the pool has no room. */
  #admit(handler: JobHandler, memory: DoMemoryBudget): MemoryReservation | undefined | "short" {
    if (!handler.memoryBytes) return undefined;
    return memory.tryReserve(handler.memoryBytes) ?? "short";
  }

  /**
   * Runs one slice of a claimed job, its memory already reserved, and
   * records the result: "taken-over" when another run claimed the job
   * meanwhile (nothing of this slice is recorded).
   */
  async #runClaimed(
    job: Job,
    handler: JobHandler,
    reservation: MemoryReservation | undefined,
  ): Promise<"ran" | "taken-over"> {
    let recorded: boolean;
    try {
      const result = await handler.runSlice(job);
      recorded = result.done
        ? this.#finish(job, "done", null)
        : this.#update(job, result.cursor, job.attempts, result.runAfterMs ?? 0, null);
    } catch (error) {
      const attempts = job.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      recorded =
        attempts >= this.policy.maxAttempts
          ? this.#finish(job, "failed", message)
          : // The cursor stays as it is: the one the slice started from, or its checkpoint.
            this.#update(
              job,
              undefined,
              attempts,
              this.policy.backoffMs * 2 ** (attempts - 1),
              message,
            );
    } finally {
      reservation?.release();
    }
    return recorded ? "ran" : "taken-over";
  }

  /** The job's state as `runJob` reports it: `busy` while another run holds it. */
  #stateOf(jobId: string): RunJobState {
    const state = this.get(jobId)?.state;
    if (state === undefined) return "missing";
    return state === "running" ? "busy" : (state as RunJobState);
  }

  /** When the earliest pending job is due (or its runner's lease expires), or null when none is pending. */
  nextAt(): number | null {
    const next = first<{ at: number | null }>(
      this.context.storage,
      `SELECT min(CASE WHEN state = 'running' THEN lease_expires_at ELSE next_run_at END) AS at
       FROM jobs WHERE state IN ('queued', 'running')`,
    );
    return next?.at ?? null;
  }

  /** Sets the alarm to the earliest pending job, if any. */
  rearm(): void {
    const at = this.nextAt();
    if (at !== null) this.setAlarm(at);
  }

  /** Claims the job `jobId` if it is queued (at any time) or its runner's lease has expired. */
  #claim(jobId: string): Job | undefined {
    const { storage } = this.context;
    const now = this.context.now();
    return storage.transactionSync(() => {
      const raw = rows<RawJob>(
        storage,
        `SELECT job_id, kind, cursor, attempts, claim FROM jobs
         WHERE job_id = ? AND (state = 'queued' OR (state = 'running' AND lease_expires_at <= ?))`,
        jobId,
        now,
      )[0];
      return raw && this.#take(raw, now);
    });
  }

  #take(raw: RawJob, now: number): Job {
    const claim = raw.claim + 1;
    const written = run(
      this.context.storage,
      `UPDATE jobs SET state = 'running', claim = ?, lease_expires_at = ?, updated_at = ?
       WHERE job_id = ?`,
      claim,
      now + this.policy.leaseMs,
      now,
      raw.job_id,
    );
    countRowsWritten(this.context, "jobs.claim", written);
    return {
      jobId: raw.job_id,
      kind: raw.kind as JobKind,
      cursor: raw.cursor ? new Uint8Array(raw.cursor) : null,
      attempts: raw.attempts,
      claim,
    };
  }

  /** The next due job of `kinds` (queued and due, or running past its lease), not claimed. */
  #nextDue(
    kinds: readonly JobKind[],
  ): { job_id: string; kind: JobKind; state: string; claim: number } | undefined {
    if (kinds.length === 0) return undefined;
    const now = this.context.now();
    return rows<{ job_id: string; kind: JobKind; state: string; claim: number }>(
      this.context.storage,
      `SELECT job_id, kind, state, claim FROM jobs
       WHERE kind IN (${kinds.map(() => "?").join(", ")})
         AND ((state = 'queued' AND next_run_at <= ?)
           OR (state = 'running' AND lease_expires_at <= ?))
       ORDER BY next_run_at, job_id LIMIT 1`,
      ...kinds,
      now,
      now,
    )[0];
  }

  /** Claims the job `jobId` if it is still due (queued and due, or past its lease). */
  #claimDue(jobId: string): Job | undefined {
    const { storage } = this.context;
    const now = this.context.now();
    return storage.transactionSync(() => {
      const raw = rows<RawJob>(
        storage,
        `SELECT job_id, kind, cursor, attempts, claim FROM jobs
         WHERE job_id = ? AND ((state = 'queued' AND next_run_at <= ?)
           OR (state = 'running' AND lease_expires_at <= ?))`,
        jobId,
        now,
        now,
      )[0];
      return raw && this.#take(raw, now);
    });
  }

  /**
   * A due job whose slice found the pool short waits `memoryRetryMs`: a
   * queued one is due later; a running one whose lease expired keeps its
   * runner's claim, with the lease extended (that runner may still finish).
   */
  #postpone(job: { job_id: string; state: string; claim: number }): void {
    const at = this.context.now() + this.policy.memoryRetryMs;
    const written =
      job.state === "queued"
        ? run(
            this.context.storage,
            "UPDATE jobs SET next_run_at = ? WHERE job_id = ? AND state = 'queued' AND claim = ?",
            at,
            job.job_id,
            job.claim,
          )
        : run(
            this.context.storage,
            `UPDATE jobs SET lease_expires_at = ? WHERE job_id = ? AND state = 'running' AND claim = ?`,
            at,
            job.job_id,
            job.claim,
          );
    countRowsWritten(this.context, "jobs.postpone", written);
  }

  /** Whether the queued job `jobId` is due only later (its slice asked for a delay). */
  #later(jobId: string): boolean {
    const row = rows<{ next_run_at: number }>(
      this.context.storage,
      "SELECT next_run_at FROM jobs WHERE job_id = ? AND state = 'queued'",
      jobId,
    )[0];
    return row !== undefined && row.next_run_at > this.context.now();
  }

  /**
   * Queues the job again under its claim (with `cursor`, or the stored one
   * when undefined); false when the claim is no longer the job's.
   */
  #update(
    job: Job,
    cursor: Uint8Array | null | undefined,
    attempts: number,
    delayMs: number,
    error: string | null,
  ): boolean {
    const now = this.context.now();
    const written = run(
      this.context.storage,
      `UPDATE jobs SET state = 'queued', cursor = CASE WHEN ? THEN cursor ELSE ? END,
         attempts = ?, next_run_at = ?, lease_expires_at = NULL, last_error = ?, updated_at = ?
       WHERE job_id = ? AND state = 'running' AND claim = ?`,
      cursor === undefined ? 1 : 0,
      cursor ? new Uint8Array(cursor).buffer : null,
      attempts,
      now + delayMs,
      error,
      now,
      job.jobId,
      job.claim,
    );
    countRowsWritten(this.context, "jobs.checkpoint", written);
    return written > 0;
  }

  /** Ends the job under its claim; false when the claim is no longer the job's. */
  #finish(job: Job, state: "done" | "failed", error: string | null): boolean {
    const written = run(
      this.context.storage,
      `UPDATE jobs SET state = ?, lease_expires_at = NULL, last_error = ?, updated_at = ?
       WHERE job_id = ? AND state = 'running' AND claim = ?`,
      state,
      error,
      this.context.now(),
      job.jobId,
      job.claim,
    );
    countRowsWritten(this.context, "jobs.finish", written);
    return written > 0;
  }
}
