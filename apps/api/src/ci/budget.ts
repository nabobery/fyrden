import {
  DISCRETIONARY_RESOURCES,
  type DiscretionaryResource,
  dailyValues,
  discretionaryAllowance,
  FREE_DAILY,
} from "../effects/discretionary.js";
import { workersPlan } from "../git/fetch/mode.js";
import { LIVE_DAILY } from "../live/budget.js";

/*
 * CI's ledger (migration 0055), modeled on live's. A grant asked at or
 * after its `validUntil` is expired whether or not its receipt still
 * exists, so pruning cannot turn a retry into a second charge.
 */

export const CI_RESOURCES = [...DISCRETIONARY_RESOURCES, "worker_requests", "r2_class_b"] as const;
export type CiResource = (typeof CI_RESOURCES)[number];
export type CiVector = Readonly<Record<CiResource, number>>;

const R = CI_RESOURCES;
const DAY = 86_400_000;
const MINUTE = 60_000;

/** R2 Free's Class B operations a month (verified: https://developers.cloudflare.com/r2/pricing/). */
const R2_FREE_CLASS_B_MONTHLY = 10_000_000;

/**
 * Workers Free's daily limits: discretionary work's; 100,000 Worker
 * requests per account per day, reset at 00:00 UTC (verified:
 * https://developers.cloudflare.com/workers/platform/limits/); and R2
 * Class B operations, a monthly limit, as its share in a 31-day month.
 */
export const CI_FREE_DAILY: CiVector = {
  ...FREE_DAILY,
  worker_requests: 100_000,
  r2_class_b: Math.floor(R2_FREE_CLASS_B_MONTHLY / 31),
};

/** CI's share of Free's limits unless set. Proposed. */
export const CI_FREE_SHARE: CiVector = {
  do_requests: 15_000,
  do_rows_read: FREE_DAILY.do_rows_read / 10,
  do_rows_written: 10_000,
  do_duration_ms: 20_312_500,
  d1_rows_read: FREE_DAILY.d1_rows_read / 10,
  d1_rows_written: FREE_DAILY.d1_rows_written / 10,
  queue_ops: FREE_DAILY.queue_ops / 10,
  worker_requests: 15_000,
  r2_class_b: Math.floor(R2_FREE_CLASS_B_MONTHLY / 31 / 10),
};

/** The part of the allowance viewer receipts may take together. Proposed. */
export const CI_VIEWER_SHARE = 0.25;

/** A Free deployment's runners unless `FYRDEN_CI_FLEET` is set. Proposed. */
export const CI_FREE_FLEET = 2;
/** A runner's daily poll budget: the default schedule's 17,280 polls a day and a quarter. Proposed. */
export const CI_POLL_BUDGET = 21_600;
/** Polls a runner may make past its budget unaccounted, in percent of it. Proposed. */
export const CI_POLL_SLACK_PERCENT = 5;
/** Polls one lease pays for. Proposed. */
export const CI_POLL_LEASE = 60;
/**
 * D1 rows a poll reads: FetchTask's authentication query (`runnerAuthQuery`
 * "fetch") reads the runner, the account's dispatch row, an expired claim,
 * the runner's live offers and its current offer. Estimated, unmeasured.
 */
const POLL_D1_ROWS_READ = 5;
/** D1 rows a lease writes: the runner's row and its index entry. Estimated, unmeasured. */
const LEASE_D1_ROWS_WRITTEN = 2;

/** A day's reservation for `cap` runners. */
export function fleetReservation(cap: number): CiVector {
  const polls = cap * (CI_POLL_BUDGET + Math.ceil((CI_POLL_BUDGET * CI_POLL_SLACK_PERCENT) / 100));
  const leases = Math.ceil(polls / CI_POLL_LEASE);
  return {
    ...zero(),
    worker_requests: polls,
    // Each lease reads the runner's row and its rank among at most `cap` others.
    d1_rows_read: polls * POLL_D1_ROWS_READ + leases * (1 + cap),
    d1_rows_written: leases * LEASE_D1_ROWS_WRITTEN,
  };
}

/**
 * `FYRDEN_CI_POLL_BUDGET` when it lowers `CI_POLL_BUDGET` (an operator's
 * check that revocation works), rounded down to whole leases. Never above
 * the default, which the fleet's reservation covers; ignored below one
 * lease, which would revoke a runner before its first poll.
 */
