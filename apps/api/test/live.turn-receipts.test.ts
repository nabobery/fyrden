// A feed's turns and the cleanup they owe: a turn's successor grant removes
// the feed's earlier turns' receipts once each is done (its validity over,
// its owner released, nothing of it in escrow), their directory debt with
// them, so a feed always on owes a turn or two of receipts rather than days
// of them; and a turn's local state (one turn row at a time) is owed once a
// feed's recovery target, not once a turn.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  LIVE_ORDINARY_DEBT_LIMIT,
  LIVE_TURN_RECEIPT_LOOK,
  LIVE_TURN_RECEIPT_PAGE,
  type LiveEnvelope,
  makeLiveGrant,
  reserveLive,
} from "../src/live/budget.js";
import {
  admitLiveOwners,
  type LiveOwnerLimits,
  markLiveOwnerDispatched,
  observeLiveOwner,
  releaseLiveOwner,
  settleLiveOwnerPage,
} from "../src/live/owners.js";
import { clockedD1, DAY, isolated, ledger, plan, testDay, vector } from "./helpers/live-budget.js";

const LIMITS: LiveOwnerLimits = {
  deploymentTotal: 64,
  deploymentOrdinary: 60,
  deploymentCleanup: 4,
  perObjectOrdinary: 1,
  perObjectCleanup: 1,
};

const MINUTE = 60_000;
const HOLD = 30_000;
const DIRECTORY_DEBT = 2;
const LOCAL_DEBT = 2;

/** A grant of `kind` for `feed`, valid a minute from `from`, holding its duration. */
async function grant(
  feed: string,
  from: number,
  kind: "pump" | "renewal" | "ticket" = "renewal",
  db: D1Database = clockedD1(env.DIRECTORY, { now: from }),
): Promise<LiveEnvelope> {
  const day = Math.floor(from / DAY);
  const p = await plan({
    day,
    from,
    validMs: MINUTE,
    recipient: feed,
    kind,
    producesLocal: true,
    directoryCleanupDebt: vector({ d1_rows_written: DIRECTORY_DEBT }),
    localCleanupDebt: vector({ do_rows_written: LOCAL_DEBT }),
    charges: [
      {
        day,
        resources: vector({ do_requests: 1, do_duration_ms: HOLD }),
        duration: { day, from, until: from + MINUTE + HOLD, ms: HOLD },
      },
    ],
  });
  const result = await reserveLive(db, await makeLiveGrant(p));
  if (result.status !== "granted") throw new Error(`not granted: ${result.reason}`);
  return result.grant;
}

