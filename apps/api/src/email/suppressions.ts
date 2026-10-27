import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { emailProvider } from "./provider.js";

/*
 * The provider's suppression list as Fyrden knows it (`email_suppressions`,
 * one row a mailbox by `address_key`). The provider skips a suppressed
 * mailbox itself; Fyrden's copy keeps it from spending allowance on one and
 * tells its owner (`deliverable`).
 *
 * Callbacks (`suppression.added`, `suppression.removed`) each name a
 * suppression `S` and when it was created, `c`. An event of a suppression
 * created after the row's replaces it (suppressed, or the tombstone of
 * `S`); an event of the row's own suppression only removes it; an event of
 * an earlier one changes nothing, so redeliveries and replays, however
 * late, are harmless. Another suppression created in the same millisecond
 * leaves the row unresolved: suppressed, due for a recheck, and holding no
 * suppression (id `''`), so no replayed removal can clear it before the
 * provider decides.
 *
 * A removal whose callback was lost would block a mailbox here, so
 * suppressed rows are rechecked with the provider when due (7 days after
 * they were last confirmed, at once when an add or a resend meets one), a
 * few a run, by the address as the provider gave it. An answer applies only
 * while the row is as it was read (`rev`).
 */

export const SUPPRESSION_ORIGINS = ["bounce", "complaint", "manual"] as const;
export type SuppressionOrigin = (typeof SUPPRESSION_ORIGINS)[number];

/** One suppression, as the provider describes it. */
export interface Suppression {
  readonly id: string;
  /** The address as the provider gave it. */
  readonly email: string;
  readonly origin: SuppressionOrigin;
  /** When it was created (milliseconds). */
  readonly createdAt: number;
}

/** How long a suppression confirmed by the provider goes before it is rechecked. */
export const RECHECK_AFTER_MS = 7 * 24 * 60 * 60_000;
/** How long a row whose lookup failed waits: the provider's or the key's failure, or the row's. */
const RETRY_PROVIDER_MS = 60 * 60_000;
const RETRY_ROW_MS = 24 * 60 * 60_000;

/** Rechecks a run makes at most (`FYRDEN_EMAIL_RECHECKS`, 0 to 10), well under Free's subrequests. */
export function rechecksOf(env: object): number {
  const value = (env as { FYRDEN_EMAIL_RECHECKS?: unknown }).FYRDEN_EMAIL_RECHECKS;
  if (value === undefined || value === "") return 3;
  return typeof value === "string" && /^(?:[0-9]|10)$/.test(value) ? Number(value) : 3;
}

/** Days in a month of the proleptic Gregorian calendar (`month` 1 to 12). */
function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * A provider time in milliseconds: ISO 8601 (`2026-11-17T19:32:22.980Z`),
 * or the list's SQL form (`2026-10-06 23:47:56.678+00`); undefined for any
 * other text.
 */
export function providerTime(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  const parts =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(
      text,
    );
  if (!parts) return undefined;
  const [, date = "", time = "", fraction = "", zone = ""] = parts;
  // A calendar date and a time of day that exist (Date.parse rolls 2026-02-30 into March).
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute, second] = time.split(":").map(Number) as [number, number, number];
  const offsetHours = zone === "Z" ? 0 : Math.abs(Number(zone.slice(1, 3)));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysIn(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 14
  )
    return undefined;
  const offset =
    zone === "Z"
      ? "Z"
      : zone.length === 3
        ? `${zone}:00`
        : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const millis = `${fraction}000`.slice(0, 3);
  const at = Date.parse(`${date}T${time}.${millis}${offset}`);
  return Number.isFinite(at) ? at : undefined;
}

/** A suppression from the provider's JSON (a callback's `data`, or a lookup); undefined when malformed. */
export function suppressionOf(value: unknown): Suppression | undefined {
  const data = value as Record<string, unknown> | null;
  if (typeof data !== "object" || data === null) return undefined;
  const { id, email, origin } = data;
  const createdAt = providerTime(data.created_at);
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
    typeof email !== "string" ||
    email.length > 320 ||
    !email.includes("@") ||
    !(SUPPRESSION_ORIGINS as readonly string[]).includes(origin as string) ||
    createdAt === undefined
  )
    return undefined;
  return { id, email, origin: origin as SuppressionOrigin, createdAt };
}