export function ciPollBudget(env: object): number {
  const raw = (env as { FYRDEN_CI_POLL_BUDGET?: unknown }).FYRDEN_CI_POLL_BUDGET;
  if (typeof raw === "string" && /^[1-9][0-9]{0,5}$/.test(raw) && Number(raw) >= CI_POLL_LEASE)
    return Math.min(Math.floor(Number(raw) / CI_POLL_LEASE) * CI_POLL_LEASE, CI_POLL_BUDGET);
  return CI_POLL_BUDGET;
}

/** The longest a job may run on Free unless `FYRDEN_CI_MAX_JOB_MINUTES` is set: the runner's default timeout. Proposed. */
export const CI_FREE_MAX_JOB_MINUTES = 180;

/**
 * On Free, the longest a job may run, in minutes: `FYRDEN_CI_MAX_JOB_MINUTES`
 * (1 to 7,200, a self-hosted job's limit), else `CI_FREE_MAX_JOB_MINUTES`.
 * Paid: null, the job's own timeout.
 */
export function ciMaxJobMinutes(env: object): number | null {
  if (workersPlan(env) === "paid") return null;
  const raw = (env as { FYRDEN_CI_MAX_JOB_MINUTES?: unknown }).FYRDEN_CI_MAX_JOB_MINUTES;
  if (typeof raw === "string" && /^[1-9][0-9]{0,3}$/.test(raw) && Number(raw) <= 7_200)
    return Number(raw);
  return CI_FREE_MAX_JOB_MINUTES;
}

export type CiVariable =
  | "FYRDEN_PLAN"
  | "FYRDEN_CI_DAILY"
  | "FYRDEN_CI_FLEET"
  | "FYRDEN_CI_MAX_JOB_MINUTES"
  | "QUOTA_CI_MINUTES"
  | "QUOTA_CI_AGENT_MINUTES";

/**
 * Values that replace the Worker's own variables where the run and account
 * objects, and the live log ticket operation, read CI's configuration, in
 * this isolate only. Empty in a deployment; tests set them, since no
 * request's variables reach those objects' env.
 */
export const ciVariableOverrides: Partial<Record<CiVariable, string>> = {};

export function ciEnv(env: object): object {
  return { ...env, ...ciVariableOverrides };
}

/** The most runners a Free deployment holds: `FYRDEN_CI_FLEET`, else Free's default. Paid: none. */
export function ciFleetCap(env: object): number | null {
  if (workersPlan(env) === "paid") return null;
  const raw = (env as { FYRDEN_CI_FLEET?: unknown }).FYRDEN_CI_FLEET;
  if (typeof raw === "string" && /^(0|[1-9][0-9]{0,5})$/.test(raw)) return Number(raw);
  return CI_FREE_FLEET;
}

/**
 * CI's daily allowance, or null on Paid. Free: each resource from
 * `FYRDEN_CI_DAILY` (`resource=n,…`, read as `FYRDEN_DISCRETIONARY_DAILY`
 * is), else `CI_FREE_SHARE`, and never more than Free's limit leaves after
 * the fleet's reservation, live's allowance and discretionary work's.
 */
export function ciAllowance(env: object): CiVector | null {
  if (workersPlan(env) === "paid") return null;
  const set = dailyValues((env as { FYRDEN_CI_DAILY?: unknown }).FYRDEN_CI_DAILY, R) ?? {};
  const fleet = fleetReservation(ciFleetCap(env) ?? 0);
  const discretionary = discretionaryAllowance(env);
  return Object.fromEntries(
    R.map((r) => {
      const others = isDiscretionary(r) ? LIVE_DAILY[r] + (discretionary?.[r] ?? 0) : 0;
      const ceiling = Math.max(0, CI_FREE_DAILY[r] - fleet[r] - others);
      return [r, Math.floor(Math.min(set[r] ?? CI_FREE_SHARE[r], ceiling))];
    }),
  ) as CiVector;
}

/**
 * A grant's price: `fixed` plus `perMinute` times `minutes`, charged on
 * every day of its span; only the per-minute part is ever refunded.
 */
export interface CiPrice {
  readonly fixed: CiVector;
  readonly perMinute: CiVector;
  readonly minutes: number;
}

