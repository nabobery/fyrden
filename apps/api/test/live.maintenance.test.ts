// Live maintenance, funded: nothing granted while nothing is due; with
// something due, one cleanup grant owned by the maintenance object pays
// for a run that clears it (here, an expired receipt), its owner accounted
// and released.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it, vi } from "vitest";
import {
  LIVE_RECEIPTS_DUE,
  LIVE_RECEIPTS_OVERDUE,
  type LiveGrantPlan,
  makeLiveGrant,
  reserveLive,
} from "../src/live/budget.js";
import {
  extendLease,
  LIVE_ADMISSION,
  LIVE_REAP_WINDOW,
  reaping,
  reapingWindowMoved,
} from "../src/live/directory.js";
import {
  liveMaintenanceDue,
  liveMaintenanceWork,
  runLiveMaintenance,
  settleStrandedOwners,
} from "../src/live/maintenance.js";
import { LIVE_PRICES, type LiveManifestEntry } from "../src/live/manifest.js";
import { adoptLiveRecoveryTargets } from "../src/live/recovery.js";
import { rowCountingD1 } from "./helpers/d1.js";
import { clockedD1, DAY, expiredReceipts, isolated, plan, vector } from "./helpers/live-budget.js";

const receipts = (kind: string) =>
  env.DIRECTORY.prepare(
    "SELECT count(*) AS n FROM live_budget_receipts WHERE json_extract(plan, '$.kind') = ?",
  )
    .bind(kind)
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);

/** D1's own clock (the ledger's), in milliseconds. */
const ledgerNow = () =>
  env.DIRECTORY.prepare("SELECT unixepoch() * 1000 AS now")
    .first<{ now: number }>()
    .then((r) => r?.now as number);

