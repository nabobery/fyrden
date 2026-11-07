// Funded live work, as its recipient checks it before doing anything: a
// funding for itself, this kind and class, priced by the manifest it
// knows, within its entry's validity, paying the entry's price on every
// day the work may run (another day's charge paying nothing of today's)
// and its cleanup, at most what a unit covers, with its admitted owner (or
// none, for a synchronous unit); then its grant's coverage in the ledger,
// its owner admitted for this very operation. A plan is built from its
// entry so; a grant made again is the same grant, charged once; another
// nonce for it is refused; a daily refusal says when D1's next day starts.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type LiveEnvelope,
  type LiveGrantPlan,
  makeLiveGrant,
  reserveLive,
} from "../src/live/budget.js";
import {
  expectationOf,
  fund,
  LIVE_MANIFEST_REVISION,
  type LiveFunding,
  liveTarget,
  ownedRun,
  planFor,
  validateFunding,
} from "../src/live/funding.js";
import {
  LIVE_PRICES,
  LIVE_REQUIRED_COMPONENTS,
  type LiveManifestEntry,
  livePrice,
} from "../src/live/manifest.js";
import { admitLiveOwners } from "../src/live/owners.js";
import {
  clockedD1,
  DAY,
  dayRow,
  incarnation,
  isolated,
  testDay,
  vector,
  ZERO,
} from "./helpers/live-budget.js";

const LIMITS = {
  deploymentTotal: 6,
  deploymentOrdinary: 4,
  deploymentCleanup: 2,
  perObjectOrdinary: 2,
  perObjectCleanup: 1,
};

/** An owned pump's entry, and a synchronous block of 32 controls (prices by the rule). */
const PUMP: LiveManifestEntry = {
  resources: livePrice([vector({ do_rows_read: 30, d1_rows_read: 4 })], 2, "owner"),
  validity: { maxMs: 60_000, days: 2 },
  duration: "owner",
  maxQuantity: 1,
  requests: 2,
  directoryCleanupDebt: ZERO,
  localCleanupDebt: vector({ do_rows_written: 1 }),
  dayCleanupDebt: ZERO,
  components: [...(LIVE_REQUIRED_COMPONENTS.pump ?? [])],
  observed: { one: vector({ do_rows_read: 30, d1_rows_read: 4 }) },
};
const BLOCK: LiveManifestEntry = {
  ...PUMP,
  resources: livePrice([vector({ do_rows_written: 40 })], 1, "synchronous", 32),
  duration: "synchronous",
  maxQuantity: 32,
  requests: 1,
  components: [],
  observed: { full: vector({ do_rows_written: 40 }) },
};

const RECIPIENT = "usr_funded";

/** One admission of `entry` for `RECIPIENT`, valid from `from`: granted, its owner admitted if owned. */
async function funded(entry: LiveManifestEntry, from: number, quantity = entry.maxQuantity) {
  const db = clockedD1(env.DIRECTORY, { now: from });
  const plan = planFor(
    entry,
    {
      incarnation: await incarnation(),
      recipientType: "UserDO",
      recipient: RECIPIENT,
      epoch: 0,
      kind: entry === PUMP ? "pump" : "control",
      class: "ordinary",
      // Its local cleanup retired by the feed's recovery.
      producesLocal: true,
    },
    from,
  );
  const request = await makeLiveGrant(plan);
  const granted = await reserveLive(db, request);
  if (granted.status !== "granted") throw new Error(granted.reason);
  const envelope: LiveEnvelope = granted.grant;
  let ownerId: string | null = null;
  if (entry.duration === "owner") {
    const admitted = await admitLiveOwners(
      db,
      {
        incarnation: plan.incarnation,
        class: plan.class,
        dispatchFrom: plan.validFrom,
        dispatchUntil: plan.validUntil,
        owners: [{ operationId: envelope.operationId, role: "pump" }],
      },
      LIMITS,
    );
    if (admitted.status !== "admitted") throw new Error(admitted.reason);
    ownerId = admitted.owners[0]?.ownerId as string;
  }
  const funding: LiveFunding = {
    protocol: 1,
    revision: LIVE_MANIFEST_REVISION,
    envelope,
    quantity,
    ownerId,
  };
  return { db, request, funding };
}

