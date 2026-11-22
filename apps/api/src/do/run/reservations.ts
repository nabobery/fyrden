import type { Job, SliceResult } from "@fyrden/adapters-cloudflare/git";
import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  CI_SETTLE_GRACE_MS,
  type CiLimits,
  type CiPrice,
  ciAllowance,
  ciFleetCap,
  ciJobPrice,
  ciMaxJobMinutes,
  grantCi,
  releaseCi,
  settleCi,
} from "../../ci/budget.js";
import { eligibleJob } from "../../runner/registry.js";
import type { CiMinutesAnswer } from "../org/ci-minutes.js";
import type { RunEngine, RunPolicy, RunRow } from "./engine.js";

/*
 * A run's CI reservations: before a queued job instance is published to
 * runners it reserves its minutes in its account's object and, on Free, its
 * price in the CI ledger first (the cheaper refusal; a ledger refusal writes
 * nothing and asks no account). One row an instance (`ci_reservations`)
 * holds its current reservation; its states:
 *
 *   wanted   -> wanted    a job no runner may take (a fork job, a public or
 *                        inactive repository): no store asked; checked again
 *                        on the run's next dispatch pass
 *   wanted   -> minutes   ledger granted (Free), or at once on Paid
 *   wanted   -> refused   ledger refused (nothing written)
 *   minutes  -> reserved  account granted; published, assignable in its window
 *   minutes  -> refused   account refused, after the ledger released
 *   wanted   -> wanted    an answer expired or released: released, seq + 1
 *   refused  -> wanted    its retry time reached: seq + 1
 *   reserved -> running   a new assignment (RunDO.assign)
 *   reserved -> wanted    window lapsed or account moved: both released, seq + 1
 *   any      -> ending    the instance ended, with a task or none
 *   ending   -> settled   running: settled in both stores; else released in both
 *
 * Every call is made by the reserve slice with the row's key, its inputs
 * fixed in the row before the first call, and its answer is recorded only
 * while the row still has the seq and state it was asked from. A call
 * without an answer leaves the row as it was, so the slice asks again with
 * the same key; the answer that led to a release stays the same (a lapsed
 * window, an expired key, a key the account released), so a release whose
 * answer was lost is asked again too. A release of a key never granted
 * leaves a tombstone in each store, so a reserve still in flight grants
 * nothing later.
 */

/** A reservation not assigned within this is released and made again. Proposed. */
export const CI_RESERVATION_START_MS = 30 * 60_000;
/** The latest after a reservation's inputs are fixed that any store may grant its key. Proposed. */
export const CI_RESERVATION_VALIDITY_MS = 10 * 60_000;
/** At most this is added to a refused reservation's retry time, spread by key. Proposed. */
export const CI_RETRY_JITTER_MS = 60_000;
/**
 * Refusals after which a waiting instance asks no more: its first ask and
 * two midnight retries fit the 24-hour queue deadline. Proposed.
 */
export const CI_RESERVATION_ASKS = 3;
/** The wait before the first ask after an expired answer; it doubles with each. Proposed. */
export const CI_EXPIRED_RETRY_MS = 60_000;
/** Rows one slice deals with. */
const PAGE = 16;
const MIN = 60_000;

/** A store call of the reserve slice, as its hooks name it. */
export type CiCall =
  | "grant"
  | "reserve"
  | "ledger_release"
  | "minutes_release"
  | "ledger_settle"
  | "minutes_settle";

/** Pause or fail points around each store call, for tests. */
export interface ReservationHooks {
  beforeCiCall?: (op: CiCall, key: string) => Promise<void> | void;
  /** After the store answered, before its answer is recorded. */
  afterCiCall?: (op: CiCall, key: string) => Promise<void> | void;
}

/** How a run pays for its jobs. */
export interface RunCiPolicy {
  /** Free: the CI ledger's limits, granted from before the account's minutes; Paid: null. */
  readonly ledger: CiLimits | null;
  /** Free: the longest a job may run, in minutes; Paid: null (its own timeout). */
  readonly maxJobMinutes: number | null;
}

/** The policy `env` sets (read through `ciEnv` by the run). */
export function runCiPolicy(env: object): RunCiPolicy {
  const allowance = ciAllowance(env);
  return {
    ledger: allowance && { allowance, fleetCap: ciFleetCap(env) },
    maxJobMinutes: ciMaxJobMinutes(env),
  };
}

