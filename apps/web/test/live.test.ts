// The live hints client against a fake socket and clock: it refreshes on
// every (re)connect, passes on what changed, acknowledges cumulatively
// within the server's allowance, renews before its deadline, reconnects as
// each close asks, and stops for good when there is no point going on;
// and the page's ticket route, which asks the API as the session.

import { describe, expect, it } from "vitest";
import {
  LIVE_CLIENT,
  LiveClient,
  type LiveSocketEvents,
  type LiveStream,
  type LiveTicket,
} from "../app/lib/live.js";
import { action as ticketAction } from "../app/routes/notifications.live-ticket.js";
import { fakeApi, formPost, json, ORIGIN } from "./helpers/context.js";

/** A clock whose timers run only when the test advances it. */
function fakeClock() {
  let now = 1_000_000;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    /** Moves the clock on, running each timer due on the way, in order. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
  };
}

interface Opened {
  url: string;
  events: LiveSocketEvents;
  sent: unknown[];
  closed: number | null;
}

/**
 * A client with fake parts; `tickets` answers each ticket asked for, in
 * turn (then tickets); `unopenable` sockets throw when made, in turn.
 */
function harness(tickets: LiveTicket[] = [], unopenable = 0) {
  let throwing = unopenable;
  const clock = fakeClock();
  const sockets: Opened[] = [];
  const changes: (readonly LiveStream[] | "all")[] = [];
  const stops: string[] = [];
  let asked = 0;
  const client = new LiveClient({
    ticket: async () => {
      asked += 1;
      return tickets.shift() ?? { kind: "ticket", url: `wss://fyrden.test/live/${asked}` };
    },
    open: (url, events) => {
      if (throwing > 0) {
        throwing -= 1;
        throw new SyntaxError("not a WebSocket URL");
      }
      const opened: Opened = { url, events, sent: [], closed: null };
      sockets.push(opened);
      return {
        send: (data) => opened.sent.push(JSON.parse(data)),
        close: (code = 1000) => {
          opened.closed = code;
        },
      };
    },
    changed: (streams) => changes.push(streams),
    stopped: (why) => stops.push(why),
    now: clock.now,
    random: () => 0.5,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  /** Lets the ticket's promise settle. */
  const settle = () =>
    new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => undefined);
  const flush = async () => {
    for (let i = 0; i < 5; i++) await settle();
  };
  const last = () => sockets.at(-1) as Opened;
  const frame = (n: number, streams?: LiveStream[]) =>
    last().events.message(JSON.stringify({ t: "changed", n, ...(streams ? { streams } : {}) }));
  return {
    client,
    clock,
    sockets,
    changes,
    stops,
    flush,
    last,
    frame,
    asked: () => asked,
  };
}

const A: LiveStream = { repo: "rep_a", kind: "issue" };

describe("the live hints client", () => {
  it("refreshes everything once open, then passes on what changed", async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    expect(h.sockets.map((s) => s.url)).toEqual(["wss://fyrden.test/live/1"]);
    expect(h.changes).toEqual([]);
    h.last().events.open();
    h.frame(1, [A]);
    h.last().events.message(JSON.stringify({ t: "changed", n: 2, refresh: true }));
    // Repeated or older frames, and what is not a frame, change nothing.
    h.frame(2, [A]);
    h.frame(1, [A]);
    h.last().events.message("not json");
    expect(h.changes).toEqual(["all", [A], "all"]);
  });

  it("acknowledges the highest frame, after four frames or a while, never one received twice", async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    h.last().events.open();
    for (const n of [1, 2, 3]) h.frame(n, [A]);
    expect(h.last().sent).toEqual([]);
    h.clock.advance(LIVE_CLIENT.ackAfterMs);
    expect(h.last().sent).toEqual([{ t: "ack", n: 3 }]);
    for (const n of [4, 5, 6, 7]) h.frame(n, [A]);
    expect(h.last().sent.at(-1)).toEqual({ t: "ack", n: 7 });
    h.clock.advance(LIVE_CLIENT.ackAfterMs);
    expect(h.last().sent).toHaveLength(2);
  });

  it("renews before the deadline on its own clock, and asks again while unanswered", async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    h.last().events.open();
    const renewAt = LIVE_CLIENT.renewMs - LIVE_CLIENT.renewBeforeMs;
    h.clock.advance(renewAt - 1);
    expect(h.last().sent).toEqual([]);
    h.clock.advance(1);
    expect(h.last().sent).toEqual([{ t: "renew" }]);
    h.clock.advance(LIVE_CLIENT.renewRetryMs);
    expect(h.last().sent).toEqual([{ t: "renew" }, { t: "renew" }]);
    // The server's clock an hour ahead: its deadline is not this clock's.
    const until = h.clock.now() + 60 * 60_000;
    h.last().events.message(JSON.stringify({ t: "renewed", until }));
    h.clock.advance(renewAt - 1);
    expect(h.last().sent).toHaveLength(2);
    h.clock.advance(1);
    expect(h.last().sent).toHaveLength(3);
  });

  it.each([
    [4401, "its deadline passed"],
    [4409, "it fell behind"],
  ])("opens a new socket at once on %i (%s) once it was stable, refreshing again", async (code) => {
    const h = harness();
    h.client.start();
    await h.flush();
    h.last().events.open();
    h.clock.advance(LIVE_CLIENT.stableMs);
    h.last().events.close(code);
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    h.last().events.open();
    expect(h.changes).toEqual(["all", "all"]);
  });

  it("stops for good when revoked, off, or refused", async () => {
    const revoked = harness();
    revoked.client.start();
    await revoked.flush();
    revoked.last().events.open();
    revoked.last().events.close(4403);
    revoked.clock.advance(LIVE_CLIENT.backoffMaxMs * 10);
    await revoked.flush();
    expect(revoked.sockets).toHaveLength(1);
    expect(revoked.stops).toEqual(["revoked"]);
    for (const kind of ["off", "stop"] as const) {
      const h = harness([{ kind }]);
      h.client.start();
      await h.flush();
      h.clock.advance(LIVE_CLIENT.backoffMaxMs * 10);
      await h.flush();
      expect(h.sockets).toEqual([]);
      expect(h.asked()).toBe(1);
      expect(h.stops).toEqual([kind]);
    }
  });

  it.each([[4401], [4409], [1006]])(
    "backs off between sockets closed (%i) before they were stable, and gives up after five",
    async (code) => {
      const h = harness();
      h.client.start();
      const delays: number[] = [];
      for (let i = 0; i < LIVE_CLIENT.maxFailures; i++) {
        await h.flush();
        h.last().events.open();
        h.clock.advance(LIVE_CLIENT.stableMs - 1);
        h.last().events.close(code);
        const [delay] = h.clock.pending();
        if (delay !== undefined) delays.push(delay);
        h.clock.advance(delay ?? 0);
      }
      await h.flush();
      // Each at three quarters of its ceiling (the random half fixed at 0.5).
      expect(delays).toEqual([750, 1_500, 3_000, 6_000]);
      expect(h.sockets).toHaveLength(LIVE_CLIENT.maxFailures);
      expect(h.stops).toEqual(["failing"]);
    },
  );

  it("retries a socket refused before it opened slowly, and gives up after two", async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    h.last().events.close(1006);
    expect(h.clock.pending()).toEqual([LIVE_CLIENT.refusedBackoffMs * 0.75]);
    h.clock.advance(LIVE_CLIENT.refusedBackoffMs);
    await h.flush();
    h.last().events.close(1006);
    expect(h.clock.pending()).toEqual([]);
    expect(h.sockets).toHaveLength(LIVE_CLIENT.maxRefused);
    expect(h.stops).toEqual(["failing"]);
  });

  it("asks again after a refused ticket, and starts the back-off over once a socket was stable", async () => {
    const h = harness([{ kind: "retry" }]);
    h.client.start();
    await h.flush();
    expect(h.sockets).toEqual([]);
    expect(h.clock.pending()).toEqual([750]);
    h.clock.advance(750);
    await h.flush();
    for (const delay of [1_500, 3_000]) {
      h.last().events.open();
      h.last().events.close(1006);
      expect(h.clock.pending()).toEqual([delay]);
      h.clock.advance(delay);
      await h.flush();
    }
    h.last().events.open();
    h.clock.advance(LIVE_CLIENT.stableMs);
    h.last().events.close(1006);
    expect(h.clock.pending()).toEqual([750]);
  });

  it("counts a socket that cannot be made as a failure", async () => {
    const h = harness([], 1);
    h.client.start();
    await h.flush();
    expect(h.sockets).toEqual([]);
    expect(h.clock.pending()).toEqual([750]);
    h.clock.advance(750);
    await h.flush();
    expect(h.sockets).toHaveLength(1);
  });

  it("keeps a minute's acknowledgements within the allowance, room left for renewal", async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    h.last().events.open();
    for (let n = 1; n <= 200; n++) h.frame(n, [A]);
    const acks = h.last().sent.filter((m) => (m as { t: string }).t === "ack");
    const room =
      LIVE_CLIENT.controlsPerMinute - LIVE_CLIENT.minuteMargin - LIVE_CLIENT.renewReserveMinute;
    expect(acks).toHaveLength(room);
    // The rest goes as one acknowledgement when the minute's first leaves it.
    h.clock.advance(60_000);
    expect(h.last().sent.at(-1)).toEqual({ t: "ack", n: 200 });
  });

  it("counts the minute's controls across sockets, wherever the server's minute starts", async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    h.last().events.open();
    h.clock.advance(LIVE_CLIENT.stableMs);
    for (let n = 1; n <= 100; n++) h.frame(n, [A]);
    h.last().events.close(4409);
    await h.flush();
    h.last().events.open();
    for (let n = 1; n <= 8; n++) h.frame(n, [A]);
    expect(h.last().sent).toEqual([]);
    h.clock.advance(60_000);
    expect(h.last().sent).toEqual([{ t: "ack", n: 8 }]);
  });

  it("moves to a new socket before its life's allowance runs out", async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    h.last().events.open();
    let n = 0;
    while (h.sockets.length === 1 && n < 10_000) {
      for (let i = 0; i < LIVE_CLIENT.ackFrames; i++) h.frame(++n, [A]);
      h.clock.advance(4_000);
    }
    await h.flush();
    const first = h.sockets[0] as Opened;
    expect(first.sent).toHaveLength(LIVE_CLIENT.controlsLife - LIVE_CLIENT.renewReserveLife);
    expect(first.closed).toBe(1000);
    expect(h.sockets).toHaveLength(2);
  });

  it("closes its socket and does nothing more once stopped", async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    h.last().events.open();
    h.frame(1, [A]);
    h.client.stop();
    expect(h.last().closed).toBe(1000);
    expect(h.clock.pending()).toEqual([]);
    h.last().events.close(1000);
    h.clock.advance(LIVE_CLIENT.backoffMaxMs * 10);
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    expect(h.stops).toEqual([]);
  });
});