const pumpExpected = expectationOf(PUMP, {
  recipientType: "UserDO",
  recipient: RECIPIENT,
  kind: "pump",
  class: "ordinary",
});
const blockExpected = expectationOf(BLOCK, {
  recipientType: "UserDO",
  recipient: RECIPIENT,
  kind: "control",
  class: "ordinary",
});
const noon = (day: number) => day * DAY + DAY / 2;

/** A database that throws on any read: a refusal decided from shape never reaches it. */
const none = new Proxy({} as D1Database, {
  get: () => {
    throw new Error("read the ledger");
  },
});

describe("a funding", () => {
  it("is valid for its recipient, unit, price, quantity and owner, a block at its entry's price", () =>
    isolated(async () => {
      const pump = await funded(PUMP, noon(testDay(1)));
      expect(await validateFunding(pump.db, pump.funding, pumpExpected)).toMatchObject({
        status: "valid",
      });
      // A block's price is one admission's, its 32 controls in it: not 32 times over.
      const block = await funded(BLOCK, noon(testDay(1)) + 1_000);
      expect(block.funding.quantity).toBe(32);
      expect(await validateFunding(block.db, block.funding, blockExpected)).toMatchObject({
        status: "valid",
      });
      // Its allowance debited outright on its day, never held: no place in the day's escrow.
      const { plan } = block.funding.envelope;
      expect(plan.charges.map((c) => [c.duration, c.resources.do_duration_ms])).toEqual(
        plan.charges.map(() => [null, BLOCK.resources.do_duration_ms]),
      );
      const day = await env.DIRECTORY.prepare("SELECT escrow FROM live_budget_days WHERE day = ?")
        .bind(testDay(1))
        .first<{ escrow: string }>();
      expect(
        (JSON.parse(day?.escrow ?? "[]") as { id: string }[]).some(
          (e) => e.id === block.funding.envelope.operationId,
        ),
      ).toBe(false);
    }));

  it("is refused from its shape for anything it is not, before reading the ledger", () =>
    isolated(async () => {
      const { funding } = await funded(PUMP, noon(testDay(2)));
      const refused = async (f: unknown, e = pumpExpected) =>
        ((await validateFunding(none, f, e)) as { reason: string }).reason;
      const withPlan = (change: Partial<LiveGrantPlan>) => ({
        ...funding,
        envelope: { ...funding.envelope, plan: { ...funding.envelope.plan, ...change } },
      });
      expect(await refused({ ...funding, protocol: 2 })).toBe("an unknown protocol");
      expect(await refused({ ...funding, revision: LIVE_MANIFEST_REVISION + 1 })).toBe(
        "another manifest's prices",
      );
      for (const envelope of [
        { ...funding.envelope, operationId: { id: 1 } },
        { ...funding.envelope, operationId: "" },
        { ...funding.envelope, seq: "1" },
        { ...funding.envelope, seq: 0 },
        { ...funding.envelope, ledgerAt: "noon" },
      ])
        expect(await refused({ ...funding, envelope })).toBe("not an envelope");
      expect(await refused(funding, { ...pumpExpected, recipient: "usr_other" })).toBe(
        "another recipient's",
      );
      expect(await refused(funding, { ...pumpExpected, kind: "renewal" })).toBe("another kind's");
      expect(await refused(funding, { ...pumpExpected, class: "cleanup" })).toBe("another class's");
      expect(await refused({ ...funding, quantity: 0 })).toBe("its quantity is not a count");
      expect(await refused({ ...funding, quantity: 2 })).toBe("more than a unit covers");
      expect(await refused({ ...funding, ownerId: null })).toBe("no owner named");
      expect(await refused(funding, { ...pumpExpected, owned: false })).toBe(
        "an owner named for a synchronous unit",
      );
      expect(
        await refused(funding, { ...pumpExpected, validity: { maxMs: 30_000, days: 2 } }),
      ).toBe("valid longer than its unit");
      expect(
        await refused(funding, {
          ...pumpExpected,
          localCleanupDebt: vector({ do_rows_written: 2 }),
        }),
      ).toBe("less localCleanupDebt than its unit leaves");
      // A one-row grant does not pay for a pump.
      const [charge] = funding.envelope.plan.charges;
      expect(
        await refused(
          withPlan({
            charges: [
              {
                ...(charge as (typeof funding.envelope.plan.charges)[number]),
                resources: vector({
                  do_requests: 1,
                  do_duration_ms: charge?.resources.do_duration_ms ?? 0,
                }),
              },
            ],
          }),
        ),
      ).toMatch(/^less do_requests than its price on day /);
    }));

  it("pays on every day it may run: tomorrow's charge pays nothing of today's", () =>
    isolated(async () => {
      const day = testDay(3);
      // Valid across midnight: both days charged its whole price, a hold on each.
      const across = await funded(PUMP, (day + 1) * DAY - 30_000);
      const charges = across.funding.envelope.plan.charges;
      expect(charges.map((c) => c.day)).toEqual([day, day + 1]);
      for (const c of charges) {
        expect(c.resources.do_requests).toBe(PUMP.resources.do_requests);
        expect(c.duration?.ms).toBeGreaterThan(0);
      }
      expect(await validateFunding(across.db, across.funding, pumpExpected)).toMatchObject({
        status: "valid",
      });
      // Today holding duration only, tomorrow paying all the rest: refused.
      const [today, tomorrow] = charges as [(typeof charges)[number], (typeof charges)[number]];
      const shifted = {
        ...across.funding,
        envelope: {
          ...across.funding.envelope,
          plan: {
            ...across.funding.envelope.plan,
            charges: [
              { ...today, resources: vector({ do_duration_ms: today.resources.do_duration_ms }) },
              {
                ...tomorrow,
                resources: Object.fromEntries(
                  Object.entries(tomorrow.resources).map(([r, n]) => [
                    r,
                    r === "do_duration_ms" ? n : 2 * n,
                  ]),
                ) as typeof tomorrow.resources,
              },
            ],
          },
        },
      };
      expect(
        ((await validateFunding(none, shifted, pumpExpected)) as { reason: string }).reason,
      ).toBe(`less do_requests than its price on day ${day}`);
    }));

  it("pays the day a run may go on into past midnight, and holds what its runs may take", () =>
    isolated(async () => {
      const day = testDay(7);
      // Valid in the last minute of the day: its runs may go on into the next, which pays too.
      const late = await funded(PUMP, (day + 1) * DAY - 61_000);
      const charges = late.funding.envelope.plan.charges;
      expect(charges.map((c) => c.day)).toEqual([day, day + 1]);
      expect(charges[1]?.resources.do_requests).toBe(PUMP.resources.do_requests);
      expect(await validateFunding(late.db, late.funding, pumpExpected)).toMatchObject({
        status: "valid",
      });
      const withCharges = (next: typeof charges) => ({
        ...late.funding,
        envelope: {
          ...late.funding.envelope,
          plan: { ...late.funding.envelope.plan, charges: next },
        },
      });
      const reason = async (f: unknown) =>
        ((await validateFunding(none, f, pumpExpected)) as { reason: string }).reason;
      expect(await reason(withCharges(charges.slice(0, 1)))).toBe(
        `nothing charged to day ${day + 1} it may run on`,
      );
      // A grant really held for a millisecond does not cover its runs.
      const plan = late.funding.envelope.plan;
      const thin = {
        ...plan,
        incarnation: plan.incarnation,
        charges: plan.charges.map((c) =>
          c.duration
            ? {
                ...c,
                resources: { ...c.resources, do_duration_ms: 1 },
                duration: { ...c.duration, ms: 1 },
              }
            : c,
        ),
      };
      const db = clockedD1(env.DIRECTORY, { now: plan.validFrom });
      const thinGrant = await reserveLive(db, await makeLiveGrant(thin));
      if (thinGrant.status !== "granted") throw new Error(thinGrant.reason);
      expect(
        (
          (await validateFunding(
            none,
            { ...late.funding, envelope: thinGrant.grant },
            pumpExpected,
          )) as {
            reason: string;
          }
        ).reason,
      ).toBe(`less duration held on day ${day} than its runs may take`);
      // Tails are counts; local cleanup only where a recovery retires it.
      const target = {
        incarnation: plan.incarnation,
        recipientType: "UserDO" as const,
        recipient: RECIPIENT,
        epoch: 0,
        kind: "pump" as const,
        class: "ordinary" as const,
        producesLocal: true,
      };
      expect(() => planFor(PUMP, target, noon(day), -899_999)).toThrow("a tail is a count");
      expect(() => planFor(PUMP, { ...target, producesLocal: false }, noon(day))).toThrow(
        "local cleanup without its recovery",
      );
      expect(
        await reason({
          ...late.funding,
          envelope: { ...late.funding.envelope, plan: { ...plan, producesLocal: false } },
        }),
      ).toBe("local cleanup without its recovery");
      expect(
        (
          (await validateFunding(none, late.funding, { ...pumpExpected, tailMs: -1 })) as {
            reason: string;
          }
        ).reason,
      ).toBe("an expectation without a tail");
    }));

  it("is refused by the ledger for an owner of another operation, or once it expired", () =>
    isolated(async () => {
      const day = testDay(4);
      const { db, funding } = await funded(PUMP, noon(day));
      const other = await funded(PUMP, noon(day) + 1);
      expect(
        await validateFunding(db, { ...funding, ownerId: other.funding.ownerId }, pumpExpected),
      ).toEqual({ status: "refused", reason: "invalid" });
      const later = clockedD1(env.DIRECTORY, { now: funding.envelope.plan.validUntil });
      expect(await validateFunding(later, funding, pumpExpected)).toEqual({
        status: "refused",
        reason: "expired",
      });
    }));
});

