// A feed's live credit in its object: a block spent a unit at a time until
// no whole unit is left (its margin drained with it, so exhausted blocks
// never fill its pool), installed on each day it is charged to; marks
// stamped with the grant that paid (a stamp of another ledger incarnation
// replaced, whatever its sequence); and the ledger's clock judged at the
// latest it may be, from the freshest sample.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import type { UserDO } from "../src/do/UserDO.js";
import { Live } from "../src/do/user/live.js";
import { LiveBudget } from "../src/do/user/live-budget.js";
import {
  expireLiveReceipts,
  type LiveEnvelope,
  makeLiveGrant,
  reserveLive,
} from "../src/live/budget.js";
import { planFor } from "../src/live/funding.js";
import {
  LIVE_BLOCK_UNITS,
  LIVE_PRICES,
  type LiveManifestEntry,
  liveBlockUnit,
} from "../src/live/manifest.js";
import { clockedD1, DAY, incarnation, isolated } from "./helpers/live-budget.js";

const BLOCK = LIVE_PRICES.control_block as LiveManifestEntry;
const UNIT = liveBlockUnit("control");

/** A control block granted for `feed`, valid from `from` (by the ledger's clock). */
async function block(feed: string, from: number): Promise<LiveEnvelope> {
  const request = await makeLiveGrant(
    planFor(
      BLOCK,
      {
        incarnation: await incarnation(),
        epoch: 0,
        recipientType: "UserDO",
        recipient: feed,
        class: "ordinary",
        kind: "control",
        producesLocal: true,
      },
      from,
    ),
  );
  const granted = await reserveLive(clockedD1(env.DIRECTORY, { now: from }), request);
  if (granted.status !== "granted") throw new Error(granted.reason);
  return granted.grant;
}

