// The live ledger under test: D1 with its clock set by the test (the marked
// expression replaced in every statement, real D1 running them), plans with
// declared test prices, and the ledger singleton kept as it was.

import { env } from "cloudflare:workers";
import type { ResourceVector } from "../../src/effects/discretionary.js";
import {
  LIVE_NOW,
  type LiveDayCharge,
  type LiveGrantPlan,
  type LiveUnit,
} from "../../src/live/budget.js";

export const DAY = 86_400_000;

/** `db` with D1's clock at `clock.now` (milliseconds) in every ledger statement. */
export function clockedD1(db: D1Database | D1DatabaseSession, clock: { now: number }): D1Database {
  const rewrite = (query: string) => query.split(LIVE_NOW).join(`(${clock.now})`);
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => target.prepare(rewrite(query));
      if (prop === "withSession")
        return (constraint?: D1SessionConstraint | D1SessionBookmark) =>
          clockedD1((target as D1Database).withSession(constraint), clock);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

export const ZERO: ResourceVector = {
  do_requests: 0,
  do_rows_read: 0,
  do_rows_written: 0,
  do_duration_ms: 0,
  d1_rows_read: 0,
  d1_rows_written: 0,
  queue_ops: 0,
};

export const vector = (parts: Partial<ResourceVector>): ResourceVector => ({ ...ZERO, ...parts });

/** The ledger's incarnation now. */
export async function incarnation(): Promise<string> {
  const row = await env.DIRECTORY.prepare(
    "SELECT incarnation FROM live_budget_state WHERE id = 1",
  ).first<{ incarnation: string }>();
  return (row as { incarnation: string }).incarnation;
}

/**
 * A plan for `day` (its first charge), valid from `from` (noon) for `validMs`,
 * charging `resources` (and a duration hold when given).
 */
export async function plan(options: {
  day: number;
  from?: number;
  validMs?: number;
  recipient?: string;
  recipientType?: LiveGrantPlan["recipientType"];
  kind?: LiveUnit;
  class?: "ordinary" | "cleanup";
  producesLocal?: boolean;
  epoch?: number;
  resources?: ResourceVector;
  charges?: LiveDayCharge[];
  directoryCleanupDebt?: ResourceVector;
  localCleanupDebt?: ResourceVector;
  dayCleanupDebt?: ResourceVector;
  incarnation?: string;
}): Promise<LiveGrantPlan> {
  // Noon, when the tests' clock stands unless moved.
  const from = options.from ?? options.day * DAY + DAY / 2;
  return {
    protocol: 1,
    incarnation: options.incarnation ?? (await incarnation()),
    recipientType: options.recipientType ?? "UserDO",
    recipient: options.recipient ?? "usr_live_budget",
    epoch: options.epoch ?? 0,
    kind: options.kind ?? "pump",
    class: options.class ?? "ordinary",
    producesLocal: options.producesLocal ?? false,
    validFrom: from,
    validUntil: from + (options.validMs ?? 60_000),
    charges: options.charges ?? [
      {
        day: options.day,
        resources: options.resources ?? vector({ do_requests: 1 }),
        duration: null,
      },
    ],
    directoryCleanupDebt: options.directoryCleanupDebt ?? ZERO,
    localCleanupDebt: options.localCleanupDebt ?? ZERO,
    dayCleanupDebt: options.dayCleanupDebt ?? ZERO,
  };
}

/** A day's row (or null). */
export function dayRow(day: number) {
  return env.DIRECTORY.prepare("SELECT * FROM live_budget_days WHERE day = ?")
    .bind(day)
    .first<Record<string, number | string>>();
}

/** The ledger singleton's debt and sequence. */
export function ledger() {
  return env.DIRECTORY.prepare("SELECT * FROM live_budget_state WHERE id = 1").first<
    Record<string, number | string | null>
  >();
}

/**
 * Days far apart per test (the ledger is the deployment's, shared by the
 * file's tests): a base day well past any real one, plus `slot` weeks.
 */
export const testDay = (slot: number) => 40_000 + slot * 14;

/**
 * Runs `fn` and then puts the ledger back as it was: receipts, days and
 * targets made since removed, the singleton's debt restored (its sequence
 * stays ahead). The file's tests run one at a time.
 */
export async function isolated(fn: () => Promise<void>): Promise<void> {
  const before = (await ledger()) as Record<string, number | string | null>;
  try {
    await fn();
  } finally {
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare("DELETE FROM live_budget_receipts WHERE seq > ?").bind(
        before.grant_seq,
      ),
      env.DIRECTORY.prepare("DELETE FROM live_budget_days"),
      env.DIRECTORY.prepare("DELETE FROM live_recovery_targets"),
      env.DIRECTORY.prepare(
        `UPDATE live_budget_state SET incarnation = ?, ${DEBTS.map((d, i) => `${d} = ?${i + 2}`).join(", ")} WHERE id = 1`,
      ).bind(before.incarnation, ...DEBTS.map((d) => before[d])),
    ]);
  }
}

const DEBTS = [
  "debt_do_requests",
  "debt_do_rows_read",
  "debt_do_rows_written",
  "debt_do_duration_ms",
  "debt_d1_rows_read",
  "debt_d1_rows_written",
  "debt_queue_ops",
];