describe("live maintenance", () => {
  it("grants nothing while nothing is due", () =>
    isolated(async () => {
      // Whatever earlier files left due, cleared first by runs of its own.
      for (let i = 0; i < 20 && (await liveMaintenanceDue(env.DIRECTORY)); i++)
        await runLiveMaintenance(env);
      const before = await receipts("maintenance");
      expect(await runLiveMaintenance(env)).toBeNull();
      expect(await receipts("maintenance")).toBe(before);
    }));

  it("funds a run when something is due, clears it, and releases its owner", () =>
    isolated(async () => {
      // A grant from three days ago, long expired by the ledger's clock now.
      const from = (await ledgerNow()) - 3 * DAY;
      const old = await reserveLive(
        clockedD1(env.DIRECTORY, { now: from }),
        await makeLiveGrant(
          await plan({ day: Math.floor(from / DAY), from, recipient: `usr_${uniqueId("old")}` }),
        ),
      );
      if (old.status !== "granted") throw new Error(old.reason);
      expect(await liveMaintenanceDue(env.DIRECTORY)).toBe(true);
      const run = await runLiveMaintenance(env);
      expect(run).toMatchObject({ status: "funded", accounted: true });
      expect(
        await env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_budget_receipts WHERE seq = ?")
          .bind(old.grant.seq)
          .first(),
      ).toEqual({ n: 0 });
      // Its own grant was a cleanup one, its owner gone once accounted.
      expect(
        await env.DIRECTORY.prepare(
          "SELECT count(*) AS n FROM live_duration_owners WHERE object_type = 'MaintenanceDO'",
        ).first(),
      ).toEqual({ n: 0 });
    }));

  it("waits for expired receipts until they call for cleanup: two hours on, or a page", () =>
    isolated(async () => {
      for (let i = 0; i < 20 && (await liveMaintenanceDue(env.DIRECTORY)); i++)
        await runLiveMaintenance(env);
      // A grant whose receipt expired an hour ago (its validity plus an hour).
      const now = await ledgerNow();
      const from = now - 60_000 - 2 * 60 * 60_000;
      const granted = await reserveLive(
        clockedD1(env.DIRECTORY, { now: from }),
        await makeLiveGrant(
          await plan({ day: Math.floor(from / DAY), from, recipient: `usr_${uniqueId("late")}` }),
        ),
      );
      if (granted.status !== "granted") throw new Error(granted.reason);
      const due = (at: number) => liveMaintenanceDue(clockedD1(env.DIRECTORY, { now: at }));
      expect(await due(now)).toBe(false);
      expect(await due(now + LIVE_RECEIPTS_OVERDUE.graceMs - 60 * 60_000)).toBe(true);
    }));

  it("pays for routine work and revocations each with a grant of its own, both when both are due", () =>
    isolated(async () => {
      for (let i = 0; i < 20 && (await liveMaintenanceDue(env.DIRECTORY)); i++)
        await runLiveMaintenance(env);
      // A receipt long expired, and a revocation resting on no socket.
      const from = (await ledgerNow()) - 3 * DAY;
      const old = await reserveLive(
        clockedD1(env.DIRECTORY, { now: from }),
        await makeLiveGrant(
          await plan({ day: Math.floor(from / DAY), from, recipient: `usr_${uniqueId("both")}` }),
        ),
      );
      if (old.status !== "granted") throw new Error(old.reason);
      await env.DIRECTORY.prepare(
        "INSERT INTO revocations (subject, at, expanded) VALUES (?, ?, 0)",
      )
        .bind(`dep_${uniqueId("none")}`, Date.now())
        .run();
      expect(await liveMaintenanceWork(env.DIRECTORY)).toMatchObject({
        routine: true,
        revocations: true,
      });
      const kinds = () =>
        env.DIRECTORY.prepare(
          `SELECT sum(kind = 'maintenance') AS maintenance, sum(kind = 'revocation_page') AS pages
           FROM live_budget_receipts`,
        ).first<{ maintenance: number; pages: number }>();
      const before = await kinds();
      expect(await runLiveMaintenance(env)).toMatchObject({ status: "funded", accounted: true });
      expect(await kinds()).toEqual({
        maintenance: (before?.maintenance ?? 0) + 1,
        pages: (before?.pages ?? 0) + 1,
      });
      // Both done: nothing left due, and neither owner holding its place.
      expect(await liveMaintenanceWork(env.DIRECTORY)).toMatchObject({
        routine: false,
        revocations: false,
      });
      expect(
        await env.DIRECTORY.prepare(
          "SELECT count(*) AS n FROM live_duration_owners WHERE object_type = 'MaintenanceDO'",
        ).first(),
      ).toEqual({ n: 0 });
    }));

  it("goes quiet: its own receipts expiring call for no run", () =>
    isolated(async () => {
      for (let i = 0; i < 20 && (await liveMaintenanceDue(env.DIRECTORY)); i++)
        await runLiveMaintenance(env);
      // Its last run's receipt, expired since.
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_receipts SET expires_at = 0 WHERE kind = 'maintenance'",
      ).run();
      expect(await liveMaintenanceDue(env.DIRECTORY)).toBe(false);
    }));

  it("releases an owner whose release was lost, so the next run is admitted", () =>
    isolated(async () => {
      // Its accounting done but its release lost: the maintenance object's one cleanup place held.
      await env.DIRECTORY.prepare(
        `INSERT INTO live_duration_owners (owner_id, operation_id, object_type, object_id, class,
           epoch, incarnation, dispatch_from, dispatch_until, holds, status, instance, started_at,
           finished_at, charged_through, cursor, admitted_at)
         SELECT 'own_lost', 'op_lost', 'MaintenanceDO', 'instance', 'cleanup', 0, incarnation, 0, 1,
           '[]', 'accounted', 'gone', 0, 1, 1, 0, 0 FROM live_budget_state WHERE id = 1`,
      ).run();
      expect(await liveMaintenanceDue(env.DIRECTORY)).toBe(true);
      expect(await settleStrandedOwners(env.DIRECTORY, 8)).toBe(1);
      expect(
        await env.DIRECTORY.prepare(
          "SELECT count(*) AS n FROM live_duration_owners WHERE owner_id = 'own_lost'",
        ).first(),
      ).toEqual({ n: 0 });
    }));
});

