// Live maintenance, funded: nothing granted while nothing is due; with
// something due, one cleanup grant owned by the maintenance object pays
// for a run that clears it (here, an expired receipt), its owner accounted
// and released.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { makeLiveGrant, reserveLive } from "../src/live/budget.js";
import { extendLease, reaping } from "../src/live/directory.js";
import {
  liveMaintenanceDue,
  runLiveMaintenance,
  settleStrandedOwners,
} from "../src/live/maintenance.js";
import { adoptLiveRecoveryTargets } from "../src/live/recovery.js";
import { clockedD1, DAY, isolated, plan } from "./helpers/live-budget.js";

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
