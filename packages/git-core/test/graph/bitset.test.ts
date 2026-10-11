import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BitSet } from "../../src/graph/bitset.js";

describe("BitSet", () => {
  it("holds 1M positions in at most 125 KB (one bit per object)", () => {
    const bits = new BitSet(1_000_000);
    expect(bits.byteLength).toBeLessThanOrEqual(125_000);
    bits.set(999_999);
    expect(bits.has(999_999)).toBe(true);
    expect(bits.count()).toBe(1);
  });

  it("uses one bit per position, rounded up to a 32-bit word", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_000_000 }), (size) => {
        const bits = new BitSet(size);
        expect(bits.size).toBe(size);
        expect(bits.byteLength).toBe(4 * Math.ceil(size / 32));
        expect(bits.byteLength).toBeLessThanOrEqual(Math.ceil(size / 8) + 3);
      }),
    );
  });

  it("behaves like a set of integers below its size", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 3000 })
          .chain((size) =>
            fc.tuple(
              fc.constant(size),
              fc.array(fc.integer({ min: 0, max: size - 1 })),
              fc.array(fc.integer({ min: 0, max: size - 1 })),
            ),
          ),
        ([size, added, other]) => {
          const bits = new BitSet(size);
          const model = new Set<number>();
          for (const i of added) {
            expect(bits.set(i)).toBe(!model.has(i));
            model.add(i);
          }
          expect(bits.count()).toBe(model.size);
          expect([...bits.indices()]).toEqual([...model].sort((a, b) => a - b));
          for (let i = 0; i < size; i++) expect(bits.has(i)).toBe(model.has(i));

          const second = new BitSet(size);
          for (const i of other) second.set(i);
          bits.or(second);
          const union = new Set([...model, ...other]);
          expect(bits.count()).toBe(union.size);
          expect([...bits.indices()]).toEqual([...union].sort((a, b) => a - b));
        },
      ),
    );
  });

  it("rejects positions outside its size and mismatched unions", () => {
    const bits = new BitSet(33);
    expect(() => bits.set(33)).toThrow(RangeError);
    expect(() => bits.set(-1)).toThrow(RangeError);
    expect(() => bits.has(1.5)).toThrow(RangeError);
    expect(() => bits.or(new BitSet(34))).toThrow(RangeError);
    expect(() => new BitSet(-1)).toThrow(RangeError);
    expect(() => new BitSet(2 ** 32 + 1)).toThrow(RangeError);
  });

  it("round-trips through bytes, so a mark can be saved between slices", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 3000 })
          .chain((size) =>
            fc.tuple(
              fc.constant(size),
              size === 0 ? fc.constant([]) : fc.array(fc.integer({ min: 0, max: size - 1 })),
            ),
          ),
        ([size, added]) => {
          const bits = new BitSet(size);
          for (const i of added) bits.set(i);
          const bytes = bits.toBytes();
          expect(bytes.length).toBe(bits.byteLength);
          const back = BitSet.fromBytes(size, bytes);
          expect([...back.indices()]).toEqual([...bits.indices()]);
          // A copy: changing one leaves the other alone.
          if (size > 0) {
            back.set(size - 1);
            bits.toBytes();
            expect(BitSet.fromBytes(size, bytes).count()).toBe(bits.count());
          }
        },
      ),
    );
  });

  it("refuses bytes of the wrong length or with bits past its size", () => {
    expect(() => BitSet.fromBytes(33, new Uint8Array(4))).toThrow(RangeError);
    const stray = new Uint8Array(8);
    stray[7] = 0x80;
    expect(() => BitSet.fromBytes(33, stray)).toThrow(RangeError);
  });

  it("complements within its size", () => {
    const bits = new BitSet(37);
    for (const i of [0, 5, 31, 32, 36]) bits.set(i);
    const rest = bits.complement();
    expect(rest.count()).toBe(32);
    for (let i = 0; i < 37; i++) expect(rest.has(i)).toBe(!bits.has(i));
    expect(new BitSet(0).complement().count()).toBe(0);
  });

  it("leaves bits past the size clear so counts stay exact", () => {
    const bits = new BitSet(33);
    for (let i = 0; i < 33; i++) bits.set(i);
    expect(bits.count()).toBe(33);
    expect(new BitSet(0).count()).toBe(0);
    expect([...new BitSet(0).indices()]).toEqual([]);
  });
});