/**
 * A job's work per minute of its timeout, refundable: a busy runner's
 * calls (about 45 a minute, measured: `RATE_LIMIT_RUNNER` in
 * wrangler.jsonc), each a Worker request and a run's Durable Object
 * request; the run's duration while the job reports; its rows. Proposed.
 */
export const CI_JOB_PER_MINUTE: CiVector = {
  ...zero(),
  worker_requests: 45,
  do_requests: 45,
  do_duration_ms: MINUTE,
  do_rows_written: 10,
  do_rows_read: 100,
};

/**
 * A job reservation's control work, never refunded: the minute and ledger
 * calls, publishing and withdrawal, settlement (4 Durable Object requests,
 * 20 of its rows written, 30 D1 rows written and 100 read), and an
 * assignment's task, token, audit and pending rows (60 D1 rows written and
 * 200 read). Proposed, to be replaced with measured numbers.
 */
export const CI_JOB_FIXED: CiVector = {
  ...zero(),
  do_requests: 4,
  do_rows_written: 20,
  d1_rows_written: 30 + 60,
  d1_rows_read: 100 + 200,
};

/** The longest job timeout the ledger prices, in minutes (a week). */
export const CI_MAX_MINUTES = 10_080;

export function ciJobPrice(minutes: number): CiPrice {
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > CI_MAX_MINUTES)
    throw new RangeError(`minutes ${minutes}`);
  return { fixed: CI_JOB_FIXED, perMinute: CI_JOB_PER_MINUTE, minutes };
}

/** Bytes a viewer socket may read from storage besides its log's rereads (rows stored later). Proposed. */
export const CI_VIEWER_READ_MARGIN = 4 * 1024 * 1024;
/** Attempts any viewer socket gets besides its log's reads: one a MiB of the margin, and these. Proposed. */
const VIEWER_GET_BYTES = 1024 * 1024;
const VIEWER_GET_MARGIN = 16;
/** Credential checks any viewer socket gets besides its first, its minutes and its reads'. Proposed. */
const VIEWER_CHECK_MARGIN = 16;

/**
 * A job's log as stored when a viewer's ticket is issued, as its socket
 * would read it back: each chunk read again from its start as many times
 * as its frames take sends to the socket (src/do/run/viewers.ts sizes them).
 */
export interface StoredLogReads {
  readonly chunks: number;
  /** Each chunk's bytes times the reads it takes, summed. */
  readonly rereadBytes: number;
  readonly reads: number;
}

/** What a viewer's socket may spend, as the run holds it to, and what its ticket is priced for. */
export interface CiViewerBudget {
  readonly readBytes: number;
  readonly getAttempts: number;
  /** Checks of its credential and access it may take. */
  readonly checks: number;
}

/**
 * A viewer socket's budget, from the log stored when its ticket is issued
 * and how long rows may flow to it (`activeMs`). Each chunk gets one
 * attempt more for a read cancelled or cut short; each attempt two checks
 * (a socket reading back is checked at most once a minute, and waits at
 * most two minutes for its window between reads). Proposed.
 */
export function ciViewerBudget({
  stored,
  activeMs,
}: {
  stored: StoredLogReads;
  activeMs: number;
}): CiViewerBudget {
  const { chunks, rereadBytes, reads } = stored;
  if (!isCount(chunks) || !isCount(rereadBytes) || !isCount(reads) || !isCount(activeMs))
    throw new RangeError("viewer budget");
  const getAttempts =
    reads + chunks + Math.ceil(CI_VIEWER_READ_MARGIN / VIEWER_GET_BYTES) + VIEWER_GET_MARGIN;
  return {
    readBytes: rereadBytes + CI_VIEWER_READ_MARGIN,
    getAttempts,
    checks: 1 + Math.ceil(activeMs / MINUTE) + 2 * getAttempts + VIEWER_CHECK_MARGIN,
  };
}

/**
 * A log viewer's price, from the budget its socket is held to: the ticket
 * and the upgrade, each check it may take, and each storage read attempt
 * (an R2 Class B operation). Nothing is refunded. Proposed.
 */
export function ciViewerPrice({ getAttempts, checks }: CiViewerBudget): CiPrice {
  if (!isCount(getAttempts) || !isCount(checks)) throw new RangeError("viewer price");
  return {
    fixed: {
      ...zero(),
      worker_requests: 2,
      do_requests: 2 + checks,
      do_rows_read: 10 * checks,
      d1_rows_read: 5 * checks,
      r2_class_b: getAttempts,
    },
    perMinute: zero(),
    minutes: 0,
  };
}