/** The statement applying one callback (`suppressed`: added, else removed) at `now`. */
export function applying(
  db: D1Database,
  event: Suppression,
  suppressed: boolean,
  now: number,
): D1PreparedStatement {
  // In DO UPDATE every column on the right is the row's old value, `excluded.*` the event's.
  const newer = "excluded.created_at > created_at";
  const tie = "excluded.created_at = created_at AND excluded.suppression_id <> suppression_id";
  return db
    .prepare(
      `INSERT INTO email_suppressions
         (address_key, email, suppression_id, created_at, origin, suppressed, rev, next_check_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
       ON CONFLICT (address_key) DO UPDATE SET
         email = CASE WHEN ${newer} OR ${tie} THEN excluded.email ELSE email END,
         suppression_id = CASE WHEN ${newer} THEN excluded.suppression_id
           WHEN ${tie} THEN '' ELSE suppression_id END,
         created_at = max(created_at, excluded.created_at),
         origin = CASE WHEN ${newer} THEN excluded.origin ELSE origin END,
         suppressed = CASE WHEN ${newer} THEN excluded.suppressed WHEN ${tie} THEN 1 ELSE 0 END,
         rev = rev + 1,
         next_check_at = CASE WHEN ${newer} THEN excluded.next_check_at
           WHEN ${tie} THEN ?8 ELSE next_check_at END
       WHERE ${newer} OR ${tie}
         OR (excluded.suppression_id = suppression_id AND excluded.suppressed = 0 AND suppressed = 1)`,
    )
    .bind(
      event.email.toLowerCase(),
      event.email,
      event.id,
      event.createdAt,
      event.origin,
      suppressed ? 1 : 0,
      now + RECHECK_AFTER_MS,
      now,
    );
}

/** The statement making the suppressed rows among `keys` (JSON) due now (never later than they were). */
export function makingDue(db: D1Database, keys: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE email_suppressions SET next_check_at = ?2
       WHERE address_key IN (SELECT value FROM json_each(?1)) AND suppressed = 1
         AND next_check_at > ?2`,
    )
    .bind(keys, now);
}

/** What a lookup of one address found. */
export type Lookup =
  | { readonly status: "found"; readonly suppression: Suppression }
  | { readonly status: "absent" }
  /** An answer about that row the provider will give again (another 4xx, a malformed body). */
  | { readonly status: "invalid" }
  /** The provider's or the key's failure (401/403, 429, 5xx, a timeout, no answer). */
  | { readonly status: "failed" };

type Due = { address_key: string; email: string; rev: number };

/**
 * Rechecks the suppressed rows that are due, oldest first, at most
 * `rechecksOf(env)` a run, one at a time. A provider failure moves the row
 * an hour on and ends the run's rechecks.
 */
export async function recheckSuppressions(
  env: Env,
  deps: { now: number; metrics?: Metrics },
): Promise<void> {
  const provider = emailProvider(env);
  const limit = rechecksOf(env);
  if (!provider?.lookupSuppression || limit === 0) return;
  const db = env.DIRECTORY;
  deps.metrics?.count("d1.query", { db: "directory", op: "suppressions_due" });
  const { results } = await db
    .prepare(
      `SELECT address_key, email, rev FROM email_suppressions INDEXED BY email_suppressions_due
       WHERE suppressed = 1 AND next_check_at <= ? ORDER BY next_check_at, address_key LIMIT ?`,
    )
    .bind(deps.now, limit)
    .all<Due>();
  for (const row of results) {
    const lookup = await provider.lookupSuppression(row.email);
    deps.metrics?.count("email.suppression_check", { status: lookup.status });
    deps.metrics?.count("d1.query", { db: "directory", op: "suppression_check" });
    const now = Date.now();
    const statement =
      lookup.status === "found"
        ? db
            .prepare(
              `UPDATE email_suppressions SET email = ?3, suppression_id = ?4, created_at = ?5,
                 origin = ?6, suppressed = 1, rev = rev + 1, next_check_at = ?7
               WHERE address_key = ?1 AND rev = ?2`,
            )
            .bind(
              row.address_key,
              row.rev,
              lookup.suppression.email,
              lookup.suppression.id,
              lookup.suppression.createdAt,
              lookup.suppression.origin,
              now + RECHECK_AFTER_MS,
            )
        : lookup.status === "absent"
          ? db
              .prepare(
                `UPDATE email_suppressions SET suppressed = 0, rev = rev + 1
                 WHERE address_key = ?1 AND rev = ?2`,
              )
              .bind(row.address_key, row.rev)
          : db
              .prepare(
                `UPDATE email_suppressions SET next_check_at = ?3
                 WHERE address_key = ?1 AND rev = ?2`,
              )
              .bind(
                row.address_key,
                row.rev,
                now + (lookup.status === "failed" ? RETRY_PROVIDER_MS : RETRY_ROW_MS),
              );
    await statement.run();
    if (lookup.status === "failed") {
      createLogger({ op: "email.suppressions" }).warn(
        "the provider did not answer a suppression lookup: rechecks resume next run",
      );
      return;
    }
  }
}
