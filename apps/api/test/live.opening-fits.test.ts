// The pre-check an opening runs before any grant, against the ledger's own
// decision: whole openings at each limit, through both. The pre-check is never
// the more permissive, so an opening it lets through is not refused halfway
// with its first grants' charges standing.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { LIVE_POLICY } from "../src/do/user/live.js";
import { DISCRETIONARY_RESOURCES } from "../src/effects/discretionary.js";
import {
  LIVE_DAILY,
  LIVE_ESCROW_ENTRIES,
  LIVE_ORDINARY_DEBT_LIMIT,
  LIVE_PROTECTED,
  type LiveGate,
  type LiveGrantPlan,
  type LiveRefusalReason,
  liveOpeningFits,
  makeLiveGrant,
  reserveLive,
} from "../src/live/budget.js";
import { liveOpeningTarget, ownedCall, planFor } from "../src/live/funding.js";
import { LIVE_PRICES, type LiveManifestEntry, liveKindOf } from "../src/live/manifest.js";
import { LIVE_OWNER_LIMITS } from "../src/live/owners.js";
import { liveRefusalMemo } from "../src/live/refusal-memo.js";
import { clockedD1, DAY, isolated, plan, testDay, vector } from "./helpers/live-budget.js";

const R = DISCRETIONARY_RESOURCES.filter((r) => r !== "queue_ops");
const RECIPIENT = "usr_opening_fits";

type Unit = Parameters<typeof liveKindOf>[0];
const WHOLE: Unit[] = [
  "upgrade_transport",
  "admission",
  "terminal",
  "control_block",
  "mark_block",
  "pump",
];
const TICKET: Unit[] = ["upgrade_transport", "ticket"];
const WARM: Unit[] = ["upgrade_transport", "admission", "terminal"];

function at(day: number, ms = DAY / 2) {
  const clock = { now: day * DAY + ms };
  return { clock, db: clockedD1(env.DIRECTORY, clock) };
}

async function plansFor(db: D1Database, units: Unit[]) {
  const target = await liveOpeningTarget(db, RECIPIENT);
  const plans = units.map((unit) =>
    planFor(
      LIVE_PRICES[unit] as LiveManifestEntry,
      {
        incarnation: target.incarnation,
        epoch: target.epoch,
        recipientType: "UserDO",
        recipient: RECIPIENT,
        class: "ordinary",
        kind: liveKindOf(unit),
        producesLocal: unit !== "upgrade_transport",
      },
      target.ledger.now,
    ),
  );
  return { target, plans };
}

/** Each plan granted in turn, as an opening does: the first refusal's gate, or null when all were. */
async function grantAll(db: D1Database, plans: readonly LiveGrantPlan[]): Promise<LiveGate | null> {
  for (const planned of plans) {
    const result = await reserveLive(db, await makeLiveGrant(planned));
    if (result.status === "refused") return result.gate;
  }
  return null;
}

/** Both verdicts on `units` with the ledger as `arrange` left it. */
async function both(
  day: number,
  units: Unit[],
  arrange: (need: Need, db: D1Database) => Promise<unknown>,
  ms = DAY / 2,
) {
  let verdict: { precheck: LiveRefusalReason | null; ledger: LiveGate | null } | undefined;
  await isolated(async () => {
    const { db } = at(day, ms);
    const { plans } = await plansFor(db, units);
    await arrange(needOf(plans), db);
    const { target, plans: fresh } = await plansFor(db, units);
    const fit = liveOpeningFits(target.view, fresh);
    verdict = { precheck: fit.fits ? null : fit.gate, ledger: await grantAll(db, fresh) };
  });
  return verdict as { precheck: LiveRefusalReason | null; ledger: LiveGate | null };
}

type Need = {
  charge: (r: (typeof R)[number]) => number;
  second: (r: (typeof R)[number]) => number;
  debt: (r: (typeof R)[number]) => number;
};

function needOf(plans: readonly LiveGrantPlan[]): Need {
  return {
    charge: (r) => plans.reduce((n, p) => n + (p.charges[0]?.resources[r] ?? 0), 0),
    second: (r) => plans.reduce((n, p) => n + (p.charges[1]?.resources[r] ?? 0), 0),
    debt: (r) =>
      plans.reduce(
        (n, p) => n + p.directoryCleanupDebt[r] + p.localCleanupDebt[r] + p.dayCleanupDebt[r],
        0,
      ),
  };
}