/** D1's clock in milliseconds (tests replace the marked expression). */
export const CI_NOW = "/*CI_NOW*/(unixepoch() * 1000)";
const N = CI_NOW;
/** Today's UTC day by D1's clock. */
export const CI_TODAY = `CAST(${N} / ${DAY} AS INTEGER)`;
const TODAY = CI_TODAY;

/** The longest validity a grant may carry, which is how long a bare tombstone lasts. Proposed. */
export const CI_MAX_VALIDITY_MS = 60 * MINUTE;
/** The longest span a grant may be charged over (a week's job, its start window and grace). */
export const CI_MAX_SPAN_MS = 8 * DAY;
/** How long after its span a receipt may still be settled before it may expire. Proposed. */
export const CI_SETTLE_GRACE_MS = 60 * MINUTE;
/** UTC days kept before today's (none is charged again: grants charge today on). */
export const CI_DAYS_KEPT = 3;
/** Receipts and days one prune removes at most. */
export const CI_RECEIPT_PAGE = 64;
export const CI_DAY_PAGE = 8;

export interface CiGrantRequest {
  /** The reservation's identity: the same key is the same grant. */
  readonly key: string;
  readonly kind: "job" | "viewer";
  readonly accountId: string;
  /** The latest time (D1's clock, ms) the ledger may grant this key; fixed when the key is made. */
  readonly validUntil: number;
  readonly price: CiPrice;
  /** How long from the grant the work may run: every UTC day it touches is charged. */
  readonly spanMs: number;
}

export interface CiLimits {
  readonly allowance: CiVector;
  /** The fleet's cap: while more runners may serve, nothing is granted. Null: none. */
  readonly fleetCap: number | null;
}

export type CiGrantResult =
  | {
      readonly status: "granted";
      /** Granted before, by an earlier call with this key. */
      readonly replay: boolean;
      readonly firstDay: number;
      readonly lastDay: number;
    }
  | { readonly status: "released" }
  | { readonly status: "expired" }
  | {
      readonly status: "refused";
      readonly reason: "daily" | "fleet";
      /** The next UTC midnight by D1's clock. */
      readonly retryAt: number;
    }
  | { readonly status: "refused"; readonly reason: "too_large" | "invalid" };

export type CiSettleResult = "settled" | "duplicate" | "released" | "expired";

const isDiscretionary = (r: CiResource): r is DiscretionaryResource =>
  (DISCRETIONARY_RESOURCES as readonly string[]).includes(r);

function zero(): Record<CiResource, number> {
  return Object.fromEntries(R.map((r) => [r, 0])) as Record<CiResource, number>;
}

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function isVector(v: unknown): v is CiVector {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  const vector = v as Record<string, unknown>;
  return keys.length === R.length && R.every((r) => isCount(vector[r]));
}

/** A vector's canonical JSON (the resources in their fixed order). */
const vectorJson = (v: CiVector) => JSON.stringify(Object.fromEntries(R.map((r) => [r, v[r]])));

function requestError(req: CiGrantRequest): string | null {
  if (typeof req.key !== "string" || req.key.length < 1 || req.key.length > 200) return "key";
  if (req.kind !== "job" && req.kind !== "viewer") return "kind";
  if (typeof req.accountId !== "string" || req.accountId.length === 0) return "accountId";
  if (!isCount(req.validUntil)) return "validUntil";
  if (!Number.isSafeInteger(req.spanMs) || req.spanMs < 1 || req.spanMs > CI_MAX_SPAN_MS)
    return "spanMs";
  const { fixed, perMinute, minutes } = req.price ?? {};
  if (!isVector(fixed) || !isVector(perMinute)) return "price";
  if (!isCount(minutes) || minutes > CI_MAX_MINUTES) return "minutes";
  // A viewer's price is never refunded, so its share of a day only ever grows.
  if (req.kind === "viewer" && minutes !== 0) return "minutes";
  return null;
}

function statement(
  db: D1Database,
  build: (bind: (value: string | number | null) => string) => string,
): D1PreparedStatement {
  const values: (string | number | null)[] = [];
  const sql = build((value) => {
    const at = values.indexOf(value);
    if (at >= 0) return `?${at + 1}`;
    values.push(value);
    return `?${values.length}`;
  });
  return db.prepare(sql).bind(...values);
}

