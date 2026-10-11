import { describe, expect, it } from "vitest";
import type { MemoryBudget } from "../../src/ports/memory-budget.js";

/** The behaviour every `MemoryBudget` must have. `create(n)` returns a budget of n bytes. */
export function describeMemoryBudgetContract(
  name: string,
  create: (totalBytes: number) => Promise<MemoryBudget>,
): void {
  describe(`${name}: MemoryBudget contract`, () => {
    it("grants what is free and refuses more", async () => {
      const budget = await create(100);
      const a = budget.tryReserve(60);
      expect(a?.bytes).toBe(60);
      expect(budget.tryReserve(41)).toBeUndefined();
      const b = budget.tryReserve(40);
      expect(b?.bytes).toBe(40);
      a?.release();
      expect(budget.tryReserve(60)).toBeDefined();
    });

    it("makes a reservation wait until enough is released, in arrival order", async () => {
      const budget = await create(100);
      const held = await budget.reserve(80);
      const order: string[] = [];
      const big = budget.reserve(50).then((r) => {
        order.push("big");
        return r;
      });
      const small = budget.reserve(10).then((r) => {
        order.push("small");
        return r;
      });
      await Promise.resolve();
      // The small request waits behind the big one, so the big one cannot starve.
      expect(order).toEqual([]);
      expect(budget.tryReserve(10)).toBeUndefined();
      held.release();
      await Promise.all([big, small]);
      expect(order).toEqual(["big", "small"]);
    });

    it("stops waiting when the signal aborts, with its reason, and lets later waiters through", async () => {
      const budget = await create(100);
      const held = await budget.reserve(80);
      const controller = new AbortController();
      const big = budget.reserve(50, controller.signal);
      const small = budget.reserve(10);
      await Promise.resolve();
      const reason = new Error("the request ended");
      controller.abort(reason);
      await expect(big).rejects.toBe(reason);
      // The small one waited behind the big one only; it fits now.
      expect((await small).bytes).toBe(10);
      // Nothing of the aborted wait was kept.
      expect(budget.tryReserve(10)?.bytes).toBe(10);
      expect(budget.tryReserve(1)).toBeUndefined();
      held.release();
    });

    it("refuses at once with a signal that has already aborted, and keeps a grant made before an abort", async () => {
      const budget = await create(100);
      const aborted = new AbortController();
      aborted.abort(new Error("too late"));
      await expect(budget.reserve(10, aborted.signal)).rejects.toThrow("too late");
      expect(budget.tryReserve(100)?.bytes).toBe(100);

      const other = await create(100);
      const controller = new AbortController();
      const granted = await other.reserve(60, controller.signal);
      controller.abort();
      expect(granted.bytes).toBe(60);
      expect(other.tryReserve(41)).toBeUndefined();
      granted.release();
      expect(other.tryReserve(100)).toBeDefined();
    });

    it("ignores a second release", async () => {
      const budget = await create(100);
      const a = await budget.reserve(100);
      a.release();
      a.release();
      await budget.reserve(100);
      expect(budget.tryReserve(1)).toBeUndefined();
    });

    it("refuses sizes it can never grant", async () => {
      const budget = await create(100);
      await expect(budget.reserve(101)).rejects.toThrow(RangeError);
      await expect(budget.reserve(0)).rejects.toThrow(RangeError);
      expect(() => budget.tryReserve(-1)).toThrow(RangeError);
      expect(() => budget.tryReserve(1.5)).toThrow(RangeError);
    });
  });
}