describe("a recovery target of another ledger incarnation", () => {
  it("is moved to the current one, due at once, cleaned through sequence 1", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("restored")}`;
      await env.DIRECTORY.prepare(
        `INSERT INTO live_recovery_targets (feed, incarnation, through_seq, next_attempt_at,
           attempts, local_cleanup_debt)
         VALUES (?, ?, 40, 99999999999999, 3, '{"do_requests":0,"do_rows_read":0,"do_rows_written":0,"do_duration_ms":0,"d1_rows_read":0,"d1_rows_written":0,"queue_ops":0}')`,
      )
        .bind(feed, "e".repeat(32))
        .run();
      expect(await adoptLiveRecoveryTargets(env.DIRECTORY, 8)).toBeGreaterThanOrEqual(1);
      const row = await env.DIRECTORY.prepare(
        `SELECT incarnation = (SELECT incarnation FROM live_budget_state WHERE id = 1) AS current,
           through_seq, next_attempt_at, attempts FROM live_recovery_targets WHERE feed = ?`,
      )
        .bind(feed)
        .first();
      expect(row).toEqual({ current: 1, through_seq: 1, next_attempt_at: 0, attempts: 0 });
    }));
});

describe("a feed's recovery target", () => {
  it("is due only once the last grant it covers has expired, not the first", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("due")}`;
      const from = await ledgerNow();
      const grant = async (validMs: number) => {
        const g = await reserveLive(
          clockedD1(env.DIRECTORY, { now: from }),
          await makeLiveGrant(
            await plan({
              day: Math.floor(from / DAY),
              from,
              validMs,
              recipient: feed,
              producesLocal: true,
            }),
          ),
        );
        if (g.status !== "granted") throw new Error(g.reason);
        return g.grant;
      };
      // A day's provision, then a minute's ticket: recovery waits for the day's.
      const long = await grant(DAY - 1_000);
      await grant(60_000);
      const target = await env.DIRECTORY.prepare(
        "SELECT next_attempt_at AS due FROM live_recovery_targets WHERE feed = ?",
      )
        .bind(feed)
        .first<{ due: number }>();
      expect(target?.due).toBe(long.plan.validUntil);
    }));
});

describe("a socket's lease", () => {
  const lease = async (id: string, expiresAt: number) => {
    await env.DIRECTORY.prepare(
      `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state, pending_until,
         expires_at) VALUES (?, ?, 'usr_lease', 'tok_lease', 'open', 0, ?)`,
    )
      .bind(id, uniqueId("t"), expiresAt)
      .run();
  };

  it("is extended only while it still holds: one lapsed stays lapsed", async () => {
    const now = Date.now();
    const [held, lapsed] = [uniqueId("lsk"), uniqueId("lsk")];
    await lease(held, now + 60_000);
    await lease(lapsed, now - 1);
    expect(await extendLease(env.DIRECTORY, held, now + 600_000, now)).toBe(true);
    expect(await extendLease(env.DIRECTORY, lapsed, now + 600_000, now)).toBe(false);
    await env.DIRECTORY.batch(reaping(env.DIRECTORY, now));
  });

  it("is reaped with past days' admission counts a page at a time", async () => {
    const now = Date.now();
    const old = Math.floor(now / DAY) - 3;
    const principals = Array.from({ length: 5 }, () => uniqueId("adm"));
    for (const p of principals)
      await env.DIRECTORY.prepare(
        "INSERT INTO live_admissions (principal_id, day, n) VALUES (?, ?, 1)",
      )
        .bind(p, old)
        .run();
    const left = async () =>
      (
        await env.DIRECTORY.prepare(
          "SELECT count(*) AS n FROM live_admissions WHERE principal_id IN (SELECT value FROM json_each(?))",
        )
          .bind(JSON.stringify(principals))
          .first<{ n: number }>()
      )?.n;
    // A page of 2: what else is old waits for the next.
    await env.DIRECTORY.batch(reaping(env.DIRECTORY, now, 2));
    expect(await left()).toBeLessThanOrEqual(5);
    for (let i = 0; i < 40 && ((await left()) ?? 0) > 0; i++)
      await env.DIRECTORY.batch(reaping(env.DIRECTORY, now, 2));
    expect(await left()).toBe(0);
  });
});

