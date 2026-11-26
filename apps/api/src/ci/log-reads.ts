import type { LogReadCharge } from "../do/run/log-pages.js";
import { workersPlan } from "../git/fetch/mode.js";
import { CI_DAY_MS, CI_LOG_READS_DAILY, CI_NOW, CI_TODAY } from "./budget.js";

/**
 * Charges `chunks` R2 reads to today by D1's clock, only while the day stays
 * within its allowance. A charge is never refunded, so a page refused or cut
 * short after it never undercounts the day. Paid: granted, with no call.
 */
export async function chargeLogReads(
  env: object,
  db: D1Database,
  chunks: number,
): Promise<LogReadCharge> {
  if (workersPlan(env) === "paid") return { status: "granted" };
  const [charged, clock] = await db.batch([
    db
      .prepare(
        `INSERT INTO ci_log_read_days (day, class_b)
         SELECT ${CI_TODAY}, CAST(?1 AS INTEGER) WHERE ?1 <= ?2
         ON CONFLICT (day) DO UPDATE SET class_b = class_b + excluded.class_b
           WHERE class_b + excluded.class_b <= ?2
         RETURNING day`,
      )
      .bind(chunks, CI_LOG_READS_DAILY),
    db.prepare(`SELECT ${CI_NOW} AS now, (${CI_TODAY} + 1) * ${CI_DAY_MS} AS midnight`),
  ]);
  if ((charged?.results.length ?? 0) === 1) return { status: "granted" };
  const times = clock?.results[0] as { now: number; midnight: number } | undefined;
  if (!times) throw new Error("the directory answered no time");
  const { now, midnight } = times;
  return {
    status: "spent",
    retryAt: midnight,
    retryAfter: Math.max(1, Math.ceil((midnight - now) / 1000)),
  };
}
