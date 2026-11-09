// Funded live entries' storage: a ticket's transport in the directory
// (claimed once, a claim's retry finding it again, expired transports
// removed in order), and a feed's one execution turn (prepared only by a
// current grant valid now, claimed once while valid, dispatched with its
// owner, ended only by itself, its successor prepared in the same step
// only while it is still valid; its dispatched owner reported for
// quarantine like a dispatched installation's).

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import type { UserDO } from "../src/do/UserDO.js";
import { LiveBudget } from "../src/do/user/live-budget.js";
import { type LiveEnvelope, makeLiveGrant, reserveLive } from "../src/live/budget.js";
import { planFor } from "../src/live/funding.js";
import { LIVE_PRICES, type LiveManifestEntry } from "../src/live/manifest.js";
import { claimTransport, expireTransports, recordTransport } from "../src/live/transports.js";
import { clockedD1, incarnation, isolated } from "./helpers/live-budget.js";

describe("a ticket's transport", () => {
  it("is claimed once, by its credential, while unexpired; expired ones go oldest first", async () => {
    const hash = (n: number) => `${uniqueId("th")}-${n}`;
    const now = Date.now();
    const db = env.DIRECTORY;
    const t = {
      ticketHash: hash(1),
      feed: "usr_t",
      credentialId: "tok_t",
      expiresAt: now + 30_000,
      operationId: "op_t",
      envelope: null,
    };
    expect(await recordTransport(db, t)).toBe(true);
    expect(await recordTransport(db, t)).toBe(false);
    expect(await claimTransport(db, t.ticketHash, "tok_other", "c1", now)).toBeNull();
    expect(await claimTransport(db, t.ticketHash, t.credentialId, "c1", now)).toEqual(t);
    // Its retry finds it again; another claim finds nothing.
    expect(await claimTransport(db, t.ticketHash, t.credentialId, "c1", now)).toEqual(t);
    expect(await claimTransport(db, t.ticketHash, t.credentialId, "c2", now)).toBeNull();
    // Expired: unclaimable, then removed, the oldest first, a page at a time.
    const old = [hash(2), hash(3), hash(4)];
    for (const [i, ticketHash] of old.entries())
      await recordTransport(db, { ...t, ticketHash, expiresAt: now - 3_000 + i });
    expect(await claimTransport(db, old[0] as string, t.credentialId, "c3", now)).toBeNull();
    expect(await expireTransports(db, now, 2)).toBe(2);
    const left = await db
      .prepare("SELECT ticket_hash FROM live_ticket_transports WHERE ticket_hash IN (?, ?, ?)")
      .bind(...old)
      .all<{ ticket_hash: string }>();
    expect(left.results.map((r) => r.ticket_hash)).toEqual([old[2]]);
    await expireTransports(db, now);
  });
});

/** A turn's grant for `feed` at today's price, valid for a minute from a little before now. */
async function grantFor(feed: string, validMs = 60_000): Promise<LiveEnvelope> {
  const from = Date.now() - 5_000;
  const priced = planFor(
    LIVE_PRICES.pump as LiveManifestEntry,
    {
      incarnation: await incarnation(),
      epoch: 0,
      recipientType: "UserDO",
      recipient: feed,
      class: "ordinary",
      kind: "pump",
      producesLocal: true,
    },
    from,
  );
  // Shorter than its unit allows (its holds still cover any run started while it is valid).
  const request = await makeLiveGrant({ ...priced, validUntil: from + validMs });
  const granted = await reserveLive(clockedD1(env.DIRECTORY, { now: from }), request);
  if (granted.status !== "granted") throw new Error(granted.reason);
  return granted.grant;
}

