// Waiting on a feed's object to have handled what a live socket sent it.
// A round trip to the object alone is not enough: a client's message can
// reach it after the round trip, and its handler awaits before it reads the
// time or changes anything. The object counts each socket event it handled
// whole (a test hook), and a test waits for the count by round trips, a
// bounded number of them (no timer).

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect } from "vitest";
import { feedHooks, type UserDO } from "../../src/do/UserDO.js";
import { LiveBudget } from "../../src/do/user/live-budget.js";
import type { Who } from "./api.js";

const ROUND_TRIPS = 200;

const feedOf = (who: Who) => env.USER.getByName(who.principalId);

/** Socket events each feed's object has handled whole, by feed and kind. */
const heard = new Map<string, number>();
feedHooks.afterSocketEvent = (feed, event) => {
  const key = `${feed}\n${event}`;
  heard.set(key, (heard.get(key) ?? 0) + 1);
};

/**
 * A wait for `who`'s feed to have handled one more socket `event` (a
 * message, or a close) than it had when this was called; it throws when
 * none was handled within its round trips.
 */
export function handled(who: Who, event: "message" | "close"): () => Promise<void> {
  const key = `${who.principalId}\n${event}`;
  const before = heard.get(key) ?? 0;
  return async () => {
    for (let i = 0; i < ROUND_TRIPS && (heard.get(key) ?? 0) <= before; i++)
      await runInDurableObject(feedOf(who), () => {});
    if ((heard.get(key) ?? 0) <= before) throw new Error(`no ${event} handled by ${who.handle}`);
  };
}

/** Sends `message` on `who`'s `socket` and waits until its feed has handled it. */
export async function say(
  who: Who,
  socket: { ws?: WebSocket | null } | undefined,
  message: Record<string, unknown>,
): Promise<void> {
  const done = handled(who, "message");
  socket?.ws?.send(JSON.stringify(message));
  await done();
}

/**
 * Waits until `check` holds of `who`'s feed's storage (a socket's state a
 * bridge changes on its own, say); it throws when it never did.
 */
export async function until(who: Who, check: (sql: SqlStorage) => boolean, what: string) {
  for (let i = 0; i < ROUND_TRIPS; i++) {
    const holds = await runInDurableObject(feedOf(who), (_: UserDO, state) =>
      check(state.storage.sql),
    );
    if (holds) return;
  }
  throw new Error(`never ${what}`);
}

/**
 * Runs `who`'s feed's alarm, then again while its prepared turn is a pump
 * already due (a turn of renewals only leaves a change marked meanwhile to
 * the pump after it, which the next alarm runs at once): a few at most.
 */
export async function runTurns(who: Who): Promise<void> {
  await runDurableObjectAlarm(feedOf(who));
  for (let i = 0; i < 3; i++) {
    const due = await runInDurableObject(feedOf(who), (_: UserDO, state) => {
      const row = state.storage.sql
        .exec<{ phase: string; intended_at: number; envelope_json: string }>(
          "SELECT phase, intended_at, envelope_json FROM live_turn",
        )
        .toArray()[0];
      const kind = row
        ? (JSON.parse(row.envelope_json) as { plan: { kind: string } }).plan.kind
        : null;
      return row?.phase === "prepared" && kind === "pump" && row.intended_at <= Date.now();
    });
    if (!due) return;
    await runDurableObjectAlarm(feedOf(who));
  }
}

/**
 * Checks, in each test of the file that calls it, that every opening a feed's object acknowledged
 * had a turn running or runnable then: a socket opened with none would have nothing to renew it
 * or send it hints.
 */
export function everyOpeningHoldsATurn(): void {
  const turnless: string[] = [];
  beforeEach(() => {
    // As the object judges it: a turn of its own running, or one prepared that can run (a row
    // claimed or dispatched with nothing of it running is stranded, not running).
    feedHooks.acknowledged = (state, running) => {
      if (!running && new LiveBudget(state.storage.sql).runnableTurn(Date.now()) === null)
        turnless.push(state.id.name ?? "?");
    };
  });
  afterEach(() => {
    delete feedHooks.acknowledged;
    expect(turnless.splice(0), "openings acknowledged with no turn to run").toEqual([]);
  });
}