/**
 * SQL counting the runners that may serve at `now`: long-lived ones and
 * ephemeral ones before their expiry, each a range of the live-runner
 * index, so expired history is never read; each range counts at most
 * `limit`. With `olderThan`, only runners whose id is below it (a runner's
 * rank). Every argument is SQL.
 */
export function servingRunners(now: string, limit: string, olderThan?: string): string {
  const older = olderThan === undefined ? "" : ` AND id < ${olderThan}`;
  const count = (range: string) =>
    `(SELECT count(*) FROM (SELECT 1 FROM ci_runners INDEXED BY ci_runners_live
      WHERE revoked_at IS NULL AND ${range}${older} LIMIT ${limit}))`;
  return `(${count("expires_at IS NULL")} + ${count(`expires_at > ${now}`)})`;
}

/** SQL true while at most `cap` runners may serve at `now`. */
function fleetWithin(cap: number | null, now: string): string {
  if (cap === null) return "1";
  return `(${servingRunners(now, String(cap + 1))} <= ${cap})`;
}

const perMinute = (column: string, r: CiResource) =>
  `CAST(json_extract(${column}, '$.${r}') AS INTEGER)`;

/**
 * Grants `req` in one batch. At or after `validUntil` (D1's clock) it is
 * expired; an existing receipt answers itself (granted, released, or
 * expired once settled); otherwise the price is charged to every UTC day
 * from now up to `spanMs` later, only if each day stays within the
 * allowance (viewers within their share too) and the fleet within its
 * cap. A refusal writes nothing. A lost answer throws; a retry with the
 * same key gets the receipt's answer.
 */
