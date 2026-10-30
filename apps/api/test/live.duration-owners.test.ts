// Live work's duration, owned: each owner funded by its own grant (its
// object and holds the grant's, one owner a grant ever), admitted all or
// none within the deployment's and each object's caps (cleanup's places
// kept), across days; dispatched once, only while ordinary duration is
// open; observed once; settled a page of days at a time (what ran past its
// holds charged to the days it ran on and owed as debt, unused holds
// refunded only while in escrow and under the same incarnation, never
// twice); released only once accounted (or never dispatched); uncertain
// owners keeping their places; the debt served once a day; the reserve
// gating ordinary work.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  expireLiveReceipts,
  type LiveDayCharge,
  type LiveEnvelope,
  type LiveGrantPlan,
  makeLiveGrant,
  reserveLive,
  settleLiveDuration,
} from "../src/live/budget.js";
import {
  admitLiveOwners,
  type LiveOwnerLimits,
  type LiveOwnerRequest,
  liveOwnerAdjustment,
  markLiveOwnerDispatched,
  observeLiveOwner,
  quarantineLiveOwners,
  releaseLiveOwner,
  serviceLiveDurationDebt,
  settleLiveOwnerPage,
} from "../src/live/owners.js";
import {
  clockedD1,
  DAY,
  dayRow,
  isolated,
  ledger,
  plan,
  testDay,
  vector,
} from "./helpers/live-budget.js";

/** Test values only: no production caps exist yet. */
const LIMITS: LiveOwnerLimits = {
  deploymentTotal: 6,
  deploymentOrdinary: 4,
  deploymentCleanup: 2,
  perObjectOrdinary: 1,
  perObjectCleanup: 1,
};

const HOLD = 900_000;
const MINUTE = 60_000;

/** The ledger with D1's clock at `ms` into `day`. */
function at(day: number, ms = DAY / 2) {
  const clock = { now: day * DAY + ms };
  return { clock, db: clockedD1(env.DIRECTORY, clock) };
}

/**
 * A granted operation for `recipient` on `day` at noon, holding `HOLD` of
 * duration (on the day, or split across its midnight with `acrossMidnight`).
 */
async function granted(
  day: number,
  options: {
    class?: "ordinary" | "cleanup";
    recipient?: string;
    recipientType?: "UserDO" | "OrgDO";
    acrossMidnight?: boolean;
    hold?: number;
  } = {},
): Promise<LiveEnvelope> {
  const cleanup = options.class === "cleanup";
  // Across midnight: valid from a minute before it, holding on both days.
  const from = options.acrossMidnight ? (day + 1) * DAY - MINUTE : day * DAY + DAY / 2;
  const validMs = options.acrossMidnight ? 2 * MINUTE : MINUTE;
  const charges: LiveDayCharge[] = options.acrossMidnight
    ? [
        {
          day,
          resources: vector({ do_requests: 1, do_duration_ms: MINUTE }),
          duration: { day, from, until: (day + 1) * DAY, ms: MINUTE },
        },
        {
          day: day + 1,
          resources: vector({ do_duration_ms: HOLD }),
          duration: { day: day + 1, from: (day + 1) * DAY, until: from + validMs + HOLD, ms: HOLD },
        },
      ]
    : [
        {
          day,
          resources: vector({ do_requests: 1, do_duration_ms: options.hold ?? HOLD }),
          duration: { day, from, until: from + MINUTE + HOLD, ms: options.hold ?? HOLD },
        },
      ];
  const p: LiveGrantPlan = await plan({
    day,
    from,
    validMs,
    recipient: options.recipient ?? "usr_owner",
    ...(options.recipientType && { recipientType: options.recipientType }),
    ...(cleanup && { class: "cleanup", kind: "maintenance", recipientType: "MaintenanceDO" }),
    charges,
  });
  const result = await reserveLive(clockedD1(env.DIRECTORY, { now: from }), await makeLiveGrant(p));
  if (result.status !== "granted") throw new Error(`not granted: ${result.reason}`);
  return result.grant;
}