describe("a feed's execution turn", () => {
  it("is prepared by a current grant, claimed once, dispatched, and ended by itself with its successor", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("turn")}`;
      const [first, second, third] = [
        await grantFor(feed),
        await grantFor(feed),
        await grantFor(feed),
      ];
      const out = await runInDurableObject(env.USER.getByName(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, first.plan.incarnation);
        const now = Date.now();
        return state.storage.transactionSync(() => [
          budget.prepareTurn(first, now + 1_000, now),
          // One at a time.
          budget.prepareTurn(second, now, now),
          budget.claimTurn(now)?.operationId,
          budget.claimTurn(now),
          // Only a claimed turn, by its own identity, is dispatched or ended.
          budget.dispatchTurn(second.operationId, "own_x", "i1"),
          budget.dispatchTurn(first.operationId, "own_1", "i1"),
          budget.dispatchedOwners(),
          budget.finishTurn(second.operationId, now),
          // Dispatched: its owner's reference stays until the owner was accounted.
          budget.finishTurn(first.operationId, now, {
            successor: { envelope: second, intendedAt: now + 2_000 },
          }),
          budget.dispatchedOwners(),
          budget.finishTurn(first.operationId, now, {
            ownerAccounted: true,
            successor: { envelope: second, intendedAt: now + 2_000 },
          }),
          budget.turn()?.operationId,
          budget.turn()?.phase,
          // The successor ends without naming another: none prepared.
          budget.claimTurn(now)?.operationId,
          budget.finishTurn(second.operationId, now),
          budget.turn(),
          budget.prepareTurn(third, now, now),
        ]);
      });
      expect(out).toEqual([
        true,
        false,
        first.operationId,
        null,
        false,
        true,
        ["own_1"],
        "kept",
        "kept",
        ["own_1"],
        "succeeded",
        second.operationId,
        "prepared",
        second.operationId,
        "ended",
        null,
        true,
      ]);
    }));

  it("pays for nothing once expired or fenced: not prepared, not claimed, no successor", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("expired")}`;
      const short = await grantFor(feed, 10_000);
      const next = await grantFor(feed);
      const out = await runInDurableObject(env.USER.getByName(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, short.plan.incarnation);
        const valid = Date.now();
        const after = short.plan.validUntil;
        return state.storage.transactionSync(() => {
          const results: unknown[] = [budget.prepareTurn(short, valid, after)];
          results.push(budget.prepareTurn(short, valid, valid));
          // Its claim once it expired: nothing.
          results.push(budget.claimTurn(after));
          results.push(budget.claimTurn(valid)?.operationId);
          // Ended after it expired: its successor is not prepared, and it says so.
          results.push(
            budget.finishTurn(short.operationId, after, {
              successor: { envelope: next, intendedAt: after },
            }),
          );
          results.push(budget.turn());
          // A restore since (a newer epoch): a grant of the old one prepares nothing.
          budget.takeEpoch(1, short.plan.incarnation);
          results.push(budget.prepareTurn(next, valid, valid));
          return results;
        });
      });
      expect(out).toEqual([false, true, null, short.operationId, "ended", null, false]);
    }));

  it("names no successor once fenced since it was claimed", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("fenced")}`;
      const [old, next] = [await grantFor(feed), await grantFor(feed)];
      const out = await runInDurableObject(env.USER.getByName(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, old.plan.incarnation);
        const now = Date.now();
        budget.prepareTurn(old, now, now);
        budget.claimTurn(now);
        // A recovery's watermark past it since: it ends, paying for no successor.
        state.storage.sql.exec("UPDATE live_budget_fence SET cleanup_through = ?", old.seq);
        return [
          budget.finishTurn(old.operationId, now, {
            successor: { envelope: next, intendedAt: now },
          }),
          budget.turn(),
        ];
      });
      expect(out).toEqual(["ended", null]);
    }));

  it("is recovered as an installation is: a dispatched one only once its owner is quarantined", () =>
    isolated(async () => {
      const feed = `usr_${uniqueId("recturn")}`;
      const grant = await grantFor(feed);
      const out = await runInDurableObject(env.USER.getByName(feed), (_: UserDO, state) => {
        const budget = new LiveBudget(state.storage.sql);
        budget.takeEpoch(0, grant.plan.incarnation);
        const now = Date.now();
        budget.prepareTurn(grant, now, now);
        budget.claimTurn(now);
        budget.dispatchTurn(grant.operationId, "own_turn", "i1");
        const held = budget.recoverPage(grant.seq);
        const kept = budget.turn()?.phase;
        const freed = budget.recoverPage(grant.seq, new Set(["own_turn"]));
        return [held.status, kept, freed.status, budget.turn()];
      });
      expect(out).toEqual(["pending", "dispatched", "clean", null]);
    }));
});
