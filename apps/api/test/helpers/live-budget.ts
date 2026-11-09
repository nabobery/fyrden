// The live ledger under test: D1 with its clock set by the test (the marked
// expression replaced in every statement, real D1 running them), plans with
// declared test prices, and the ledger singleton kept as it was.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import type { ResourceVector } from "../../src/effects/discretionary.js";
import {
  canonicalVector,
  LIVE_NOW,
  type LiveDayCharge,
  type LiveGrantPlan,
  type LiveUnit,
} from "../../src/live/budget.js";

export const DAY = 86_400_000;
const MINUTE = 60_000;

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

/**
 * D1's clock in every ledger statement of every binding in this isolate, a Durable Object's among
 * them (which `clockedD1` can't reach), held at `now` until the returned function is called.
 */
export async function pinLedgerClock(now: number): Promise<() => void> {
  const rewrite = (query: string) => query.split(LIVE_NOW).join(`(${now})`);
  type Preparing = { prepare(query: string): D1PreparedStatement };
  const session = env.DIRECTORY.withSession("first-primary");
  const prototypes = [env.DIRECTORY, session].map((d) => Object.getPrototypeOf(d) as Preparing);
  const originals = prototypes.map((proto) => proto.prepare);
  prototypes.forEach((proto, i) => {
    const original = originals[i] as Preparing["prepare"];
    proto.prepare = function (this: Preparing, query: string) {
      return original.call(this, rewrite(query));
    };
  });
  return () => {
    prototypes.forEach((proto, i) => {
      proto.prepare = originals[i] as Preparing["prepare"];
    });
  };
}

/**
 * Counts the D1 rows every statement in this isolate reads and writes (as D1's result metadata
 * says) until `stop`: a Worker's and a Durable Object's alike, whichever binding or session runs
 * them. A statement's `first` is read through `all`, as an invocation counts it.
 */
export function countD1Rows(): { stop(): { d1Read: number; d1Written: number } } {
  const tally = { d1Read: 0, d1Written: 0 };
  type Meta = { rows_read?: number; rows_written?: number } | undefined;
  const add = (meta: Meta) => {
    tally.d1Read += meta?.rows_read ?? 0;
    tally.d1Written += meta?.rows_written ?? 0;
  };
  type Fn = (this: unknown, ...args: unknown[]) => Promise<unknown>;
  const restore: (() => void)[] = [];
  const patch = (proto: Record<string, Fn>, name: string, make: (original: Fn) => Fn) => {
    const original = proto[name] as Fn;
    proto[name] = make(original);
    restore.push(() => {
      proto[name] = original;
    });
  };
  const db = env.DIRECTORY;
  // A binding's batch runs through its session's: counted there only, once.
  patch(
    Object.getPrototypeOf(db.withSession("first-primary")) as Record<string, Fn>,
    "batch",
    (original) =>
      async function (this: unknown, ...args: unknown[]) {
        const results = (await original.apply(this, args)) as { meta?: Meta }[];
        for (const result of results) add(result?.meta);
        return results;
      },
  );
  const statement = Object.getPrototypeOf(db.prepare("SELECT 1")) as Record<string, Fn>;
  const all = statement.all as Fn;
  for (const name of ["all", "run"])
    patch(
      statement,
      name,
      (original) =>
        async function (this: unknown, ...args: unknown[]) {
          const result = (await original.apply(this, args)) as { meta?: Meta };
          add(result?.meta);
          return result;
        },
    );
  patch(
    statement,
    "first",
    () =>
      async function (this: unknown, ...args: unknown[]) {
        const result = (await all.call(this)) as {
          meta?: Meta;
          results?: Record<string, unknown>[];
        };
        add(result?.meta);
        const row = result?.results?.[0];
        if (row === undefined) return null;
        const column = args[0] as string | undefined;
        return column === undefined ? row : (row[column] ?? null);
      },
  );
  return {
    stop() {
      for (const undo of restore.reverse()) undo();
      return tally;
    },
  };
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

/** `n` receipts expired half an hour before `at`: within the overdue check's grace. */
export async function expiredReceipts(at: number, n: number): Promise<void> {
  const { incarnation } = (await env.DIRECTORY.prepare(
    "SELECT incarnation FROM live_budget_state WHERE id = 1",
  ).first<{ incarnation: string }>()) as { incarnation: string };
  const expiresAt = at - 30 * MINUTE;
  const validUntil = expiresAt - 2 * DAY;
  const zero = JSON.stringify(canonicalVector(ZERO));
  await env.DIRECTORY.batch(
    Array.from({ length: n }, (_, i) =>
      env.DIRECTORY.prepare(
        `INSERT INTO live_budget_receipts (seq, operation_id, mint, incarnation, recipient_type,
           recipient, kind, class, epoch, produces_local, valid_from, valid_until, granted_at,
           plan, directory_cleanup_debt, settle_until, expires_at)
         VALUES (?, ?, ?, ?, 'UserDO', ?, 'ticket', 'ordinary', 0, 0, ?, ?, ?, '{"charges":[]}', ?, ?, ?)`,
      ).bind(
        Number.MAX_SAFE_INTEGER - i,
        uniqueId("expired"),
        uniqueId("mint"),
        incarnation,
        uniqueId("feed"),
        validUntil - MINUTE,
        validUntil,
        validUntil - MINUTE,
        zero,
        validUntil,
        expiresAt,
      ),
    ),
  );
}

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
      // Owners never expire (an uncertain one keeps its place): every test's own goes.
      env.DIRECTORY.prepare("DELETE FROM live_duration_owners"),
      env.DIRECTORY.prepare(
        `UPDATE live_budget_state SET incarnation = ?, ${DEBTS.map((d, i) => `${d} = ?${i + 2}`).join(", ")} WHERE id = 1`,
      ).bind(before.incarnation, ...DEBTS.map((d) => before[d])),
    ]);
  }
}

const DEBTS = [
  "targets_incarnation",
  "revocations_reap_at",
  "revocations_reap_seq",
  "revocations_reap_end_at",
  "revocations_reap_end_seq",
  "duration_debt_ms",
  "debt_service_day",
  "duration_reserve_ms",
  "ordinary_duration_blocked",
  "debt_do_requests",
  "debt_do_rows_read",
  "debt_do_rows_written",
  "debt_do_duration_ms",
  "debt_d1_rows_read",
  "debt_d1_rows_written",
  "debt_queue_ops",
];