/** A request for owners of `grants` (by role), dispatched within the first one's validity. */
function owners(
  grants: { grant: LiveEnvelope; role: string; parentRole?: string }[],
): LiveOwnerRequest {
  const first = (grants[0] as { grant: LiveEnvelope }).grant;
  return {
    incarnation: first.plan.incarnation,
    class: first.plan.class,
    dispatchFrom: first.plan.validFrom,
    dispatchUntil: first.plan.validUntil,
    owners: grants.map((g) => ({
      operationId: g.grant.operationId,
      role: g.role,
      ...(g.parentRole && { parentRole: g.parentRole }),
    })),
  };
}

const occupied = () =>
  env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_duration_owners").first<{ n: number }>();

/** An owner of a fresh grant for `objectId`, admitted; its id. */
async function admitted(
  day: number,
  objectId: string,
  options: Parameters<typeof granted>[1] = {},
) {
  const grant = await granted(day, { ...options, recipient: objectId });
  const result = await admitLiveOwners(
    clockedD1(env.DIRECTORY, { now: grant.plan.validFrom }),
    owners([{ grant, role: "feed" }]),
    LIMITS,
  );
  if (result.status !== "admitted") throw new Error(result.reason);
  return { grant, ownerId: result.owners[0]?.ownerId as string };
}

/** An owner run from its grant's start for `ms`, observed; its id. */
async function ran(day: number, ms: number, objectId = "usr_run") {
  const { grant, ownerId } = await admitted(day, objectId);
  const db = clockedD1(env.DIRECTORY, { now: grant.plan.validFrom });
  const start = grant.plan.validFrom;
  expect(await markLiveOwnerDispatched(db, ownerId, { instance: "i1", startedAt: start })).toBe(
    "dispatched",
  );
  expect(
    await observeLiveOwner(db, ownerId, {
      startedAt: start,
      physicalFinishedAt: start + ms,
      chargedThrough: start + ms,
    }),
  ).toBe("accepted");
  return { ownerId, grant, db };
}