describe("a pool of controls", () => {
  it("spends a block a unit at a time, drains its margin with its last unit, and has room again", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("pool")}`;
      const from = (Math.floor(Date.now() / DAY) + 3) * DAY + 3_600_000;
      const grants = [
        await block(feed, from),
        await block(feed, from + 1),
        await block(feed, from + 2),
      ];
      const out = await runInDurableObject(env.USER.getByName(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, (grants[0] as LiveEnvelope).plan.incarnation);
        const now = from + 10;
        const day = Math.floor(now / DAY);
        const installed = [
          budget.installBlock("control", grants[0] as LiveEnvelope, now),
          budget.installBlock("control", grants[1] as LiveEnvelope, now),
          budget.installBlock("control", grants[2] as LiveEnvelope, now),
        ];
        // Both blocks spent, every unit of each: the pool's margin goes with its last unit.
        let spent = 0;
        while (budget.spend("control", day, UNIT, now)) spent++;
        const third = budget.installBlock("control", grants[2] as LiveEnvelope, now);
        return { installed, spent, third, left: budget.unitsLeft("control", day, UNIT, now, 99) };
      });
      expect(out).toEqual({
        installed: ["installed", "installed", "full"],
        spent: 2 * LIVE_BLOCK_UNITS,
        third: "installed",
        left: LIVE_BLOCK_UNITS,
      });
    }));

  it("takes a block on a day with room though its next day's pool is full, the full day left out", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("roomy")}`;
      // An evening's blocks: each charged to today and tomorrow.
      const evening = (Math.floor(Date.now() / DAY) + 5) * DAY + 21 * 3_600_000;
      const [a, b, c] = [
        await block(feed, evening),
        await block(feed, evening + 1),
        await block(feed, evening + 2),
      ];
      const out = await runInDurableObject(env.USER.getByName(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, a.plan.incarnation);
        const now = evening + 10;
        const day = Math.floor(now / DAY);
        budget.installBlock("control", a, now);
        budget.installBlock("control", b, now);
        // Today's first block spent whole: today has room, tomorrow still holds both untouched.
        for (let i = 0; i < LIVE_BLOCK_UNITS; i++) budget.spend("control", day, UNIT, now);
        const third = budget.installBlock("control", c, now);
        const days = state.storage.sql
          .exec<{ day: number }>(
            "SELECT day FROM live_budget_balances WHERE operation_id = ? ORDER BY day",
            c.operationId,
          )
          .toArray()
          .map((r) => r.day);
        return { third, days, today: day };
      });
      expect(out).toEqual({ third: "installed", days: [out.today], today: out.today });
    }));

  it("is installed on each day a block is charged to: one before the evening, two across midnight", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("days")}`;
      const morning = (Math.floor(Date.now() / DAY) + 4) * DAY + 3_600_000;
      const evening = morning + 21 * 3_600_000;
      const early = await block(feed, morning);
      // What the cron's maintenance does long before the evening.
      await expireLiveReceipts(clockedD1(env.DIRECTORY, { now: evening }));
      const late = await block(feed, evening);
      const days = await runInDurableObject(env.USER.getByName(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, early.plan.incarnation);
        const rows = (grant: LiveEnvelope) =>
          state.storage.sql
            .exec<{ day: number }>(
              "SELECT day FROM live_budget_balances WHERE operation_id = ? ORDER BY day",
              grant.operationId,
            )
            .toArray()
            .map((r) => r.day);
        budget.installBlock("control", early, morning + 1);
        const once = rows(early);
        // By the evening the morning's block has expired (and is removed as the next installs).
        budget.installBlock("control", late, evening + 1);
        return [once, rows(late)];
      });
      const day = Math.floor(morning / DAY);
      expect(days).toEqual([[day], [day, day + 1]]);
    }));
});

describe("a mark's stamp", () => {
  it("is the paying grant's when the row's was another incarnation's, whatever its sequence", async () => {
    const feed = `usr_${uniqueId("stamp")}`;
    const rows = await runInDurableObject(env.USER.getByName(feed), (_: UserDO, state) => {
      const live = new Live(state.storage.sql);
      const signal = {
        repoId: "rep_s",
        subject: "issue" as const,
        conversation: "c1",
        direct: false,
      };
      live.mark([signal], { epoch: 0, incarnation: "a".repeat(32), seq: 100, validUntil: 9 });
      // A directory restore since: a new incarnation, its sequences from the start again.
      live.mark([signal], { epoch: 0, incarnation: "b".repeat(32), seq: 2, validUntil: 8 });
      // The same incarnation's older grant keeps the newer stamp.
      live.mark([signal], { epoch: 0, incarnation: "b".repeat(32), seq: 1, validUntil: 7 });
      return ["live_dirty", "live_candidates"].map((table) =>
        state.storage.sql
          .exec(`SELECT budget_incarnation AS i, budget_seq AS s FROM ${table}`)
          .one(),
      );
    });
    expect(rows).toEqual([
      { i: "b".repeat(32), s: 2 },
      { i: "b".repeat(32), s: 2 },
    ]);
  });
});

describe("the ledger's clock in a feed's object", () => {
  it("is judged at the latest the ledger may be, from the freshest sample only", async () => {
    const feed = `usr_${uniqueId("clock")}`;
    const out = await runInDurableObject(env.USER.getByName(feed), (_: UserDO, state) => {
      const budget = new LiveBudget(state.storage.sql);
      // D1 answered 12:00:00 (whole seconds) to a request sent at 12:00:00.900 here, heard at
      // 12:00:01.000.
      budget.noteLedger(43_200_000, 43_200_900, 43_201_000);
      const first = budget.ledgerNow(43_201_000);
      // An older sample, answered later: not kept.
      budget.noteLedger(43_100_000, 43_200_100, 43_201_000);
      const kept = budget.ledgerNow(43_201_000);
      // Its day, but not where the ledger may be either side of a midnight.
      const day = budget.ledgerDay(43_201_000);
      // 50 ms before a midnight here: the ledger may be up to 100 ms past it, or 1,000 ms before.
      const near = budget.ledgerDay(86_400_000 - 50);
      const after = budget.ledgerDays(86_400_000 - 50);
      return [first, kept, day, near, after];
    });
    // At most a second past what it said, as of when it was asked; the day uncertain within the
    // second and the time the answer took.
    expect(out).toEqual([43_201_100, 43_201_100, 0, null, [1, 0]]);
  });
});