export type ReservationState =
  | "wanted"
  | "minutes"
  | "reserved"
  | "running"
  | "refused"
  | "ending"
  | "settled";

export type WaitingFor = "ci_minutes" | "daily_capacity";

export interface ReservationRow {
  job_id: number;
  seq: number;
  state: ReservationState;
  key: string | null;
  account_id: string | null;
  agent_id: string | null;
  minutes: number | null;
  price: string | null;
  span_ms: number | null;
  fixed_at: number | null;
  valid_until: number | null;
  settle_by: number | null;
  window_until: number | null;
  retry_at: number | null;
  refusals: number;
  waiting_for: WaitingFor | null;
  started_at: number | null;
  ended_at: number | null;
  ineligible_at: number | null;
  rebind: number;
  asked_for: string | null;
}

/** A row whose inputs are fixed. */
type Fixed = ReservationRow & {
  key: string;
  account_id: string;
  minutes: number;
  span_ms: number;
  fixed_at: number;
  valid_until: number;
  settle_by: number;
};

/** A reservation as `ciReserveNow` reports it. */
export interface ReservationView {
  readonly jobId: number;
  readonly seq: number;
  readonly state: ReservationState;
  readonly waitingFor: WaitingFor | null;
}

/** What the reservations need from their object. */
export interface ReservationHost {
  readonly env: Env;
  readonly engine: RunEngine;
  readonly hooks: ReservationHooks;
  readonly metrics: Metrics;
  readonly log: Logger;
  readonly policy: RunPolicy;
  now(): number;
  tx<T>(fn: () => T): T;
  /** Writes `fn` only while the run exists and `job`'s slice still holds its claim. */
  guarded(job: Job, fn: () => void): void;
  /** How the run pays for its jobs now. */
  ci(): RunCiPolicy;
  /** Has the reserve slice run at `runAt` (now by default), or earlier. */
  ensureSlice(runAt?: number): void;
  /** Has the run's dispatch pass run again within its resync interval. */
  ensureResync(): void;
}

/** What a too-large job's instance is failed with. */
function tooLarge(minutes: number): string {
  return `ci_too_large: at its timeout of ${minutes} minutes the job costs more than this deployment's daily CI allowance; a shorter timeout-minutes may fit`;
}

/** What a job needing more than its account's or agent's monthly CI minutes is failed with. */
function overMonth(minutes: number, reason: "account" | "agent", limit: number): string {
  const whose = reason === "account" ? "the account's" : "the agent's";
  return `ci_too_large: at its timeout of ${minutes} minutes the job needs more than ${whose} ${limit} CI minutes a month; a shorter timeout-minutes may fit`;
}

/** A key's share of the retry jitter: the same for every ask of one key (FNV-1a). */
function jitter(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
  return (hash >>> 0) % CI_RETRY_JITTER_MS;
}

/** Rows with work due at the time bound three times after it. */
const DUE = `(rebind = 1 OR state IN ('minutes', 'ending')
  OR (state = 'wanted' AND ineligible_at IS NULL AND (retry_at IS NULL OR retry_at <= ?))
  OR (state = 'reserved' AND window_until <= ?)
  OR (state = 'refused' AND retry_at <= ?))`;

export class RunReservations {
  /** Whether this object has warned that a store's clock seems ahead of the run's. */
  #clockWarned = false;

  constructor(private readonly host: ReservationHost) {}

  row(jobId: number): ReservationRow | undefined {
    return this.host.engine.rows<ReservationRow>(
      "SELECT * FROM ci_reservations WHERE job_id = ?",
      jobId,
    )[0];
  }

  // ---------------------------------------------------------------- in the caller's transaction

  /** An instance was queued: it reserves before it is published. */
  want(jobId: number): void {
    this.host.engine.exec(
      "INSERT INTO ci_reservations (job_id, seq, state) VALUES (?, 1, 'wanted') ON CONFLICT DO NOTHING",
      jobId,
    );
    this.host.ensureSlice();
  }