describe("a run for expired receipts", () => {
  const HOUR = 60 * 60_000;
  const clear = async () => {
    for (let i = 0; i < 20 && (await liveMaintenanceDue(env.DIRECTORY)); i++)
      await runLiveMaintenance(env);
  };
  /** `n` receipts expired by `at`, each its own grant. */
  const expired = async (n: number, at: number) => {
    const from = at - HOUR - 60_000;
    for (let i = 0; i < n; i++) {
      const granted = await reserveLive(
        clockedD1(env.DIRECTORY, { now: from }),
        await makeLiveGrant(
          await plan({ day: Math.floor(from / DAY), from, recipient: `usr_${uniqueId("due")}` }),
        ),
      );
      if (granted.status !== "granted") throw new Error(granted.reason);
    }
  };
  const ordinary = async (now: number) => {
    const db = clockedD1(env.DIRECTORY, { now });
    return reserveLive(
      db,
      await makeLiveGrant(
        await plan({ day: Math.floor(now / DAY), from: now, recipient: `usr_${uniqueId("ord")}` }),
      ),
    );
  };

  it("is due at 13 expired, before the 16 that close the ledger", () =>
    isolated(async () => {
      await clear();
      const now = await ledgerNow();
      await expired(LIVE_RECEIPTS_DUE.page - 1, now);
      const due = () => liveMaintenanceDue(clockedD1(env.DIRECTORY, { now }));
      expect(await due()).toBe(false);
      await expired(1, now);
      expect(await due()).toBe(true);
      expect((await ordinary(now)).status).toBe("granted");
    }));

  it("is due an hour and three quarters overdue, before the two hours that close the ledger", () =>
    isolated(async () => {
      await clear();
      const now = await ledgerNow();
      await expired(1, now);
      const at = (ms: number) => now + ms;
      const due = (t: number) => liveMaintenanceDue(clockedD1(env.DIRECTORY, { now: t }));
      expect(await due(at(LIVE_RECEIPTS_DUE.graceMs - 1_000))).toBe(false);
      const whenDue = at(LIVE_RECEIPTS_DUE.graceMs);
      expect(await due(whenDue)).toBe(true);
      expect((await ordinary(whenDue)).status).toBe("granted");
    }));

  it("clears a whole batch expiring between two runs before it can close the ledger", () =>
    isolated(async () => {
      await clear();
      const now = await ledgerNow();
      const page = LIVE_RECEIPTS_OVERDUE.page;
      // Twice what a run removes, all expiring at once, just after a run found nothing.
      await expired(2 * page, now);
      expect((await ordinary(now)).status).toBe("granted");
      // (Each grant's own receipt is new: it can't expire inside this test's minutes.)
      const cron = 5 * 60_000;
      const at = (t: number) => ({
        ...env,
        DIRECTORY: clockedD1(env.DIRECTORY, { now: t }),
      });
      await runLiveMaintenance(at(now + cron) as typeof env);
      expect((await ordinary(now + cron)).status).toBe("granted");
      await runLiveMaintenance(at(now + 2 * cron) as typeof env);
      expect((await ordinary(now + 2 * cron)).status).toBe("granted");
      expect(LIVE_RECEIPTS_OVERDUE.pageAfterMs).toBeGreaterThanOrEqual(2 * cron);
    }));

  it("closes the ledger when maintenance has really stopped: a page expired 10 minutes on", () =>
    isolated(async () => {
      await clear();
      const now = await ledgerNow();
      await expired(LIVE_RECEIPTS_OVERDUE.page, now);
      // No run at all, past the 2 cron runs it is given.
      const after = now + LIVE_RECEIPTS_OVERDUE.pageAfterMs;
      expect((await ordinary(after - 1_000)).status).toBe("granted");
      expect(await ordinary(after)).toMatchObject({
        status: "refused",
        gate: "overdue_receipts",
      });
      // A run clears it.
      const db = clockedD1(env.DIRECTORY, { now: after });
      await runLiveMaintenance({ ...env, DIRECTORY: db } as typeof env);
      expect((await ordinary(after)).status).toBe("granted");
    }));

  it.each([
    [
      "an admission's day count",
      () =>
        env.DIRECTORY.prepare(
          "INSERT INTO live_admissions (principal_id, day, n) VALUES ('usr_old_count', ?, 1)",
        ),
    ],
    [
      "a ticket's day count",
      () =>
        env.DIRECTORY.prepare(
          "INSERT INTO live_ticket_days (principal_id, day, issued) VALUES ('usr_old_count', ?, 1)",
        ),
    ],
  ])("pays the full price when a run is due and %s is left to reap", (_name, insert) =>
    isolated(async () => {
      await clear();
      const now = await ledgerNow();
      await expired(LIVE_RECEIPTS_DUE.page, now);
      const db = clockedD1(env.DIRECTORY, { now });
      expect((await liveMaintenanceWork(db)).full).toBe(false);
      await insert()
        .bind(Math.floor(now / DAY) - 3)
        .run();
      try {
        expect(await liveMaintenanceWork(db)).toMatchObject({ routine: true, full: true });
      } finally {
        await env.DIRECTORY.batch([
          env.DIRECTORY.prepare("DELETE FROM live_admissions WHERE principal_id = 'usr_old_count'"),
          env.DIRECTORY.prepare(
            "DELETE FROM live_ticket_days WHERE principal_id = 'usr_old_count'",
          ),
        ]);
      }
    }),
  );

  it("pays the full price when a run is due and an old revocation is left to reap, and reaping alone calls for no run", () =>
    isolated(async () => {
      await clear();
      const now = await ledgerNow();
      const db = clockedD1(env.DIRECTORY, { now });
      const subject = uniqueId("old_rev");
      await env.DIRECTORY.prepare(
        "INSERT INTO revocations (subject, at, expanded) VALUES (?, ?, 1)",
      )
        .bind(subject, now - 8 * DAY)
        .run();
      try {
        expect(await liveMaintenanceWork(db)).toMatchObject({ routine: false, full: false });
        await expired(LIVE_RECEIPTS_DUE.page, now);
        expect(await liveMaintenanceWork(db)).toMatchObject({ routine: true, full: true });
      } finally {
        // The ledger's helper puts back only the ledger: the next test's run would find this.
        await env.DIRECTORY.prepare("DELETE FROM revocations WHERE subject = ?")
          .bind(subject)
          .run();
      }
    }));

  describe("after a restore: the ledger of a new incarnation", () => {
    const FUTURE = 24 * 60 * 60_000;
    const targets = (now: number, incarnation: string, feeds: readonly string[]) =>
      env.DIRECTORY.batch(
        feeds.map((feed) =>
          env.DIRECTORY.prepare(
            `INSERT INTO live_recovery_targets (feed, incarnation, through_seq, next_attempt_at,
               attempts, local_cleanup_debt, turn_debt) VALUES (?, ?, 1, ?, 0, ?, 0)`,
          ).bind(feed, incarnation, now + FUTURE, JSON.stringify(vector({}))),
        ),
      );
    const removeTargets = (feeds: readonly string[]) =>
      env.DIRECTORY.batch(
        feeds.map((feed) =>
          env.DIRECTORY.prepare("DELETE FROM live_recovery_targets WHERE feed = ?").bind(feed),
        ),
      );
    const restored = () =>
      env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET incarnation = lower(hex(randomblob(16))) WHERE id = 1",
      ).run();
    const incarnationNow = async () =>
      (
        await env.DIRECTORY.prepare(
          "SELECT incarnation FROM live_budget_state WHERE id = 1",
        ).first<{ incarnation: string }>()
      )?.incarnation as string;

    it("calls for a full run at once, however far ahead its targets' attempts are, until all are moved", () =>
      isolated(async () => {
        await clear();
        const now = await ledgerNow();
        const db = clockedD1(env.DIRECTORY, { now });
        const feeds = [`usr_${uniqueId("one")}`, `usr_${uniqueId("two")}`];
        await targets(now, await incarnationNow(), feeds);
        try {
          expect(await liveMaintenanceWork(db)).toMatchObject({ routine: false, full: false });
          await restored();
          expect(await liveMaintenanceWork(db)).toMatchObject({ routine: true, full: true });
          // A page moves one (due at once, for recovery): the other still counts as of another.
          const settled = async () =>
            (
              await env.DIRECTORY.prepare(
                "SELECT incarnation = targets_incarnation AS same FROM live_budget_state WHERE id = 1",
              ).first<{ same: number }>()
            )?.same;
          await adoptLiveRecoveryTargets(db, 1);
          expect(await settled()).toBe(0);
          await adoptLiveRecoveryTargets(db, 1);
          expect(await settled()).toBe(1);
          // None of another left, and no attempt due: nothing more is called for.
          await removeTargets(feeds);
          expect(await liveMaintenanceWork(db)).toMatchObject({ routine: false, full: false });
        } finally {
          await removeTargets(feeds);
        }
      }));

    it("calls for a run with no targets to move, which then settles it", () =>
      isolated(async () => {
        await clear();
        const now = await ledgerNow();
        const db = clockedD1(env.DIRECTORY, { now });
        await restored();
        expect(await liveMaintenanceWork(db)).toMatchObject({ routine: true, full: true });
        await adoptLiveRecoveryTargets(db, 16);
        expect(await liveMaintenanceWork(db)).toMatchObject({ routine: false, full: false });
      }));

    it("costs a check the same rows however many targets there are", () =>
      isolated(async () => {
        await clear();
        const now = await ledgerNow();
        const read = async () => {
          const rows = { read: 0, written: 0 };
          await liveMaintenanceWork(rowCountingD1(clockedD1(env.DIRECTORY, { now }), rows));
          return rows.read;
        };
        const few = await read();
        const feeds = Array.from({ length: 50 }, () => `usr_${uniqueId("many")}`);
        await targets(now, await incarnationNow(), feeds);
        try {
          expect(await read()).toBe(few);
        } finally {
          await removeTargets(feeds);
        }
      }));
  });

  it("pays the light price and runs only its pages when nothing else is due", () =>
    isolated(async () => {
      await clear();
      const now = await ledgerNow();
      await expired(LIVE_RECEIPTS_DUE.page, now);
      const db = clockedD1(env.DIRECTORY, { now });
      expect(await liveMaintenanceWork(db)).toEqual({
        routine: true,
        full: false,
        revocations: false,
      });
      const run = await runLiveMaintenance({ ...env, DIRECTORY: db } as typeof env);
      expect(run?.status).toBe("funded");
      const { results } = await env.DIRECTORY.prepare(
        "SELECT kind, plan FROM live_budget_receipts WHERE kind = 'maintenance'",
      ).all<{ kind: string; plan: string }>();
      const charged = (JSON.parse(results.at(-1)?.plan as string) as LiveGrantPlan).charges[0];
      expect(charged?.resources.d1_rows_written).toBe(
        (LIVE_PRICES.maintenance_light as LiveManifestEntry).resources.d1_rows_written,
      );
      expect(await liveMaintenanceDue(db)).toBe(false);
    }));

  it("pays the full price when anything else is due too, and runs those pages", () =>
    isolated(async () => {
      await clear();
      const now = await ledgerNow();
      await expired(LIVE_RECEIPTS_DUE.page, now);
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET duration_debt_ms = 1000, debt_service_day = 0 WHERE id = 1",
      ).run();
      const db = clockedD1(env.DIRECTORY, { now });
      expect((await liveMaintenanceWork(db)).full).toBe(true);
      expect((await runLiveMaintenance({ ...env, DIRECTORY: db } as typeof env))?.status).toBe(
        "funded",
      );
      const { results } = await env.DIRECTORY.prepare(
        "SELECT plan FROM live_budget_receipts WHERE kind = 'maintenance'",
      ).all<{ plan: string }>();
      const charged = (JSON.parse(results.at(-1)?.plan as string) as LiveGrantPlan).charges[0];
      expect(charged?.resources.d1_rows_written).toBe(
        (LIVE_PRICES.maintenance as LiveManifestEntry).resources.d1_rows_written,
      );
      const debt = await env.DIRECTORY.prepare(
        "SELECT duration_debt_ms AS ms FROM live_budget_state WHERE id = 1",
      ).first<{ ms: number }>();
      expect(debt?.ms).toBe(0);
    }));
});

