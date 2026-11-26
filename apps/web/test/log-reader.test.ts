import { describe, expect, it } from "vitest";
import { LogReader, MAX_FROM, type PageAnswer, READS_PER_MINUTE } from "../app/lib/log-reader.js";
import { LogStore } from "../app/lib/log-store.js";

function harness() {
  const store = new LogStore();
  const asked: string[] = [];
  const answers: ((a: PageAnswer) => void)[] = [];
  let now = 0;
  const reader = new LogReader({
    store,
    fetchPage: (query) => {
      asked.push(query);
      return new Promise((done) => answers.push(done));
    },
    now: () => now,
  });
  return {
    store,
    asked,
    reader,
    answer: (a: PageAnswer) => (answers.shift() as (a: PageAnswer) => void)(a),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const page = (
  rows: unknown[],
  end: number,
  next: string | null,
  state = "streaming",
): PageAnswer => ({
  status: 200,
  body: { rows, state, end, next_cursor: next },
  retryAfter: null,
});

describe("LogReader", () => {
  it("reads the first missing row in view, one request at a time", async () => {
    const h = harness();
    const first = h.reader.want(0, 50);
    expect(h.asked).toEqual(["from=0&max_bytes=262144"]);
    h.reader.want(0, 50);
    expect(h.asked).toHaveLength(1);
    h.answer(page([{ i: 0, t: 1, c: "a" }], 100, "n1"));
    await first;
    expect(h.store.length).toBe(100);
    h.reader.want(0, 50);
    expect(h.asked.at(-1)).toBe("from=1&max_bytes=262144");
  });

  it("goes on with a split row by its cursor, not from its start", async () => {
    const h = harness();
    const read = h.reader.want(0, 5);
    h.answer(page([{ i: 0, t: 1, c: "ab", o: 0, end: false }], 3, "inside-0"));
    await read;
    h.reader.want(0, 5);
    expect(h.asked.at(-1)).toBe("cursor=inside-0&max_bytes=262144");
  });

  it("reads at most its share a minute", async () => {
    const h = harness();
    for (let k = 0; k < READS_PER_MINUTE + 3; k++) {
      const read = h.reader.want(k, k + 1);
      if (h.asked.length > k) {
        h.answer(page([{ i: k, t: 1, c: "x" }], 1_000, "n"));
        await read;
      }
    }
    expect(h.asked).toHaveLength(READS_PER_MINUTE);
    expect(h.reader.waitMs()).toBeGreaterThan(0);
    h.advance(60_001);
    void h.reader.want(500, 501);
    expect(h.asked).toHaveLength(READS_PER_MINUTE + 1);
  });

  it("names a refusal and reads no more until asked again", async () => {
    const h = harness();
    const read = h.reader.want(0, 5);
    h.answer({ status: 429, body: { code: "log_reads_spent", retry_at: 99 }, retryAfter: "60" });
    await read;
    expect(h.reader.refusal).toEqual({ status: 429, code: "log_reads_spent", retryAt: 99 });
    void h.reader.want(0, 5);
    expect(h.asked).toHaveLength(1);
    h.reader.clearRefusal();
    void h.reader.want(0, 5);
    expect(h.asked).toHaveLength(2);
  });

  it("waits out a busy log a bounded number of times", async () => {
    const h = harness();
    for (let k = 0; k < 6; k++) {
      const read = h.reader.want(0, 5);
      h.answer({ status: 503, body: { code: "log_busy" }, retryAfter: "1" });
      await read;
      h.advance(1_000);
    }
    expect(h.reader.refusal?.code).toBe("log_busy");
    expect(h.reader.retryAfterMs()).toBeNull();
  });

  it("waits out a rate limit a bounded number of times, then leaves it to the viewer", async () => {
    const h = harness();
    let read = h.reader.tail(200);
    for (let k = 0; k < 6; k++) {
      h.answer({ status: 429, body: { code: "rate_limited" }, retryAfter: "1" });
      await read;
      expect(h.reader.retryAfterMs()).toBe(k < 5 ? 60_000 : null);
      h.advance(60_000);
      read = h.reader.retry() as Promise<void>;
    }
    expect(read).toBeUndefined();
    expect(h.asked).toHaveLength(6);
  });

  it("starts at the tail, and follows the log from its last cursor", async () => {
    const h = harness();
    const read = h.reader.tail(200);
    expect(h.asked).toEqual(["tail=200&max_bytes=262144"]);
    h.answer(page([{ i: 9, t: 1, c: "x" }], 10, "after-9"));
    await read;
    const more = h.reader.more();
    expect(h.asked.at(-1)).toBe("cursor=after-9&max_bytes=262144");
    h.answer(page([], 10, null, "complete"));
    await more;
    expect(h.store.closed).toBe(true);
    expect(h.reader.more()).toBeNull();
  });

  it("never asks for rows at or past a terminal end's durable rows", async () => {
    const h = harness();
    const first = h.reader.want(0, 10);
    h.answer(
      page(
        [0, 1, 2, 3, 4].map((i) => ({ i, t: 1, c: "x" })),
        5,
        "after-4",
      ),
    );
    await first;
    h.store.applyLive([{ i: 5, t: 1, c: "half", o: 0, end: false }]);
    h.store.dropUnfinishedFrom(5);
    h.store.applyTerminal(5, "complete");
    expect(h.reader.want(0, 10)).toBeUndefined();
    expect(h.asked).toHaveLength(1);
  });

  it("never asks for a row shown live but not stored, once the log ended", async () => {
    const h = harness();
    const first = h.reader.want(0, 10);
    h.answer(
      page(
        [0, 1, 2, 3, 4].map((i) => ({ i, t: 1, c: "x" })),
        5,
        "after-4",
      ),
    );
    await first;
    h.store.applyLive([
      { i: 5, t: 1, c: "live" },
      { i: 7, t: 1, c: "live" },
    ]);
    h.store.applyTerminal(5, "incomplete");
    expect(h.reader.want(0, 10)).toBeUndefined();
    expect(h.asked).toHaveLength(1);
  });

  it("reads only the ranges in view, never the rows between them", async () => {
    const h = harness();
    const first = h.reader.want(0, 1);
    h.answer(page([{ i: 0, t: 1, c: "x" }], 100_000, "n"));
    await first;
    h.store.applyLive(Array.from({ length: 10 }, (_, k) => ({ i: k, t: 1, c: "x" })));
    void h.reader.wantRanges([
      [0, 10],
      [99_990, 100_000],
    ]);
    expect(h.asked.at(-1)).toBe("from=99990&max_bytes=262144");
  });

  it("asks a line past the API's largest index as that index", () => {
    const h = harness();
    void h.reader.want(9_999_999_998, 9_999_999_999);
    expect(h.asked).toEqual([`from=${MAX_FROM}&max_bytes=262144`]);
  });

  it("retries a refused first read by itself when it is due, without a window", async () => {
    const h = harness();
    const read = h.reader.tail(200);
    h.answer({ status: 503, body: { code: "log_busy" }, retryAfter: "2" });
    await read;
    expect(h.reader.answered).toBe(false);
    expect(h.reader.retryAfterMs()).toBe(2_000);
    expect(h.reader.retry()).toBeUndefined();
    h.advance(2_000);
    const again = h.reader.retry();
    expect(h.asked).toEqual(["tail=200&max_bytes=262144", "tail=200&max_bytes=262144"]);
    h.answer(page([{ i: 9, t: 1, c: "x" }], 10, "after-9"));
    await again;
    expect(h.reader.answered).toBe(true);
    expect(h.reader.refusal).toBeNull();
    expect(h.reader.retry()).toBeUndefined();
  });

  it("asks a refused read again when the viewer tries again", async () => {
    const h = harness();
    const read = h.reader.want(0, 5);
    h.answer({ status: 503, body: { code: "log_unreadable" }, retryAfter: null });
    await read;
    expect(h.reader.retryAfterMs()).toBeNull();
    expect(h.reader.retry()).toBeUndefined();
    h.reader.clearRefusal();
    void h.reader.retry();
    expect(h.asked).toEqual(["from=0&max_bytes=262144", "from=0&max_bytes=262144"]);
  });

  it("keeps a refused read to retry while the minute's share is spent", async () => {
    const h = harness();
    for (let k = 0; k < READS_PER_MINUTE - 1; k++) {
      const read = h.reader.want(k, k + 1);
      h.answer(page([{ i: k, t: 1, c: "x" }], 1_000, "n"));
      await read;
    }
    const busy = h.reader.want(500, 501);
    h.answer({ status: 503, body: { code: "log_busy" }, retryAfter: "1" });
    await busy;
    h.advance(1_000);
    expect(h.reader.retry()).toBeUndefined();
    expect(h.reader.refusal?.code).toBe("log_busy");
    expect(h.reader.retryAfterMs()).toBeGreaterThan(50_000);
    h.advance(60_000);
    expect(h.reader.retry()).toBeDefined();
  });
});