describe("admitting owners", () => {
  it("admits a caller and its callee from their own grants, all or none, within each object's places", () =>
    isolated(async () => {
      const day = testDay(1);
      const { db } = at(day);
      const caller = await granted(day, { recipient: "usr_a" });
      const callee = await granted(day, { recipient: "org_a", recipientType: "OrgDO" });
      expect(
        await admitLiveOwners(
          db,
          owners([
            { grant: caller, role: "caller" },
            { grant: callee, role: "callee", parentRole: "caller" },
          ]),
          LIMITS,
        ),
      ).toMatchObject({
        status: "admitted",
        owners: [
          { objectType: "UserDO", objectId: "usr_a" },
          { objectType: "OrgDO", objectId: "org_a" },
        ],
      });
      // Another caller of the same account: its place is the account's, whoever calls. None admitted.
      const other = await granted(day, { recipient: "usr_b" });
      const again = await granted(day, { recipient: "org_a", recipientType: "OrgDO" });
      expect(
        await admitLiveOwners(
          db,
          owners([
            { grant: other, role: "caller" },
            { grant: again, role: "callee" },
          ]),
          LIMITS,
        ),
      ).toEqual({ status: "refused", reason: "capacity" });
      expect(await occupied()).toEqual({ n: 2 });
      // The deployment's ordinary places: two more, then none.
      for (const object of ["usr_c", "usr_d"]) await admitted(day, object);
      const full = await granted(day, { recipient: "usr_e" });
      expect(await admitLiveOwners(db, owners([{ grant: full, role: "feed" }]), LIMITS)).toEqual({
        status: "refused",
        reason: "capacity",
      });
    }));

  it("holds each owner to its own grant's holds, settled each against its own", () =>
    isolated(async () => {
      const day = testDay(15);
      const { db } = at(day);
      const caller = await granted(day, { recipient: "usr_own", hold: HOLD });
      const callee = await granted(day, {
        recipient: "org_own",
        recipientType: "OrgDO",
        hold: 100_000,
      });
      const result = await admitLiveOwners(
        db,
        owners([
          { grant: caller, role: "caller" },
          { grant: callee, role: "callee", parentRole: "caller" },
        ]),
        LIMITS,
      );
      if (result.status !== "admitted") throw new Error(result.reason);
      const holds = await env.DIRECTORY.prepare(
        "SELECT object_id, holds, parent_id FROM live_duration_owners ORDER BY object_id",
      ).all();
      expect(holds.results).toEqual([
        {
          object_id: "org_own",
          holds: JSON.stringify([{ day, ms: 100_000 }]),
          parent_id: result.owners[0]?.ownerId,
        },
        { object_id: "usr_own", holds: JSON.stringify([{ day, ms: HOLD }]), parent_id: null },
      ]);
      const debt = (await ledger())?.duration_debt_ms as number;
      const start = caller.plan.validFrom;
      // Both run eighteen minutes: each overrun is its own grant's.
      for (const owner of result.owners) {
        await markLiveOwnerDispatched(db, owner.ownerId, { instance: "i1", startedAt: start });
        await observeLiveOwner(db, owner.ownerId, {
          startedAt: start,
          physicalFinishedAt: start + 18 * MINUTE,
          chargedThrough: start + 18 * MINUTE,
        });
        expect(await settleLiveOwnerPage(db, owner.ownerId)).toMatchObject({ accounted: true });
      }
      expect(await dayRow(day)).toMatchObject({ do_duration_ms: 2 * 18 * MINUTE, escrow: "[]" });
      expect((await ledger())?.duration_debt_ms).toBe(
        debt + (18 * MINUTE - HOLD) + (18 * MINUTE - 100_000),
      );
    }));

  it("funds one owner a grant: the same grant again, or once released, admits no other", () =>
    isolated(async () => {
      const day = testDay(2);
      const { db } = at(day);
      const grant = await granted(day, { recipient: "usr_once" });
      expect(await admitLiveOwners(db, owners([{ grant, role: "feed" }]), LIMITS)).toMatchObject({
        status: "admitted",
      });
      // Another role on the same grant would share its hold: refused.
      expect(await admitLiveOwners(db, owners([{ grant, role: "other" }]), LIMITS)).toEqual({
        status: "refused",
        reason: "duplicate",
      });
      // Never dispatched, its window over: released, and the grant funds no other owner.
      const after = at(day, DAY / 2 + MINUTE).db;
      expect(await releaseLiveOwner(after, `${grant.operationId}/feed`)).toBe("released");
      expect(await admitLiveOwners(db, owners([{ grant, role: "again" }]), LIMITS)).toEqual({
        status: "refused",
        reason: "duplicate",
      });
      // A window the grant does not cover, or no grant at all.
      const other = await granted(day, { recipient: "usr_x" });
      expect(
        await admitLiveOwners(
          db,
          { ...owners([{ grant: other, role: "feed" }]), dispatchUntil: other.plan.validUntil + 1 },
          LIMITS,
        ),
      ).toEqual({ status: "refused", reason: "unfunded" });
      expect(
        await admitLiveOwners(
          db,
          {
            ...owners([{ grant: other, role: "feed" }]),
            owners: [{ operationId: "v1.none", role: "feed" }],
          },
          LIMITS,
        ),
      ).toEqual({ status: "refused", reason: "unfunded" });
    }));

  it("keeps cleanup's places from ordinary work, and holds places across days", () =>
    isolated(async () => {
      const day = testDay(3);
      for (const object of ["usr_1", "usr_2", "usr_3", "usr_4"]) await admitted(day, object);
      // Ordinary places full; cleanup's still there.
      await admitted(day, "maintenance", { class: "cleanup" });
      // Days later, their receipts expired, the places are still held: a new day frees nothing.
      const later = day + 3;
      await expireLiveReceipts(at(later).db);
      const next = await granted(later, { recipient: "usr_6" });
      expect(
        await admitLiveOwners(at(later).db, owners([{ grant: next, role: "feed" }]), LIMITS),
      ).toEqual({ status: "refused", reason: "capacity" });
    }));
});

