// Live budgets in feeds' objects: credit installed once for the identity
// pending under the current fence, spent all or nothing, invalidated at once
// by a restore or a new ledger incarnation; recovery of what grants left,
// funded per attempt, a bounded page a call, retiring a target and its debt
// only on a clean acknowledgement of exactly what was captured; and the
// ledger's bounded cleanup of expired receipts and old days.

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserDO } from "../src/do/UserDO.js";
import { feedHooks } from "../src/do/UserDO.js";
import { LIVE_RECOVERY_ROWS, LiveBudget } from "../src/do/user/live-budget.js";
import {
  expireLiveReceipts,
  LIVE_RECEIPT_PAGE,
  type LiveEnvelope,
  type LiveGrantResult,
  makeLiveGrant,
  pruneLiveBudgetDays,
  reserveLive,
  validateLiveCoverage,
} from "../src/live/budget.js";
import { reserveDuration } from "../src/live/duration.js";
import {
  backoffLiveTarget,
  captureLiveRecoveryTarget,
  dueLiveRecoveryFeeds,
  LIVE_RECOVERY_DURATION,
  type LiveRecoveryReply,
  type LiveRecoveryRequest,
  recoverLiveTargets,
  retireLiveTarget,
} from "../src/live/recovery.js";
import {
  clockedD1,
  DAY,
  dayRow,
  incarnation,
  isolated,
  ledger,
  plan,
  vector,
  ZERO,
} from "./helpers/live-budget.js";

// The ledger's validity is D1's clock, which the objects' clock must agree with here: the
// isolate's held clock (a day ahead) is set back to real time for these tests.
beforeEach(() => {
  vi.setSystemTime(vi.getRealSystemTime());
});

afterEach(() => {});

const feedOf = (feed: string) => env.USER.getByName(feed);

/** A grant of `feed`'s local state, minted a minute ago and valid 30 s: its target due now. */
async function ordinaryGrant(
  feed: string,
  localDebt = vector({ do_rows_written: 4 }),
): Promise<LiveEnvelope> {
  const from = Date.now() - 60_000;
  const db = clockedD1(env.DIRECTORY, { now: from });
  const result = await reserveLive(
    db,
    await makeLiveGrant(
      await plan({
        day: Math.floor(from / DAY),
        from,
        validMs: 30_000,
        recipient: feed,
        kind: "control",
        producesLocal: true,
        localCleanupDebt: localDebt,
      }),
    ),
  );
  if (result.status !== "granted") throw new Error(JSON.stringify(result));
  return result.grant;
}

/** A little before now. */
const recently = () => Date.now() - 5_000;

/** A plan's first day and start, from one instant a little before now. */
const today = () => {
  const from = recently();
  return { day: Math.floor(from / DAY), from };
};

/** `request` granted with D1's clock at its own start (its days and D1's agree, at midnight too). */
const mint = (request: Awaited<ReturnType<typeof makeLiveGrant>>) =>
  reserveLive(clockedD1(env.DIRECTORY, { now: request.plan.validFrom }), request);

/** A recovery attempt's own cleanup grant for `feed`, valid now. */
async function recoveryCoverage(feed: string): Promise<LiveGrantResult> {
  const from = recently();
  const until = from + 10 * 60_000;
  const holds = reserveDuration(
    from,
    until - 1,
    LIVE_RECOVERY_DURATION.pendingMs,
    LIVE_RECOVERY_DURATION.tailMs,
  );
  return mint(
    await makeLiveGrant(
      await plan({
        day: Math.floor(from / DAY),
        from,
        validMs: until - from,
        recipient: feed,
        kind: "recovery",
        class: "cleanup",
        charges: holds.map((h) => ({
          day: h.day,
          resources: vector({ do_requests: 1, do_duration_ms: h.ms }),
          duration: h,
        })),
      }),
    ),
  );
}

const tell = (request: LiveRecoveryRequest) => feedOf(request.feed).recoverLiveV1(request);

/** Seeds `count` balance rows in `feed`'s object stamped with `grant` (valid until `validUntil`). */
async function seedBalances(feed: string, grant: LiveEnvelope, count: number, validUntil: number) {
  await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
    for (let i = 0; i < count; i++)
      state.storage.sql.exec(
        `INSERT INTO live_budget_balances (operation_id, day, kind, remaining, budget_epoch,
           budget_incarnation, budget_seq, budget_valid_until)
         VALUES (?, ?, 'control', ?, ?, ?, ?, ?)`,
        `${grant.operationId}.${i}`,
        i,
        JSON.stringify(ZERO),
        grant.plan.epoch,
        grant.plan.incarnation,
        grant.seq,
        validUntil,
      );
  });
}

const localCount = (feed: string, table: string) =>
  runInDurableObject(
    feedOf(feed),
    (_: UserDO, state) =>
      state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n,
  );

const fenceOf = (feed: string) =>
  runInDurableObject(feedOf(feed), (_: UserDO, state) => new LiveBudget(state.storage.sql).fence());

const targetOf = (feed: string) =>
  env.DIRECTORY.prepare("SELECT * FROM live_recovery_targets WHERE feed = ?")
    .bind(feed)
    .first<Record<string, number | string>>();