describe("told revocations past their keep", () => {
  it("are looked for and reaped a window at a time, however many still wait on their targets", () =>
    isolated(async () => {
      const now = await ledgerNow();
      const old = now - LIVE_ADMISSION.keepMs - DAY;
      const reads = async () => {
        const rows = { read: 0, written: 0 };
        await liveMaintenanceWork(rowCountingD1(env.DIRECTORY, rows));
        return rows.read;
      };
      // Nothing else old to reap (the check would stop there), so it looks at revocations.
      await env.DIRECTORY.batch([
        env.DIRECTORY.prepare("DELETE FROM live_admissions WHERE day < ?").bind(
          Math.floor(now / DAY) - 1,
        ),
        env.DIRECTORY.prepare("DELETE FROM live_ticket_days WHERE day < ?").bind(
          Math.floor(now / DAY) - 1,
        ),
      ]);
      const before = await reads();
      // 128 old revocations still being told (each a target not due yet), then one told.
      const fill: D1PreparedStatement[] = [];
      const subjects: string[] = [];
      for (let i = 0; i < 128; i++) {
        const subject = uniqueId("dep_wait");
        subjects.push(subject);
        fill.push(
          env.DIRECTORY.prepare(
            "INSERT INTO revocations (subject, at, expanded) VALUES (?, ?, 1)",
          ).bind(subject, old + i),
          env.DIRECTORY.prepare(
            `INSERT INTO revocation_targets (seq, feed, attempts, next_attempt_at)
             SELECT seq, 'usr_wait', 1, ? FROM revocations WHERE subject = ?`,
          ).bind(now + DAY, subject),
        );
      }
      const told = uniqueId("dep_told");
      fill.push(
        env.DIRECTORY.prepare(
          "INSERT INTO revocations (subject, at, expanded) VALUES (?, ?, 1)",
        ).bind(told, old + 200),
      );
      for (let i = 0; i < fill.length; i += 50) await env.DIRECTORY.batch(fill.slice(i, i + 50));
      try {
        // The check reads about a window of them, not the backlog: three seeks of a window at most,
        // each row's target looked for.
        expect((await reads()) - before).toBeLessThanOrEqual(5 * LIVE_REAP_WINDOW);
        // Reaping moves past the windows still being told, and reaches the told one.
        const left = () =>
          env.DIRECTORY.prepare("SELECT count(*) AS n FROM revocations WHERE subject = ?")
            .bind(told)
            .first<{ n: number }>();
        for (let i = 0; i < 40 && (await left())?.n === 1; i++)
          await env.DIRECTORY.batch(reaping(env.DIRECTORY, now, 2));
        expect(await left()).toEqual({ n: 0 });
        expect(
          await env.DIRECTORY.prepare(
            "SELECT count(*) AS n FROM revocations WHERE subject IN (SELECT value FROM json_each(?))",
          )
            .bind(JSON.stringify(subjects))
            .first(),
        ).toEqual({ n: 128 });
      } finally {
        await env.DIRECTORY.batch([
          env.DIRECTORY.prepare(
            `DELETE FROM revocation_targets WHERE seq IN (SELECT seq FROM revocations
               WHERE subject IN (SELECT value FROM json_each(?)))`,
          ).bind(JSON.stringify(subjects)),
          env.DIRECTORY.prepare(
            "DELETE FROM revocations WHERE subject IN (SELECT value FROM json_each(?))",
          ).bind(JSON.stringify([...subjects, told])),
        ]);
      }
    }));
});