const setDebt = (r: string, value: number) =>
  env.DIRECTORY.prepare(`UPDATE live_budget_state SET debt_${r} = ? WHERE id = 1`)
    .bind(value)
    .run();

const setDay = (day: number, column: string, value: number | string) =>
  env.DIRECTORY.prepare(
    `INSERT INTO live_budget_days (day, ${column}, retain_until, cleanup_debt) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (day) DO UPDATE SET ${column} = excluded.${column}`,
  )
    .bind(day, value, (day + 4) * DAY, JSON.stringify(vector({})))
    .run();

const durationReserve = async () =>
  (
    await env.DIRECTORY.prepare(
      "SELECT duration_reserve_ms AS ms FROM live_budget_state WHERE id = 1",
    ).first<{ ms: number }>()
  )?.ms as number;

/** Each kind of opening. */
const SETS: [string, Unit[]][] = [
  ["a cold feed's whole opening", WHOLE],
  ["a warm feed's opening", WARM],
  ["a ticket", TICKET],
];

describe.each(SETS)("%s through both", (_name, units) => {
  const day = testDay(100);

  it("both let it through on an empty ledger", async () => {
    expect(await both(day, units, async () => {})).toEqual({ precheck: null, ledger: null });
  });

  it.each(R)("agrees at the day's ordinary share of %s", async (r) => {
    // Ordinary duration also leaves the day's reserve.
    const reserve = r === "do_duration_ms" ? await durationReserve() : 0;
    const limit = LIVE_DAILY[r] - LIVE_PROTECTED[r] - reserve;
    const fits = await both(day, units, (need) => setDay(day, r, limit - need.charge(r)));
    expect(fits).toEqual({ precheck: null, ledger: null });
    const over = await both(day, units, async (need) => {
      if (need.charge(r) > 0) await setDay(day, r, limit - need.charge(r) + 1);
    });
    expect(over.precheck === null).toBe(over.ledger === null);
    expect(over.precheck).toBe(over.ledger);
  });

  it.each(R)("agrees at the limit of %s debt", async (r) => {
    const limit = LIVE_ORDINARY_DEBT_LIMIT[r];
    const fits = await both(day, units, (need) => setDebt(r, limit - need.debt(r)));
    expect(fits).toEqual({ precheck: null, ledger: null });
    const over = await both(day, units, (need) => setDebt(r, limit - need.debt(r) + 1));
    expect(over.precheck).toBe(`debt:${r}`);
    expect(over.ledger).toBe(`debt:${r}`);
  });

  it("agrees when ordinary duration is blocked", async () => {
    const verdict = await both(day, units, () =>
      env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET ordinary_duration_blocked = 1 WHERE id = 1",
      ).run(),
    );
    expect(verdict).toEqual({ precheck: "duration_closed", ledger: "duration_closed" });
    await env.DIRECTORY.prepare(
      "UPDATE live_budget_state SET ordinary_duration_blocked = 0 WHERE id = 1",
    ).run();
  });

  it("agrees when the day's reserve is spent", async () => {
    const reserve = await durationReserve();
    const verdict = await both(day, units, () => setDay(day, "reserve_used_ms", reserve));
    expect(verdict).toEqual({ precheck: "duration_closed", ledger: "duration_closed" });
  });

  it("agrees at the day's escrow places", async () => {
    const entries = (n: number) =>
      JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `held-${i}`, ms: 1 })));
    const held = async (db: D1Database) => {
      const { plans } = await plansFor(db, units);
      return plans.filter((p) => p.charges[0]?.duration).length;
    };
    const fits = await both(day, units, async (_need, db) =>
      setDay(day, "escrow", entries(LIVE_ESCROW_ENTRIES - (await held(db)))),
    );
    expect(fits).toEqual({ precheck: null, ledger: null });
    const over = await both(day, units, async (_need, db) =>
      setDay(day, "escrow", entries(LIVE_ESCROW_ENTRIES - (await held(db)) + 1)),
    );
    expect(over).toEqual({ precheck: "escrow_full", ledger: "escrow_full" });
  });

  it("agrees when receipts are overdue", async () => {
    const verdict = await both(day, units, async (_need, db) => {
      // Expired before the grace ended, from a day still within the old days' week.
      const from = (day - 5) * DAY;
      const old = await plan({
        day: day - 5,
        from,
        recipient: "usr_overdue",
      });
      await reserveLive(clockedD1(env.DIRECTORY, { now: from + 1 }), await makeLiveGrant(old));
      return db;
    });
    expect(verdict).toEqual({ precheck: "overdue_receipts", ledger: "overdue_receipts" });
  });

  it("agrees when old days are owed their cleanup", async () => {
    const verdict = await both(day, units, () =>
      env.DIRECTORY.prepare(
        "INSERT INTO live_budget_days (day, retain_until, cleanup_debt) VALUES (?, ?, ?)",
      )
        .bind(day - 8, (day - 3) * DAY, JSON.stringify(vector({})))
        .run(),
    );
    expect(verdict).toEqual({ precheck: "old_days", ledger: "old_days" });
  });
});

