import { workersPlan } from "../../git/fetch/mode.js";

/*
 * Every call is idempotent by key. A release leaves the key released even
 * when it was never reserved, so a later reserve of it (reordered, or
 * retried after a lost answer) grants nothing.
 */

/** Free's minutes an account a month unless `QUOTA_CI_MINUTES` is set. Proposed. */
export const CI_FREE_ACCOUNT_MINUTES = 2_000;
/** Free's minutes an agent a month in one account unless `QUOTA_CI_AGENT_MINUTES` is set. Proposed. */
export const CI_FREE_AGENT_MINUTES = 500;
/** The most minutes one reservation holds: a week. */
export const CI_MINUTES_MAX = 10_080;
/** Rows of months before the last one removed by one reserve. */
const PRUNE_PAGE = 64;

export interface CiMinuteLimits {
  /** Minutes the account may use a UTC month; null: no cap. */
  readonly account: number | null;
  /** Minutes one agent may use a UTC month in the account; null: no cap. */
  readonly agent: number | null;
}

/** The instance's CI minute limits: Free's defaults (Paid: none), each replaced by its variable when set. */
export function ciMinuteLimits(env: object): CiMinuteLimits {
  const vars = env as Partial<Record<string, unknown>>;
  const paid = workersPlan(env) === "paid";
  const read = (name: string, fallback: number | null): number | null => {
    const raw = vars[name];
    const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  };
  return {
    account: read("QUOTA_CI_MINUTES", paid ? null : CI_FREE_ACCOUNT_MINUTES),
    agent: read("QUOTA_CI_AGENT_MINUTES", paid ? null : CI_FREE_AGENT_MINUTES),
  };
}

export interface CiMinutesRequest {
  /** The reservation's identity: the same key is the same hold. */
  readonly key: string;
  /** The agent the job's minutes count against too, or null. */
  readonly agentId: string | null;
  readonly minutes: number;
  /** The latest time (this object's clock, ms) the key may be granted; fixed when the key is made. */
  readonly validUntil: number;
  /** After this the hold counts as used, since the job may have run; a hold never lapses. */
  readonly settleBy: number;
}

export type CiMinutesAnswer =
  | { readonly status: "granted"; readonly replay: boolean }
  | { readonly status: "released" }
  | { readonly status: "expired" }
  | {
      readonly status: "refused";
      readonly reason: "account" | "agent";
      /** The next UTC midnight by this object's clock. */
      readonly retryAt: number;
      /** The next month's start, when the month's used minutes alone leave no room; else null. */
      readonly resetsAt: number | null;
    }
  | {
      /** More minutes than the account's or the agent's whole month: no reset admits them. */
      readonly status: "too_large";
      readonly reason: "account" | "agent";
      readonly limit: number;
    };

export type CiMinutesSettlement = "settled" | "duplicate" | "released" | "unknown";

type Row = {
  key: string;
  agent_id: string | null;
  month: string;
  reserved: number;
  used: number;
  state: "held" | "settled" | "released";
  settle_by: number | null;
};

const DAY = 86_400_000;

function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

