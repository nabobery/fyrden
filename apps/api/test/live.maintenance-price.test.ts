// Live maintenance's price, from its pages full: each page of a run built
// past its bound, at its worst (receipts holding escrow over a midnight,
// the deployment's owners each settled two pages of days, recoveries'
// durations settled, every kind reaped), and run alone, the D1 rows it
// reads and writes counted as an invocation counts them; and a whole run
// (its own grant, over a midnight, its owner and checks) with one receipt
// to remove. A run is priced at no less than their sum.

import { env } from "cloudflare:workers";
import {
  countedD1,
  createMetrics,
  d1RowsRun,
  measureInvocation,
} from "@fyrden/adapters-cloudflare/obs";
import { describe, expect, it } from "vitest";
import {
  expireLiveReceipts,
  type LiveDayCharge,
  type LiveEnvelope,
  makeLiveGrant,
  pruneLiveBudgetDays,
  reserveLive,
} from "../src/live/budget.js";
import { reaping } from "../src/live/directory.js";
import {
  LIVE_MAINTENANCE,
  LIVE_REVOCATION_PAGE,
  liveMaintenanceWork,
  runLiveMaintenance,
  settleStrandedOwners,
} from "../src/live/maintenance.js";
import { LIVE_MAINTENANCE_MEASURED, LIVE_REVOCATION_PAGE_MEASURED } from "../src/live/manifest.js";
import {
  admitLiveOwners,
  LIVE_OWNER_LIMITS,
  markLiveOwnerDispatched,
  observeLiveOwner,
  serviceLiveDurationDebt,
} from "../src/live/owners.js";
import {
  adoptLiveRecoveryTargets,
  type LiveRecoveryRequest,
  recoverLiveTargets,
} from "../src/live/recovery.js";
import { clockedD1, DAY, isolated, plan, testDay, vector } from "./helpers/live-budget.js";

const MINUTE = 60_000;
const HOLD = 30_000;

type Rows = { read: number; written: number };

/** The D1 rows `fn` reads and writes with D1's clock at `now`, as an invocation counts them. */
function measure(now: number, fn: (db: D1Database) => Promise<unknown>): Promise<Rows> {
  return measureInvocation(
    createMetrics(env.METRICS),
    { where: "do", op: "liveMaintenance", doClass: "MaintenanceDO" },
    async () => {
      const before = d1RowsRun();
      await fn(countedD1(clockedD1(env.DIRECTORY, { now })));
      const after = d1RowsRun();
      return { read: after.read - before.read, written: after.written - before.written };
    },
  );
}

/**
 * A grant for `recipient` from a minute before `day`'s midnight, holding
 * duration on both days it may run on (its escrow on each).
 */
async function overMidnight(
  day: number,
  recipient: string,
  options: { class?: "ordinary" | "cleanup"; kind?: "pump" | "recovery" } = {},
): Promise<LiveEnvelope> {
  const from = (day + 1) * DAY - MINUTE;
  const charges: LiveDayCharge[] = [
    {
      day,
      resources: vector({ do_requests: 1, do_duration_ms: MINUTE }),
      duration: { day, from, until: (day + 1) * DAY, ms: MINUTE },
    },
    {
      day: day + 1,
      resources: vector({ do_duration_ms: HOLD }),
      duration: { day: day + 1, from: (day + 1) * DAY, until: from + 2 * MINUTE + HOLD, ms: HOLD },
    },
  ];
  const p = await plan({
    day,
    from,
    validMs: 2 * MINUTE,
    recipient,
    directoryCleanupDebt: vector({ d1_rows_written: 2 }),
    charges,
    ...(options.class === "cleanup" && { class: "cleanup", kind: options.kind ?? "recovery" }),
  });
  const result = await reserveLive(clockedD1(env.DIRECTORY, { now: from }), await makeLiveGrant(p));
  if (result.status !== "granted") throw new Error(result.reason);
  return result.grant;
}

/** Clears what is left (an ordinary grant waits for overdue cleanup), as of `now`. */
async function clear(now: number) {
  const db = clockedD1(env.DIRECTORY, { now });
  while ((await expireLiveReceipts(db, 32)).expired > 0);
  while ((await pruneLiveBudgetDays(db, 8)).removed > 0);
}

