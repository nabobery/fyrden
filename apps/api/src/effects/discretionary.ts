import { workersPlan } from "../git/fetch/mode.js";

/*
 * Discretionary work (watched P2 entries now; digests later) is admitted
 * against a daily allowance of the deployment's resources, so it never
 * takes more than its share of an account's daily quotas, which core work
 * (P0 and P1 entries, everything else) shares and is never refused. A UTC
 * day's admissions, each priced at its whole life, stay within the
 * allowance. See docs/operations/limits.md (Discretionary work).
 */

/** The resources an admission is priced in. */
export const DISCRETIONARY_RESOURCES = [
  "do_requests",
  "do_rows_read",
  "do_rows_written",
  "do_duration_ms",
  "d1_rows_read",
  "d1_rows_written",
  "queue_ops",
] as const;
export type DiscretionaryResource = (typeof DISCRETIONARY_RESOURCES)[number];

/** An amount of each resource. */
export type ResourceVector = Readonly<Record<DiscretionaryResource, number>>;

/**
 * Workers Free's daily limits, per account, reset at 00:00 UTC (Durable
 * Objects, D1 and Queues pricing pages, read 2026-10-27): duration is
 * 13,000 GB-s, in milliseconds at the 128 MB an object is billed for.
 */
export const FREE_DAILY: ResourceVector = {
  do_requests: 100_000,
  do_rows_read: 5_000_000,
  do_rows_written: 100_000,
  do_duration_ms: 104_000_000,
  d1_rows_read: 5_000_000,
  d1_rows_written: 100_000,
  queue_ops: 10_000,
};

/** The share of each Free limit discretionary work gets unless set. Proposed. */
export const FREE_SHARE = 0.2;

/** Each resource's daily allowance; null for one not capped. */
export type Allowance = Readonly<Record<DiscretionaryResource, number | null>>;

const ENTRY = /^([a-z0-9_]+)=(0|[1-9][0-9]{0,14})$/;

/**
 * `FYRDEN_DISCRETIONARY_DAILY` (`resource=n,…`) read whole, or null when
 * unset or not readable whole (a resource unknown or named twice, a value
 * not a whole number): treated as unset, as `internalCallLimit` treats
 * its variable; `fyrden deploy` refuses such a value before it is set.
 */
function setValues(env: object): Partial<Record<DiscretionaryResource, number>> | null {
  const raw = (env as { FYRDEN_DISCRETIONARY_DAILY?: unknown }).FYRDEN_DISCRETIONARY_DAILY;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const values: Partial<Record<DiscretionaryResource, number>> = {};
  for (const part of raw.split(",")) {
    const match = ENTRY.exec(part.trim());
    const resource = match?.[1] as DiscretionaryResource | undefined;
    if (!match || !resource || !DISCRETIONARY_RESOURCES.includes(resource)) return null;
    if (resource in values) return null;
    values[resource] = Number(match[2]);
  }
  return values;
}

/**
 * The deployment's daily allowance for discretionary work, or null when
 * nothing is capped (no admission is then made at all). Free: each
 * resource as set, at most Free's limit, else `FREE_SHARE` of it. Paid:
 * only the resources set are capped (scale is billed, not refused).
 */
export function discretionaryAllowance(env: object): Allowance | null {
  const set = setValues(env) ?? {};
  const paid = workersPlan(env) === "paid";
  if (paid && Object.keys(set).length === 0) return null;
  return Object.fromEntries(
    DISCRETIONARY_RESOURCES.map((resource) => {
      const value = set[resource];
      if (paid) return [resource, value ?? null];
      const limit = FREE_DAILY[resource];
      return [resource, value === undefined ? limit * FREE_SHARE : Math.min(value, limit)];
    }),
  ) as Allowance;
}

/** How long an admitted effect may be delivered after it is journaled: its window. Proposed. */
export const DISCRETIONARY_WINDOW_MS = 60 * 60 * 1000;

/** What a discretionary effect is admitted with. */
export interface Admission {
  /** Its whole life's cost at its worst, in each resource. */
  readonly price: ResourceVector;
  /** Attempts it gets at most (one: never retried at core's expense). */
  readonly maxAttempts: number;
  /** How long after it is journaled it may be delivered. */
  readonly windowMs: number;
  /** How long a refusal may leave what it would have delivered missing (reported meanwhile). */
  readonly warnMs: number;
}

/**
 * The database's own clock, in UTC hours and days since the Unix epoch:
 * an admission's window is the database's, whenever the batch was made
 * (one made before midnight and run after it is judged in the new day).
 */
const HOUR = "CAST(unixepoch() / 3600 AS INTEGER)";
const DAY = "CAST(unixepoch() / 86400 AS INTEGER)";

/**
 * SQL true when the effect `?<n>` names was admitted: the hour's row (or
 * the one before, should the batch straddle an hour) last admitted it.
 */
export const ADMITTED_EFFECT = (n: number) =>
  `EXISTS (SELECT 1 FROM discretionary_hours WHERE hour >= ${HOUR} - 1 AND last_grant = ?${n})`;

