// Waiting on a feed's object to have handled what a live socket sent it.
// A round trip to the object alone is not enough: a client's message can
// reach it after the round trip, and its handler awaits before it reads the
// time or changes anything. The object counts each socket event it handled
// whole (a test hook), and a test waits for the count by round trips, a
// bounded number of them (no timer).

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { feedHooks, type UserDO } from "../../src/do/UserDO.js";
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
