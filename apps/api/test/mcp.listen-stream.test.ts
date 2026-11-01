// A listen stream's writer on its own: a stand-in socket and a clock moved by
// hand. Messages are made only as the stream is read; hints fold together;
// frames are acknowledged every half window within the socket's control
// budgets; the socket is renewed before its deadline and again when a
// renewal goes unanswered; the stream ends gracefully when its socket
// closes, at its longest life and before its controls run out.

import { describe, expect, it } from "vitest";
import { LIVE_POLICY } from "../src/do/user/live.js";
import {
  LISTEN_POLICY,
  type ListenClock,
  type ListenSocket,
  ListenStream,
} from "../src/mcp/listen.js";

const URI = "fyrden://feed/usr_1";
const SERVER = { name: "fyrden", version: "test" };

/** A socket that records what the stream sends, and lets the test speak for the object. */
function fakeSocket() {
  const handlers: Record<string, ((event: { data: unknown }) => void)[]> = {};
  const sent: unknown[] = [];
  let closed: number | null = null;
  const socket: ListenSocket = {
    send: (message) => sent.push(JSON.parse(message)),
    close: (code) => {
      closed = code ?? 1005;
    },
    addEventListener: (type: string, handler: (event: { data: unknown }) => void) => {
      handlers[type] = [...(handlers[type] ?? []), handler];
    },
  };
  const emit = (type: string, data?: unknown) => {
    for (const handler of handlers[type] ?? []) handler({ data });
  };
  return {
    socket,
    sent,
    closed: () => closed,
    frame: (frame: unknown) => emit("message", JSON.stringify(frame)),
    close: () => emit("close"),
  };
}

/** A clock moved by hand; `tick` runs the stream's repeated callback once. */
function manualClock(start = 1_000_000) {
  let now = start;
  let tick: (() => void) | null = null;
  let stopped = false;
  const clock: ListenClock = {
    now: () => now,
    every: (_ms, callback) => {
      tick = callback;
      return () => {
        stopped = true;
      };
    },
  };
  return {
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    tick: () => tick?.(),
    stopped: () => stopped,
    now: () => now,
  };
}

function open(id: string | number = "s-1", signal?: AbortSignal) {
  const socket = fakeSocket();
  const time = manualClock();
  const stream = new ListenStream({
    id,
    serverInfo: SERVER,
    feed: { uri: URI, socket: socket.socket, deadline: time.now() + LIVE_POLICY.renewMs },
    clock: time.clock,
    ...(signal && { signal }),
  });
  const reader = stream.readable.getReader();
  const decoder = new TextDecoder();
  /** The next message the stream makes (the read itself is what lets it make one). */
  const read = async () => {
    const chunk = await reader.read();
    if (chunk.done) return null;
    const text = decoder.decode(chunk.value);
    return text.startsWith(":")
      ? text
      : (JSON.parse(text.slice(text.indexOf("data: ") + 6)) as {
          method?: string;
          id?: unknown;
          result?: unknown;
          params?: unknown;
        });
  };
  return { socket, time, reader, read };
}

const changed = (n: number) => ({ t: "changed", n, streams: [] });