/**
 * The statements admitting one discretionary effect, before its journal
 * insert (whose own guards `guards` repeats, with `?1` its id and the
 * source's id at `?2`): a grant, when the day has refused nothing yet and
 * every resource's admissions from the hour before the day's start on
 * (later hours included: a batch run late still counts what was admitted
 * after it was made), with this price, stay within the allowance; else,
 * the day's first refusal, recorded once, with its warning's end (the
 * next midnight plus `warnMs`, only ever raised). Nothing is admitted for
 * an effect already journaled (a redelivered event's).
 */
export function admissionStatements(
  db: D1Database,
  effectId: string,
  sourceId: string,
  { price, warnMs }: Admission,
  allowance: Allowance,
  guards: string,
): D1PreparedStatement[] {
  const n = DISCRETIONARY_RESOURCES.length;
  const columns = DISCRETIONARY_RESOURCES.join(", ");
  // ?3.. the price; ?(3 + n).. the allowance (null: not capped).
  const fits = DISCRETIONARY_RESOURCES.map(
    (resource, i) => `(?${3 + n + i} IS NULL OR s.${resource} + ?${3 + i} <= ?${3 + n + i})`,
  ).join(" AND ");
  const sums = DISCRETIONARY_RESOURCES.map(
    (resource) => `coalesce(sum(${resource}), 0) AS ${resource}`,
  ).join(", ");
  const fresh = `NOT EXISTS (SELECT 1 FROM effects WHERE effect_id = ?1)`;
  const grant = db
    .prepare(
      `INSERT INTO discretionary_hours (hour, ${columns}, granted, last_grant)
       SELECT ${HOUR}, ${DISCRETIONARY_RESOURCES.map((_, i) => `?${3 + i}`).join(", ")}, 1, ?1
       WHERE ${guards} AND ${fresh}
         AND NOT EXISTS (SELECT 1 FROM discretionary_state WHERE id = 1 AND refused_day >= ${DAY})
         AND EXISTS (SELECT 1 FROM (SELECT ${sums} FROM discretionary_hours
           WHERE hour >= ${DAY} * 24 - 1) s WHERE ${fits})
       ON CONFLICT (hour) DO UPDATE SET
         ${DISCRETIONARY_RESOURCES.map((r) => `${r} = ${r} + excluded.${r}`).join(", ")},
         granted = granted + 1, last_grant = excluded.last_grant
       RETURNING last_grant AS admitted`,
    )
    .bind(
      effectId,
      sourceId,
      ...DISCRETIONARY_RESOURCES.map((r) => price[r]),
      ...DISCRETIONARY_RESOURCES.map((r) => allowance[r]),
    );
  const refusal = db
    .prepare(
      `INSERT INTO discretionary_state (id, refused_day, warn_until)
       SELECT 1, ${DAY}, (${DAY} + 1) * 86400000 + ?3
       WHERE ${guards} AND ${fresh} AND NOT ${ADMITTED_EFFECT(1)}
       ON CONFLICT (id) DO UPDATE SET refused_day = excluded.refused_day,
         warn_until = max(warn_until, excluded.warn_until)
       WHERE refused_day < excluded.refused_day`,
    )
    .bind(effectId, sourceId, warnMs);
  return [grant, refusal];
}

/** Admitted hours kept (a day's window reaches one hour before it). */
export const DISCRETIONARY_KEPT_HOURS = 48;

/** Deletes admitted hours no window reaches any more. */
export function pruneHoursStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `DELETE FROM discretionary_hours WHERE hour < ${HOUR} - ${DISCRETIONARY_KEPT_HOURS}`,
  );
}

/** How long an isolate keeps what it read of the warning before reading it again. Proposed. */
export const DELIVERY_STATE_TTL_MS = 60_000;

/** The warning's end as last read (0: none), and when a read was last tried. */
let known: number | undefined;
let triedAt = Number.NEGATIVE_INFINITY;
/** The read under way, which callers meanwhile wait on rather than start another. */
let reading: Promise<void> | undefined;

/**
 * Whether watched activity may be missing from feeds: a discretionary
 * effect was refused within the feeds' retention (until `warn_until`),
 * the same for every reader. Read from the read model at most once
 * `DELIVERY_STATE_TTL_MS` an isolate, failed reads included, one at a time
 * (two isolates may briefly differ); a failed read keeps what was known
 * (complete when nothing was).
 */
export async function deliveryState(
  db: D1Database,
  now: number,
  metrics?: { count(name: "d1.query", dims: { db: string; op: string }): void },
): Promise<"complete" | "degraded"> {
  if (!reading && now - triedAt >= DELIVERY_STATE_TTL_MS) {
    triedAt = now;
    const read = async () => {
      metrics?.count("d1.query", { db: "org", op: "discretionary_state" });
      const row = await db
        .prepare("SELECT warn_until FROM discretionary_state WHERE id = 1")
        .first<{ warn_until: number }>();
      known = row?.warn_until ?? 0;
    };
    // Settled before it is cleared, whether the read failed at once or later.
    const pending = Promise.resolve()
      .then(read)
      .catch(() => {
        // Kept as known; read again once the minute is past.
      })
      .finally(() => {
        if (reading === pending) reading = undefined;
      });
    reading = pending;
  }
  if (reading) await reading;
  return known !== undefined && now < known ? "degraded" : "complete";
}

/** Forgets what this isolate read of the warning (tests). */
export function forgetDeliveryState(): void {
  known = undefined;
  triedAt = Number.NEGATIVE_INFINITY;
  reading = undefined;
}
