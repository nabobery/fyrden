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