describe("funding a grant", () => {
  it("is the same grant again, charged once; its identity with another nonce is temporary", () =>
    isolated(async () => {
      const day = testDay(5);
      const { db, request, funding } = await funded(PUMP, noon(day));
      const before = await dayRow(day);
      expect(await fund(db, request)).toEqual({ status: "funded", value: funding.envelope });
      expect(await dayRow(day)).toEqual(before);
      const forged = await makeLiveGrant(request.plan, "f".repeat(32));
      expect(await fund(db, { ...forged, operationId: request.operationId })).toEqual({
        status: "refused",
        reason: "temporary",
        gate: "validity",
      });
      // A retry must send the request it made (its identity and nonce): a fresh nonce is another
      // operation, granted and charged again.
      const again = await fund(db, forged);
      expect(again.status).toBe("funded");
      expect((await dayRow(day))?.do_requests).toBe(
        (before?.do_requests as number) + PUMP.resources.do_requests,
      );
    }));

  it("is refused for the day past its allowance, until D1's next UTC day", () =>
    isolated(async () => {
      const day = testDay(6);
      const huge: LiveManifestEntry = {
        ...BLOCK,
        resources: { ...BLOCK.resources, do_requests: 1_000_000 },
      };
      const plan = planFor(
        huge,
        {
          incarnation: await incarnation(),
          recipientType: "UserDO",
          recipient: RECIPIENT,
          epoch: 0,
          kind: "control",
          class: "ordinary",
          producesLocal: true,
        },
        noon(day),
      );
      // Whatever the caller's clock says: the ledger's day decides.
      expect(
        await fund(clockedD1(env.DIRECTORY, { now: noon(day) }), await makeLiveGrant(plan)),
      ).toEqual({
        status: "refused",
        reason: "daily",
        retryAt: (day + 1) * DAY,
        gate: "daily_total",
      });
    }));
});

