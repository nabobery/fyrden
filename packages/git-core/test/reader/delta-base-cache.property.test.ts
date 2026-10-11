import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DELTA_BASE_ENTRY_OVERHEAD, DeltaBaseCache } from "../../src/reader/delta-base-cache.js";

/*
 * The delta-base cache is an LRU bounded by bytes. Against a model (a list
 * in recency order), any sequence of puts and gets leaves the same keys in
 * the same order, and the bytes held never exceed the capacity.
 */

type Op =
  | { readonly op: "put"; readonly key: number; readonly size: number }
  | { readonly op: "get"; readonly key: number };

const ops = fc.array(
  fc.oneof(
    fc.record({
      op: fc.constant("put" as const),
      key: fc.integer({ min: 0, max: 15 }),
      size: fc.integer({ min: 0, max: 600 }),
    }),
    fc.record({ op: fc.constant("get" as const), key: fc.integer({ min: 0, max: 15 }) }),
  ),
  { maxLength: 200 },
);

describe("delta-base cache", () => {
  it("behaves as a byte-bounded LRU", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2000 }), ops, (capacity, sequence: Op[]) => {
        const cache = new DeltaBaseCache(capacity);
        let model: { key: number; size: number }[] = [];
        const cost = (size: number) => size + DELTA_BASE_ENTRY_OVERHEAD;
        for (const step of sequence) {
          const pack = step.key % 2;
          const offset = 12 + step.key;
          if (step.op === "put") {
            const data = new Uint8Array(step.size).fill(step.key);
            const stored = cache.put(pack, offset, { type: "blob", data });
            model = model.filter((e) => e.key !== step.key);
            expect(stored).toBe(cost(step.size) <= capacity);
            if (stored) {
              model.push({ key: step.key, size: step.size });
              let held = model.reduce((n, e) => n + cost(e.size), 0);
              while (held > capacity) held -= cost((model.shift() as { size: number }).size);
            }
          } else {
            const found = cache.get(pack, offset);
            const at = model.findIndex((e) => e.key === step.key);
            expect(found !== undefined).toBe(at >= 0);
            if (at >= 0) {
              const [entry] = model.splice(at, 1);
              model.push(entry as { key: number; size: number });
              expect(found?.data.length).toBe(entry?.size);
              expect(found?.data.every((b) => b === step.key)).toBe(true);
            }
          }
          expect(cache.bytes).toBeLessThanOrEqual(capacity);
          expect(cache.bytes).toBe(model.reduce((n, e) => n + cost(e.size), 0));
          expect(cache.count).toBe(model.length);
        }
      }),
    );
  });

  it("peek does not change the order", () => {
    const cache = new DeltaBaseCache(3 * (10 + DELTA_BASE_ENTRY_OVERHEAD));
    const entry = { type: "blob" as const, data: new Uint8Array(10) };
    cache.put(0, 12, entry);
    cache.put(0, 13, entry);
    cache.put(0, 14, entry);
    expect(cache.peek(0, 12)).toBe(entry);
    cache.put(0, 15, entry);
    expect(cache.peek(0, 12)).toBeUndefined();
    expect(cache.get(0, 13)).toBe(entry);
  });

  it("rejects a bad capacity", () => {
    expect(() => new DeltaBaseCache(0)).toThrow(RangeError);
    expect(() => new DeltaBaseCache(1.5)).toThrow(RangeError);
  });
});
