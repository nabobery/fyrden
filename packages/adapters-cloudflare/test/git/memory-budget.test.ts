import { describe, expect, it } from "vitest";
import {
  createDoMemoryBudget,
  DO_MEMORY,
  MemoryWaitTimeoutError,
} from "../../src/git/memory-budget.js";

describe("Durable Object memory pool", () => {
  it("splits the usable memory into the block and index caches and the operation pool", () => {
    expect(
      DO_MEMORY.blockCacheBytes + DO_MEMORY.indexCacheBytes + DO_MEMORY.operationPoolBytes,
    ).toBe(DO_MEMORY.usableBytes);
    expect(createDoMemoryBudget().stats().totalBytes).toBe(72 * 1024 * 1024);
  });

  it("never waits forever: a wait past the pool's limit fails with a clear error", async () => {
    expect(DO_MEMORY.maxWaitMs).toBe(60_000);
    const budget = createDoMemoryBudget(100, { maxWaitMs: 20 });
    // Work that holds most of the pool and then, inside itself, asks for more
    // than is left can never be served: it must fail, not hang.
    const outer = await budget.reserve(70);
    const inner = budget.reserve(40);
    const after = budget.reserve(10);
    await expect(inner).rejects.toThrow(MemoryWaitTimeoutError);
    await expect(inner).rejects.toThrow(
      "40 bytes of working memory did not become free within 20 ms",
    );
    expect((await after).bytes).toBe(10);
    expect(budget.stats()).toMatchObject({ reservedBytes: 80, waiting: 0 });
    outer.release();
  });

  it("ends a wait at the caller's signal before the pool's limit", async () => {
    const budget = createDoMemoryBudget(100, { maxWaitMs: 60_000 });
    const held = await budget.reserve(100);
    const reason = new Error("request ended");
    const wait = budget.reserve(10, AbortSignal.any([AbortSignal.abort(reason)]));
    await expect(wait).rejects.toBe(reason);
    const controller = new AbortController();
    const pending = budget.reserve(10, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(budget.stats().waiting).toBe(0);
    held.release();
  });

  it("gives up a bounded wait so the caller can spill, then serves those behind it", async () => {
    const budget = createDoMemoryBudget(100);
    const held = await budget.reserve(90);
    const big = budget.reserveWithin(60, 20);
    const small = budget.reserveWithin(10, 1_000);
    expect(budget.stats().waiting).toBe(2);
    // The big request leaves the queue at its deadline; the small one fits.
    expect(await big).toBeUndefined();
    const granted = await small;
    expect(granted?.bytes).toBe(10);
    expect(budget.stats()).toEqual({
      totalBytes: 100,
      reservedBytes: 100,
      peakBytes: 100,
      waiting: 0,
    });
    held.release();
    granted?.release();
    expect(budget.stats().reservedBytes).toBe(0);
  });

  it("never reserves past the total under overlapping maximum-size requests", async () => {
    const budget = createDoMemoryBudget(100);
    const work = Array.from({ length: 5 }, async () => {
      const reservation = await budget.reserve(100);
      // biome-ignore lint/style/noRestrictedGlobals: holds the reservation across a turn so the others overlap; the bound asserted holds however long.
      await new Promise((resolve) => setTimeout(resolve, 2));
      reservation.release();
    });
    await Promise.all(work);
    expect(budget.stats()).toMatchObject({ reservedBytes: 0, peakBytes: 100, waiting: 0 });
  });

  it("refuses a zero wait without queueing", async () => {
    const budget = createDoMemoryBudget(10);
    const held = budget.tryReserve(10);
    expect(await budget.reserveWithin(1, 0)).toBeUndefined();
    expect(budget.stats().waiting).toBe(0);
    held?.release();
  });
});

describe("operations started with their share of the pool", () => {
  it("finish one after another where reserving in steps leaves each waiting on the other", async () => {
    // Two pieces of work, each needing 40 bytes of a 100-byte pool and then 30 more.
    const steps = createDoMemoryBudget(100, { maxWaitMs: 20 });
    const held = [await steps.reserve(40), await steps.reserve(40)];
    // Each waits for 30 that only the other's 40 could free.
    await expect(Promise.all([steps.reserve(30), steps.reserve(30)])).rejects.toThrow(
      MemoryWaitTimeoutError,
    );
    for (const reservation of held) reservation.release();

    const budget = createDoMemoryBudget(100, { maxWaitMs: 20 });
    const run = async () => {
      const memory = await budget.begin(70);
      try {
        const first = await memory.reserve(40);
        const second = await memory.reserve(30);
        first.release();
        second.release();
      } finally {
        memory.release();
      }
    };
    await Promise.all([run(), run()]);
    expect(budget.stats()).toMatchObject({ reservedBytes: 0, peakBytes: 70, waiting: 0 });
  });

  it("serves work under way, in arrival order, before operations not yet started", async () => {
    const budget = createDoMemoryBudget(100);
    const operation = await budget.begin(50);
    const own = await operation.reserve(50);
    const other = await budget.reserve(40);
    const later = budget.begin(30);
    // What is free goes to work under way, though an operation waits to start.
    const past = await operation.reserve(10);
    const plain = budget.reserve(5);
    const more = operation.reserve(20);
    expect(budget.stats()).toMatchObject({ reservedBytes: 100, waiting: 3 });
    other.release();
    expect((await plain).bytes).toBe(5);
    expect((await more).bytes).toBe(20);
    // The 15 left do not fit the operation waiting to start.
    expect(budget.stats()).toMatchObject({ reservedBytes: 85, waiting: 1 });
    for (const reservation of [own, past, await more]) reservation.release();
    operation.release();
    const started = await later;
    expect(budget.stats()).toMatchObject({ reservedBytes: 35, waiting: 0 });
    started.release();
    (await plain).release();
  });

  it("serves a reservation of other work queued before an operation's, which it may need to finish", async () => {
    const budget = createDoMemoryBudget(100, { maxWaitMs: 1_000 });
    const operation = await budget.begin(40);
    const own = await operation.reserve(40);
    const other = await budget.reserve(40);
    const brief = await budget.reserve(20);
    // The other work needs 10 more before it can release its 40.
    const otherMore = budget.reserve(10);
    const operationMore = operation.reserve(30);
    brief.release();
    expect((await otherMore).bytes).toBe(10);
    other.release();
    (await otherMore).release();
    expect((await operationMore).bytes).toBe(30);
    for (const reservation of [own, await operationMore]) reservation.release();
    operation.release();
    expect(budget.stats()).toMatchObject({ reservedBytes: 0, waiting: 0 });
  });

  it("answers an operation's later waiter from its share once an earlier one came from the pool", async () => {
    const budget = createDoMemoryBudget(100, { maxWaitMs: 1_000 });
    const operation = await budget.begin(60);
    const own = await operation.reserve(50);
    const others = [await budget.reserve(20), await budget.reserve(20)];
    const first = operation.reserve(20);
    const second = operation.reserve(5);
    others[0]?.release();
    // The first comes from the pool, which is then full; the second fits the share.
    expect((await first).bytes).toBe(20);
    expect((await second).bytes).toBe(5);
    expect(budget.stats()).toMatchObject({ reservedBytes: 100, waiting: 0 });
    for (const reservation of [own, await first, await second, others[1]]) reservation?.release();
    operation.release();
    expect(budget.stats().reservedBytes).toBe(0);
  });

  it("answers an operation's waiter from its own share once the operation frees some", async () => {
    const budget = createDoMemoryBudget(100);
    const operation = await budget.begin(60);
    const other = await budget.reserve(40);
    const first = await operation.reserve(50);
    const second = operation.reserve(20);
    first.release();
    expect((await second).bytes).toBe(20);
    // Nothing more came from the pool, which stayed full.
    expect(budget.stats()).toMatchObject({ reservedBytes: 100, waiting: 0 });
    (await second).release();
    other.release();
    operation.release();
    expect(budget.stats().reservedBytes).toBe(0);
  });

  it("takes an operation's waiter at the front from its share before the pool", async () => {
    const budget = createDoMemoryBudget(100, { maxWaitMs: 1_000 });
    const a = await budget.begin(40);
    const b = await budget.begin(30);
    const held = [await a.reserve(30), await b.reserve(30)];
    const brief = await budget.reserve(30);
    const [a20, a10, b10] = [a.reserve(20), a.reserve(10), b.reserve(10)];
    brief.release();
    // A's 20 comes from the pool, its 10 from its share, leaving room for B's 10.
    expect((await a20).bytes).toBe(20);
    expect((await a10).bytes).toBe(10);
    expect((await b10).bytes).toBe(10);
    expect(budget.stats()).toMatchObject({ reservedBytes: 100, waiting: 0 });
    for (const reservation of [...held, await a20, await a10, await b10]) reservation.release();
    a.release();
    b.release();
    expect(budget.stats().reservedBytes).toBe(0);
  });

  it("ends an operation: its share goes back, its waiters fail and it reserves no more", async () => {
    const budget = createDoMemoryBudget(100);
    const operation = await budget.begin(60);
    const own = await operation.reserve(60);
    const past = await operation.reserve(30);
    const waits = operation.reserve(20);
    operation.release();
    await expect(waits).rejects.toThrow("the operation ended while it waited for memory");
    expect(budget.stats()).toMatchObject({ reservedBytes: 30, waiting: 0 });
    // What it held of its share went back with it; what it held past it stays held.
    own.release();
    expect(budget.stats().reservedBytes).toBe(30);
    past.release();
    expect(budget.stats().reservedBytes).toBe(0);
    await expect(operation.reserve(1)).rejects.toThrow("the operation has ended");
    expect(() => operation.tryReserve(1)).toThrow("the operation has ended");
    operation.release();
    expect(budget.stats().reservedBytes).toBe(0);
  });
});