function nextMonth(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function previousMonth(at: number): string {
  const d = new Date(at);
  return monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}

function requestError(req: CiMinutesRequest): string | null {
  if (typeof req.key !== "string" || req.key.length < 1 || req.key.length > 200) return "key";
  if (req.agentId !== null && (typeof req.agentId !== "string" || req.agentId.length === 0))
    return "agentId";
  if (!Number.isSafeInteger(req.minutes) || req.minutes < 0 || req.minutes > CI_MINUTES_MAX)
    return "minutes";
  if (!Number.isSafeInteger(req.validUntil) || req.validUntil < 0) return "validUntil";
  if (!Number.isSafeInteger(req.settleBy) || req.settleBy < 0) return "settleBy";
  return null;
}

export class CiMinutes {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly limits: CiMinuteLimits,
    private readonly now: () => number,
  ) {}

  /**
   * Holds `minutes` under `key` when they fit this month: the account's
   * settled minutes, its holds (each at what it reserved) and these within
   * its quota, and the same for the agent's. A held key answers itself; a
   * released one `released`; a settled one, like any key asked at or after
   * its validity, `expired`.
   */
  reserve(req: CiMinutesRequest): CiMinutesAnswer {
    const error = requestError(req);
    if (error !== null) throw new RangeError(`CI minutes: ${error}`);
    return this.storage.transactionSync((): CiMinutesAnswer => {
      const now = this.now();
      if (now >= req.validUntil) return { status: "expired" };
      const existing = this.#row(req.key);
      if (existing?.state === "held") return { status: "granted", replay: true };
      if (existing?.state === "released") return { status: "released" };
      if (existing) return { status: "expired" };
      if (this.limits.account !== null && req.minutes > this.limits.account)
        return { status: "too_large", reason: "account", limit: this.limits.account };
      if (this.limits.agent !== null && req.agentId !== null && req.minutes > this.limits.agent)
        return { status: "too_large", reason: "agent", limit: this.limits.agent };
      const month = monthOf(now);
      this.#prune(now);
      const refusal = (reason: "account" | "agent", limit: number, agentId: string | null) => {
        const { counted, used } = this.#count(month, now, agentId);
        if (counted + req.minutes <= limit) return null;
        return {
          status: "refused" as const,
          reason,
          retryAt: (Math.floor(now / DAY) + 1) * DAY,
          resetsAt: used + req.minutes > limit ? nextMonth(now) : null,
        };
      };
      const refused =
        (this.limits.account === null ? null : refusal("account", this.limits.account, null)) ??
        (this.limits.agent === null || req.agentId === null
          ? null
          : refusal("agent", this.limits.agent, req.agentId));
      if (refused) return refused;
      this.storage.sql.exec(
        `INSERT INTO ci_minutes (key, agent_id, month, reserved, used, state, settle_by, created_at)
         VALUES (?, ?, ?, ?, 0, 'held', ?, ?)`,
        req.key,
        req.agentId,
        month,
        req.minutes,
        req.settleBy,
        now,
      );
      return { status: "granted", replay: false };
    });
  }

  /**
   * Settles a hold once: it keeps the minutes the job ran (`actualMs`,
   * rounded up), at most what it reserved. `duplicate` once settled.
   */
  settle(key: string, actualMs: number): CiMinutesSettlement {
    if (!Number.isSafeInteger(actualMs) || actualMs < 0)
      throw new RangeError("CI minutes: actualMs");
    return this.storage.transactionSync((): CiMinutesSettlement => {
      const row = this.#row(key);
      if (!row) return "unknown";
      if (row.state === "settled") return "duplicate";
      if (row.state === "released") return "released";
      this.storage.sql.exec(
        "UPDATE ci_minutes SET state = 'settled', used = min(reserved, ?) WHERE key = ?",
        Math.ceil(actualMs / 60_000),
        key,
      );
      return "settled";
    });
  }

  /** Releases `key`: a hold counts nothing more; an unknown key is released for good. Repeats change nothing. */
  release(key: string): "released" | "settled" {
    if (typeof key !== "string" || key.length < 1 || key.length > 200)
      throw new RangeError("CI minutes: key");
    return this.storage.transactionSync(() => {
      const now = this.now();
      this.storage.sql.exec(
        `INSERT INTO ci_minutes (key, agent_id, month, reserved, used, state, settle_by, created_at)
         VALUES (?, NULL, ?, 0, 0, 'released', NULL, ?)
         ON CONFLICT (key) DO UPDATE SET state = 'released', used = 0 WHERE state = 'held'`,
        key,
        monthOf(now),
        now,
      );
      return this.#row(key)?.state === "settled" ? "settled" : "released";
    });
  }

  /**
   * This month's minutes of the account (or of `agentId` in it): `counted`
   * is what a new hold must fit beside (settled minutes used and holds at
   * what they reserved); `used`, the part of it the month has spent for
   * good (settled minutes and holds past their settlement time).
   */
  #count(month: string, now: number, agentId: string | null): { counted: number; used: number } {
    const row = this.storage.sql
      .exec<{ counted: number; used: number }>(
        `SELECT coalesce(sum(CASE state WHEN 'held' THEN reserved WHEN 'settled' THEN used ELSE 0 END), 0) AS counted,
           coalesce(sum(CASE WHEN state = 'settled' THEN used
             WHEN state = 'held' AND settle_by <= ? THEN reserved ELSE 0 END), 0) AS used
         FROM ci_minutes WHERE month = ? AND (? IS NULL OR agent_id = ?)`,
        now,
        month,
        agentId,
        agentId,
      )
      .one();
    return row;
  }

  /** Removes a page of rows from months before the last one: no quota counts them, and no key lives that long. */
  #prune(now: number): void {
    this.storage.sql.exec(
      `DELETE FROM ci_minutes WHERE key IN (
         SELECT key FROM ci_minutes WHERE month < ? ORDER BY month LIMIT ?)`,
      previousMonth(now),
      PRUNE_PAGE,
    );
  }

  #row(key: string): Row | undefined {
    return this.storage.sql
      .exec<Row & Record<string, SqlStorageValue>>("SELECT * FROM ci_minutes WHERE key = ?", key)
      .toArray()[0];
  }
}