describe("a page's ticket", () => {
  /** The API answering the ticket with `status` and `body`, the session as ada's. */
  const issuing = (status: number, body: unknown) =>
    fakeApi((req) =>
      new URL(req.url).pathname === "/auth/session"
        ? json({ user: { id: "usr_ada", handle: "ada" } })
        : json(body, status),
    );
  const ask = (context: unknown, fields = { viewer: "usr_ada" }) =>
    ticketAction({
      request: formPost("/notifications/live-ticket", fields),
      context,
      params: {},
    } as never);

  it("is the API's, for a socket on the page's own origin, never cached", async () => {
    const { context, calls } = issuing(200, { ticket: "t/1", expires_in: 30, url: "elsewhere" });
    const res = await ask(context);
    expect(await res.json()).toEqual({
      kind: "ticket",
      url: "wss://fyrden.test/api/notifications/live?ticket=t%2F1",
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const issued = calls.filter((c) => new URL(c.url).pathname !== "/auth/session");
    expect(issued.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/notifications/live",
    ]);
  });

  it.each([
    [503, { code: "live_unavailable" }, "off"],
    [503, { code: "unavailable" }, "retry"],
    [429, { code: "rate_limited" }, "retry"],
    [401, { code: "unauthorized" }, "stop"],
    [403, { code: "delegated_listing" }, "stop"],
  ])("answers %i (%o) as %s", async (status, body, kind) => {
    const { context } = issuing(status, body);
    expect(await (await ask(context)).json()).toEqual({ kind });
  });

  it("is asked for again later when the session could not be checked", async () => {
    const { context, calls } = fakeApi(() => json({ detail: "Unavailable." }, 503));
    expect(await (await ask(context)).json()).toEqual({ kind: "retry" });
    expect(calls.every((c) => new URL(c.url).pathname === "/auth/session")).toBe(true);
  });

  it("is not asked for when another viewer signed in since the page was drawn", async () => {
    const { context, calls } = issuing(200, { ticket: "t1" });
    expect(await (await ask(context, { viewer: "usr_bo" })).json()).toEqual({ kind: "stop" });
    expect(calls.every((c) => new URL(c.url).pathname === "/auth/session")).toBe(true);
  });

  it("is refused to another origin", async () => {
    const { context, calls } = issuing(200, { ticket: "t1" });
    const request = new Request(`${ORIGIN}/notifications/live-ticket`, {
      method: "POST",
      headers: { Origin: "https://evil.test", Cookie: "fyrden_session=s" },
      body: new URLSearchParams({ viewer: "usr_ada" }),
    });
    const thrown = await ticketAction({ request, context, params: {} } as never).catch(
      (e: unknown) => e,
    );
    expect(thrown).toMatchObject({ init: { status: 403 } });
    expect(calls).toEqual([]);
  });
});
