// Queued live work in a feed's object (dormant: nothing in production queues
// it yet): a socket's renewal queued once (never early), in deadline order
// across sockets, cleared only as queued; a refill or renewal installation
// queued once, its exact request prepared once, dispatched once with its
// owner (never back to queued), and a refill's grant installed only as the
// grant it asked for, under the current fence.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import type { UserDO } from "../src/do/UserDO.js";
import { LIVE_POLICY, Live } from "../src/do/user/live.js";
import { LiveBudget } from "../src/do/user/live-budget.js";
import { type LiveEnvelope, makeLiveGrant, reserveLive } from "../src/live/budget.js";
import type { LiveOwnerRef } from "../src/live/owners.js";
import { clockedD1, DAY, isolated, plan, vector } from "./helpers/live-budget.js";

const feedOf = (feed: string) => env.USER.getByName(feed);

/** A refill grant for `feed`, valid from a minute ago. */
async function refillGrant(feed: string): Promise<LiveEnvelope> {
  const from = Date.now() - 60_000;
  const result = await reserveLive(
    clockedD1(env.DIRECTORY, { now: from }),
    await makeLiveGrant(
      await plan({
        day: Math.floor(from / DAY),
        from,
        validMs: 10 * 60_000,
        recipient: feed,
        kind: "control",
        producesLocal: true,
        resources: vector({ do_requests: 10 }),
      }),
    ),
  );
  if (result.status !== "granted") throw new Error(JSON.stringify(result));
  return result.grant;
}

const owner = (feed: string, operationId: string): LiveOwnerRef => ({
  ownerId: `${operationId}/feed`,
  operationId,
  objectType: "UserDO",
  objectId: feed,
  incarnation: "a".repeat(32),
  epoch: 0,
});

describe("a socket's queued renewal", () => {
  it("is queued once, never early, in deadline order, and cleared only as it was queued", async () => {
    const feed = `usr_${uniqueId("renew")}`;
    const out = await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
      const live = new Live(state.storage.sql);
      const now = Date.now();
      return state.storage.transactionSync(() => {
        for (const [id, at] of [
          ["s_late", now],
          ["s_soon", now - 60_000],
        ] as const) {
          live.addSocket(
            { id, credentialId: "tok_1", expiresAt: now + DAY, scopes: [], repoIds: null },
            [],
            at,
          );
          live.open(id);
        }
        const halfway = now + LIVE_POLICY.renewMs / 2;
        const early = live.queueRenewal("s_late", "n0", now);
        const first = live.queueRenewal("s_late", "n1", halfway);
        const again = live.queueRenewal("s_late", "n2", halfway + 1);
        const soon = live.queueRenewal("s_soon", "n3", halfway);
        const missing = live.queueRenewal("s_none", "n4", halfway);
        const queued = live.queuedRenewals().map((s) => [s.socket_id, s.renewal_nonce]);
        const generation = live.socket("s_late")?.socket_generation ?? -1;
        const wrong = live.finishRenewal("s_late", "n2", generation);
        const stale = live.finishRenewal("s_late", "n1", generation - 1);
        const cleared = live.finishRenewal("s_late", "n1", generation);
        const after = live.socket("s_late");
        return {
          results: [early, first, again, soon, missing],
          queued,
          generation,
          finished: [wrong, stale, cleared],
          after: [after?.renewal_nonce, after?.renewal_intended_at, after?.deadline],
        };
      });
    });
    expect(out.results).toEqual(["early", "queued", "duplicate", "queued", "missing"]);
    // By deadline: the socket opened a minute earlier first.
    expect(out.queued).toEqual([
      ["s_soon", "n3"],
      ["s_late", "n1"],
    ]);
    expect(out.generation).toBe(1);
    expect(out.finished).toEqual([false, false, true]);
    // Cleared, its deadline untouched (renewing it is the authorization's, later).
    expect(out.after.slice(0, 2)).toEqual([null, null]);
  });
});