describe("the pre-check", () => {
  const day = testDay(102);

  it("agrees on tomorrow's room for what is valid past midnight", async () => {
    const before = 15 * 60_000;
    const late = DAY - before;
    const limit = LIVE_DAILY.do_rows_written - LIVE_PROTECTED.do_rows_written;
    const over = await both(
      day,
      WHOLE,
      async (need) => {
        await setDay(day + 1, "do_rows_written", limit - need.second("do_rows_written") + 1);
      },
      late,
    );
    expect(over).toEqual({ precheck: "second_day", ledger: "second_day" });
  });

  it("counts a cold feed's turn debt in full, so it is at most early, never late", async () => {
    await isolated(async () => {
      const { db } = at(day);
      const { plans } = await plansFor(db, ["upgrade_transport", "pump"]);
      const need = needOf(plans);
      await setDebt(
        "d1_rows_written",
        LIVE_ORDINARY_DEBT_LIMIT.d1_rows_written - need.debt("d1_rows_written") + 1,
      );
      const { target, plans: fresh } = await plansFor(db, ["upgrade_transport", "pump"]);
      expect(liveOpeningFits(target.view, fresh)).toMatchObject({
        fits: false,
        gate: "debt:d1_rows_written",
      });
    });
  });

  it("names a recovery target of another incarnation", async () => {
    await isolated(async () => {
      const { db } = at(day);
      await env.DIRECTORY.prepare(
        `INSERT INTO live_recovery_targets (feed, incarnation, through_seq, next_attempt_at, attempts,
           local_cleanup_debt, turn_debt) VALUES (?, ?, 1, 0, 0, ?, 0)`,
      )
        .bind(RECIPIENT, "0".repeat(32), JSON.stringify(vector({})))
        .run();
      const { target, plans } = await plansFor(db, WARM);
      expect(liveOpeningFits(target.view, plans)).toMatchObject({
        fits: false,
        gate: "target_incarnation",
      });
    });
  });

  it("counts the places owners hold, only when asked to", async () => {
    await isolated(async () => {
      const { db } = at(day);
      for (let i = 0; i < LIVE_OWNER_LIMITS.deploymentOrdinary; i++)
        await env.DIRECTORY.prepare(
          `INSERT INTO live_duration_owners (owner_id, operation_id, object_type, object_id, class,
             epoch, incarnation, dispatch_from, dispatch_until, holds, status, admitted_at)
           VALUES (?1, ?1, 'UserDO', ?2, 'ordinary', 0, ?3, 0, 1, '[]', 'reserved', 0)`,
        )
          .bind(`held-${i}`, `usr_${i}`, "0".repeat(32))
          .run();
      const { target, plans } = await plansFor(db, WARM);
      expect(liveOpeningFits(target.view, plans).fits).toBe(true);
      expect(liveOpeningFits(target.view, plans, 1)).toMatchObject({
        fits: false,
        reason: "temporary",
        gate: "owner:capacity",
      });
    });
  });

  describe("through owner admission, at a feed's own places", () => {
    const holdPlaces = async (n: number, feed: string) => {
      for (let i = 0; i < n; i++)
        await env.DIRECTORY.prepare(
          `INSERT INTO live_duration_owners (owner_id, operation_id, object_type, object_id, class,
             epoch, incarnation, dispatch_from, dispatch_until, holds, status, admitted_at)
           VALUES (?1, ?1, 'UserDO', ?2, 'ordinary', 0, ?3, 0, 1, '[]', 'reserved', 0)`,
        )
          .bind(`${feed}-held-${i}`, feed, "0".repeat(32))
          .run();
    };

    /** The pre-check's verdict on a listen's transport, and what really running it answers. */
    const verdicts = async (db: D1Database) => {
      const { target, plans } = await plansFor(db, ["upgrade_transport"]);
      const fit = liveOpeningFits(target.view, plans, 1);
      const run = await ownedCall(
        db,
        await makeLiveGrant(plans[0] as LiveGrantPlan),
        "upgrade",
        async () => "ran",
        { ledger: target.ledger },
      );
      return {
        precheck: fit.fits ? null : fit.gate,
        run: run.status === "funded" ? null : run.gate,
      };
    };

    it("lets through the last place", async () => {
      await isolated(async () => {
        const { db } = at(day);
        await holdPlaces(LIVE_OWNER_LIMITS.perObjectOrdinary - 1, RECIPIENT);
        expect(await verdicts(db)).toEqual({ precheck: null, run: null });
      });
    });

    it("refuses once the feed's places are taken, as owner admission would", async () => {
      await isolated(async () => {
        const { db } = at(day);
        await holdPlaces(LIVE_OWNER_LIMITS.perObjectOrdinary, RECIPIENT);
        expect(await verdicts(db)).toEqual({
          precheck: "owner:capacity",
          run: "owner:capacity",
        });
      });
    });

    it("does not count another feed's places as this one's", async () => {
      await isolated(async () => {
        const { db } = at(day);
        await holdPlaces(LIVE_OWNER_LIMITS.perObjectOrdinary, "usr_another_feed");
        expect(await verdicts(db)).toEqual({ precheck: null, run: null });
      });
    });
  });

  it("takes a block of controls as held only if it lasts past the feed's next renewal", async () => {
    await isolated(async () => {
      const { db, clock } = at(day);
      const { plans } = await plansFor(db, ["control_block"]);
      const block = plans[0] as LiveGrantPlan;
      expect((await reserveLive(db, await makeLiveGrant(block))).status).toBe("granted");
      const held = async () => (await liveOpeningTarget(db, RECIPIENT)).controlsHeld;
      expect(await held()).toBe(true);
      clock.now = block.validUntil - LIVE_POLICY.renewMs - 5 * 60_000 - 1_000;
      expect(await held()).toBe(true);
      clock.now = block.validUntil - LIVE_POLICY.renewMs - 5 * 60_000;
      expect(await held()).toBe(false);
    });
  });

  it("answers the day's room as a refusal until tomorrow, and the rest as for now", async () => {
    await isolated(async () => {
      const { db } = at(day);
      await setDay(day, "do_requests", LIVE_DAILY.do_requests);
      const { target, plans } = await plansFor(db, WARM);
      expect(liveOpeningFits(target.view, plans)).toEqual({
        fits: false,
        reason: "daily",
        gate: "daily_total",
        retryAt: (day + 1) * DAY,
      });
    });
  });
});

describe("the refusal memo", () => {
  const closure = { reason: "temporary", gate: "debt:d1_rows_written" } as const;

  it("holds a closure a minute, then lets go", () => {
    liveRefusalMemo.clear();
    liveRefusalMemo.note(closure, 1_000);
    expect(liveRefusalMemo.closed(1_000 + 59_999)).toEqual(closure);
    expect(liveRefusalMemo.closed(1_000 + 60_000)).toBeNull();
  });

  it("lets go of a day's closure when its day ends", () => {
    liveRefusalMemo.clear();
    const daily = { reason: "daily", gate: "daily_total", retryAt: 11_000 } as const;
    liveRefusalMemo.note(daily, 1_000);
    expect(liveRefusalMemo.closed(10_999)).toEqual(daily);
    expect(liveRefusalMemo.closed(11_000)).toBeNull();
  });

  it.each(["epoch", "target_incarnation", "validity", "first_day", "unknown"] as const)(
    "holds nothing for %s: it proves nothing of other feeds or the next attempt",
    (gate) => {
      liveRefusalMemo.clear();
      liveRefusalMemo.note({ reason: "temporary", gate }, 1_000);
      expect(liveRefusalMemo.closed(1_001)).toBeNull();
    },
  );
});