describe("reaping told revocations, a window at a time", () => {
  const clean = () =>
    env.DIRECTORY.batch([
      env.DIRECTORY.prepare("DELETE FROM revocation_targets"),
      env.DIRECTORY.prepare("DELETE FROM revocations"),
    ]);
  /** A revocation past its keep, told unless `waiting` (a target not due for a day). */
  const revocation = async (subject: string, at: number, waiting: boolean, now: number) => {
    await env.DIRECTORY.prepare("INSERT INTO revocations (subject, at, expanded) VALUES (?, ?, 1)")
      .bind(subject, at)
      .run();
    if (waiting)
      await env.DIRECTORY.prepare(
        `INSERT INTO revocation_targets (seq, feed, attempts, next_attempt_at)
         SELECT seq, 'usr_wait', 1, ? FROM revocations WHERE subject = ?`,
      )
        .bind(now + DAY, subject)
        .run();
  };
  const left = (subject: string) =>
    env.DIRECTORY.prepare("SELECT count(*) AS n FROM revocations WHERE subject = ?")
      .bind(subject)
      .first<{ n: number }>();

  it("reaches a told one sharing its time with a window of others still being told", () =>
    isolated(async () => {
      await clean();
      const now = await ledgerNow();
      const at = now - LIVE_ADMISSION.keepMs - DAY;
      for (let i = 0; i < 9; i++) await revocation(`same_${i}`, at, i < 8, now);
      for (let i = 0; i < 10 && (await left("same_8"))?.n === 1; i++)
        await env.DIRECTORY.batch(reaping(env.DIRECTORY, now, 2));
      expect(await left("same_8")).toEqual({ n: 0 });
      await clean();
    }));

  it("comes back to an earlier one told after its window was passed, while newer ones keep coming", () =>
    isolated(async () => {
      await clean();
      const now = await ledgerNow();
      const cutoff = now - LIVE_ADMISSION.keepMs;
      const interval = 2 * 60 * 60_000;
      for (let i = 0; i < 8; i++) await revocation(`prefix_${i}`, cutoff - 100 + i, true, now);
      // Told revocations passing their keep three at a time, one run's interval apart.
      for (let page = 1; page <= 12; page++)
        for (let i = 0; i < 3; i++)
          await revocation(`later_${page}_${i}`, cutoff + page * interval - 1, false, now);
      await env.DIRECTORY.batch(reaping(env.DIRECTORY, now, 2));
      // The earliest's feed answers only now.
      await env.DIRECTORY.prepare(
        "DELETE FROM revocation_targets WHERE seq IN (SELECT seq FROM revocations WHERE subject = 'prefix_0')",
      ).run();
      for (let page = 1; page <= 12; page++)
        await env.DIRECTORY.batch(reaping(env.DIRECTORY, now + page * interval, 2));
      expect(await left("prefix_0")).toEqual({ n: 0 });
      await clean();
    }));

  it("reads a window, not a backlog, however many share one time", () =>
    isolated(async () => {
      await clean();
      const now = await ledgerNow();
      const at = now - LIVE_ADMISSION.keepMs - DAY;
      await env.DIRECTORY.batch([
        env.DIRECTORY.prepare("DELETE FROM live_admissions"),
        env.DIRECTORY.prepare("DELETE FROM live_ticket_days"),
      ]);
      const baseline = { read: 0, written: 0 };
      await liveMaintenanceWork(rowCountingD1(env.DIRECTORY, baseline));
      for (let start = 0; start < 1_024; start += 25) {
        const batch: D1PreparedStatement[] = [];
        for (let i = start; i < start + 25; i++)
          batch.push(
            env.DIRECTORY.prepare(
              "INSERT INTO revocations (subject, at, expanded) VALUES (?, ?, 1)",
            ).bind(`large_${i}`, at),
            env.DIRECTORY.prepare(
              `INSERT INTO revocation_targets (seq, feed, attempts, next_attempt_at)
               SELECT seq, 'usr_wait', 1, ? FROM revocations WHERE subject = ?`,
            ).bind(now + DAY, `large_${i}`),
          );
        await env.DIRECTORY.batch(batch);
      }
      // A cycle under way, then each step of it: the check and each move read about a window.
      for (let i = 0; i < 4; i++) {
        const check = { read: 0, written: 0 };
        await liveMaintenanceWork(rowCountingD1(env.DIRECTORY, check));
        const move = { read: 0, written: 0 };
        const db = rowCountingD1(env.DIRECTORY, move);
        await db.batch([reapingWindowMoved(db, now)]);
        expect({
          i,
          check: check.read - baseline.read <= 5 * LIVE_REAP_WINDOW,
          move: move.read <= 10 * LIVE_REAP_WINDOW,
        }).toEqual({
          i,
          check: true,
          move: true,
        });
      }
      await clean();
    }));
});