describe("dispatching and observing an owner", () => {
  it("marks it dispatched once, and takes one observation, whose start is its dispatch's", () =>
    isolated(async () => {
      const day = testDay(4);
      const { db } = at(day);
      const { grant, ownerId } = await admitted(day, "usr_obs");
      const start = grant.plan.validFrom + 1_000;
      expect(
        await markLiveOwnerDispatched(db, ownerId, {
          instance: "i1",
          startedAt: grant.plan.validUntil,
        }),
      ).toBe("invalid");
      expect(await markLiveOwnerDispatched(db, ownerId, { instance: "i1", startedAt: start })).toBe(
        "dispatched",
      );
      // A replayed answer is never permission to dispatch again.
      expect(await markLiveOwnerDispatched(db, ownerId, { instance: "i2", startedAt: start })).toBe(
        "already",
      );
      const observation = {
        startedAt: start,
        physicalFinishedAt: start + 5,
        chargedThrough: start + 9,
      };
      // A later start (less charged) is not its start.
      expect(await observeLiveOwner(db, ownerId, { ...observation, startedAt: start + 1 })).toBe(
        "invalid",
      );
      expect(await observeLiveOwner(db, ownerId, observation)).toBe("accepted");
      expect(await observeLiveOwner(db, ownerId, observation)).toBe("duplicate");
      expect(
        await observeLiveOwner(db, ownerId, { ...observation, chargedThrough: start + 8 }),
      ).toBe("invalid");
    }));

  it("dispatches no ordinary owner once ordinary duration has closed since it was admitted", () =>
    isolated(async () => {
      const day = testDay(5);
      const { db } = at(day);
      const { grant, ownerId } = await admitted(day, "usr_closed");
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET ordinary_duration_blocked = 1",
      ).run();
      expect(
        await markLiveOwnerDispatched(db, ownerId, {
          instance: "i1",
          startedAt: grant.plan.validFrom,
        }),
      ).toBe("blocked");
    }));

  it("keeps an uncertain owner's place: nothing but an observation and its accounting frees it", () =>
    isolated(async () => {
      const day = testDay(6);
      const { db } = at(day);
      const { grant, ownerId } = await admitted(day, "usr_q");
      await markLiveOwnerDispatched(db, ownerId, {
        instance: "i1",
        startedAt: grant.plan.validFrom,
      });
      expect(await quarantineLiveOwners(db, [ownerId])).toBe(1);
      // Its receipt expired and days passed: still held.
      const later = at(day + 6).db;
      await expireLiveReceipts(later);
      expect(await releaseLiveOwner(later, ownerId)).toBe("held");
      expect(await occupied()).toEqual({ n: 1 });
      // Observed late (it did finish), accounted, then released.
      const start = grant.plan.validFrom;
      expect(
        await observeLiveOwner(later, ownerId, {
          startedAt: start,
          physicalFinishedAt: start + 1_000,
          chargedThrough: start + 1_000,
        }),
      ).toBe("accepted");
      expect(await settleLiveOwnerPage(later, ownerId)).toMatchObject({ accounted: true });
      expect(await releaseLiveOwner(later, ownerId)).toBe("released");
      expect(await occupied()).toEqual({ n: 0 });
    }));
});

