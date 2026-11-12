// The pool feed deliveries make their calls through: a bounded number under
// way at once, the next started as soon as one ends, outcomes in order.
import { describe, expect, it } from "vitest";
import { settledInPool } from "../src/feed/sink.js";

describe("a pool of calls", () => {
  it("keeps at most its limit under way, and answers each outcome in order", async () => {
    let inFlight = 0;
    let most = 0;
    // Each task waits until released; they are released out of order, a few at a time.
    const waiting = new Map<number, () => void>();
    // Each task announces its start, so the test waits for the pool's own progress.
    let started = 0;
    let reached: { count: number; resolve: () => void } | undefined;
    const startedAtLeast = (count: number) =>
      started >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            reached = { count, resolve };
          });
    const tasks = Array.from({ length: 25 }, (_, i) => async () => {
      inFlight++;
      started++;
      if (reached && started >= reached.count) reached.resolve();
      most = Math.max(most, inFlight);
      await new Promise<void>((resolve) => waiting.set(i, resolve));
      inFlight--;
      if (i % 4 === 0) throw new Error(`no ${i}`);
      return i;
    });
    const settled = settledInPool(tasks, 6);
    for (let released = 0; released < 25; released++) {
      // Wait until the pool has started what it can (its limit, or all that remain),
      // then end the newest task under way.
      await startedAtLeast(Math.min(25, 6 + released));
      const newest = Math.max(...waiting.keys());
      waiting.get(newest)?.();
      waiting.delete(newest);
    }
    const results = await settled;
    expect(most).toBe(6);
    expect(results).toHaveLength(25);
    results.forEach((result, i) => {
      if (i % 4 === 0) expect(result).toEqual({ status: "rejected", reason: new Error(`no ${i}`) });
      else expect(result).toEqual({ status: "fulfilled", value: i });
    });
  });

  it("starts the next as soon as one ends, a slow one holding up no other", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ended = 0;
    const tasks = [
      async () => {
        await slow;
        return "slow";
      },
      ...Array.from({ length: 9 }, () => async () => {
        ended++;
        // The last of the others lets the slow one end.
        if (ended === 9) release();
        return "quick";
      }),
    ];
    const results = await settledInPool(tasks, 2);
    expect(results.map((r) => r.status === "fulfilled" && r.value)).toEqual([
      "slow",
      ...Array(9).fill("quick"),
    ]);
  });

  it("refuses a limit that would start nothing", async () => {
    for (const limit of [0, -1, 0.5, Number.NaN])
      await expect(settledInPool([async () => 1], limit)).rejects.toThrow(RangeError);
  });

  it("takes a task that throws before it awaits, and an empty list", async () => {
    const results = await settledInPool(
      [
        () => {
          throw new Error("at once");
        },
        async () => 1,
      ],
      4,
    );
    expect(results).toEqual([
      { status: "rejected", reason: new Error("at once") },
      { status: "fulfilled", value: 1 },
    ]);
    expect(await settledInPool([], 4)).toEqual([]);
  });
});