describe("live credit in a feed's object", () => {
  it("is installed once: a second installation leaves what was spent spent", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("inst")}`;
      const grant = await mint(
        await makeLiveGrant(
          await plan({
            ...today(),
            recipient: feed,
            kind: "control",
            producesLocal: true,
            resources: vector({ do_requests: 10 }),
          }),
        ),
      );
      if (grant.status !== "granted") throw new Error(JSON.stringify(grant));
      const g = grant.grant;
      const results = await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, g.plan.incarnation);
        // The grant's own clock: its first instant is on the day it funds.
        const now = g.plan.validFrom;
        const stamp = {
          epoch: 0,
          incarnation: g.plan.incarnation,
          seq: g.seq,
          validUntil: g.plan.validUntil,
        };
        return state.storage.transactionSync(() => [
          budget.begin("install", g.operationId, now, stamp, now),
          budget.install("install", g, now),
          budget.spend("control", g.plan.charges[0]?.day ?? 0, vector({ do_requests: 4 }), now),
          budget.install("install", g, now),
          budget.spend("control", g.plan.charges[0]?.day ?? 0, vector({ do_requests: 7 }), now),
          budget.spend("control", g.plan.charges[0]?.day ?? 0, vector({ do_requests: 6 }), now),
          // Tomorrow's day named today: never.
          budget.spend(
            "control",
            (g.plan.charges[0]?.day ?? 0) + 1,
            vector({ do_requests: 0 }),
            now,
          ),
          state.storage.sql
            .exec<{ remaining: string }>("SELECT remaining FROM live_budget_balances")
            .one().remaining,
        ]);
      });
      expect(results.slice(0, 7)).toEqual([
        true,
        "installed",
        true,
        "duplicate",
        false,
        true,
        false,
      ]);
      expect(JSON.parse(results[7] as string).do_requests).toBe(0);
    });
  });

  it("cannot be spent or installed again after a restore that came after spending it", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("respend")}`;
      const g = await ordinaryGrant(feed);
      const out = await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, g.plan.incarnation);
        const now = g.plan.validFrom;
        const day = Math.floor(now / DAY);
        const stamp = {
          epoch: 0,
          incarnation: g.plan.incarnation,
          seq: g.seq,
          validUntil: g.plan.validUntil,
        };
        return state.storage.transactionSync(() => {
          budget.begin("install", g.operationId, now, stamp, now);
          const installed = budget.install("install", g, now);
          const spent = budget.spend("control", day, vector({ do_requests: 1 }), now);
          // The restore: the same day's balance as it was is back, under an older epoch.
          state.storage.sql.exec(
            "UPDATE live_budget_balances SET remaining = ?",
            JSON.stringify(vector({ do_requests: 1 })),
          );
          budget.takeEpoch(1, g.plan.incarnation);
          return [
            installed,
            spent,
            budget.spend("control", day, vector({ do_requests: 1 }), now),
            budget.begin("install", g.operationId, now, stamp, now),
          ];
        });
      });
      expect(out).toEqual(["installed", true, false, false]);
    });
  });

  it("is installed only for the identity still pending: a newer one replaces it", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("pend")}`;
      const grantOne = async () => {
        const r = await mint(
          await makeLiveGrant(
            await plan({
              ...today(),
              recipient: feed,
              kind: "control",
              producesLocal: true,
            }),
          ),
        );
        if (r.status !== "granted") throw new Error(JSON.stringify(r));
        return r.grant;
      };
      const [a, b] = [await grantOne(), await grantOne()];
      const out = await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, a.plan.incarnation);
        const now = a.plan.validFrom;
        const stamp = (g: LiveEnvelope) => ({
          epoch: 0,
          incarnation: g.plan.incarnation,
          seq: g.seq,
          validUntil: g.plan.validUntil,
        });
        return state.storage.transactionSync(() => {
          budget.begin("install", a.operationId, now, stamp(a), now);
          budget.begin("install", b.operationId, now, stamp(b), now);
          return [budget.install("install", a, now), budget.install("install", b, now)];
        });
      });
      expect(out).toEqual(["refused", "installed"]);
    });
  });

  it("is invalidated with the feed's epoch by a restore found during a grant's await", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("restore")}`;
      const grant = await ordinaryGrant(feed);
      // A pending installation under the fence as it was.
      await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, grant.plan.incarnation);
        const stamp = {
          epoch: 0,
          incarnation: grant.plan.incarnation,
          seq: grant.seq,
          validUntil: Date.now() + 60_000,
        };
        state.storage.transactionSync(() =>
          budget.begin("install", grant.operationId, Date.now(), stamp, Date.now()),
        );
      });
      const before = await fenceOf(feed);
      // The restore: the directory's epoch moves; the object starts cold and takes it.
      await env.DIRECTORY.prepare("INSERT INTO source_epochs (source_id, epoch_gen) VALUES (?, 2)")
        .bind(`feed:${feed}`)
        .run();
      await evictDurableObject(feedOf(feed));
      await feedOf(feed).liveTicket("tok_restore");
      const after = await fenceOf(feed);
      expect(after.epoch).toBe(2);
      expect(after.authorizationGen).toBe(before.authorizationGen + 1);
      const feedEpoch = await runInDurableObject(
        feedOf(feed),
        (_: UserDO, state) =>
          state.storage.sql.exec<{ e: number }>("SELECT epoch_gen AS e FROM feed_meta").one().e,
      );
      expect(feedEpoch).toBe(2);
      const installed = await runInDurableObject(feedOf(feed), (_: UserDO, state) =>
        state.storage.transactionSync(() =>
          new LiveBudget(state.storage.sql).install(
            "install",
            { ...grant, plan: { ...grant.plan, validUntil: Date.now() + 60_000 } },
            Date.now(),
          ),
        ),
      );
      expect(installed).toBe("refused");
    });
  });

  it("is invalidated by a new ledger incarnation, and its envelope fenced", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("inc")}`;
      const grant = await ordinaryGrant(feed);
      await feedOf(feed).liveTicket("tok_inc");
      await evictDurableObject(feedOf(feed));
      await feedOf(feed).liveTicket("tok_inc");
      const before = await fenceOf(feed);
      expect(before.incarnation).toBe(grant.plan.incarnation);
      const fresh = "f".repeat(32);
      await env.DIRECTORY.prepare("UPDATE live_budget_state SET incarnation = ? WHERE id = 1")
        .bind(fresh)
        .run();
      await evictDurableObject(feedOf(feed));
      await feedOf(feed).liveTicket("tok_inc");
      const after = await fenceOf(feed);
      expect([after.incarnation, after.authorizationGen]).toEqual([
        fresh,
        before.authorizationGen + 1,
      ]);
      expect(
        await validateLiveCoverage(env.DIRECTORY, grant, {
          recipientType: "UserDO",
          recipient: feed,
          kind: "control",
        }),
      ).toEqual({ status: "refused", reason: "fenced" });
    });
  });

  it("keeps the feed's epoch where it was when the fence cannot move with it", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("txn")}`;
      await feedOf(feed).liveTicket("tok_txn");
      // No alarm of its own runs into the failing fence meanwhile (the clock is real here).
      await runInDurableObject(feedOf(feed), async (_: UserDO, state) => {
        state.storage.sql.exec("DELETE FROM user_schedule");
        await state.storage.deleteAlarm();
        state.storage.sql.exec(
          "CREATE TRIGGER fence_fails BEFORE UPDATE ON live_budget_fence BEGIN SELECT RAISE(ABORT, 'test'); END",
        );
      });
      await env.DIRECTORY.prepare("INSERT INTO source_epochs (source_id, epoch_gen) VALUES (?, 5)")
        .bind(`feed:${feed}`)
        .run();
      await evictDurableObject(feedOf(feed));
      const failed = await feedOf(feed)
        .liveTicket("tok_txn")
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(String(failed)).toMatch(/SQLITE_CONSTRAINT/);
      const epoch = await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        const e = state.storage.sql
          .exec<{ e: number }>("SELECT epoch_gen AS e FROM feed_meta")
          .one().e;
        state.storage.sql.exec("DROP TRIGGER fence_fails");
        return e;
      });
      expect(epoch).not.toBe(5);
    });
  });
});