  /**
   * An instance ended, by any path: its reservation is settled or released by
   * the slice, for the account it was made for. A mark to reserve again for a
   * new owner is dropped: nothing is left to reserve.
   */
  end(jobId: number, at: number): void {
    const row = this.row(jobId);
    if (!row || row.state === "ending" || row.state === "settled") return;
    this.host.engine.exec(
      "UPDATE ci_reservations SET state = 'ending', ended_at = ?, ineligible_at = NULL, rebind = 0 WHERE job_id = ?",
      at,
      jobId,
    );
    this.host.ensureSlice();
  }

  /**
   * Whether instance `jobId` may be newly assigned to a runner of
   * `accountId`: reserved, inside its start window, for that account, and
   * priced by the ledger when the deployment has one. One reserved for
   * another account, or reserved on Paid before the deployment moved to
   * Free, is released and reserved again.
   */
  admits(jobId: number, accountId: string | undefined): boolean {
    const row = this.row(jobId);
    const now = this.host.now();
    if (row?.state !== "reserved" || row.rebind === 1 || (row.window_until ?? 0) <= now)
      return false;
    // Reserved without the ledger (Paid) while the deployment is now Free: released and reserved
    // again under Free's allowance and clamp, never run on the old terms.
    if (row.price === null && this.host.ci().ledger !== null) {
      this.#closeWindow(jobId, now);
      return false;
    }
    if (accountId === undefined || row.account_id === accountId) return true;
    this.#closeWindow(jobId, now);
    return false;
  }

  /** A new assignment of instance `jobId` at `at`: its reservation runs. */
  started(jobId: number, at: number): void {
    this.host.engine.exec(
      "UPDATE ci_reservations SET state = 'running', started_at = ? WHERE job_id = ? AND state = 'reserved'",
      at,
      jobId,
    );
  }

  /**
   * Instance `jobId`'s assignment was undone before any runner was given
   * it: its reservation is reserved again, unused, and published while its
   * window holds (the slice reserves again once it lapses).
   */
  unassigned(jobId: number): void {
    this.host.engine.exec(
      "UPDATE ci_reservations SET state = 'reserved', started_at = NULL WHERE job_id = ? AND state = 'running'",
      jobId,
    );
    this.host.engine.bumpQueue();
    this.host.ensureSlice();
  }

  /**
   * The repository's owner is `accountId` now: every unassigned reservation
   * made for another account (waiting, refused, asking, or reserved and no
   * longer published) is released and made again for it; a job found
   * ineligible is checked again. The slice is ensured for any work due (a
   * reservation its object's upgrade wrote, too).
   */
  ownedBy(accountId: string): void {
    this.host.engine.exec(
      "UPDATE ci_reservations SET ineligible_at = NULL WHERE ineligible_at IS NOT NULL",
    );
    this.host.engine.exec(
      `UPDATE ci_reservations SET rebind = 1
       WHERE rebind = 0 AND key IS NOT NULL AND account_id <> ?
         AND state IN ('wanted', 'refused', 'minutes', 'reserved')`,
      accountId,
    );
    this.owed();
  }

