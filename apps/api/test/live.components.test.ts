// What each funded operation's inline steps cost an invocation, pinned
// against the statements and calls they actually make (counted at the
// binding): a grant over its days, an owner's admission, dispatch,
// observation, a bounded quarantine, a settlement page, its release, a
// day's debt service and coverage validation. An alarm reserves these
// components whole, so a component that grew must grow its price too.

import { env } from "cloudflare:workers";
import type { SubrequestTally } from "@fyrden/adapters-cloudflare/obs";
import { describe, expect, it } from "vitest";
import { ALARM_UNITS, AlarmBudget, type AlarmUnit } from "../src/do/user/alarm-budget.js";
import {
  expireLiveReceipts,
  type LiveDayCharge,
  type LiveEnvelope,
  makeLiveGrant,
  reserveLive,
  validateLiveCoverage,
} from "../src/live/budget.js";
import {
  admitLiveOwners,
  type LiveOwnerLimits,
  markLiveOwnerDispatched,
  observeLiveOwner,
  quarantineLiveOwners,
  releaseLiveOwner,
  serviceLiveDurationDebt,
  settleLiveOwnerPage,
} from "../src/live/owners.js";
import { countingD1 } from "./helpers/d1.js";
import { clockedD1, DAY, isolated, plan, testDay, vector } from "./helpers/live-budget.js";

const LIMITS: LiveOwnerLimits = {
  deploymentTotal: 6,
  deploymentOrdinary: 4,
  deploymentCleanup: 2,
  perObjectOrdinary: 2,
  perObjectCleanup: 1,
};
const HOLD = 900_000;
const MINUTE = 60_000;

/** `work` on the ledger with D1's clock at `now`: what it cost, as an alarm's component counts it. */
async function cost<T>(now: number, work: (db: D1Database) => Promise<T>) {
  const count = { queries: 0, calls: 0 };
  const result = await work(countingD1(clockedD1(env.DIRECTORY, { now }), count));
  return { result, used: { d1: count.queries, internal: count.calls, external: 0 } };
}

/**
 * A grant for `recipient`, valid from noon of `day` (across its midnight, on both days): a
 * pump's by default, or `kind`'s, producing local state with `local`.
 */
async function granted(
  day: number,
  recipient: string,
  acrossMidnight = false,
  { kind, local = false }: { kind?: "renewal" | "control"; local?: boolean } = {},
) {
  const from = acrossMidnight ? (day + 1) * DAY - MINUTE : day * DAY + DAY / 2;
  const charges: LiveDayCharge[] = acrossMidnight
    ? [
        {
          day,
          resources: vector({ do_requests: 1, do_duration_ms: MINUTE }),
          duration: { day, from, until: (day + 1) * DAY, ms: MINUTE },
        },
        {
          day: day + 1,
          resources: vector({ do_duration_ms: HOLD }),
          duration: {
            day: day + 1,
            from: (day + 1) * DAY,
            until: from + 2 * MINUTE + HOLD,
            ms: HOLD,
          },
        },
      ]
    : [
        {
          day,
          resources: vector({ do_requests: 1, do_duration_ms: HOLD }),
          duration: { day, from, until: from + MINUTE + HOLD, ms: HOLD },
        },
      ];
  const request = await makeLiveGrant(
    await plan({
      day,
      from,
      validMs: acrossMidnight ? 2 * MINUTE : MINUTE,
      recipient,
      charges,
      ...(kind && { kind }),
      ...(local && {
        producesLocal: true,
        localCleanupDebt: vector({ do_rows_written: 2 }),
      }),
    }),
  );
  return { request, from };
}

/** An owner of a grant for `recipient`, run three days past it and settled after: the page's cost. */
async function settledPage(day: number, recipient: string, acrossMidnight: boolean) {
  const { request, from } = await granted(day, recipient, acrossMidnight);
  // The ledger's expired receipts cleaned up first (an ordinary grant waits for that).
  await cost(from, (db) => expireLiveReceipts(db));
  const reserved = await cost(from, (db) => reserveLive(db, request));
  if (reserved.result.status !== "granted")
    throw new Error(`not granted: ${reserved.result.reason}`);
  const g = reserved.result.grant;
  const a = await cost(from, (db) =>
    admitLiveOwners(
      db,
      {
        incarnation: g.plan.incarnation,
        class: g.plan.class,
        dispatchFrom: g.plan.validFrom,
        dispatchUntil: g.plan.validUntil,
        owners: [{ operationId: g.operationId, role: "feed" }],
      },
      LIMITS,
    ),
  );
  if (a.result.status !== "admitted") throw new Error(a.result.reason);
  const ownerId = a.result.owners[0]?.ownerId as string;
  await cost(from, (db) =>
    markLiveOwnerDispatched(db, ownerId, { instance: recipient, startedAt: from }),
  );
  const end = from + 3 * DAY;
  await cost(end, (db) =>
    observeLiveOwner(db, ownerId, {
      startedAt: from,
      physicalFinishedAt: end,
      chargedThrough: end,
    }),
  );
  return cost(end + DAY, (db) => settleLiveOwnerPage(db, ownerId));
}