describe("live recovery", () => {
  it("cleans a quiet feed through its target, retiring the target and its exact debt once", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("quiet")}`;
      const before = await ledger();
      const grant = await ordinaryGrant(feed, vector({ do_rows_written: 4 }));
      await seedBalances(feed, grant, 3, grant.plan.validUntil);
      expect((await ledger())?.debt_do_rows_written).toBe(
        (before?.debt_do_rows_written as number) + 4,
      );
      const run = await recoverLiveTargets(env.DIRECTORY, {
        limit: 10,
        reserveTarget: recoveryCoverage,
        tell,
      });
      expect(run).toEqual({ attempted: 1, retired: 1, pending: 0, failed: 0 });
      expect(await localCount(feed, "live_budget_balances")).toBe(0);
      expect((await fenceOf(feed)).cleanupThrough).toBe(grant.seq);
      expect(await targetOf(feed)).toBeNull();
      expect((await ledger())?.debt_do_rows_written).toBe(before?.debt_do_rows_written);
      // Recovery made nothing for itself: no balance, pending, completion or live alarm.
      for (const table of [
        "live_budget_balances",
        "live_budget_pending",
        "live_budget_completions",
      ])
        expect(await localCount(feed, table)).toBe(0);
      expect(
        await runInDurableObject(
          feedOf(feed),
          (_: UserDO, state) =>
            state.storage.sql.exec("SELECT 1 FROM user_schedule WHERE kind = 'live'").toArray()
              .length,
        ),
      ).toBe(0);
      // A delayed installation of what was cleaned is refused.
      const late = await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        const stamp = {
          epoch: 0,
          incarnation: grant.plan.incarnation,
          seq: grant.seq,
          validUntil: Date.now() + 60_000,
        };
        return budget.begin("install", grant.operationId, Date.now(), stamp, Date.now());
      });
      expect(late).toBe(false);
    });
  });

  it("leaves its own receipts to expire with their debt, and the alarm to non-live work exactly", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("drain")}`;
      const before = await ledger();
      await ordinaryGrant(feed);
      // A live alarm due soon and later core work: recovery keeps only the later.
      const soon = Date.now() + 60_000;
      const later = Date.now() + 60 * 60_000;
      await runInDurableObject(feedOf(feed), async (_: UserDO, state) => {
        state.storage.sql.exec(
          "INSERT INTO user_schedule (kind, due_at) VALUES ('live', ?), ('retain', ?)",
          soon,
          later,
        );
        await state.storage.setAlarm(soon);
      });
      expect(
        (
          await recoverLiveTargets(env.DIRECTORY, {
            limit: 10,
            reserveTarget: recoveryCoverage,
            tell,
          })
        ).retired,
      ).toBe(1);
      expect(
        await runInDurableObject(feedOf(feed), (_: UserDO, state) => state.storage.getAlarm()),
      ).toBe(later);
      // Its recovery receipts: removed once expired, their debt with them; nothing recreated.
      const clock = { now: Date.now() + 3 * DAY };
      while ((await expireLiveReceipts(clockedD1(env.DIRECTORY, clock))).expired > 0);
      const after = await ledger();
      for (const r of ["debt_do_requests", "debt_do_rows_written", "debt_d1_rows_written"])
        expect(after?.[r]).toBe(before?.[r]);
      expect(await targetOf(feed)).toBeNull();
      for (const table of [
        "live_budget_balances",
        "live_budget_pending",
        "live_budget_completions",
      ])
        expect(await localCount(feed, table)).toBe(0);
    });
  });

  it("refuses a malformed request whole, and its coordinator retires nothing on a malformed reply", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("malformed")}`;
      await ordinaryGrant(feed);
      const coverage = await recoveryCoverage(feed);
      if (coverage.status !== "granted") throw new Error(JSON.stringify(coverage));
      const captured = await captureLiveRecoveryTarget(env.DIRECTORY, feed);
      const request: LiveRecoveryRequest = {
        protocol: 1,
        nonce: "e".repeat(32),
        feed,
        incarnation: captured?.incarnation as string,
        throughSeq: captured?.throughSeq as number,
        coverage: coverage.grant,
      };
      const broken = {
        ...request,
        coverage: { ...coverage.grant, plan: { ...coverage.grant.plan, charges: [null] } },
      };
      expect(await tell(broken as unknown as LiveRecoveryRequest)).toMatchObject({
        status: "refused",
        reason: "invalid",
      });
      const hollow = async (r: LiveRecoveryRequest): Promise<LiveRecoveryReply> => {
        const reply = (await tell(r)) as unknown as Record<string, unknown>;
        const completion = reply.completion as { operationId: string };
        return {
          ...reply,
          completion: { operationId: completion.operationId, actual: [] },
        } as unknown as LiveRecoveryReply;
      };
      const out = await recoverLiveTargets(env.DIRECTORY, {
        limit: 10,
        reserveTarget: recoveryCoverage,
        tell: hollow,
      });
      expect(out).toMatchObject({ retired: 0, failed: 1 });
      expect(await targetOf(feed)).not.toBeNull();
    });
  });

  it("fences covered credit before deleting it, still valid or not, and is clean once it is gone", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("valid")}`;
      const grant = await ordinaryGrant(feed);
      await seedBalances(feed, grant, 1, Date.now() + 60 * 60_000);
      const before = await fenceOf(feed);
      expect(
        await recoverLiveTargets(env.DIRECTORY, {
          limit: 10,
          reserveTarget: recoveryCoverage,
          tell,
        }),
      ).toEqual({ attempted: 1, retired: 1, pending: 0, failed: 0 });
      expect(await localCount(feed, "live_budget_balances")).toBe(0);
      const after = await fenceOf(feed);
      expect(after.cleanupThrough).toBe(grant.seq);
      expect(after.authorizationGen).toBeGreaterThan(before.authorizationGen);
    });
  });

  it("quarantines a dispatched installation's owner before forgetting it, its place kept", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("orphan")}`;
      const grant = await ordinaryGrant(feed);
      // Work dispatched by an instance gone since: its owner in the directory, its row here.
      const ownerId = `${grant.operationId}/feed`;
      await env.DIRECTORY.prepare(
        `INSERT INTO live_duration_owners (owner_id, operation_id, object_type, object_id, class,
           epoch, incarnation, dispatch_from, dispatch_until, holds, status, instance, started_at,
           admitted_at)
         VALUES (?1, ?2, 'UserDO', ?3, 'ordinary', 0, ?4, 0, 1, '[]', 'dispatched', 'gone', 0, 0)`,
      )
        .bind(ownerId, grant.operationId, feed, grant.plan.incarnation)
        .run();
      await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        state.storage.sql.exec(
          `INSERT INTO live_budget_pending (kind, operation_id, intended_at, authorization_gen,
             budget_epoch, budget_incarnation, budget_seq, budget_valid_until, phase, request_json,
             owner_id, dispatch_instance)
           VALUES ('control_refill', 'q1', 0, 0, 0, ?, ?, ?, 'dispatched', '{}', ?, 'gone')`,
          grant.plan.incarnation,
          grant.seq,
          grant.plan.validUntil,
          ownerId,
        );
      });
      expect(
        await recoverLiveTargets(env.DIRECTORY, {
          limit: 10,
          reserveTarget: recoveryCoverage,
          tell,
        }),
      ).toEqual({ attempted: 1, retired: 1, pending: 0, failed: 0 });
      expect(await localCount(feed, "live_budget_pending")).toBe(0);
      // Its place is still held: uncertain, never released by recovery.
      expect(
        await env.DIRECTORY.prepare("SELECT status FROM live_duration_owners WHERE owner_id = ?")
          .bind(ownerId)
          .first(),
      ).toEqual({ status: "uncertain" });
      await env.DIRECTORY.prepare("DELETE FROM live_duration_owners WHERE owner_id = ?")
        .bind(ownerId)
        .run();
    });
  });

  it("keeps a dispatched installation whose owner the directory does not hold, and stays pending", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("unheld")}`;
      const grant = await ordinaryGrant(feed);
      await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        state.storage.sql.exec(
          `INSERT INTO live_budget_pending (kind, operation_id, intended_at, authorization_gen,
             budget_epoch, budget_incarnation, budget_seq, budget_valid_until, phase, request_json,
             owner_id, dispatch_instance)
           VALUES ('control_refill', 'q1', 0, 0, 0, ?, ?, ?, 'dispatched', '{}', ?, 'gone')`,
          grant.plan.incarnation,
          grant.seq,
          grant.plan.validUntil,
          `${grant.operationId}/missing`,
        );
      });
      expect(
        await recoverLiveTargets(env.DIRECTORY, {
          limit: 10,
          reserveTarget: recoveryCoverage,
          tell,
        }),
      ).toEqual({ attempted: 1, retired: 0, pending: 1, failed: 0 });
      expect(await localCount(feed, "live_budget_pending")).toBe(1);
    });
  });

  it("touches nothing under a fence other than the one it was validated under", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("moved")}`;
      const grant = await ordinaryGrant(feed);
      await seedBalances(feed, grant, 1, grant.plan.validUntil);
      const page = await runInDurableObject(feedOf(feed), (_: UserDO, state) =>
        state.storage.transactionSync(() => {
          const budget = new LiveBudget(state.storage.sql);
          budget.takeEpoch(0, grant.plan.incarnation);
          // Validated under another incarnation (a newer one established while it awaited).
          return budget.recoverPage(grant.seq, new Set(), {
            epoch: 0,
            incarnation: "f".repeat(32),
          });
        }),
      );
      expect(page.status).toBe("fenced");
      expect(await localCount(feed, "live_budget_balances")).toBe(1);
      expect((await fenceOf(feed)).cleanupThrough).toBe(0);
    });
  });

  it("takes a clean acknowledgement with no completion (its holds overrun), refunding nothing", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("overrun")}`;
      await ordinaryGrant(feed);
      expect(
        await recoverLiveTargets(env.DIRECTORY, {
          limit: 10,
          reserveTarget: recoveryCoverage,
          tell: async (request) => ({
            protocol: 1,
            nonce: request.nonce,
            feed: request.feed,
            incarnation: request.incarnation,
            throughSeq: request.throughSeq,
            status: "clean",
            completion: null,
          }),
        }),
      ).toEqual({ attempted: 1, retired: 1, pending: 0, failed: 0 });
      // A malformed completion still retires nothing.
      await ordinaryGrant(feed);
      expect(
        await recoverLiveTargets(env.DIRECTORY, {
          limit: 10,
          reserveTarget: recoveryCoverage,
          tell: async (request) => ({
            protocol: 1,
            nonce: request.nonce,
            feed: request.feed,
            incarnation: request.incarnation,
            throughSeq: request.throughSeq,
            status: "clean",
            completion: { protocol: 1 } as never,
          }),
        }),
      ).toMatchObject({ retired: 0, failed: 1 });
    });
  });

  it("inspects at most a page of rows a call, and finishes in later calls", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("page")}`;
      const grant = await ordinaryGrant(feed);
      await seedBalances(feed, grant, LIVE_RECOVERY_ROWS + 10, grant.plan.validUntil);
      const coverage = await recoveryCoverage(feed);
      if (coverage.status !== "granted") throw new Error(JSON.stringify(coverage));
      const page = await runInDurableObject(feedOf(feed), (_: UserDO, state) =>
        state.storage.transactionSync(() => {
          const budget = new LiveBudget(state.storage.sql);
          budget.takeEpoch(0, grant.plan.incarnation);
          return budget.recoverPage(grant.seq);
        }),
      );
      expect(page.status).toBe("pending");
      expect(page.inspected).toBeLessThanOrEqual(LIVE_RECOVERY_ROWS);
      // Fenced before anything was deleted: nothing granted through it applies, though rows remain.
      expect((await fenceOf(feed)).cleanupThrough).toBe(grant.seq);
      expect(await localCount(feed, "live_budget_balances")).toBe(10);
      const second = await runInDurableObject(feedOf(feed), (_: UserDO, state) =>
        state.storage.transactionSync(() =>
          new LiveBudget(state.storage.sql).recoverPage(grant.seq),
        ),
      );
      expect(second.status).toBe("clean");
      expect(await localCount(feed, "live_budget_balances")).toBe(0);
    });
  });

  it("inspects at most a page across tables of every kind", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("mixed")}`;
      const grant = await ordinaryGrant(feed);
      await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        const stamp = [grant.plan.epoch, grant.plan.incarnation, grant.seq, grant.plan.validUntil];
        for (let i = 0; i < 30; i++) {
          state.storage.sql.exec(
            `INSERT INTO live_tickets (ticket_hash, credential_id, expires_at, budget_epoch,
               budget_incarnation, budget_seq, budget_valid_until) VALUES (?, 'tok', 0, ?, ?, ?, ?)`,
            `t${i}`,
            ...stamp,
          );
          state.storage.sql.exec(
            `INSERT INTO live_revoked (dependency, at, budget_epoch, budget_incarnation, budget_seq,
               budget_valid_until) VALUES (?, 0, ?, ?, ?, ?)`,
            `credential:c${i}`,
            ...stamp,
          );
        }
      });
      await seedBalances(feed, grant, 30, grant.plan.validUntil);
      const pages = [];
      // 90 rows: a full page, then the rest.
      for (let i = 0; i < 2; i++)
        pages.push(
          await runInDurableObject(feedOf(feed), (_: UserDO, state) =>
            state.storage.transactionSync(() => {
              const budget = new LiveBudget(state.storage.sql);
              budget.takeEpoch(0, grant.plan.incarnation);
              return budget.recoverPage(grant.seq);
            }),
          ),
        );
      expect(pages.every((p) => p.inspected <= LIVE_RECOVERY_ROWS)).toBe(true);
      expect(pages.map((p) => p.status)).toEqual(["pending", "clean"]);
      for (const table of ["live_tickets", "live_revoked", "live_budget_balances"])
        expect(await localCount(feed, table)).toBe(0);
    });
  });

  it("drains more expired sockets than a page holds, deleting some every call", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("sockets")}`;
      const grant = await ordinaryGrant(feed);
      await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        for (let i = 0; i < LIVE_RECOVERY_ROWS + 6; i++)
          state.storage.sql.exec(
            `INSERT INTO live_local (socket_id, credential_id, phase, expires_at, deadline, sent, acked,
               refresh_pending, blocked_since, renew_failures, controls_used, minute_start,
               minute_count, delivered_seq, retry_at, scopes, repo_ids, budget_epoch,
               budget_incarnation, budget_seq, budget_valid_until)
             VALUES (?, 'tok', 'open', 0, 0, 0, 0, 0, NULL, 0, 0, 0, 0, 0, 0, '[]', NULL, 0, ?, ?, ?)`,
            `lsk_${String(i).padStart(3, "0")}`,
            grant.plan.incarnation,
            grant.seq,
            grant.plan.validUntil,
          );
      });
      const pages = [];
      for (let i = 0; i < 4 && pages.at(-1)?.status !== "clean"; i++)
        pages.push(
          await runInDurableObject(feedOf(feed), (_: UserDO, state) =>
            state.storage.transactionSync(() => {
              const budget = new LiveBudget(state.storage.sql);
              budget.takeEpoch(0, grant.plan.incarnation);
              return budget.recoverPage(grant.seq);
            }),
          ),
        );
      expect(
        pages.every(
          (p) => p.inspected <= LIVE_RECOVERY_ROWS && (p.status === "clean" || p.deleted > 0),
        ),
      ).toBe(true);
      expect(pages.at(-1)?.status).toBe("clean");
      expect(await localCount(feed, "live_local")).toBe(0);
    });
  });

  it("does not retire a target a newer grant moved, nor twice, nor for a wrong acknowledgement", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("newer")}`;
      const first = await ordinaryGrant(feed, vector({ do_rows_written: 2 }));
      const captured = await captureLiveRecoveryTarget(env.DIRECTORY, feed);
      expect(captured?.throughSeq).toBe(first.seq);
      const coverage = await recoveryCoverage(feed);
      if (coverage.status !== "granted") throw new Error(JSON.stringify(coverage));
      const request: LiveRecoveryRequest = {
        protocol: 1,
        nonce: "c".repeat(32),
        feed,
        incarnation: captured?.incarnation as string,
        throughSeq: first.seq,
        coverage: coverage.grant,
      };
      const reply = await tell(request);
      expect(reply.status).toBe("clean");
      // A newer grant before the acknowledgement is retired: the target moved on.
      const second = await ordinaryGrant(feed, vector({ do_rows_written: 3 }));
      const debt = (await ledger())?.debt_do_rows_written;
      expect(
        await retireLiveTarget(
          env.DIRECTORY,
          reply as Extract<LiveRecoveryReply, { status: "clean" }>,
        ),
      ).toBe(false);
      expect((await targetOf(feed))?.through_seq).toBe(second.seq);
      expect((await ledger())?.debt_do_rows_written).toBe(debt);
      // Wrong acknowledgements, through the coordinator, back off and retire nothing.
      const wrong =
        (change: Record<string, unknown>) =>
        async (r: LiveRecoveryRequest): Promise<LiveRecoveryReply> =>
          ({ ...((await tell(r)) as object), ...change }) as LiveRecoveryReply;
      const changes: Record<string, unknown>[] = [
        { nonce: "0".repeat(32) },
        { feed: "usr_other" },
        { throughSeq: 1 },
        { protocol: 2 },
      ];
      for (const change of changes) {
        await env.DIRECTORY.prepare(
          "UPDATE live_recovery_targets SET next_attempt_at = 0 WHERE feed = ?",
        )
          .bind(feed)
          .run();
        const out = await recoverLiveTargets(env.DIRECTORY, {
          limit: 10,
          reserveTarget: recoveryCoverage,
          tell: wrong(change),
        });
        expect(out.retired).toBe(0);
      }
      expect(await targetOf(feed)).not.toBeNull();
      expect((await ledger())?.debt_do_rows_written).toBe(debt);
    });
  });

  it("retires a target exactly once after a lost acknowledgement, the next attempt acknowledging it again", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("lost")}`;
      const before = (await ledger())?.debt_do_rows_written as number;
      await ordinaryGrant(feed, vector({ do_rows_written: 5 }));
      const lost = await recoverLiveTargets(env.DIRECTORY, {
        limit: 10,
        reserveTarget: recoveryCoverage,
        tell: async (r) => {
          await tell(r);
          throw new Error("Network connection lost.");
        },
      });
      expect(lost).toEqual({ attempted: 1, retired: 0, pending: 0, failed: 1 });
      expect(await targetOf(feed)).not.toBeNull();
      expect((await ledger())?.debt_do_rows_written).toBe(before + 5);
      await env.DIRECTORY.prepare(
        "UPDATE live_recovery_targets SET next_attempt_at = 0 WHERE feed = ?",
      )
        .bind(feed)
        .run();
      const again = await recoverLiveTargets(env.DIRECTORY, {
        limit: 10,
        reserveTarget: recoveryCoverage,
        tell,
      });
      expect(again.retired).toBe(1);
      expect((await ledger())?.debt_do_rows_written).toBe(before);
      // The same clean acknowledgement once more: nothing more subtracted.
      const captured = { feed, incarnation: await incarnation(), throughSeq: 0 };
      expect(
        await retireLiveTarget(env.DIRECTORY, {
          protocol: 1,
          nonce: "d".repeat(32),
          ...captured,
          throughSeq: (await ledger())?.grant_seq as number,
          status: "clean",
          completion: {} as never,
        }),
      ).toBe(false);
      expect((await ledger())?.debt_do_rows_written).toBe(before);
    });
  });

  it("deletes an expired socket without its close callback releasing the lease", async () => {
    await isolated(async () => {
      const feed = `usr_${uniqueId("sock")}`;
      const grant = await ordinaryGrant(feed);
      await env.DIRECTORY.prepare(
        `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state, pending_until, expires_at)
         VALUES ('lsk_recover', 'ticket_recover', ?, 'tok_x', 'open', 0, ?)`,
      )
        .bind(feed, Date.now() + 60_000)
        .run();
      await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        state.storage.sql.exec(
          `INSERT INTO live_local (socket_id, credential_id, phase, expires_at, deadline, sent, acked,
             refresh_pending, blocked_since, renew_failures, controls_used, minute_start, minute_count,
             delivered_seq, retry_at, scopes, repo_ids, budget_epoch, budget_incarnation, budget_seq,
             budget_valid_until)
           VALUES ('lsk_recover', 'tok_x', 'open', ?1, ?1, 0, 0, 0, NULL, 0, 0, 0, 0, 0, 0, '[]', NULL,
             0, ?2, ?3, ?4)`,
          Date.now() + 60_000,
          grant.plan.incarnation,
          grant.seq,
          grant.plan.validUntil,
        );
      });
      const run = await recoverLiveTargets(env.DIRECTORY, {
        limit: 10,
        reserveTarget: recoveryCoverage,
        tell,
      });
      expect(run.retired).toBe(1);
      expect(await localCount(feed, "live_local")).toBe(0);
      // The directory's lease stays for the funded reaper.
      expect(
        await env.DIRECTORY.prepare(
          "SELECT count(*) AS n FROM live_sockets WHERE socket_id = 'lsk_recover'",
        ).first(),
      ).toEqual({ n: 1 });
      await env.DIRECTORY.prepare("DELETE FROM live_sockets WHERE socket_id = 'lsk_recover'").run();
    });
  });
});

describe("live recovery's maintenance", () => {
  const seedTarget = (feed: string, inc: string, nextAttemptAt: number, attempts = 0) =>
    env.DIRECTORY.prepare(
      `INSERT INTO live_recovery_targets (feed, incarnation, through_seq, next_attempt_at, attempts, local_cleanup_debt)
       VALUES (?, ?, 1, ?, ?, ?)`,
    )
      .bind(feed, inc, nextAttemptAt, attempts, JSON.stringify(ZERO))
      .run();

  it("selects due targets in due order, then feed, leaving future ones", async () => {
    await isolated(async () => {
      const inc = await incarnation();
      const now = Date.now();
      await seedTarget("usr_b", inc, now - 10_000);
      await seedTarget("usr_a", inc, now - 10_000);
      await seedTarget("usr_c", inc, now - 20_000);
      await seedTarget("usr_d", inc, now + 60 * 60_000);
      expect(await dueLiveRecoveryFeeds(env.DIRECTORY, 10)).toEqual(["usr_c", "usr_a", "usr_b"]);
      await expect(dueLiveRecoveryFeeds(env.DIRECTORY, 201)).rejects.toThrow(RangeError);
    });
  });

  it("backs off 1, 2, 4, 8, 16, 32, then 60 minutes, once per captured attempt", async () => {
    await isolated(async () => {
      const inc = await incarnation();
      const clock = { now: Date.now() };
      const db = clockedD1(env.DIRECTORY, clock);
      await seedTarget("usr_backoff", inc, 0);
      const delays: number[] = [];
      for (let i = 0; i < 8; i++) {
        clock.now += 1_000;
        const captured = await captureLiveRecoveryTarget(env.DIRECTORY, "usr_backoff");
        if (!captured) throw new Error("no target");
        expect(await backoffLiveTarget(db, captured)).toBe(true);
        // The same captured attempt again: nothing.
        expect(await backoffLiveTarget(db, captured)).toBe(false);
        const next = await captureLiveRecoveryTarget(env.DIRECTORY, "usr_backoff");
        delays.push(((next?.nextAttemptAt as number) - clock.now) / 60_000);
      }
      expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    });
  });

  it("puts a target untouched by a full run ahead of those it backed off", async () => {
    await isolated(async () => {
      const inc = await incarnation();
      const now = Date.now() - 60_000;
      for (let i = 0; i < 201; i++)
        await seedTarget(`usr_fair_${String(i).padStart(3, "0")}`, inc, now);
      const run = await recoverLiveTargets(env.DIRECTORY, {
        limit: 200,
        // Coverage without a duration hold (a day holds 64): the attempts fail before dispatch.
        reserveTarget: async (feed) =>
          mint(
            await makeLiveGrant(
              await plan({
                ...today(),
                recipient: feed,
                kind: "recovery",
                class: "cleanup",
              }),
            ),
          ),
        tell: async () => {
          throw new Error("unreachable");
        },
      });
      expect(run.failed).toBe(200);
      expect((await dueLiveRecoveryFeeds(env.DIRECTORY, 10))[0]).toBe("usr_fair_200");
    });
  });

  it("expires receipts a page at a time, their holds dropped (duration kept charged), their debt retired once", async () => {
    await isolated(async () => {
      const day = 50_000;
      const clock = { now: day * DAY + DAY / 2 };
      const db = clockedD1(env.DIRECTORY, clock);
      const before = (await ledger())?.debt_d1_rows_written as number;
      for (let i = 0; i < LIVE_RECEIPT_PAGE + 1; i++) {
        const r = await reserveLive(
          db,
          await makeLiveGrant(
            await plan({
              day,
              class: "cleanup",
              kind: "maintenance",
              directoryCleanupDebt: vector({ d1_rows_written: 2 }),
              charges: [
                {
                  day,
                  resources: vector({ do_duration_ms: 100 }),
                  duration: {
                    day,
                    from: day * DAY + DAY / 2,
                    until: day * DAY + DAY / 2 + 60_000,
                    ms: 100,
                  },
                },
              ],
            }),
          ),
        );
        expect(r.status).toBe("granted");
      }
      expect((await ledger())?.debt_d1_rows_written).toBe(before + 2 * (LIVE_RECEIPT_PAGE + 1));
      // Past every receipt's expiry: one page, then the rest.
      clock.now = (day + 3) * DAY;
      expect(await expireLiveReceipts(db)).toEqual({ expired: LIVE_RECEIPT_PAGE });
      expect(await expireLiveReceipts(db)).toEqual({ expired: 1 });
      expect(await expireLiveReceipts(db)).toEqual({ expired: 0 });
      const row = await dayRow(day);
      expect(JSON.parse(String(row?.escrow))).toEqual([]);
      expect(row?.do_duration_ms).toBe(100 * (LIVE_RECEIPT_PAGE + 1));
      expect((await ledger())?.debt_d1_rows_written).toBe(before);
    });
  });

  it("refuses a replay of an identity whose receipt is gone", async () => {
    await isolated(async () => {
      const day = 50_100;
      const clock = { now: day * DAY + DAY / 2 };
      const db = clockedD1(env.DIRECTORY, clock);
      const request = await makeLiveGrant(await plan({ day }));
      expect((await reserveLive(db, request)).status).toBe("granted");
      clock.now = (day + 3) * DAY;
      expect((await expireLiveReceipts(db)).expired).toBe(1);
      const seq = (await ledger())?.grant_seq;
      expect(await reserveLive(db, request)).toEqual({ status: "refused", reason: "expired" });
      expect((await ledger())?.grant_seq).toBe(seq);
    });
  });

  it("removes only day rows older than a week that no receipt may need, their debt once", async () => {
    await isolated(async () => {
      const day = 50_200;
      const clock = { now: (day + 8) * DAY };
      const db = clockedD1(env.DIRECTORY, clock);
      const debt = JSON.stringify({ ...ZERO, d1_rows_written: 3 });
      const insert = (d: number, retainUntil: number) =>
        env.DIRECTORY.prepare(
          "INSERT INTO live_budget_days (day, retain_until, cleanup_debt) VALUES (?, ?, ?)",
        )
          .bind(d, retainUntil, debt)
          .run();
      await insert(day - 1, (day + 1) * DAY);
      await insert(day, (day + 5) * DAY);
      await insert(day + 2, (day + 3) * DAY);
      await env.DIRECTORY.prepare(
        "UPDATE live_budget_state SET debt_d1_rows_written = debt_d1_rows_written + 9 WHERE id = 1",
      ).run();
      const before = (await ledger())?.debt_d1_rows_written as number;
      // `day + 2` is not older than a week; `day` may still be needed until day + 5 (past at day + 8).
      expect(await pruneLiveBudgetDays(db)).toEqual({ removed: 2 });
      expect(await pruneLiveBudgetDays(db)).toEqual({ removed: 0 });
      expect(await dayRow(day + 2)).not.toBeNull();
      expect((await ledger())?.debt_d1_rows_written).toBe(before - 6);
    });
  });
});