describe("a queued live installation", () => {
  it("is queued once, its request prepared once, dispatched once with its owner, installed only as asked", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("refill")}`;
      const grant = await refillGrant(feed);
      const other = await refillGrant(feed);
      const request = await makeLiveGrant(grant.plan, grant.operationId.split(".")[3]);
      const out = await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, grant.plan.incarnation);
        const now = grant.plan.validFrom;
        const stamp = {
          epoch: 0,
          incarnation: grant.plan.incarnation,
          seq: grant.seq,
          validUntil: grant.plan.validUntil,
        };
        return state.storage.transactionSync(() => {
          const queued = [
            budget.queueOnce("control_refill", "q1", now, stamp, now),
            budget.queueOnce("control_refill", "q2", now + 1, stamp, now),
            budget.queueOnce("mark_refill", "m1", now, { ...stamp, epoch: 3 }, now),
          ];
          // Not dispatched before its request is prepared.
          const early = budget.dispatchPending("control_refill", "q1", owner(feed, "op"), "i1");
          // Nor by an instance with no name (it would match any other).
          const unnamed = budget.dispatchPending("control_refill", "q1", owner(feed, "op"), "");
          const prepared = [
            budget.preparePending("control_refill", "q1", request),
            budget.preparePending("control_refill", "q1", request),
            budget.preparePending("control_refill", "q1", { ...request, nonce: "0".repeat(32) }),
          ];
          // Prepared, not dispatched: its grant installs nothing yet.
          const undispatched = budget.installPending(
            "control_refill",
            "q1",
            grant,
            now,
            feed,
            "i1",
          );
          // The older path never replaces a prepared item.
          const replaced = budget.begin("control_refill", "other", now, stamp, now);
          const dispatched = [
            budget.dispatchPending("control_refill", "q1", owner(feed, grant.operationId), "i1"),
            budget.dispatchPending("control_refill", "q1", owner(feed, "again"), "i2"),
          ];
          const pending = budget.pending("control_refill");
          // Another grant than the one it asked for: refused; its own: installed, once.
          const installed = [
            budget.installPending("control_refill", "q1", other, now, feed, "i1"),
            // Another instance (a new one after a restart) never adopts it.
            budget.installPending("control_refill", "q1", grant, now, feed, "i2"),
            budget.installPending("control_refill", "q1", grant, now, feed, ""),
            // Not valid yet by this object's clock.
            budget.installPending(
              "control_refill",
              "q1",
              grant,
              grant.plan.validFrom - 1,
              feed,
              "i1",
            ),
            budget.installPending("control_refill", "q1", grant, now, feed, "i1"),
            budget.installPending("control_refill", "q1", grant, now, feed, "i1"),
          ];
          return {
            queued,
            early,
            unnamed,
            undispatched,
            replaced,
            prepared,
            dispatched,
            pending: [pending?.identity, pending?.phase, pending?.ownerId, pending?.instance],
            request: pending?.request?.operationId,
            installed,
            left: budget.pending("control_refill"),
          };
        });
      });
      expect(out.queued).toEqual(["queued", "existing", "refused"]);
      expect(out.early).toBe(false);
      expect(out.unnamed).toBe(false);
      expect(out.undispatched).toBe("refused");
      expect(out.replaced).toBe(false);
      expect(out.prepared).toEqual([true, true, false]);
      expect(out.dispatched).toEqual([true, false]);
      expect(out.pending).toEqual(["q1", "dispatched", `${grant.operationId}/feed`, "i1"]);
      expect(out.request).toBe(grant.operationId);
      expect(out.installed).toEqual([
        "refused",
        "refused",
        "refused",
        "refused",
        "installed",
        "duplicate",
      ]);
      expect(out.left).toBeNull();
    }));

  it("installs nothing once the fence moved while its grant was asked for", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("stale")}`;
      const grant = await refillGrant(feed);
      const request = await makeLiveGrant(grant.plan, grant.operationId.split(".")[3]);
      const out = await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, grant.plan.incarnation);
        const now = grant.plan.validFrom;
        return state.storage.transactionSync(() => {
          budget.queueOnce(
            "control_refill",
            "q1",
            now,
            {
              epoch: 0,
              incarnation: grant.plan.incarnation,
              seq: grant.seq,
              validUntil: grant.plan.validUntil,
            },
            now,
          );
          budget.preparePending("control_refill", "q1", request);
          budget.dispatchPending("control_refill", "q1", owner(feed, grant.operationId), "i1");
          // A restore while the request was out: the epoch moves.
          budget.takeEpoch(1, grant.plan.incarnation);
          return budget.installPending("control_refill", "q1", grant, now, feed, "i1");
        });
      });
      expect(out).toBe("refused");
    }));

  it("installs a refill only from a grant of its kind", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("kind")}`;
      const grant = await refillGrant(feed);
      const request = await makeLiveGrant(grant.plan, grant.operationId.split(".")[3]);
      const out = await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, grant.plan.incarnation);
        const now = grant.plan.validFrom;
        return state.storage.transactionSync(() => {
          // A control grant asked for as a mark refill.
          budget.queueOnce(
            "mark_refill",
            "m1",
            now,
            {
              epoch: 0,
              incarnation: grant.plan.incarnation,
              seq: grant.seq,
              validUntil: grant.plan.validUntil,
            },
            now,
          );
          budget.preparePending("mark_refill", "m1", request);
          budget.dispatchPending("mark_refill", "m1", owner(feed, grant.operationId), "i1");
          return budget.installPending("mark_refill", "m1", grant, now, feed, "i1");
        });
      });
      expect(out).toBe("refused");
    }));

  it("is kept by recovery once dispatched (its owner's work may still run), which stays pending", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("keep")}`;
      const grant = await refillGrant(feed);
      const request = await makeLiveGrant(grant.plan, grant.operationId.split(".")[3]);
      const out = await runInDurableObject(feedOf(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, grant.plan.incarnation);
        const now = grant.plan.validFrom;
        return state.storage.transactionSync(() => {
          budget.queueOnce(
            "control_refill",
            "q1",
            now,
            {
              epoch: 0,
              incarnation: grant.plan.incarnation,
              seq: grant.seq,
              validUntil: grant.plan.validUntil,
            },
            now,
          );
          budget.preparePending("control_refill", "q1", request);
          budget.dispatchPending("control_refill", "q1", owner(feed, grant.operationId), "i1");
          // Its funding expired: recovery would otherwise delete it.
          const page = budget.recoverPage(grant.seq, grant.plan.validUntil + 1, false);
          return { status: page.status, kept: budget.pending("control_refill")?.ownerId };
        });
      });
      expect(out).toEqual({ status: "pending", kept: `${grant.operationId}/feed` });
    }));
});