describe("a maintenance run's pages, full", () => {
  it("cost no more than its price was measured at", () =>
    isolated(async () => {
      const first = testDay(1);
      const out: Record<string, Rows> = {};

      // Receipts each holding escrow on two days of their own, all expired: a page, and one more.
      // Latest first: an earlier one granted later would find the later ones overdue.
      const receipts = LIVE_MAINTENANCE.receipts;
      for (let i = receipts; i >= 0; i--) await overMidnight(first + 2 * i, `usr_receipt_${i}`);
      let now = (first + 2 * receipts + 10) * DAY;
      out.receipts = await measure(now, (db) => expireLiveReceipts(db, receipts));
      out.days = await measure(now, (db) => pruneLiveBudgetDays(db, LIVE_MAINTENANCE.days));
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET duration_debt_ms = 1000, debt_service_day = 0 WHERE id = 1",
      ).run();
      out.debt = await measure(now, (db) => serviceLiveDurationDebt(db));
      await clear(now);

      // Targets of another incarnation, a page and one more.
      const targetDebt = `json_object('do_requests', 0, 'do_rows_read', 0, 'do_rows_written', 2,
        'do_duration_ms', 0, 'd1_rows_read', 0, 'd1_rows_written', 0, 'queue_ops', 0)`;
      for (let i = 0; i <= LIVE_MAINTENANCE.recoveries; i++)
        await env.DIRECTORY.prepare(
          `INSERT INTO live_recovery_targets (feed, incarnation, through_seq, next_attempt_at,
             attempts, local_cleanup_debt) VALUES (?, ?, 1, ?, 0, ${targetDebt})`,
        )
          .bind(`usr_adopt_${i}`, "0".repeat(32), now + DAY)
          .run();
      out.adopt = await measure(now, (db) =>
        adoptLiveRecoveryTargets(db, LIVE_MAINTENANCE.recoveries),
      );
      await env.DIRECTORY.prepare("DELETE FROM live_recovery_targets").run();

      // Recoveries coordinated (their funded pages are recovery's own): targets due, captured,
      // each reply's duration settled over two days, retired.
      const coverage: Record<string, LiveEnvelope> = {};
      for (let i = LIVE_MAINTENANCE.recoveries; i >= 0; i--)
        coverage[`usr_due_${i}`] = await overMidnight(now / DAY + i, `usr_due_${i}`, {
          class: "cleanup",
        });
      now = (now / DAY + LIVE_MAINTENANCE.recoveries + 1) * DAY;
      // Their targets' debt as their grants would have added it.
      await env.DIRECTORY.prepare(
        `UPDATE live_budget_state SET debt_do_rows_written = debt_do_rows_written + ?
         WHERE id = 1`,
      )
        .bind(2 * (LIVE_MAINTENANCE.recoveries + 1))
        .run();
      const incarnation = (
        (await env.DIRECTORY.prepare("SELECT incarnation FROM live_budget_state").first()) as {
          incarnation: string;
        }
      ).incarnation;
      for (let i = 0; i <= LIVE_MAINTENANCE.recoveries; i++)
        await env.DIRECTORY.prepare(
          `INSERT INTO live_recovery_targets (feed, incarnation, through_seq, next_attempt_at,
             attempts, local_cleanup_debt) VALUES (?, ?, 1, ?, 0, ${targetDebt})`,
        )
          .bind(`usr_due_${i}`, incarnation, now - 3 * DAY)
          .run();
      out.recover = await measure(now - 3 * DAY + MINUTE, (db) =>
        recoverLiveTargets(db, {
          limit: LIVE_MAINTENANCE.recoveries,
          reserveTarget: async (feed) => ({
            status: "granted",
            replay: false,
            grant: coverage[feed] as LiveEnvelope,
          }),
          tell: async (request: LiveRecoveryRequest) => {
            const plan = request.coverage.plan;
            return {
              protocol: 1,
              nonce: request.nonce,
              feed: request.feed,
              incarnation: request.incarnation,
              throughSeq: request.throughSeq,
              status: "clean",
              completion: {
                protocol: 1,
                operationId: request.coverage.operationId,
                incarnation: plan.incarnation,
                recipientType: plan.recipientType,
                recipient: plan.recipient,
                epoch: plan.epoch,
                finishedAt: plan.validFrom + 1_000,
                actual: plan.charges.map((c) => ({ day: c.day, ms: 1_000 })),
              },
            };
          },
        }),
      );
      await clear(now);

      // Every kind reaping takes, each past its page.
      const reap = LIVE_MAINTENANCE.reap;
      const past = now - DAY;
      const fill: D1PreparedStatement[] = [];
      // Leases lapsed both ways (past their expiry, and pending past their wait): each its own
      // range, each past the page.
      for (let i = 0; i <= 2 * reap.leases + 1; i++) {
        const id = `s_${i}`;
        const pending = i % 2 === 1;
        fill.push(
          env.DIRECTORY.prepare(
            `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state,
               pending_until, expires_at) VALUES (?, ?, 'usr_reap', 'tok_reap', ?, ?, ?)`,
          ).bind(id, `t_${id}`, pending ? "pending" : "open", past, pending ? now + DAY : past),
        );
        for (let d = 0; d < 5; d++)
          fill.push(
            env.DIRECTORY.prepare(
              "INSERT INTO live_socket_deps (dependency, socket_id) VALUES (?, ?)",
            ).bind(`dep_${d}`, id),
          );
      }
      for (let i = 0; i <= reap.revocations; i++)
        fill.push(
          env.DIRECTORY.prepare(
            "INSERT INTO revocations (subject, at, expanded) VALUES (?, ?, 1)",
          ).bind(`rev_${i}`, past - 8 * DAY),
        );
      for (let i = 0; i <= reap.counts; i++)
        fill.push(
          env.DIRECTORY.prepare(
            "INSERT INTO live_admissions (principal_id, day, n) VALUES (?, ?, 1)",
          ).bind(`usr_count_${i}`, Math.floor(past / DAY) - 3),
          env.DIRECTORY.prepare(
            "INSERT INTO live_ticket_days (principal_id, day, issued) VALUES (?, ?, 1)",
          ).bind(`usr_count_${i}`, Math.floor(past / DAY) - 3),
        );
      for (let i = 0; i <= reap.transports; i++)
        fill.push(
          env.DIRECTORY.prepare(
            `INSERT INTO live_ticket_transports (ticket_hash, feed, credential_id, expires_at,
               operation_id) VALUES (?, 'usr_reap', 'tok_reap', ?, 'op')`,
          ).bind(`h_${i}`, past),
        );
      for (let i = 0; i < fill.length; i += 50) await env.DIRECTORY.batch(fill.slice(i, i + 50));
      out.reap = await measure(now, (db) => db.batch(reaping(db, now, reap)));

      // Owners (ordinary and cleanup) each having run seven days from a minute before a midnight
      // (eight days touched: two whole pages of days) with their accounting lost, a page and one
      // more: two pages settled each, then released.
      const ownersDay = Math.floor(now / DAY) + 1;
      await clear((ownersDay + 1) * DAY - MINUTE);
      const kinds = Array.from({ length: LIVE_MAINTENANCE.owners + 1 }, (_, i) =>
        i % 2 === 0 ? ("ordinary" as const) : ("cleanup" as const),
      );
      for (let i = kinds.length - 1; i >= 0; i--) {
        const g = await overMidnight(ownersDay, `usr_owner_${i}`, {
          class: kinds[i] as "ordinary" | "cleanup",
        });
        const from = g.plan.validFrom;
        const db = clockedD1(env.DIRECTORY, { now: from });
        const admitted = await admitLiveOwners(
          db,
          {
            incarnation: g.plan.incarnation,
            class: g.plan.class,
            dispatchFrom: from,
            dispatchUntil: g.plan.validUntil,
            owners: [{ operationId: g.operationId, role: "feed" }],
          },
          LIVE_OWNER_LIMITS,
        );
        if (admitted.status !== "admitted") throw new Error(admitted.reason);
        const ownerId = admitted.owners[0]?.ownerId as string;
        await markLiveOwnerDispatched(db, ownerId, { instance: "i1", startedAt: from });
        const end = from + 7 * DAY;
        await observeLiveOwner(clockedD1(env.DIRECTORY, { now: end }), ownerId, {
          startedAt: from,
          physicalFinishedAt: end,
          chargedThrough: end,
        });
      }
      out.owners = await measure((ownersDay + 9) * DAY, (db) =>
        settleStrandedOwners(db, LIVE_MAINTENANCE.owners),
      );
      expect(
        await env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_duration_owners").first(),
      ).toEqual({ n: 1 });

      // A whole run over a midnight with one receipt to remove: its own grant, owner and checks.
      now = (ownersDay + 10) * DAY;
      // The owner the page left goes first (its page is counted above).
      await settleStrandedOwners(clockedD1(env.DIRECTORY, { now }), LIVE_MAINTENANCE.owners);
      await clear(now);
      // (The owners' overruns are owed as duration debt, which holds ordinary duration back.)
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET duration_debt_ms = 0, ordinary_duration_blocked = 0",
      ).run();
      const one = await overMidnight(ownersDay + 9, "usr_one");
      // Half a minute before a midnight, a day past the receipt's expiry (overdue past the grace).
      const midnight = (ownersDay + 13) * DAY - 30_000;
      out.whole = await measureInvocation(
        createMetrics(env.METRICS),
        { where: "do", op: "liveMaintenance", doClass: "MaintenanceDO" },
        async () => {
          const before = d1RowsRun();
          const run = await runLiveMaintenance({
            ...env,
            DIRECTORY: countedD1(clockedD1(env.DIRECTORY, { now: midnight })),
          } as typeof env);
          if (run?.status !== "funded") throw new Error(JSON.stringify(run));
          const after = d1RowsRun();
          return { read: after.read - before.read, written: after.written - before.written };
        },
      );

      // The receipt removed by it.
      expect(
        await env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_budget_receipts WHERE seq = ?")
          .bind(one.seq)
          .first(),
      ).toEqual({ n: 0 });

      const total = Object.values(out).reduce(
        (sum, rows) => ({ read: sum.read + rows.read, written: sum.written + rows.written }),
        { read: 0, written: 0 },
      );
      expect({ out, total }).toEqual({
        out,
        total: {
          read: Math.min(total.read, LIVE_MAINTENANCE_MEASURED.d1_rows_read),
          written: Math.min(total.written, LIVE_MAINTENANCE_MEASURED.d1_rows_written),
        },
      });
    }));

  it("a revocation page, at its most, costs no more than it was measured at", () =>
    isolated(async () => {
      const now = Date.now();
      // Revocations to expand past a page, each resting on a socket in a feed of its own (each a
      // scan row and a target: a page's most).
      const fill: D1PreparedStatement[] = [];
      for (let i = 0; i <= LIVE_REVOCATION_PAGE.revocations; i++)
        fill.push(
          env.DIRECTORY.prepare(
            "INSERT INTO revocations (subject, at, expanded) VALUES (?, ?, 0)",
          ).bind(`dep_expand_${i}`, now),
          env.DIRECTORY.prepare(
            `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state,
             pending_until, expires_at) VALUES (?, ?, ?, 'tok_x', 'open', ?, ?)`,
          ).bind(`sx_${i}`, `tx_${i}`, `usr_expand_${i}`, now + DAY, now + DAY),
          env.DIRECTORY.prepare(
            "INSERT INTO live_socket_deps (dependency, socket_id) VALUES (?, ?)",
          ).bind(`dep_expand_${i}`, `sx_${i}`),
        );
      // A feed told, due before them, whose sockets all close: their leases released.
      fill.push(
        env.DIRECTORY.prepare(
          "INSERT INTO revocations (subject, at, expanded) VALUES (?, ?, 1)",
        ).bind("dep_told", now),
      );
      const closing: string[] = [];
      for (let i = 0; i < 20; i++) {
        const id = `st_${i}`;
        closing.push(id);
        fill.push(
          env.DIRECTORY.prepare(
            `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state,
             pending_until, expires_at) VALUES (?, ?, 'usr_told', 'tok_t', 'open', ?, ?)`,
          ).bind(id, `tt_${id}`, now + DAY, now + DAY),
        );
        for (let d = 0; d < 5; d++)
          fill.push(
            env.DIRECTORY.prepare(
              "INSERT INTO live_socket_deps (dependency, socket_id) VALUES (?, ?)",
            ).bind(d === 0 ? "dep_told" : `dep_t${d}`, id),
          );
      }
      for (let i = 0; i < fill.length; i += 50) await env.DIRECTORY.batch(fill.slice(i, i + 50));
      await env.DIRECTORY.prepare(
        `INSERT INTO revocation_targets (seq, feed, attempts, next_attempt_at)
       SELECT seq, 'usr_told', 0, ? FROM revocations WHERE subject = 'dep_told'`,
      )
        .bind(now - 60_000)
        .run();
      // Nothing routine due (earlier files' leftovers cleared), revocations due.
      for (let i = 0; i < 20 && (await liveMaintenanceWork(env.DIRECTORY)).routine; i++)
        await runLiveMaintenance(env);
      expect(await liveMaintenanceWork(env.DIRECTORY)).toEqual({
        routine: false,
        revocations: true,
      });
      const granted = () =>
        env.DIRECTORY.prepare(
          `SELECT sum(kind = 'maintenance') AS maintenance, sum(kind = 'revocation_page') AS pages
         FROM live_budget_receipts`,
        ).first<{ maintenance: number; pages: number }>();
      const before = await granted();
      const told: string[] = [];
      const rows = await measureInvocation(
        createMetrics(env.METRICS),
        { where: "do", op: "liveMaintenance", doClass: "MaintenanceDO" },
        async () => {
          const before = d1RowsRun();
          const run = await runLiveMaintenance({
            ...env,
            DIRECTORY: countedD1(env.DIRECTORY),
            USER: {
              getByName: (feed: string) => ({
                revoked: async () => {
                  told.push(feed);
                  return feed === "usr_told" ? closing : [];
                },
              }),
            },
          } as unknown as typeof env);
          if (run?.status !== "funded") throw new Error(JSON.stringify(run));
          const after = d1RowsRun();
          return { read: after.read - before.read, written: after.written - before.written };
        },
      );
      // Its own grant, routine maintenance's none (nothing routine was due).
      expect(await granted()).toEqual({
        maintenance: before?.maintenance ?? 0,
        pages: (before?.pages ?? 0) + 1,
      });
      // One feed told, its leases gone; the revocations expanded a page into targets of their own.
      expect(told).toEqual(["usr_told"]);
      expect(
        await env.DIRECTORY.prepare(
          "SELECT count(*) AS n FROM live_sockets WHERE feed = 'usr_told'",
        ).first(),
      ).toEqual({ n: 0 });
      expect(
        await env.DIRECTORY.prepare(
          `SELECT count(*) AS n FROM revocation_targets t JOIN revocations r ON r.seq = t.seq
         WHERE r.subject LIKE 'dep_expand_%'`,
        ).first(),
      ).toEqual({ n: LIVE_REVOCATION_PAGE.revocations });
      expect(rows).toEqual({
        read: Math.min(rows.read, LIVE_REVOCATION_PAGE_MEASURED.d1_rows_read),
        written: Math.min(rows.written, LIVE_REVOCATION_PAGE_MEASURED.d1_rows_written),
      });
      // What it made of the directory's goes (the file's other test measures whole runs).
      await env.DIRECTORY.batch([
        env.DIRECTORY.prepare(
          `DELETE FROM revocation_targets
           WHERE seq IN (SELECT seq FROM revocations WHERE subject LIKE 'dep_%')`,
        ),
        env.DIRECTORY.prepare("DELETE FROM revocations WHERE subject LIKE 'dep_%'"),
        env.DIRECTORY.prepare(
          "DELETE FROM live_socket_deps WHERE socket_id LIKE 'sx_%' OR socket_id LIKE 'st_%'",
        ),
        env.DIRECTORY.prepare(
          "DELETE FROM live_sockets WHERE socket_id LIKE 'sx_%' OR socket_id LIKE 'st_%'",
        ),
      ]);
    }));
});