describe("settling an owner's duration", () => {
  it("charges a run past its hold the whole overrun, on its day, owed as debt, its hold settled once", () =>
    isolated(async () => {
      const day = testDay(7);
      const before = (await ledger())?.duration_debt_ms as number;
      // Eighteen minutes against a fifteen-minute hold.
      const { ownerId, grant, db } = await ran(day, 18 * MINUTE);
      expect(await settleLiveOwnerPage(db, ownerId)).toEqual({
        status: "settled",
        cursor: day + 1,
        accounted: true,
      });
      expect(await dayRow(day)).toMatchObject({
        do_duration_ms: 18 * MINUTE,
        reserve_used_ms: 3 * MINUTE,
        escrow: "[]",
      });
      expect((await ledger())?.duration_debt_ms).toBe(before + 3 * MINUTE);
      // Settled by its owner: the grant's own settlement cannot refund it again.
      expect(
        await settleLiveDuration(db, {
          protocol: 1,
          operationId: grant.operationId,
          incarnation: grant.plan.incarnation,
          recipientType: grant.plan.recipientType,
          recipient: grant.plan.recipient,
          epoch: grant.plan.epoch,
          finishedAt: grant.plan.validFrom + MINUTE,
          actual: [{ day, ms: MINUTE }],
        }),
      ).toBe("invalid");
      expect(await settleLiveOwnerPage(db, ownerId)).toMatchObject({ status: "duplicate" });
      expect((await dayRow(day))?.do_duration_ms).toBe(18 * MINUTE);
    }));

  it("refunds an unused hold while in escrow and under the same incarnation, never otherwise", () =>
    isolated(async () => {
      const day = testDay(8);
      const short = await ran(day, 5 * MINUTE, "usr_short");
      expect(await settleLiveOwnerPage(short.db, short.ownerId)).toMatchObject({ accounted: true });
      expect((await dayRow(day))?.do_duration_ms).toBe(5 * MINUTE);
      // The receipt gone before its observation was settled: the hold stays charged.
      const gone = await ran(day, 5 * MINUTE, "usr_gone");
      await env.DIRECTORY.prepare("DELETE FROM live_budget_receipts WHERE operation_id = ?")
        .bind(gone.grant.operationId)
        .run();
      await settleLiveOwnerPage(gone.db, gone.ownerId);
      expect((await dayRow(day))?.do_duration_ms).toBe(5 * MINUTE + HOLD);
      // The ledger restored (another incarnation): its hold is not refunded either.
      const restored = await ran(day, 5 * MINUTE, "usr_restored");
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET incarnation = lower(hex(randomblob(16)))",
      ).run();
      await settleLiveOwnerPage(restored.db, restored.ownerId);
      expect((await dayRow(day))?.do_duration_ms).toBe(5 * MINUTE + 2 * HOLD);
    }));

  it("settles every day it ran on or held, from a hold before its start through the next day", () =>
    isolated(async () => {
      const day = testDay(9);
      // Held a minute before midnight and the next day; started after midnight, for two minutes.
      const { grant, ownerId } = await admitted(day, "usr_mid", { acrossMidnight: true });
      const start = (day + 1) * DAY + 1_000;
      const db = clockedD1(env.DIRECTORY, { now: start });
      // (Its window is open: valid from a minute before midnight to a minute past it.)
      expect(grant.plan.validUntil).toBeGreaterThan(start);
      await markLiveOwnerDispatched(db, ownerId, { instance: "i1", startedAt: start });
      await observeLiveOwner(db, ownerId, {
        startedAt: start,
        physicalFinishedAt: start + 2 * MINUTE,
        chargedThrough: start + 2 * MINUTE,
      });
      expect(await settleLiveOwnerPage(db, ownerId)).toMatchObject({ accounted: true });
      // The day before its start gets its whole minute back; the next day keeps what ran.
      expect((await dayRow(day))?.do_duration_ms).toBe(0);
      expect((await dayRow(day + 1))?.do_duration_ms).toBe(2 * MINUTE);
    }));

  it("charges a long run a page of days at a time, each day once", () =>
    isolated(async () => {
      const day = testDay(10);
      // Three days and an hour: pages of two days, the cursor going on.
      const long = await ran(day, 3 * DAY + 3_600_000, "usr_long");
      const later = at(day + 4).db;
      expect(await settleLiveOwnerPage(later, long.ownerId, 2)).toMatchObject({
        status: "settled",
        cursor: day + 2,
        accounted: false,
      });
      expect(await settleLiveOwnerPage(later, long.ownerId, 2)).toMatchObject({
        status: "settled",
        cursor: day + 4,
        accounted: true,
      });
      expect((await dayRow(day))?.do_duration_ms).toBe(DAY / 2);
      expect((await dayRow(day + 1))?.do_duration_ms).toBe(DAY);
      expect((await dayRow(day + 3))?.do_duration_ms).toBe(DAY / 2 + 3_600_000);
      expect(
        liveOwnerAdjustment(
          { startedAt: 0, physicalFinishedAt: 0, chargedThrough: DAY + 10 },
          [{ day: 0, ms: 100 }],
          1,
        ),
      ).toEqual({ used: 10, correction: 10, unused: 0 });
    }));

  it("applies a page once when two runners race, and a replay changes nothing", () =>
    isolated(async () => {
      const day = testDay(11);
      const { ownerId, db } = await ran(day, 20 * MINUTE);
      const before = (await ledger())?.duration_debt_ms as number;
      const [a, b] = await Promise.all([
        settleLiveOwnerPage(db, ownerId),
        settleLiveOwnerPage(db, ownerId),
      ]);
      expect([a.status, b.status].sort()).toEqual(["duplicate", "settled"]);
      expect((await ledger())?.duration_debt_ms).toBe(before + 5 * MINUTE);
      expect((await dayRow(day))?.do_duration_ms).toBe(20 * MINUTE);
    }));

  it("charges a correction past the day's allowance, marking the breach", () =>
    isolated(async () => {
      const day = testDay(12);
      const { ownerId, db } = await ran(day, 20 * MINUTE);
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_days SET do_duration_ms = 19999990 WHERE day = ?",
      )
        .bind(day)
        .run();
      await settleLiveOwnerPage(db, ownerId);
      expect(await dayRow(day)).toMatchObject({ duration_breach: 1 });
    }));
});