describe("a maintenance step that fails", () => {
  it("is logged by name, and the run goes on to its next step", () =>
    isolated(async () => {
      for (let i = 0; i < 20 && (await liveMaintenanceDue(env.DIRECTORY)); i++)
        await runLiveMaintenance(env);
      const now = await ledgerNow();
      // Expired receipts enough for a run, their plans unreadable: removing them throws.
      await expiredReceipts(now, LIVE_RECEIPTS_DUE.page);
      const broken = Number.MAX_SAFE_INTEGER - LIVE_RECEIPTS_DUE.page;
      await env.DIRECTORY.prepare("UPDATE live_budget_receipts SET plan = '{}' WHERE seq > ?")
        .bind(broken)
        .run();
      // A transport past its expiry: the run's next step's.
      const hash = uniqueId("h_fail");
      await env.DIRECTORY.prepare(
        `INSERT INTO live_ticket_transports (ticket_hash, feed, credential_id, expires_at,
           operation_id) VALUES (?, 'usr_fail', 'tok_fail', ?, 'op')`,
      )
        .bind(hash, now - 60_000)
        .run();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await runLiveMaintenance(env)).toMatchObject({ status: "funded" });
        const lines = warn.mock.calls.flatMap(([line]) => {
          try {
            return [JSON.parse(String(line)) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
        expect(lines).toContainEqual(
          expect.objectContaining({
            op: "live.maintenance",
            msg: "a maintenance step failed",
            step: "receipts",
          }),
        );
      } finally {
        warn.mockRestore();
        await env.DIRECTORY.prepare("DELETE FROM live_budget_receipts WHERE seq > ?")
          .bind(broken)
          .run();
      }
      expect(
        await env.DIRECTORY.prepare(
          "SELECT count(*) AS n FROM live_ticket_transports WHERE ticket_hash = ?",
        )
          .bind(hash)
          .first(),
      ).toEqual({ n: 0 });
    }));
});
