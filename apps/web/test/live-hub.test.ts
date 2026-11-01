// A tab's live hints across its pages, with a fake client, clock and
// page: one socket however the tab navigates, none while hidden from the
// start, let go after a while hidden or with no page listening, stopped
// for good when off, signed out or revoked (failing: tried again after a
// pause); paused for the day whatever the tab does, then started again
// past the pause's end only if wanted; reads paced, one at a time, held
// during navigations and while hidden; and what the viewer is told.

import { describe, expect, it } from "vitest";
import type { LiveBudgetPause, LiveStream } from "../app/lib/live.js";
import { LIVE_HUB, LiveHub, type LiveHubEvents } from "../app/lib/live-hub.js";

function harness({
  hidden = false,
  kept = null as LiveBudgetPause | null,
}: {
  hidden?: boolean;
  kept?: LiveBudgetPause | null;
} = {}) {
  let now = 1_000_000;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const page = { hidden, idle: true, off: 0, storage: true, pause: kept };
  const client = { starts: 0, stops: 0 };
  const reads: { done: () => void }[] = [];
  let events: LiveHubEvents | null = null;
  const hub = new LiveHub({
    client: (e) => {
      events = e;
      return {
        start: () => {
          client.starts += 1;
        },
        stop: () => {
          client.stops += 1;
        },
      };
    },
    hidden: () => page.hidden,
    idle: () => page.idle,
    revalidate: () =>
      new Promise<void>((resolve) => {
        reads.push({ done: resolve });
      }),
    offSince: () => page.off,
    markOff: (at) => {
      if (page.storage) page.off = at;
    },
    pausedUntil: () => page.pause,
    markPaused: (pause) => {
      page.pause = pause;
    },
    now: () => now,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  /** Lets a finished read's promise settle. */
  const finish = async () => {
    reads.shift()?.done();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    hub,
    page,
    client,
    reads,
    advance,
    finish,
    now: () => now,
    hint: (streams: readonly LiveStream[] | "all") => events?.changed(streams),
    stop: (why: "off" | "stop" | "revoked" | "failing") => events?.stopped(why),
    pause: (retryAt: number) => events?.paused({ kind: "budget", retryAt }),
    temporary: (refused: boolean) => events?.temporary(refused),
  };
}

/** How far past a pause's end the hub starts again (the random half fixed at 0.5). */
const LATE = LIVE_HUB.resumeSpreadMs * 0.75;

const want = (repo: string) => ({ current: (s: LiveStream) => s.repo === repo });
const A: LiveStream = { repo: "rep_a", kind: "issue" };
const B: LiveStream = { repo: "rep_b", kind: "issue" };

describe("a tab's live hints", () => {
  it("keeps one socket from page to page, and lets it go a while after the last", () => {
    const h = harness();
    const leave = h.hub.listen(want("rep_a"));
    expect(h.client.starts).toBe(1);
    leave();
    h.advance(LIVE_HUB.lingerMs - 1);
    const leaveAgain = h.hub.listen(want("rep_b"));
    h.advance(LIVE_HUB.lingerMs * 3);
    expect(h.client).toEqual({ starts: 1, stops: 0 });
    leaveAgain();
    h.advance(LIVE_HUB.lingerMs);
    expect(h.client).toEqual({ starts: 1, stops: 1 });
  });

  it("opens nothing in a tab hidden from the start, until it is shown", () => {
    const h = harness({ hidden: true });
    h.hub.listen(want("rep_a"));
    h.advance(LIVE_HUB.hiddenMs * 2);
    expect(h.client.starts).toBe(0);
    h.page.hidden = false;
    h.hub.visibility();
    expect(h.client.starts).toBe(1);
  });

  it("lets the socket go after a while hidden, and opens one when shown again", () => {
    const h = harness();
    h.hub.listen(want("rep_a"));
    h.page.hidden = true;
    h.hub.visibility();
    h.advance(LIVE_HUB.hiddenMs - 1);
    h.page.hidden = false;
    h.hub.visibility();
    expect(h.client).toEqual({ starts: 1, stops: 0 });
    h.page.hidden = true;
    h.hub.visibility();
    h.advance(LIVE_HUB.hiddenMs);
    expect(h.client).toEqual({ starts: 1, stops: 1 });
    h.page.hidden = false;
    h.hub.visibility();
    expect(h.client).toEqual({ starts: 2, stops: 1 });
  });

  it("reads at once on a connect, a wanted hint after a gap, and nothing for another stream", async () => {
    const h = harness();
    h.hub.listen(want("rep_a"));
    h.hint("all");
    expect(h.reads).toHaveLength(1);
    await h.finish();
    h.hint([B]);
    h.hint([A]);
    expect(h.reads).toHaveLength(0);
    h.advance(LIVE_HUB.readGapMs - 1);
    expect(h.reads).toHaveLength(0);
    h.advance(1);
    expect(h.reads).toHaveLength(1);
    await h.finish();
    h.hint([B]);
    h.advance(LIVE_HUB.readGapMs * 2);
    expect(h.reads).toHaveLength(0);
  });

  it("reads one at a time, once more for what came during a read", async () => {
    const h = harness();
    h.hub.listen(want("rep_a"));
    h.hint("all");
    h.hint("all");
    h.hint([A]);
    expect(h.reads).toHaveLength(1);
    await h.finish();
    expect(h.reads).toHaveLength(1);
    await h.finish();
    h.advance(LIVE_HUB.readGapMs * 2);
    expect(h.reads).toHaveLength(0);
  });

  it("holds a read during a navigation and while hidden", async () => {
    const h = harness();
    h.hub.listen(want("rep_a"));
    h.page.idle = false;
    h.hint("all");
    expect(h.reads).toHaveLength(0);
    h.page.idle = true;
    h.hub.settled();
    expect(h.reads).toHaveLength(1);
    await h.finish();
    h.page.hidden = true;
    h.hub.visibility();
    h.hint("all");
    expect(h.reads).toHaveLength(0);
    h.page.hidden = false;
    h.hub.visibility();
    expect(h.reads).toHaveLength(1);
  });

  it("stays stopped when revoked or signed out, an hour when off, a pause when failing", () => {
    for (const why of ["revoked", "stop"] as const) {
      const h = harness();
      h.hub.listen(want("rep_a"));
      h.stop(why);
      h.advance(LIVE_HUB.offForMs * 2);
      h.hub.visibility();
      h.hub.listen(want("rep_b"));
      expect(h.client.starts).toBe(1);
    }
    const off = harness();
    off.hub.listen(want("rep_a"));
    off.stop("off");
    off.advance(LIVE_HUB.offForMs - 1);
    off.hub.visibility();
    expect(off.client.starts).toBe(1);
    off.advance(1);
    off.hub.visibility();
    expect(off.client.starts).toBe(2);
    const failing = harness();
    failing.hub.listen(want("rep_a"));
    failing.stop("failing");
    failing.advance(LIVE_HUB.failedPauseMs - 1);
    failing.hub.visibility();
    expect(failing.client.starts).toBe(1);
    failing.advance(1);
    failing.hub.visibility();
    expect(failing.client.starts).toBe(2);
  });

  it("reads for no page that does not listen, nor for a hint the arriving page does not want", async () => {
    const h = harness();
    const leave = h.hub.listen(want("rep_a"));
    leave();
    // Lingering: connected, but no page listens.
    h.hint("all");
    h.hint([A]);
    h.advance(LIVE_HUB.readGapMs * 2);
    expect(h.reads).toHaveLength(0);
    // A hint for the page left, held through a navigation, is not the arriving page's.
    const leaveA = h.hub.listen(want("rep_a"));
    h.hint("all");
    await h.finish();
    h.page.idle = false;
    h.hint([A]);
    leaveA();
    h.hub.listen(want("rep_b"));
    h.page.idle = true;
    h.hub.settled();
    h.advance(LIVE_HUB.readGapMs * 2);
    expect(h.reads).toHaveLength(0);
    // One for the arriving page's, held through the navigation, is read.
    h.page.idle = false;
    h.hint([B]);
    h.page.idle = true;
    h.hub.settled();
    h.advance(LIVE_HUB.readGapMs);
    expect(h.reads).toHaveLength(1);
  });

  it("tries a failing socket again after the pause, with nothing happening in the tab", () => {
    const h = harness();
    h.hub.listen(want("rep_a"));
    h.stop("failing");
    h.advance(LIVE_HUB.failedPauseMs - 1);
    expect(h.client.starts).toBe(1);
    h.advance(1);
    expect(h.client.starts).toBe(2);
  });

  it("remembers off for the hour when the tab's storage fails", () => {
    const h = harness();
    h.page.storage = false;
    h.hub.listen(want("rep_a"));
    h.stop("off");
    h.hub.visibility();
    h.hub.listen(want("rep_b"));
    expect(h.client.starts).toBe(1);
    h.advance(LIVE_HUB.offForMs);
    h.hub.visibility();
    expect(h.client.starts).toBe(2);
  });

  it("opens nothing while paused for the day, whatever the tab does, then starts again past its end", () => {
    const h = harness();
    const leave = h.hub.listen(want("rep_a"));
    h.stop("failing");
    const retryAt = h.now() + 60 * 60_000;
    h.pause(retryAt);
    expect(h.page.pause).toEqual({ kind: "budget", retryAt });
    expect(h.hub.status()).toEqual({ kind: "paused", retryAt });
    // A page arriving, a navigation, the tab hidden and shown, the failure's retry, lingering.
    leave();
    h.hub.listen(want("rep_b"));
    h.hub.settled();
    h.page.hidden = true;
    h.hub.visibility();
    h.page.hidden = false;
    h.hub.visibility();
    h.advance(LIVE_HUB.failedPauseMs);
    h.advance(retryAt - h.now() + LATE - 1);
    expect(h.client.starts).toBe(1);
    expect(h.page.pause).not.toBeNull();
    h.advance(1);
    expect(h.client.starts).toBe(2);
    expect(h.page.pause).toBeNull();
    expect(h.hub.status()).toEqual({ kind: "live" });
  });

  it("starts nothing at the pause's end while hidden or unwanted, and starts once shown", () => {
    const h = harness();
    const leave = h.hub.listen(want("rep_a"));
    h.pause(h.now() + 60_000);
    h.page.hidden = true;
    h.hub.visibility();
    h.advance(60_000 + LATE);
    expect(h.client.starts).toBe(1);
    expect(h.hub.status()).toEqual({ kind: "live" });
    h.page.hidden = false;
    h.hub.visibility();
    expect(h.client.starts).toBe(2);
    const other = harness();
    const left = other.hub.listen(want("rep_a"));
    other.pause(other.now() + 60_000);
    left();
    other.advance(LIVE_HUB.lingerMs + 60_000 + LATE);
    expect(other.client.starts).toBe(1);
    other.hub.listen(want("rep_a"));
    expect(other.client.starts).toBe(2);
    leave();
  });

  it("keeps a pause the tab kept, from its first page", () => {
    const retryAt = 1_000_000 + 30 * 60_000;
    const h = harness({ kept: { kind: "budget", retryAt } });
    expect(h.hub.status()).toEqual({ kind: "paused", retryAt });
    h.hub.listen(want("rep_a"));
    expect(h.client.starts).toBe(0);
    h.advance(30 * 60_000 + LATE);
    expect(h.client.starts).toBe(1);
  });

  it("tells a refusal for now until it passes, or until it stops for good", () => {
    const h = harness();
    const told: string[] = [];
    h.hub.watch(() => told.push(h.hub.status().kind));
    h.hub.listen(want("rep_a"));
    h.temporary(true);
    expect(h.hub.status()).toEqual({ kind: "temporary" });
    // Failing, it is tried again: still told.
    h.stop("failing");
    expect(h.hub.status()).toEqual({ kind: "temporary" });
    h.temporary(false);
    expect(h.hub.status()).toEqual({ kind: "live" });
    h.temporary(true);
    h.stop("revoked");
    expect(h.hub.status()).toEqual({ kind: "live" });
    // A pause overrides it, and is told once.
    h.temporary(true);
    h.pause(h.now() + 60_000);
    h.pause(h.now() + 60_000);
    expect(told).toEqual(["temporary", "live", "temporary", "live", "temporary", "paused"]);
  });

  it("does nothing more once disposed, a read under way included", async () => {
    const h = harness();
    h.hub.listen(want("rep_a"));
    h.hint("all");
    h.hint("all");
    h.hub.dispose();
    expect(h.client.stops).toBe(1);
    await h.finish();
    expect(h.reads).toHaveLength(0);
    h.hub.visibility();
    h.hub.listen(want("rep_a"));
    expect(h.client.starts).toBe(1);
  });
});