describe("the duration debt and reserve", () => {
  it("serves the debt once a day from ordinary capacity", () =>
    isolated(async () => {
      const day = testDay(13);
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET duration_debt_ms = 5000, debt_service_day = 0",
      ).run();
      expect(await serviceLiveDurationDebt(at(day).db)).toBe(5000);
      expect(await serviceLiveDurationDebt(at(day).db)).toBe(0);
      expect(await dayRow(day)).toMatchObject({ debt_withheld_ms: 5000 });
      expect((await ledger())?.duration_debt_ms).toBe(0);
      await env.DIRECTORY.prepare("UPDATE live_budget_state SET duration_debt_ms = 7").run();
      expect(await serviceLiveDurationDebt(at(day + 1).db)).toBe(7);
    }));

  it("blocks ordinary duration once the day's reserve is spent, and leaves cleanup its own", () =>
    isolated(async () => {
      const day = testDay(14);
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET duration_reserve_ms = 1000000",
      ).run();
      const g = await granted(day, { recipient: "usr_r" });
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_days SET reserve_used_ms = 1000000 WHERE day = ?",
      )
        .bind(day)
        .run();
      const { db } = at(day);
      expect(await admitLiveOwners(db, owners([{ grant: g, role: "feed" }]), LIMITS)).toEqual({
        status: "refused",
        reason: "blocked",
      });
      // A new ordinary grant holding duration is refused too.
      await expect(granted(day, { recipient: "usr_s" })).rejects.toThrow("not granted");
      await admitted(day, "maintenance", { class: "cleanup" });
    }));
});