/** The directory with D1's clock at `now`, counting the rows its batches read and write. */
function meteredD1(now: number) {
  const totals = { read: 0, written: 0 };
  const clocked = clockedD1(env.DIRECTORY, { now });
  const db = new Proxy(clocked, {
    get(target, prop) {
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          for (const r of results) {
            totals.read += r.meta.rows_read;
            totals.written += r.meta.rows_written;
          }
          return results;
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return { db, totals };
}

/**
 * Runs `granted`'s owner through: admitted, dispatched, observed, accounted
 * and released (`upTo` stops it earlier), as a feed's turn does.
 */
async function run(
  granted: LiveEnvelope,
  upTo: "admitted" | "dispatched" | "released" = "released",
): Promise<void> {
  const from = granted.plan.validFrom;
  const db = clockedD1(env.DIRECTORY, { now: from });
  const admitted = await admitLiveOwners(
    db,
    {
      incarnation: granted.plan.incarnation,
      class: "ordinary",
      dispatchFrom: from,
      dispatchUntil: granted.plan.validUntil,
      owners: [{ operationId: granted.operationId, role: "feed" }],
    },
    LIMITS,
  );
  if (admitted.status !== "admitted") throw new Error(admitted.reason);
  const ownerId = admitted.owners[0]?.ownerId as string;
  if (upTo === "admitted") return;
  expect(await markLiveOwnerDispatched(db, ownerId, { instance: "i1", startedAt: from })).toBe(
    "dispatched",
  );
  if (upTo === "dispatched") return;
  expect(
    await observeLiveOwner(db, ownerId, {
      startedAt: from,
      physicalFinishedAt: from + 1_000,
      chargedThrough: from + 1_000,
    }),
  ).toBe("accepted");
  expect(await settleLiveOwnerPage(db, ownerId)).toMatchObject({ accounted: true });
  expect(await releaseLiveOwner(db, ownerId)).toBe("released");
}

/** Which of `grants` still have receipts. */
async function kept(...grants: LiveEnvelope[]): Promise<boolean[]> {
  const { results } = await env.DIRECTORY.prepare(
    "SELECT operation_id FROM live_budget_receipts",
  ).all<{ operation_id: string }>();
  const held = new Set(results.map((r) => r.operation_id));
  return grants.map((g) => held.has(g.operationId));
}

const d1Debt = async () => (await ledger())?.debt_d1_rows_written as number;
const doDebt = async () => (await ledger())?.debt_do_rows_written as number;

/** `feed`'s recovery target's local debt (object rows written), or null. */
const targetDebt = async (feed: string) => {
  const row = await env.DIRECTORY.prepare(
    "SELECT local_cleanup_debt FROM live_recovery_targets WHERE feed = ?",
  )
    .bind(feed)
    .first<{ local_cleanup_debt: string }>();
  return row ? (JSON.parse(row.local_cleanup_debt).do_rows_written as number) : null;
};

describe("a feed's turn receipts", () => {
  it("are removed by a later turn's grant once each is done, their debt with them", () =>
    isolated(async () => {
      const noon = testDay(1) * DAY + DAY / 2;
      const first = await grant("usr_turns", noon);
      await run(first);
      const before = await d1Debt();
      // Past the first's validity: the next turn's grant removes it, owing its own instead.
      const second = await grant("usr_turns", noon + 2 * MINUTE);
      expect(await kept(first, second)).toEqual([false, true]);
      expect(await d1Debt()).toBe(before);
      // Its kind does not matter, a pump's or a renewal's, either way.
      await run(second);
      const third = await grant("usr_turns", noon + 4 * MINUTE, "pump");
      expect(await kept(second, third)).toEqual([false, true]);
    }));

  it("are kept while not done: still valid, not yet released, or with a hold still in escrow", () =>
    isolated(async () => {
      const noon = testDay(2) * DAY + DAY / 2;
      // Released within its validity: kept until a grant made past it.
      const valid = await grant("usr_valid", noon);
      await run(valid);
      const during = await grant("usr_valid", noon + 30_000);
      expect(await kept(valid)).toEqual([true]);
      // Dispatched, never accounted (a turn still running, or one recovery deals with).
      const running = await grant("usr_running", noon);
      await run(running, "dispatched");
      await grant("usr_running", noon + 2 * MINUTE);
      expect(await kept(running)).toEqual([true]);
      // Admitted and never dispatched, released once its window passed: its hold is still in
      // escrow, so it waits for its expiry (maintenance refunds nothing it removes early).
      const idle = await grant("usr_idle", noon);
      await run(idle, "admitted");
      const later = clockedD1(env.DIRECTORY, { now: noon + 2 * MINUTE });
      const { results } = await later
        .prepare("SELECT owner_id FROM live_duration_owners WHERE operation_id = ?")
        .bind(idle.operationId)
        .all<{ owner_id: string }>();
      expect(await releaseLiveOwner(later, results[0]?.owner_id as string)).toBe("released");
      await grant("usr_idle", noon + 3 * MINUTE);
      expect(await kept(idle)).toEqual([true]);
      // Never admitted (its turn never ran): its expiry removes it.
      const unrun = await grant("usr_unrun", noon);
      await grant("usr_unrun", noon + 2 * MINUTE);
      expect(await kept(unrun, during)).toEqual([true, true]);
    }));

  it("are a feed's own turns' only: another feed's, or another kind's, are left to expire", () =>
    isolated(async () => {
      const noon = testDay(3) * DAY + DAY / 2;
      const other = await grant("usr_other", noon);
      await run(other);
      const ticket = await grant("usr_mine", noon, "ticket");
      await run(ticket);
      await grant("usr_mine", noon + 2 * MINUTE);
      expect(await kept(other, ticket)).toEqual([true, true]);
    }));

  it("are removed a page a grant, the newest first", () =>
    isolated(async () => {
      const noon = testDay(4) * DAY + DAY / 2;
      const done: LiveEnvelope[] = [];
      for (let i = 0; i <= LIVE_TURN_RECEIPT_PAGE; i++) {
        // One owner a feed at once: each run through before the next is granted.
        const g = await grant("usr_paged", noon + i * 2 * MINUTE);
        await run(g);
        done.push(g);
      }
      // Each grant past the first removed the one before it: only the last is left.
      expect(await kept(...done)).toEqual([...done.slice(0, -1).map(() => false), true]);
      // A backlog (receipts done while no grant came) goes a page at a time, the newest first.
      const backlog: LiveEnvelope[] = [];
      const start = noon + DAY / 4;
      for (let i = 0; i <= LIVE_TURN_RECEIPT_PAGE; i++) {
        const g = await grant(`usr_backlog_${i}`, start + i * 2 * MINUTE);
        await run(g);
        backlog.push(g);
      }
      // Moved to one feed (as if granted to it while its successors were refused).
      await env.DIRECTORY.prepare(
        `UPDATE live_budget_receipts SET recipient = 'usr_backlog'
         WHERE operation_id IN (SELECT value FROM json_each(?))`,
      )
        .bind(JSON.stringify(backlog.map((g) => g.operationId)))
        .run();
      const debt = await d1Debt();
      await grant("usr_backlog", start + (LIVE_TURN_RECEIPT_PAGE + 1) * 2 * MINUTE);
      expect(await kept(...backlog)).toEqual([true, ...backlog.slice(1).map(() => false)]);
      // Their debt went with them, the new grant's came.
      expect(await d1Debt()).toBe(debt - LIVE_TURN_RECEIPT_PAGE * DIRECTORY_DEBT + DIRECTORY_DEBT);
    }));

  it("let a turn through the ordinary debt limit when it retires as much as it owes", () =>
    isolated(async () => {
      const noon = testDay(7) * DAY + DAY / 2;
      const first = await grant("usr_limit", noon);
      await run(first);
      // The ledger at its ordinary limit of directory rows written.
      const limit = LIVE_ORDINARY_DEBT_LIMIT.d1_rows_written;
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET debt_d1_rows_written = ? WHERE id = 1",
      )
        .bind(limit)
        .run();
      // Another feed's turn retires nothing of it: refused.
      await expect(grant("usr_unlimited", noon + 2 * MINUTE)).rejects.toThrow("temporary");
      // The feed's next turn owes what it retires (the first's receipt): granted, still at it.
      const second = await grant("usr_limit", noon + 2 * MINUTE);
      expect(await kept(first, second)).toEqual([false, true]);
      expect(await d1Debt()).toBe(limit);
    }));

  it("are looked for among a few newest only: turns that never ran, or another incarnation's, cost later grants nothing more", () =>
    isolated(async () => {
      const noon = testDay(6) * DAY + DAY / 2;
      // Turns granted and never run (never done), or (`elsewhere`) granted under an earlier
      // incarnation of the ledger, then one that ran (a day holds 64 unsettled durations).
      const read = async (feed: string, unrun: number, elsewhere = false) => {
        for (let i = 0; i < unrun; i++) await grant(feed, noon + i * 2 * MINUTE);
        // A new incarnation since (the directory restored): its receipts stay, the feed's target
        // retired (as its recovery does), and later grants are the new incarnation's.
        if (elsewhere)
          await env.DIRECTORY.batch([
            env.DIRECTORY.prepare("UPDATE live_budget_state SET incarnation = ? WHERE id = 1").bind(
              crypto.randomUUID().replaceAll("-", ""),
            ),
            env.DIRECTORY.prepare("DELETE FROM live_recovery_targets WHERE feed = ?").bind(feed),
          ]);
        const ran = await grant(feed, noon + unrun * 2 * MINUTE);
        await run(ran);
        const at = noon + (unrun + 1) * 2 * MINUTE;
        const metered = meteredD1(at);
        await grant(feed, at, "renewal", metered.db);
        return { read: metered.totals.read, removed: !(await kept(ran))[0] };
      };
      const few = await read("usr_few", LIVE_TURN_RECEIPT_LOOK);
      const many = await read("usr_many", 3 * LIVE_TURN_RECEIPT_LOOK);
      const older = await read("usr_older", 3 * LIVE_TURN_RECEIPT_LOOK, true);
      expect([few.removed, many.removed, older.removed]).toEqual([true, true, true]);
      expect([many.read, older.read]).toEqual([few.read, few.read]);
    }));
});

describe("a feed's turn state", () => {
  it("is owed once its recovery target, however many turns, while other work is owed each time", () =>
    isolated(async () => {
      const noon = testDay(5) * DAY + DAY / 2;
      const before = await doDebt();
      await grant("usr_owed", noon);
      await grant("usr_owed", noon + 2 * MINUTE, "pump");
      await grant("usr_owed", noon + 4 * MINUTE);
      expect(await targetDebt("usr_owed")).toBe(LOCAL_DEBT);
      expect(await doDebt()).toBe(before + LOCAL_DEBT);
      // A ticket's local state grows with tickets: owed every time.
      await grant("usr_owed", noon + 6 * MINUTE, "ticket");
      await grant("usr_owed", noon + 8 * MINUTE, "ticket");
      expect(await targetDebt("usr_owed")).toBe(3 * LOCAL_DEBT);
      expect(await doDebt()).toBe(before + 3 * LOCAL_DEBT);
      // A target first made by other work owes its turn state at the first turn.
      await grant("usr_later", noon, "ticket");
      await grant("usr_later", noon + 2 * MINUTE);
      await grant("usr_later", noon + 4 * MINUTE);
      expect(await targetDebt("usr_later")).toBe(2 * LOCAL_DEBT);
    }));
});
