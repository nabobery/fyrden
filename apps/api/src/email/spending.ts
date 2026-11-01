import { createLogger } from "@fyrden/adapters-cloudflare/obs";

/*
 * The deployment's provider allowance: messages a UTC day and a UTC month
 * (`FYRDEN_EMAIL_DAILY_LIMIT`, default 100, and
 * `FYRDEN_EMAIL_MONTHLY_LIMIT`, default 3,000: Resend Free's), kept in the
 * directory (`email_spend`). Each provider call reserves one message in
 * both the day's and the month's row before it is made, in the batch of
 * its fence (both or neither); a refusal gives back exactly the periods it
 * took, an unknown outcome keeps them. Notification email stops
 * `FYRDEN_EMAIL_RESERVE` (default 10) short of both limits, so
 * confirmations always have room. A daily limit of 0 turns email off;
 * otherwise `0 ≤ reserve < daily ≤ monthly`, else email is off (logged).
 * The provider's own quota also counts mail sent outside Fyrden.
 */

export interface EmailLimits {
  readonly daily: number;
  readonly monthly: number;
  readonly reserve: number;
}

export const EMAIL_LIMIT_DEFAULTS: EmailLimits = { daily: 100, monthly: 3_000, reserve: 10 };

type LimitsEnv = {
  FYRDEN_EMAIL_DAILY_LIMIT?: unknown;
  FYRDEN_EMAIL_MONTHLY_LIMIT?: unknown;
  FYRDEN_EMAIL_RESERVE?: unknown;
};

/** A limit as configured: its default when unset, NaN when not a whole number. */
function limitOf(value: unknown, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  return typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN;
}

/** Whether limits are usable: a daily limit above 0, the reserve below it, the month not below it. */
export function validLimits({ daily, monthly, reserve }: EmailLimits): boolean {
  return (
    [daily, monthly, reserve].every(Number.isSafeInteger) &&
    reserve >= 0 &&
    reserve < daily &&
    daily <= monthly
  );
}

/** The unusable configuration (as set) last logged, until a usable one: logged once a change. */
let logged: string | undefined;

/** The deployment's limits; null when email is off by them (0 a day, or unusable). */
export function emailLimits(env: object): EmailLimits | null {
  const vars = env as LimitsEnv;
  const limits = {
    daily: limitOf(vars.FYRDEN_EMAIL_DAILY_LIMIT, EMAIL_LIMIT_DEFAULTS.daily),
    monthly: limitOf(vars.FYRDEN_EMAIL_MONTHLY_LIMIT, EMAIL_LIMIT_DEFAULTS.monthly),
    reserve: limitOf(vars.FYRDEN_EMAIL_RESERVE, EMAIL_LIMIT_DEFAULTS.reserve),
  };
  if (limits.daily === 0) return null;
  if (validLimits(limits)) {
    logged = undefined;
    return limits;
  }
  const text = JSON.stringify([
    vars.FYRDEN_EMAIL_DAILY_LIMIT,
    vars.FYRDEN_EMAIL_MONTHLY_LIMIT,
    vars.FYRDEN_EMAIL_RESERVE,
  ]);
  if (logged !== text) {
    logged = text;
    createLogger({ op: "email.limits" }).error(
      "email limits are unusable: email is off (want 0 ≤ reserve < daily ≤ monthly)",
      { daily_monthly_reserve: text },
    );
  }
  return null;
}

const DAY = 24 * 60 * 60_000;

/** The periods a call at `now` reserves in: days since the epoch, and `year * 12 + month - 1` (UTC). */
export function periodsOf(now: number): { day: number; month: number } {
  const date = new Date(now);
  return {
    day: Math.floor(now / DAY),
    month: date.getUTCFullYear() * 12 + date.getUTCMonth(),
  };
}

/** Seconds until the period that ran out ends (the day's, or the month's). */
export function secondsUntilRoom(now: number, which: "day" | "month"): number {
  const date = new Date(now);
  const end =
    which === "day"
      ? (Math.floor(now / DAY) + 1) * DAY
      : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((end - now) / 1000));
}

/**
 * The fence's condition that both periods (`?<day>`, `?<month>`) have room
 * for one more message under `limits`, short of the reserve for
 * notification email (`reserve`), the whole limits for confirmations.
 */
export function roomFor(limits: EmailLimits, reserve: boolean, day: string, month: string): string {
  const held = reserve ? limits.reserve : 0;
  return `coalesce((SELECT used FROM email_spend WHERE scope = 'day' AND period = ${day}), 0)
      < ${limits.daily - held}
    AND coalesce((SELECT used FROM email_spend WHERE scope = 'month' AND period = ${month}), 0)
      < ${limits.monthly - held}`;
}

/** The statements reserving one message in both periods, each held by the admission `nonce`. */
export function reserving(
  db: D1Database,
  nonce: string,
  periods: { day: number; month: number },
): D1PreparedStatement[] {
  const admitted = "EXISTS (SELECT 1 FROM email_admissions WHERE nonce = ?1)";
  return (["day", "month"] as const).map((scope) =>
    db
      .prepare(
        `INSERT INTO email_spend (scope, period, used) SELECT ?2, ?3, 1 WHERE ${admitted}
         ON CONFLICT (scope, period) DO UPDATE SET used = used + 1`,
      )
      .bind(nonce, scope, periods[scope]),
  );
}

/** Gives one message back to the periods a refused call reserved in. */
export async function giveBack(
  db: D1Database,
  periods: { day: number; month: number },
): Promise<void> {
  await db.batch(
    (["day", "month"] as const).map((scope) =>
      db
        .prepare(
          "UPDATE email_spend SET used = used - 1 WHERE scope = ? AND period = ? AND used > 0",
        )
        .bind(scope, periods[scope]),
    ),
  );
}

/** The statement reaping spend rows below the period before (`now`'s). */
export function reapingSpend(db: D1Database, now: number): D1PreparedStatement {
  const { day, month } = periodsOf(now);
  return db
    .prepare(
      `DELETE FROM email_spend WHERE (scope = 'day' AND period < ?1)
         OR (scope = 'month' AND period < ?2)`,
    )
    .bind(day - 1, month - 1);
}