  #closeWindow(jobId: number, now: number): void {
    this.host.engine.exec(
      "UPDATE ci_reservations SET window_until = ? WHERE job_id = ? AND state = 'reserved'",
      now,
      jobId,
    );
    this.host.engine.bumpQueue();
    this.host.ensureSlice();
  }

  /**
   * Whether a queued job waits unpublished (to be eligible, refused, or
   * asking): the run's dispatch passes go on, so a transfer or a change of
   * visibility is noticed.
   */
  waiting(): boolean {
    return (
      this.host.engine.rows(
        "SELECT 1 FROM ci_reservations WHERE state IN ('wanted', 'refused', 'minutes') LIMIT 1",
      ).length > 0
    );
  }

  /** Whether any reservation has work due now; the slice is ensured for it. */
  owed(): boolean {
    const now = this.host.now();
    const due = this.host.engine.rows(
      `SELECT 1 FROM ci_reservations WHERE ${DUE} LIMIT 1`,
      now,
      now,
      now,
    );
    if (due.length > 0) this.host.ensureSlice();
    return due.length > 0;
  }

  /** Makes every refused reservation due now (it keeps its refusal count). */
  retryNow(): void {
    const now = this.host.now();
    this.host.engine.exec(
      "UPDATE ci_reservations SET retry_at = ? WHERE state = 'refused' AND retry_at > ?",
      now,
      now,
    );
    this.host.ensureSlice();
  }

  views(): ReservationView[] {
    return this.host.engine
      .rows<ReservationRow>("SELECT * FROM ci_reservations ORDER BY job_id")
      .map((r) => ({ jobId: r.job_id, seq: r.seq, state: r.state, waitingFor: r.waiting_for }));
  }

  // ---------------------------------------------------------------- the reserve slice

  /**
   * Moves due reservations on, a page at a time, each by the calls its state
   * needs; then schedules itself for the next window or retry time.
   */
  async slice(job: Job): Promise<SliceResult> {
    const run = this.host.engine.run();
    if (!run) return { done: true };
    const now = this.host.now();
    const rows = this.host.engine.rows<ReservationRow>(
      `SELECT * FROM ci_reservations WHERE ${DUE} ORDER BY job_id LIMIT ?`,
      now,
      now,
      now,
      PAGE,
    );
    let directory: Promise<Directory> | undefined;
    const read = () => {
      directory ??= this.#readDirectory(run);
      return directory;
    };
    let progressed = false;
    for (const first of rows) {
      let row: ReservationRow | undefined = first;
      // Fixing the inputs, then the first call, in one pass.
      for (let i = 0; i < 2 && row; i++) {
        const next = await this.#step(job, run, row, read);
        if (!next.stuck) progressed = true;
        row = next.then;
      }
    }
    return this.#next(progressed);
  }

  #next(progressed: boolean): SliceResult {
    const { engine, policy } = this.host;
    const now = this.host.now();
    if (engine.rows(`SELECT 1 FROM ci_reservations WHERE ${DUE} LIMIT 1`, now, now, now).length > 0)
      // A row that cannot move (its repository is gone from the directory) is not asked in a loop.
      return { done: false, cursor: null, runAfterMs: progressed ? 0 : policy.sweepMs };
    const [later] = engine.rows<{ at: number | null }>(
      `SELECT min(CASE state WHEN 'reserved' THEN window_until ELSE retry_at END) AS at
       FROM ci_reservations WHERE state IN ('reserved', 'refused')
         OR (state = 'wanted' AND ineligible_at IS NULL)`,
    );
    if (later?.at === null || later?.at === undefined) return { done: true };
    return { done: false, cursor: null, runAfterMs: Math.max(0, later.at - now) };
  }

  /** One transition of `row`, and the row as it now stands when another may follow at once. */
  async #step(
    job: Job,
    run: RunRow,
    row: ReservationRow,
    directory: () => Promise<Directory>,
  ): Promise<Step> {
    if (row.rebind === 1 && row.state !== "ending") {
      await this.#rebind(job, fixed(row));
      return {};
    }
    switch (row.state) {
      case "ending":
        await this.#resolve(job, row);
        return {};
      case "refused":
        this.#record(job, row, () => this.#nextSeq(row));
        return {};
      case "reserved":
        await this.#lapse(job, fixed(row));
        return {};
      case "wanted":
        if (row.key === null) return this.#fix(job, run, row, await directory());
        await this.#grant(job, fixed(row));
        return {};
      case "minutes":
        await this.#reserve(job, fixed(row));
        return {};
      default:
        return { stuck: true };
    }
  }

  /** Fixes a new reservation's inputs, before any store is asked. */
  #fix(job: Job, run: RunRow, row: ReservationRow, directory: Directory): Step {
    const { engine, policy } = this.host;
    // A repository gone from the directory: the run is erased once its repository says so.
    if (directory.owner === undefined) return { stuck: true };
    if (!directory.eligible) {
      this.#record(job, row, () => {
        this.#set(row.job_id, "ineligible_at = ?, waiting_for = NULL", this.host.now());
        this.host.ensureResync();
      });
      return {};
    }
    const instance = engine.instance(row.job_id);
    const actor = instance && engine.attempt(instance.attempt)?.triggering_actor_id;
    if (!instance || actor === undefined) return { stuck: true };
    const ci = this.host.ci();
    // On Free, Free's clamp, also for an instance queued before it applied (an upgrade, a plan
    // changed to Free): it is unassigned, so its deadline is not running yet.
    const timeoutMs =
      ci.maxJobMinutes === null
        ? instance.timeout_ms
        : Math.min(instance.timeout_ms, ci.maxJobMinutes * MIN);
    const minutes = Math.ceil(timeoutMs / MIN);
    const span =
      CI_RESERVATION_START_MS + timeoutMs + policy.heartbeatTimeoutMs + policy.cancelGraceMs;
    const now = this.host.now();
    const price: CiPrice | null = ci.ledger ? ciJobPrice(minutes) : null;
    const moved = this.#record(job, row, () => {
      if (timeoutMs < instance.timeout_ms)
        engine.exec(
          "UPDATE run_instances SET timeout_ms = ? WHERE job_id = ? AND status = 'queued'",
          timeoutMs,
          row.job_id,
        );
      // Asks counted against another account do not count against this one.
      engine.exec(
        `UPDATE ci_reservations SET refusals = 0, waiting_for = NULL
         WHERE job_id = ? AND asked_for IS NOT ?`,
        row.job_id,
        directory.owner as string,
      );
      engine.exec(
        `UPDATE ci_reservations SET key = ?, account_id = ?, agent_id = ?, minutes = ?, price = ?,
           span_ms = ?, fixed_at = ?, valid_until = ?, settle_by = ?, state = ?, asked_for = ?
         WHERE job_id = ?`,
        `${run.run_id}/j${row.job_id}/r${row.seq}`,
        directory.owner as string,
        directory.agents.has(actor) ? actor : null,
        minutes,
        price && JSON.stringify(price),
        span,
        now,
        now + CI_RESERVATION_VALIDITY_MS,
        now + span + CI_SETTLE_GRACE_MS,
        // Paid asks only the account.
        price ? "wanted" : "minutes",
        directory.owner as string,
        row.job_id,
      );
    });
    const then = moved ? this.row(row.job_id) : undefined;
    return then ? { then } : {};
  }

  /** Free: the CI ledger's grant for every day the job may run on. */
  async #grant(job: Job, row: Fixed): Promise<boolean> {
    const limits = this.host.ci().ledger;
    if (row.price === null)
      return this.#record(job, row, () => this.#set(row.job_id, "state = 'minutes'"));
    // Paid now, though priced on Free before its grant was answered: the key is released in the
    // ledger (a grant whose answer was lost goes back too) and made again on Paid's terms, so
    // no unpriced grant ever reads as one if the deployment returns to Free.
    if (!limits) {
      await this.#releaseLedger(row);
      return this.#record(job, row, () => this.#nextSeq(row));
    }
    const answer = await this.#call("grant", row.key, () => {
      this.#count("ci_grant", 3);
      return grantCi(
        this.host.env.DIRECTORY,
        {
          key: row.key,
          kind: "job",
          accountId: row.account_id,
          validUntil: row.valid_until,
          price: JSON.parse(row.price as string) as CiPrice,
          spanMs: row.span_ms,
        },
        limits,
      );
    });
    switch (answer.status) {
      case "granted":
        return this.#record(job, row, () => this.#set(row.job_id, "state = 'minutes'"));
      case "released":
      case "expired":
        await this.#releaseLedger(row);
        return this.#record(job, row, () => this.#expired(row));
      case "refused": {
        if ("retryAt" in answer) {
          const { retryAt } = answer;
          return this.#record(job, row, () => this.#refuse(row, "daily_capacity", retryAt));
        }
        if (answer.reason === "invalid")
          throw new Error(
            "the CI ledger refused the reservation's validity: is the run's clock ahead of D1's?",
          );
        // Too large for any day's allowance: it would wait for nothing, so it fails now.
        return this.#record(job, row, () => this.#fail(row, tooLarge(row.minutes)));
      }
    }
  }

  /** Fails a queued instance that no allowance can ever admit. */
  #fail(row: Fixed, error: string): void {
    const instance = this.host.engine.instance(row.job_id);
    if (instance?.status === "queued")
      this.host.engine.applyInstance(instance, { kind: "fail" }, { error });
  }

  /** The account's minutes; refused, the ledger's grant goes back (its fixed part kept). */
  async #reserve(job: Job, row: Fixed): Promise<boolean> {
    const answer = await this.#call(
      "reserve",
      row.key,
      () =>
        // The RPC stub's type of a union answer is not assignable to the union; it is the union.
        this.host.env.ORG.getByName(row.account_id).reserveCiMinutes({
          key: row.key,
          agentId: row.agent_id,
          minutes: row.minutes,
          validUntil: row.valid_until,
          settleBy: row.settle_by,
        }) as unknown as Promise<CiMinutesAnswer>,
    );
    switch (answer.status) {
      case "granted":
        return this.#record(job, row, () => {
          this.#set(
            row.job_id,
            "state = 'reserved', window_until = ?, retry_at = NULL, waiting_for = NULL",
            row.fixed_at + CI_RESERVATION_START_MS,
          );
          this.host.engine.bumpQueue();
        });
      case "refused":
        // The account keeps the key released too: asked again after this release's answer was
        // lost, it answers `released` rather than granting a key whose ledger part went back.
        await this.#releaseBoth(row);
        return this.#record(job, row, () =>
          this.#refuse(row, "ci_minutes", Math.max(answer.retryAt, answer.resetsAt ?? 0)),
        );
      case "too_large":
        // No month can hold it: it would wait for nothing, so it fails now.
        await this.#releaseBoth(row);
        return this.#record(job, row, () =>
          this.#fail(row, overMonth(row.minutes, answer.reason, answer.limit)),
        );
      case "released":
      case "expired":
        await this.#releaseBoth(row);
        return this.#record(job, row, () => this.#expired(row));
    }
  }

  /** A start window past (or closed by an account move): withdrawn, released, made again. */
  async #lapse(job: Job, row: Fixed): Promise<boolean> {
    // Out of its window it is published no more: the dispatch index withdraws it now.
    if (!this.#record(job, row, () => this.host.engine.bumpQueue())) return false;
    await this.#releaseBoth(row);
    return this.#record(job, row, () => this.#nextSeq(row));
  }

  /** An ended instance's reservation: settled at what it ran, or released, in both stores. */
  async #resolve(job: Job, row: ReservationRow): Promise<boolean> {
    if (row.key !== null) {
      const r = fixed(row);
      if (r.started_at !== null) {
        const startedAt = r.started_at;
        const endedAt = Math.max(startedAt, r.ended_at ?? this.host.now());
        await this.#call("minutes_settle", r.key, () =>
          this.host.env.ORG.getByName(r.account_id).settleCiMinutes(r.key, endedAt - startedAt),
        );
        if (r.price !== null)
          await this.#call("ledger_settle", r.key, () => {
            this.#count("ci_settle", 3);
            return settleCi(this.host.env.DIRECTORY, r.key, { startedAt, endedAt });
          });
      } else await this.#releaseBoth(r);
    }
    return this.#record(job, row, () => this.#set(row.job_id, "state = 'settled', rebind = 0"));
  }

  async #releaseBoth(row: Fixed): Promise<void> {
    await this.#call("minutes_release", row.key, () =>
      this.host.env.ORG.getByName(row.account_id).releaseCiMinutes(row.key),
    );
    await this.#releaseLedger(row);
  }

  async #releaseLedger(row: Fixed): Promise<void> {
    if (row.price === null) return;
    await this.#call("ledger_release", row.key, () => {
      this.#count("ci_release", 4);
      return releaseCi(this.host.env.DIRECTORY, row.key, row.valid_until);
    });
  }

  async #call<T>(op: CiCall, key: string, fn: () => Promise<T>): Promise<T> {
    await this.host.hooks.beforeCiCall?.(op, key);
    const answer = await fn();
    await this.host.hooks.afterCiCall?.(op, key);
    return answer;
  }

  /**
   * Writes `fn` only while the row still has the seq and state it was read
   * with (and the slice its claim); whether it did.
   */
  #record(job: Job, row: ReservationRow, fn: () => void): boolean {
    let written = false;
    this.host.guarded(job, () => {
      const now = this.row(row.job_id);
      if (now?.seq !== row.seq || now.state !== row.state) return;
      fn();
      written = true;
    });
    return written;
  }

  #set(jobId: number, assignments: string, ...values: (string | number | null)[]): void {
    this.host.engine.exec(
      `UPDATE ci_reservations SET ${assignments} WHERE job_id = ?`,
      ...values,
      jobId,
    );
  }

  /** The next reservation of the instance: nothing fixed yet; why it waited stays until it is reserved. */
  #nextSeq(row: ReservationRow): void {
    this.#set(
      row.job_id,
      `seq = seq + 1, state = 'wanted', key = NULL, account_id = NULL, agent_id = NULL,
       minutes = NULL, price = NULL, span_ms = NULL, fixed_at = NULL, valid_until = NULL,
       settle_by = NULL, window_until = NULL, retry_at = NULL, rebind = 0`,
    );
  }

  /**
   * A store answered the key expired (or released): released by key, it
   * counts as an ask, and the next one waits, a minute doubling with each;
   * the last ask stops it, refused. A store's clock ahead of the run's by
   * more than the key's validity does this on every ask.
   */
  #expired(row: Fixed): void {
    const refusals = row.refusals + 1;
    const now = this.host.now();
    if (!this.#clockWarned) {
      this.#clockWarned = true;
      this.host.log.warn(
        "a CI store answered a reservation's key expired: is the run's clock behind it?",
        {
          key: row.key,
          behindAtLeastMs: Math.max(0, row.valid_until - now),
        },
      );
    }
    if (refusals >= CI_RESERVATION_ASKS) {
      this.#set(row.job_id, "state = 'refused', refusals = ?, retry_at = NULL", refusals);
      return;
    }
    this.#nextSeq(row);
    this.#set(
      row.job_id,
      "refusals = ?, retry_at = ?",
      refusals,
      now + CI_EXPIRED_RETRY_MS * 2 ** (refusals - 1),
    );
  }

  /** Made for an account that no longer owns the repository: released, and made again for its owner. */
  async #rebind(job: Job, row: Fixed): Promise<void> {
    if (row.state === "reserved" && !this.#record(job, row, () => this.host.engine.bumpQueue()))
      return;
    await this.#releaseBoth(row);
    this.#record(job, row, () => {
      this.#nextSeq(row);
      this.#set(row.job_id, "refusals = 0, waiting_for = NULL");
    });
  }

  /**
   * Refused: asks again at the store's retry time (never before now) plus
   * the key's jitter, unless this was its last ask.
   */
  #refuse(row: Fixed, why: WaitingFor, storeRetryAt: number): void {
    const refusals = row.refusals + 1;
    const retryAt =
      refusals >= CI_RESERVATION_ASKS
        ? null
        : Math.max(storeRetryAt, this.host.now()) + jitter(row.key);
    this.#set(
      row.job_id,
      "state = 'refused', waiting_for = ?, refusals = ?, retry_at = ?",
      why,
      refusals,
      retryAt,
    );
    this.host.log.info("CI reservation refused", {
      key: row.key,
      waitingFor: why,
      retryAt,
    });
  }

  async #readDirectory(run: RunRow): Promise<Directory> {
    const actors = this.host.engine
      .rows<{ id: string }>("SELECT DISTINCT triggering_actor_id AS id FROM run_attempts")
      .map((a) => a.id);
    const db = this.host.env.DIRECTORY.withSession("first-primary");
    this.#count("ci_reserve_read", 3);
    const [owner, agents, eligible] = await db.batch([
      db.prepare("SELECT owner_id FROM repos WHERE id = ?").bind(run.repo_id),
      db
        .prepare(
          "SELECT id FROM principals WHERE type = 'agent' AND id IN (SELECT value FROM json_each(?))",
        )
        .bind(JSON.stringify(actors)),
      db
        .prepare(`SELECT ${eligibleJob("?1", "?2")} AS eligible`)
        .bind(run.fork === 0 ? 0 : 1, run.repo_id),
    ]);
    return {
      eligible: (eligible?.results[0] as { eligible: number } | undefined)?.eligible === 1,
      owner: (owner?.results[0] as { owner_id: string } | undefined)?.owner_id,
      agents: new Set(((agents?.results ?? []) as { id: string }[]).map((a) => a.id)),
    };
  }

  #count(op: string, statements: number): void {
    this.host.metrics.count("d1.query", { db: "directory", op }, statements);
  }
}

/** What one transition left: the row when another may follow at once; `stuck` when it could not move. */
interface Step {
  readonly then?: ReservationRow;
  readonly stuck?: boolean;
}

/**
 * The repository's owner now (undefined: not in the directory), which
 * triggering actors are agents, and whether a runner may take the run's jobs.
 */
interface Directory {
  readonly eligible: boolean;
  readonly owner: string | undefined;
  readonly agents: ReadonlySet<string>;
}

function fixed(row: ReservationRow): Fixed {
  if (row.key === null) throw new Error(`reservation of job ${row.job_id} has no inputs`);
  return row as Fixed;
}
