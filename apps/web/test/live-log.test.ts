import { describe, expect, it } from "vitest";
import { LiveLog, type LiveSocket } from "../app/lib/live-log.js";
import { LogStore } from "../app/lib/log-store.js";

class FakeSocket implements LiveSocket {
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  frame(body: unknown) {
    this.onmessage?.({ data: JSON.stringify(body) });
  }
  end(code: number) {
    this.onclose?.({ code });
  }
}

function harness(start = 0) {
  const store = new LogStore();
  const sockets: FakeSocket[] = [];
  const tickets: number[] = [];
  let now = 0;
  let refuse: string | null = null;
  let fail: "ticket" | "connect" | null = null;
  let changes = 0;
  const live = new LiveLog({
    store,
    ticket: async (from) => {
      tickets.push(from);
      if (fail === "ticket") throw new TypeError("Failed to fetch");
      return refuse === null
        ? { url: `ws://x/live?ticket=t${tickets.length}&from=${from}` }
        : { refused: refuse };
    },
    connect: (url) => {
      if (fail === "connect") throw new SyntaxError("The URL is invalid");
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => now,
    onChange: () => {
      changes += 1;
    },
  });
  return {
    store,
    sockets,
    tickets,
    live,
    last: () => sockets.at(-1) as FakeSocket,
    advance: (ms: number) => {
      now += ms;
    },
    refuseWith: (code: string | null) => {
      refuse = code;
    },
    failAt: (where: "ticket" | "connect" | null) => {
      fail = where;
    },
    changes: () => changes,
    start: () => live.start(start),
  };
}

const rows = (from: number, n: number) => ({
  t: "rows",
  rows: Array.from({ length: n }, (_, k) => ({ i: from + k, t: 1, c: `r${from + k}` })),
});

describe("LiveLog", () => {
  it("stores rows and acknowledges every 16 frames at the next row", async () => {
    const h = harness(10);
    await h.start();
    h.last().open();
    for (let k = 0; k < 16; k++) h.last().frame(rows(10 + k, 1));
    expect(h.store.row(25)).toMatchObject({ c: "r25" });
    expect(h.last().sent).toEqual([{ t: "ack", i: 26, o: 0 }]);
    expect(h.live.state).toBe("live");
  });

  it("acknowledges after 256 KiB of frames, at a piece's end", async () => {
    const h = harness();
    await h.start();
    h.last().open();
    const big = "x".repeat(140 * 1024);
    h.last().frame({ t: "part", i: 0, o: 0, c: big, end: false, ts: 7 });
    h.last().frame({ t: "part", i: 0, o: big.length, c: big, end: false });
    expect(h.last().sent).toEqual([{ t: "ack", i: 0, o: 2 * big.length }]);
    expect(h.store.row(0)).toMatchObject({ kind: "prefix", t: 7 });
  });

  it("ends on the terminal frame, with what was stored", async () => {
    const h = harness();
    await h.start();
    h.last().open();
    h.last().frame(rows(0, 5));
    h.last().frame({ t: "part", i: 5, o: 0, c: "half", end: false, ts: 1 });
    h.last().frame({ t: "end", log: "complete", durable: 5, unfinished: 5 });
    h.last().end(1000);
    expect(h.live.state).toBe("ended");
    expect(h.store.closed).toBe(true);
    expect(h.store.row(5)).toBeUndefined();
    expect(h.store.length).toBe(5);
    expect(h.tickets).toEqual([0]);
  });

  it("reconnects after a budget end from the row it names", async () => {
    const h = harness();
    await h.start();
    h.last().open();
    h.last().frame(rows(0, 3));
    h.last().frame({ t: "part", i: 3, o: 0, c: "ha", end: false, ts: 1 });
    h.last().frame({ t: "end", reason: "budget", unfinished: 3 });
    h.last().end(4429);
    await h.live.settled();
    expect(h.tickets).toEqual([0, 3]);
    expect(h.store.closed).toBe(false);
    expect(h.store.row(3)).toBeUndefined();
  });

  it("reconnects after a 4429 with no frame, from the row after the last whole one", async () => {
    const h = harness();
    await h.start();
    h.last().open();
    h.last().frame(rows(0, 4));
    h.last().frame({ t: "part", i: 4, o: 0, c: "ha", end: false, ts: 1 });
    h.last().end(4429);
    await h.live.settled();
    expect(h.tickets).toEqual([0, 4]);
  });

  it("stops reconnecting after three tries in ten minutes", async () => {
    const h = harness();
    await h.start();
    for (let k = 0; k < 4; k++) {
      h.last().open();
      h.last().end(1001);
      await h.live.settled();
    }
    expect(h.tickets).toHaveLength(4);
    expect(h.live.state).toBe("stopped");
  });

  it("does not retry a socket that never opened", async () => {
    const h = harness();
    await h.start();
    h.last().onerror?.();
    h.last().end(1006);
    await h.live.settled();
    expect(h.live.state).toBe("refused");
    expect(h.tickets).toHaveLength(1);
  });

  it.each([
    [4403, "gone"],
    [4404, "gone"],
    [4408, "stopped"],
    [1006, "stopped"],
  ])("after opening, a close %i leaves it %s", async (code, state) => {
    const h = harness();
    await h.start();
    h.last().open();
    h.last().end(code);
    await h.live.settled();
    expect(h.live.state).toBe(state);
    expect(h.tickets).toHaveLength(1);
  });

  it("says why when no ticket is given", async () => {
    const h = harness();
    h.refuseWith("log_viewers_spent");
    await h.start();
    expect(h.live.state).toBe("refused");
    expect(h.live.reason).toBe("log_viewers_spent");
    expect(h.sockets).toHaveLength(0);
  });

  it("resumes by hand from the next whole row", async () => {
    const h = harness();
    await h.start();
    h.last().open();
    h.last().frame(rows(0, 2));
    h.last().end(4408);
    await h.live.settled();
    await h.live.resume();
    expect(h.tickets).toEqual([0, 2]);
  });

  it("ignores frames it cannot read, and stops on close", async () => {
    const h = harness();
    await h.start();
    h.last().open();
    h.last().onmessage?.({ data: "not json" });
    h.last().frame({ t: "rows", rows: "nope" });
    h.live.stop();
    expect(h.last().closed).toBe(true);
    h.last().end(1000);
    await h.live.settled();
    expect(h.tickets).toHaveLength(1);
  });

  it.each(["ticket", "connect"] as const)(
    "stops, says so and can resume when the %s fails",
    async (where) => {
      const h = harness();
      h.failAt(where);
      await expect(h.start()).resolves.toBeUndefined();
      expect(h.live.state).toBe("stopped");
      expect(h.live.reason).toBe(`${where}_failed`);
      const seen = h.changes();
      expect(seen).toBeGreaterThan(1);
      h.failAt(null);
      await h.live.resume();
      h.last().open();
      expect(h.live.state).toBe("live");
    },
  );
});