describe("an alarm's components", () => {
  it("cost what their steps make", () =>
    isolated(async () => {
      const day = testDay(3);
      const measured: Partial<Record<AlarmUnit, unknown>> = {};
      const settles: { d1: number; internal: number }[] = [];
      // A feed's turn's grant over two days (its target registered, its done turns looked for).
      const turn = await granted(day, "usr_turn_component", true, { kind: "renewal", local: true });
      measured.turnGrant = (await cost(turn.from, (db) => reserveLive(db, turn.request))).used;
      // An ordinary grant over two days: a block's, producing local state.
      const { request, from } = await granted(day, "usr_component", true, {
        kind: "control",
        local: true,
      });
      const grant = await cost(from, (db) => reserveLive(db, request));
      measured.grant = grant.used;
      if (grant.result.status !== "granted") throw new Error("not granted");
      const envelope: LiveEnvelope = grant.result.grant;
      measured.coverage = (
        await cost(from, (db) =>
          validateLiveCoverage(db, envelope, {
            recipientType: envelope.plan.recipientType,
            recipient: envelope.plan.recipient,
            kind: envelope.plan.kind,
          }),
        )
      ).used;
      const admitted = await cost(from, (db) =>
        admitLiveOwners(
          db,
          {
            incarnation: envelope.plan.incarnation,
            class: envelope.plan.class,
            dispatchFrom: envelope.plan.validFrom,
            dispatchUntil: envelope.plan.validUntil,
            owners: [{ operationId: envelope.operationId, role: "feed" }],
          },
          LIMITS,
        ),
      );
      measured.admitOwner = admitted.used;
      if (admitted.result.status !== "admitted") throw new Error(admitted.result.reason);
      const ownerId = admitted.result.owners[0]?.ownerId as string;
      measured.dispatchOwner = (
        await cost(from, (db) =>
          markLiveOwnerDispatched(db, ownerId, { instance: "i1", startedAt: from }),
        )
      ).used;
      measured.acceptObservation = (
        await cost(from, (db) =>
          observeLiveOwner(db, ownerId, {
            startedAt: from,
            physicalFinishedAt: from + 2 * MINUTE,
            chargedThrough: from + 2 * MINUTE,
          }),
        )
      ).used;
      // Settled after both its days, a page of up to four.
      measured.settle = (
        await cost((day + 2) * DAY, (db) => settleLiveOwnerPage(db, ownerId))
      ).used;
      measured.releaseOwner = (
        await cost((day + 2) * DAY, (db) => releaseLiveOwner(db, ownerId, false))
      ).used;
      measured.quarantine = (
        await cost((day + 2) * DAY, (db) => quarantineLiveOwners(db, ["own_x", "own_y"]))
      ).used;
      measured.debtService = (
        await cost((day + 2) * DAY, (db) => serviceLiveDurationDebt(db))
      ).used;
      // Owners that ran three days past their grants: a whole page (four days) settled, its days'
      // holds corrected or refunded (from noon, and from a minute before midnight: a held day
      // that needs no correction refunds).
      for (const acrossMidnight of [false, true]) {
        // (Each with the ledger as it was: an overrun is charged to the days it ran on, and owed.)
        await isolated(async () => {
          const page = await settledPage(day + 6, `usr_long_${acrossMidnight}`, acrossMidnight);
          expect(page.result).toMatchObject({ status: "settled", accounted: true });
          // A whole page costs more than two days do: the component is its most.
          expect(page.used.d1).toBeGreaterThan((measured.settle as { d1: number }).d1);
          settles.push(page.used);
        });
      }
      measured.settle = {
        d1: Math.max(...settles.map((u) => u.d1)),
        internal: Math.max(...settles.map((u) => u.internal)),
        external: 0,
      };
      const { grant: grantUsed, ...rest } = measured;
      // A grant's component is an ordinary grant's or a refill batch's, whichever is larger.
      for (const counter of ["d1", "internal", "external"] as const)
        expect((grantUsed as Record<string, number>)[counter]).toBeLessThanOrEqual(
          ALARM_UNITS.grant[counter],
        );
      expect(rest).toEqual(
        Object.fromEntries(Object.keys(rest).map((unit) => [unit, ALARM_UNITS[unit as AlarmUnit]])),
      );
    }));

  it("are reserved whole: an owned pump's inline accounting fits beside the mandatory work, not beside an email turn too", () => {
    const tally = { d1: 0, internal: 0, external: 0 };
    const owned: AlarmUnit[] = [
      "pump",
      "turnGrant",
      "coverage",
      "admitOwner",
      "dispatchOwner",
      "acceptObservation",
      "settle",
      "releaseOwner",
    ];
    // An invocation that ran its mandatory steps and one email (as measured: 8 statements, 6
    // calls): what they made stays counted after they end.
    const budget = new AlarmBudget(tally as SubrequestTally);
    const mandatory = budget.reserve("mandatory");
    const email = budget.reserve("email");
    expect(mandatory && email).toBeTruthy();
    // With the email turn held, the whole owned pump does not fit: none of it is reserved.
    expect(budget.reserve(...owned)).toBeNull();
    tally.d1 += ALARM_UNITS.mandatory.d1 + 8;
    tally.internal += ALARM_UNITS.mandatory.internal + 6;
    email?.physicalComplete();
    mandatory?.physicalComplete();
    // Its accounting waits for a turn of its own: it does not fit after the email either.
    expect(budget.reserve(...owned)).toBeNull();
    // In an invocation with room (its mandatory steps alone made), it is reserved whole, and
    // nothing else fits beside it until it completes.
    const fresh = {
      d1: ALARM_UNITS.mandatory.d1,
      internal: ALARM_UNITS.mandatory.internal,
      external: 0,
    };
    const roomy = new AlarmBudget(fresh as SubrequestTally);
    const pump = roomy.reserve(...owned);
    expect(pump).not.toBeNull();
    expect(roomy.reserve("email")).toBeNull();
    pump?.physicalComplete();
    expect(roomy.reserve("email")).not.toBeNull();
  });

  it("are counted as an invocation's tally counts them, an exec too", async () => {
    const count = { queries: 0, calls: 0 };
    const db = countingD1(env.DIRECTORY, count);
    await db.exec("SELECT 1");
    await db.prepare("SELECT 1").first();
    await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2")]);
    expect(count).toEqual({ queries: 4, calls: 3 });
  });
});