export async function grantCi(
  db: D1Database,
  req: CiGrantRequest,
  { allowance, fleetCap }: CiLimits,
): Promise<CiGrantResult> {
  const error = requestError(req);
  if (error !== null) throw new RangeError(`CI grant: ${error}`);
  if (!isVector(allowance)) throw new RangeError("CI grant: allowance");
  if (fleetCap !== null && !isCount(fleetCap)) throw new RangeError("CI grant: fleetCap");
  const { fixed, perMinute: rate, minutes } = req.price;
  const charge = Object.fromEntries(R.map((r) => [r, fixed[r] + rate[r] * minutes])) as CiVector;
  const viewer = req.kind === "viewer";
  const viewerAllowance = Object.fromEntries(
    R.map((r) => [r, Math.floor(allowance[r] * CI_VIEWER_SHARE)]),
  ) as CiVector;
  // Never fits: only read what the key's own receipt and the clock answer first.
  const tooLarge = R.some(
    (r) => charge[r] > allowance[r] || (viewer && charge[r] > viewerAllowance[r]),
  );
  const mint = crypto.randomUUID();
  const offsets = JSON.stringify(
    Array.from({ length: Math.floor(req.spanMs / DAY) + 2 }, (_, i) => i),
  );
  const span = req.spanMs;
  const fits = (d: string) =>
    R.map(
      (r) =>
        `coalesce(${d}.${r}, 0) + ${charge[r]} <= ${allowance[r]}` +
        (viewer
          ? ` AND coalesce(${d}.viewer_${r}, 0) + ${charge[r]} <= ${viewerAllowance[r]}`
          : ""),
    ).join(" AND ");
  const writes = [
    statement(
      db,
      (b) => `INSERT INTO ci_budget_receipts (key, kind, account_id, first_day, last_day,
    span_from, span_until, fixed, per_minute, minutes, mint, valid_until, expires_at, state, created_at)
  SELECT ${b(req.key)}, ${b(req.kind)}, ${b(req.accountId)}, c.today, c.last, c.now, c.now + ${span},
    ${b(vectorJson(fixed))}, ${b(vectorJson(rate))}, ${minutes}, ${b(mint)}, ${req.validUntil},
    max(${req.validUntil}, c.now + ${span} + ${CI_SETTLE_GRACE_MS}), 'granted', c.now
  FROM (SELECT ${N} AS now, ${TODAY} AS today, CAST((${N} + ${span} - 1) / ${DAY} AS INTEGER) AS last) c
  WHERE c.now < ${req.validUntil} AND ${req.validUntil} <= c.now + ${CI_MAX_VALIDITY_MS}
    AND NOT EXISTS (SELECT 1 FROM ci_budget_receipts WHERE key = ${b(req.key)})
    AND ${fleetWithin(fleetCap, "c.now")}
    AND NOT EXISTS (SELECT 1 FROM json_each(${b(offsets)}) o
      LEFT JOIN ci_budget_days d ON d.day = c.today + o.value
      WHERE c.today + o.value <= c.last AND NOT (${fits("d")}))`,
    ),
    statement(
      db,
      (
        b,
      ) => `INSERT INTO ci_budget_days (day, ${R.join(", ")}, ${R.map((r) => `viewer_${r}`).join(", ")})
  SELECT r.first_day + o.value, ${R.map((r) => charge[r]).join(", ")},
    ${R.map((r) => (viewer ? charge[r] : 0)).join(", ")}
  FROM ci_budget_receipts r, json_each(${b(offsets)}) o
  WHERE r.key = ${b(req.key)} AND r.mint = ${b(mint)} AND r.first_day + o.value <= r.last_day
  ON CONFLICT (day) DO UPDATE SET
    ${R.map((r) => `${r} = ${r} + excluded.${r}, viewer_${r} = viewer_${r} + excluded.viewer_${r}`).join(",\n    ")}`,
    ),
  ];
  const answer = statement(
    db,
    (b) => `SELECT c.now, c.today, ${fleetWithin(fleetCap, "c.now")} AS fleet_within,
    r.state, r.mint, r.first_day, r.last_day
  FROM (SELECT ${N} AS now, ${TODAY} AS today) c
  LEFT JOIN ci_budget_receipts r ON r.key = ${b(req.key)}`,
  );
  const results = await db.batch(tooLarge ? [answer] : [...writes, answer]);
  const row = results.at(-1)?.results[0] as
    | {
        now: number;
        today: number;
        fleet_within: number;
        state: "granted" | "settled" | "released" | null;
        mint: string | null;
        first_day: number | null;
        last_day: number | null;
      }
    | undefined;
  if (!row) throw new Error("CI grant: no answer");
  const granted = (replay: boolean): CiGrantResult => ({
    status: "granted",
    replay,
    firstDay: row.first_day as number,
    lastDay: row.last_day as number,
  });
  // `mint` is private to this call: equal only when this batch granted it.
  if (row.mint === mint) return granted(false);
  if (row.now >= req.validUntil) return { status: "expired" };
  if (row.state === "granted") return granted(true);
  if (row.state === "released") return { status: "released" };
  if (row.state === "settled") return { status: "expired" };
  if (tooLarge) return { status: "refused", reason: "too_large" };
  if (req.validUntil > row.now + CI_MAX_VALIDITY_MS)
    return { status: "refused", reason: "invalid" };
  const retryAt = (row.today + 1) * DAY;
  if (row.fleet_within !== 1) return { status: "refused", reason: "fleet", retryAt };
  return { status: "refused", reason: "daily", retryAt };
}

/**
 * Releases `key`: a granted receipt gives its per-minute part back to
 * every day it charged and keeps its fixed part; an unknown key gets a
 * tombstone (until `validUntil`, or the longest validity from now when not
 * given) that answers a later grant `released`. Repeats change nothing; a
 * settled receipt stays settled.
 */