describe("a listen stream's writer", () => {
  it("acknowledges first, then folds frames heard meanwhile into one hint", async () => {
    const { socket, read } = open();
    for (let n = 1; n <= 3; n++) socket.frame(changed(n));
    expect(await read()).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: { resourceSubscriptions: [URI] },
        _meta: { "io.modelcontextprotocol/subscriptionId": "s-1" },
      },
    });
    expect(await read()).toEqual({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: URI, _meta: { "io.modelcontextprotocol/subscriptionId": "s-1" } },
    });
    // Three frames taken: fewer than half the window, not acknowledged yet.
    expect(socket.sent).toEqual([]);
    socket.frame(changed(4));
    await read();
    expect(socket.sent).toEqual([{ t: "ack", n: 4 }]);
  });

  it("acknowledges a full window heard before it was read, so the socket can send again", async () => {
    const { socket, read } = open();
    await read();
    for (let n = 1; n <= LIVE_POLICY.window; n++) socket.frame(changed(n));
    expect(await read()).toMatchObject({ method: "notifications/resources/updated" });
    expect(socket.sent).toEqual([{ t: "ack", n: LIVE_POLICY.window }]);
  });

  it("makes nothing ahead of a read: an unread stream acknowledges nothing", async () => {
    const { socket, time, read } = open();
    await read();
    for (let n = 1; n <= 40; n++) socket.frame(changed(n));
    time.tick();
    expect(socket.sent).toEqual([]);
  });

  it("keeps one keepalive pending at most, and sends it only while nothing else is", async () => {
    const { socket, time, read } = open();
    await read();
    const waiting = read();
    time.tick();
    time.tick();
    time.tick();
    // Three ticks, one keepalive.
    expect(await waiting).toBe(": keepalive\n\n");
    time.tick();
    socket.frame(changed(1));
    // The hint goes before the keepalive the tick asked for.
    expect(await read()).toMatchObject({ method: "notifications/resources/updated" });
    expect(await read()).toBe(": keepalive\n\n");
    const next = read();
    socket.frame(changed(2));
    expect(await next).toMatchObject({ method: "notifications/resources/updated" });
  });

  it("renews before the deadline, again a minute later when unanswered, and from the answer's deadline", async () => {
    const { socket, time, read } = open();
    await read();
    const start = time.now();
    time.advance(LIVE_POLICY.renewMs / 2 - 60_000);
    time.tick();
    expect(socket.sent).toEqual([]);
    time.advance(60_000 + LISTEN_POLICY.renewMarginMs);
    time.tick();
    expect(socket.sent).toEqual([{ t: "renew" }]);
    time.advance(30_000);
    time.tick();
    expect(socket.sent).toHaveLength(1);
    time.advance(LISTEN_POLICY.renewRetryMs);
    time.tick();
    expect(socket.sent).toEqual([{ t: "renew" }, { t: "renew" }]);
    const until = time.now() + LIVE_POLICY.renewMs;
    socket.frame({ t: "renewed", until });
    // An answered renewal is a hint to read again (changes whose access the object could not
    // decide were passed over), which acknowledges nothing.
    expect(await read()).toMatchObject({ method: "notifications/resources/updated" });
    time.tick();
    expect(socket.sent).toHaveLength(2);
    time.advance(until - LIVE_POLICY.renewMs / 2 + LISTEN_POLICY.renewMarginMs - time.now());
    time.tick();
    expect(socket.sent).toHaveLength(3);
    expect(time.now() - start).toBeLessThan(LISTEN_POLICY.lifeMs);
  });

  it("keeps acknowledgements within a minute's controls, leaving room for renewals", async () => {
    const { socket, time, read } = open();
    await read();
    for (let n = 1; n <= 100; n++) {
      socket.frame(changed(n * LISTEN_POLICY.ackEvery));
      await read();
    }
    const acks = socket.sent.filter((m) => (m as { t: string }).t === "ack");
    expect(acks).toHaveLength(LIVE_POLICY.controlsPerMinute - LISTEN_POLICY.renewReserveMinute);
    // A minute later the latest is acknowledged at the next tick.
    time.advance(60_000);
    time.tick();
    expect(socket.sent.at(-1)).toEqual({ t: "ack", n: 100 * LISTEN_POLICY.ackEvery });
  });

  it("ends gracefully when the socket closes: a pending hint first, then the result", async () => {
    const { socket, time, read } = open(7);
    await read();
    socket.frame(changed(1));
    socket.close();
    expect(await read()).toMatchObject({ method: "notifications/resources/updated" });
    expect(await read()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        resultType: "complete",
        _meta: {
          "io.modelcontextprotocol/subscriptionId": 7,
          "io.modelcontextprotocol/serverInfo": SERVER,
        },
      },
    });
    expect(await read()).toBeNull();
    expect(time.stopped()).toBe(true);
  });

  it("stops ticking as soon as it ends, though its last messages are not read yet", async () => {
    const { socket, time, read } = open();
    await read();
    socket.close();
    expect(time.stopped()).toBe(true);
    time.tick();
    expect(socket.sent).toEqual([]);
    expect(await read()).toMatchObject({ result: { resultType: "complete" } });
  });

  it("never starts ticking when its socket closed before it was read", async () => {
    const { socket, time, read } = open();
    socket.close();
    await read();
    await read();
    expect(await read()).toBeNull();
    time.tick();
    expect(socket.sent).toEqual([]);
  });

  it("lets its socket go and ends its body when the request is aborted", async () => {
    const abort = new AbortController();
    const { socket, time, read } = open("s-1", abort.signal);
    await read();
    const waiting = read();
    abort.abort();
    expect(await waiting).toBeNull();
    expect(socket.closed()).toBe(1000);
    expect(time.stopped()).toBe(true);
  });

  it("starts nothing when the request was aborted before the first read", async () => {
    const abort = new AbortController();
    const { socket, time, read } = open("s-1", abort.signal);
    abort.abort();
    expect(await read()).toBeNull();
    time.tick();
    expect(socket.sent).toEqual([]);
    expect(socket.closed()).toBe(1000);
  });

  it("ends at its longest life, closing its socket", async () => {
    const { socket, time, read } = open();
    await read();
    time.advance(LISTEN_POLICY.lifeMs);
    time.tick();
    expect(await read()).toMatchObject({ id: "s-1", result: { resultType: "complete" } });
    expect(socket.closed()).toBe(1000);
  });

  it("ends before the socket's controls run out", async () => {
    const { socket, time, read } = open();
    await read();
    let n = 0;
    while (socket.closed() === null && n < 10_000) {
      for (let i = 0; i < 4; i++) {
        n += LISTEN_POLICY.ackEvery;
        socket.frame(changed(n));
        const message = await read();
        if (message !== null && typeof message === "object" && "result" in message) break;
      }
      time.advance(60_000);
      time.tick();
    }
    expect(socket.closed()).toBe(1000);
    expect(socket.sent.length).toBeLessThanOrEqual(LIVE_POLICY.controlsLife);
  });

  it("closes its socket and stops when the client cancels it", async () => {
    const { socket, time, reader, read } = open();
    await read();
    await reader.cancel();
    expect(socket.closed()).toBe(1000);
    expect(time.stopped()).toBe(true);
  });

  it("without a feed, acknowledges nothing honored and ends", async () => {
    const stream = new ListenStream({ id: 1, serverInfo: SERVER });
    const text = await new Response(stream.readable).text();
    const messages = text
      .split("\n\n")
      .filter(Boolean)
      .map((e) => JSON.parse(e.slice(e.indexOf("data: ") + 6)) as Record<string, unknown>);
    expect(messages).toMatchObject([
      { method: "notifications/subscriptions/acknowledged", params: { notifications: {} } },
      { id: 1, result: { resultType: "complete" } },
    ]);
  });
});