describe("owned live work", () => {
  /** A funded transport for a fresh feed, planned from the ledger's time now. */
  const transport = async () => {
    const recipient = `usr_${crypto.randomUUID()}`;
    const target = await liveTarget(env.DIRECTORY, recipient);
    const funded = await fund(
      env.DIRECTORY,
      await makeLiveGrant(
        planFor(
          LIVE_PRICES.upgrade_transport as LiveManifestEntry,
          {
            incarnation: target.incarnation,
            recipientType: "UserDO",
            recipient,
            epoch: target.epoch,
            kind: "upgrade_transport",
            class: "ordinary",
            producesLocal: false,
          },
          target.ledger.now,
        ),
      ),
    );
    if (funded.status !== "funded") throw new Error(funded.reason);
    return { envelope: funded.value, ledger: target.ledger };
  };
  const ownerRow = (ownerId: string | null) =>
    env.DIRECTORY.prepare("SELECT status, started_at FROM live_duration_owners WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ status: string; started_at: number }>();

  it("is timed on the ledger's clock from when it was sampled, the wait since included", () =>
    isolated(async () => {
      const { envelope, ledger } = await transport();
      // Sampled five seconds ago (by this Worker's clock): its run starts five seconds on.
      const run = await ownedRun(
        env.DIRECTORY,
        envelope,
        "upgrade",
        async (funding) => (await ownerRow(funding.ownerId))?.started_at,
        { ledger: { ...ledger, at: ledger.at - 5_000 } },
      );
      expect(run.status).toBe("funded");
      expect((run as { value: number }).value).toBeGreaterThanOrEqual(ledger.now + 5_000);
      // D1's whole second and its answer's time: what the ledger's time may be past its sample.
      expect(ledger.slack).toBeGreaterThanOrEqual(1_000);
    }));

  it("is given up on past its pending bound, told to stop, its owner left for recovery", () =>
    isolated(async () => {
      const { envelope, ledger } = await transport();
      let ownerId: string | null = null;
      let stopped = false;
      const run = await ownedRun(
        env.DIRECTORY,
        envelope,
        "upgrade",
        async (funding, signal) => {
          ownerId = funding.ownerId;
          // Waits on its deadline only (no timer of the test's own).
          await new Promise((resolve) => signal.addEventListener("abort", resolve));
          stopped = signal.aborted;
          return "late";
        },
        { ledger, pendingMs: 20 },
      );
      expect(run).toEqual({ status: "refused", reason: "temporary", gate: "given_up" });
      expect(stopped).toBe(true);
      expect((await ownerRow(ownerId))?.status).toBe("dispatched");
    }));

  it("keeps its result when its accounting fails after it ran, its owner left for recovery", () =>
    isolated(async () => {
      const { envelope, ledger } = await transport();
      let down = false;
      // The directory unreachable from the moment the call ran.
      const db = new Proxy(env.DIRECTORY, {
        get(target, key) {
          if (down && (key === "batch" || key === "prepare"))
            return () => {
              throw new Error("the directory is unreachable");
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      let ownerId: string | null = null;
      const run = await ownedRun(
        db,
        envelope,
        "upgrade",
        async (funding) => {
          ownerId = funding.ownerId;
          down = true;
          return "opened";
        },
        { ledger },
      );
      // Its result stands; its owner, not accounted, is said to be.
      expect(run).toEqual({ status: "funded", value: "opened", accounted: false });
      expect((await ownerRow(ownerId))?.status).toBe("dispatched");
    }));
});