export async function releaseCi(
  db: D1Database,
  key: string,
  validUntil?: number,
): Promise<"released" | "settled"> {
  if (typeof key !== "string" || key.length < 1 || key.length > 200)
    throw new RangeError("CI release: key");
  if (validUntil !== undefined && !isCount(validUntil))
    throw new RangeError("CI release: validUntil");
  const until = validUntil ?? null;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE ci_budget_days SET
           ${R.map((r) => `${r} = ${r} - ${perMinute("g.per_minute", r)} * g.minutes`).join(",\n           ")}
         FROM (SELECT first_day, last_day, per_minute, minutes FROM ci_budget_receipts
               WHERE key = ?1 AND state = 'granted') g
         WHERE ci_budget_days.day BETWEEN g.first_day AND g.last_day`,
      )
      .bind(key),
    db
      .prepare(
        "UPDATE ci_budget_receipts SET state = 'released' WHERE key = ?1 AND state = 'granted'",
      )
      .bind(key),
    db
      .prepare(
        `INSERT INTO ci_budget_receipts (key, state, valid_until, expires_at, created_at)
         SELECT ?1, 'released', CAST(?2 AS INTEGER),
           max(coalesce(CAST(?2 AS INTEGER), 0), ${N} + ${CI_MAX_VALIDITY_MS}), ${N} WHERE 1
         ON CONFLICT (key) DO NOTHING`,
      )
      .bind(key, until),
    db.prepare("SELECT state FROM ci_budget_receipts WHERE key = ?1").bind(key),
  ]);
  const state = (results.at(-1)?.results[0] as { state: string } | undefined)?.state;
  return state === "settled" ? "settled" : "released";
}

/**
 * Settles a granted job once: each day of its span keeps, of the
 * per-minute part, only the minutes the job ran within that day (rounded
 * up, at most its minutes), the times clamped to the receipt's span; the
 * rest goes back. Answers `duplicate` once settled, `released` for a
 * released key, and `expired` for a key the ledger no longer holds (the
 * charge stays).
 */
export async function settleCi(
  db: D1Database,
  key: string,
  { startedAt, endedAt }: { startedAt: number; endedAt: number },
): Promise<CiSettleResult> {
  if (typeof key !== "string" || key.length < 1 || key.length > 200)
    throw new RangeError("CI settle: key");
  if (!isCount(startedAt) || !isCount(endedAt) || endedAt < startedAt)
    throw new RangeError("CI settle: times");
  const overlap = `max(0, min(g.e, (ci_budget_days.day + 1) * ${DAY}) - max(g.s, ci_budget_days.day * ${DAY}))`;
  const used = `min(g.minutes, (${overlap} + ${MINUTE - 1}) / ${MINUTE})`;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE ci_budget_days SET
           ${R.map((r) => `${r} = ${r} - ${perMinute("g.per_minute", r)} * (g.minutes - ${used})`).join(",\n           ")}
         FROM (SELECT first_day, last_day, per_minute, minutes,
                 max(span_from, min(CAST(?2 AS INTEGER), span_until)) AS s,
                 max(span_from, min(CAST(?3 AS INTEGER), span_until)) AS e
               FROM ci_budget_receipts WHERE key = ?1 AND state = 'granted') g
         WHERE ci_budget_days.day BETWEEN g.first_day AND g.last_day`,
      )
      .bind(key, startedAt, endedAt),
    db
      .prepare(
        "UPDATE ci_budget_receipts SET state = 'settled' WHERE key = ?1 AND state = 'granted' RETURNING key",
      )
      .bind(key),
    db.prepare("SELECT state FROM ci_budget_receipts WHERE key = ?1").bind(key),
  ]);
  if ((results[1]?.results.length ?? 0) === 1) return "settled";
  const state = (results.at(-1)?.results[0] as { state: string } | undefined)?.state;
  if (state === "settled") return "duplicate";
  if (state === "released") return "released";
  return "expired";
}

function page(limit: number | undefined, max: number): number {
  const n = limit ?? max;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new RangeError(`limit ${n}`);
  return n;
}

/**
 * Removes a page of receipts a day past their expiry (never before their
 * validity) and a page of days older than `CI_DAYS_KEPT`, by D1's clock.
 */
export async function pruneCiBudget(
  db: D1Database,
  limits: { readonly receipts?: number; readonly days?: number } = {},
): Promise<{ readonly receipts: number; readonly days: number }> {
  const receipts = page(limits.receipts, CI_RECEIPT_PAGE);
  const days = page(limits.days, CI_DAY_PAGE);
  const [removedReceipts, removedDays] = await db.batch([
    db
      .prepare(
        `DELETE FROM ci_budget_receipts WHERE key IN (
           SELECT key FROM ci_budget_receipts INDEXED BY ci_budget_receipts_expiry
           WHERE expires_at <= ${N} - ${DAY} ORDER BY expires_at LIMIT ?1)
         RETURNING key`,
      )
      .bind(receipts),
    db
      .prepare(
        `DELETE FROM ci_budget_days WHERE day IN (
           SELECT day FROM ci_budget_days WHERE day < ${TODAY} - ${CI_DAYS_KEPT} ORDER BY day LIMIT ?1)
         RETURNING day`,
      )
      .bind(days),
  ]);
  return {
    receipts: removedReceipts?.results.length ?? 0,
    days: removedDays?.results.length ?? 0,
  };
}
