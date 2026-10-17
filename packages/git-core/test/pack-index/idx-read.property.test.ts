import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BitSet } from "../../src/graph/bitset.js";
import { OidTable } from "../../src/graph/oid-table.js";
import { markPositions } from "../../src/graph/reachability.js";
import { compareOids, OID_BYTES, type Oid, oidFromBytes } from "../../src/object/oid.js";
import { decodeFanout, encodeFanout } from "../../src/pack/idx-format.js";
import { openRangedIdx } from "../../src/pack/idx-range-read.js";
import {
  type IdxEntry,
  type IdxLocation,
  type IdxLookup,
  PackIdx,
} from "../../src/pack/idx-read.js";
import { type IdxWriteInput, writeIdx } from "../../src/pack/idx-write.js";
import { countingReader, hex, idxHasher } from "./support.js";

/*
 * Property: for any set of entries (duplicates included), both readers
 * answer every lookup as a Map built from the same entries does, and the
 * ranged reader issues no read at all for an oid whose fanout bucket is empty.
 */

const PACK_CHECKSUM = new Uint8Array(20).fill(7);

const oidArb = fc.uint8Array({ minLength: 20, maxLength: 20 });

/** Entries with a narrow first byte sometimes, so buckets hold many oids and duplicates. */
const entriesArb = fc
  .record({
    oids: fc.array(
      fc.oneof(
        oidArb,
        oidArb.map((o) => {
          const narrow = o.slice();
          narrow[0] = (narrow[0] as number) & 0x03;
          return narrow;
        }),
      ),
      { maxLength: 300 },
    ),
    dupEvery: fc.integer({ min: 0, max: 5 }),
    bigOffsets: fc.boolean(),
  })
  .map(({ oids, dupEvery, bigOffsets }): IdxWriteInput => {
    const all = [...oids];
    if (dupEvery > 0)
      for (let i = 0; i < oids.length; i += dupEvery) all.push(oids[i] as (typeof oids)[number]);
    const count = all.length;
    const packed = new Uint8Array(count * OID_BYTES);
    for (const [i, o] of all.entries()) packed.set(o, i * OID_BYTES);
    const offsets = new Float64Array(count);
    const crc32s = new Uint32Array(count);
    let offset = 12;
    for (let i = 0; i < count; i++) {
      offsets[i] = offset;
      offset += bigOffsets ? 2 ** 28 + i : 30 + i;
      crc32s[i] = (Math.imul(i + 1, 0x9e3779b1) >>> 0) as number;
    }
    return { count, oids: packed, offsets, crc32s };
  });

/** A lookup's answer without its CRC32, as an index read by ranges gives it. */
function location(found: IdxLookup | undefined): IdxLocation | undefined {
  return found && { position: found.position, offset: found.offset };
}

/** The first entry (lowest offset) for each oid, as a lookup should return. */
function model(input: IdxWriteInput): Map<string, { offset: number; crc32: number }> {
  const map = new Map<string, { offset: number; crc32: number }>();
  for (let i = 0; i < input.count; i++) {
    const key = hex(input.oids.subarray(i * OID_BYTES, (i + 1) * OID_BYTES));
    const offset = input.offsets[i] as number;
    const existing = map.get(key);
    if (!existing || offset < existing.offset) {
      map.set(key, { offset, crc32: input.crc32s[i] as number });
    }
  }
  return map;
}

describe("idx readers agree with a Map", () => {
  it("whole-buffer and ranged lookups, present and absent", async () => {
    await fc.assert(
      fc.asyncProperty(entriesArb, fc.array(oidArb, { maxLength: 40 }), async (input, probes) => {
        const written = await writeIdx(input, PACK_CHECKSUM, { createHasher: idxHasher });
        const idx = PackIdx.parse(written.bytes);
        const expected = model(input);
        expect(idx.count).toBe(input.count);
        expect(idx.packChecksum()).toEqual(PACK_CHECKSUM);
        expect(idx.byteLength).toBe(written.bytes.length);
        expect(await idx.verifyChecksum(idxHasher)).toBe(true);
        expect(encodeFanout(idx.fanout)).toEqual(written.bytes.subarray(8, 8 + 1024));
        expect(decodeFanout(encodeFanout(written.fanout))).toEqual(written.fanout);

        const reader = countingReader(written.bytes);
        const ranged = await openRangedIdx(reader, { fanout: written.fanout });
        expect(reader.calls).toBe(0);

        const queries = [
          ...expected.keys(),
          ...probes.map((p) => hex(p)).filter((p) => !expected.has(p)),
        ];
        for (const key of queries) {
          const oid = Uint8Array.from(Buffer.from(key, "hex"));
          const want = expected.get(key);
          const got = idx.lookup(oid);
          const before = reader.calls;
          const gotRanged = await ranged.lookup(oid);
          if (!want) {
            expect(got).toBeUndefined();
            expect(gotRanged).toBeUndefined();
            expect(idx.find(oid)).toBe(-1);
            const bucket = oid[0] as number;
            const lo = bucket === 0 ? 0 : (written.fanout[bucket - 1] as number);
            if (lo === written.fanout[bucket]) expect(reader.calls).toBe(before);
            continue;
          }
          expect(got).toEqual({ position: got?.position, ...want });
          expect(gotRanged).toEqual({ position: got?.position, offset: want.offset });
          expect(hex(idx.oidAt(got?.position as number))).toBe(key);
          expect(hex(await ranged.oidAt(got?.position as number))).toBe(key);
          // The position is the first of a run of equal oids.
          const p = got?.position as number;
          if (p > 0) expect(hex(idx.oidAt(p - 1))).not.toBe(key);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("batched lookups answer as single lookups, whatever the read span", async () => {
    await fc.assert(
      fc.asyncProperty(
        entriesArb,
        fc.array(oidArb, { maxLength: 40 }),
        fc.constantFrom(1, 20, 64, 1000, 1 << 20),
        async (input, probes, span) => {
          const written = await writeIdx(input, PACK_CHECKSUM, { createHasher: idxHasher });
          const idx = PackIdx.parse(written.bytes);
          const ranged = await openRangedIdx(countingReader(written.bytes), {
            fanout: written.fanout,
          });
          const oids = [
            ...[...model(input).keys()].map((key) => Uint8Array.from(Buffer.from(key, "hex"))),
            ...probes,
          ];
          const single = oids.map((oid) => idx.lookup(oid));
          expect(idx.lookupMany(oids)).toEqual(single);
          expect(await ranged.lookupMany(oids, undefined, span)).toEqual(single.map(location));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("a batched lookup under a read budget stays within it and answers the rest as single lookups", async () => {
    await fc.assert(
      fc.asyncProperty(
        entriesArb,
        fc.array(oidArb, { maxLength: 40 }),
        fc.constantFrom(1, 20, 64, 1000),
        fc.integer({ min: 0, max: 12 }),
        async (input, probes, span, maxReads) => {
          const written = await writeIdx(input, PACK_CHECKSUM, { createHasher: idxHasher });
          const idx = PackIdx.parse(written.bytes);
          const reader = countingReader(written.bytes);
          const ranged = await openRangedIdx(reader, { fanout: written.fanout });
          const oids = [
            ...[...model(input).keys()].map((key) => Uint8Array.from(Buffer.from(key, "hex"))),
            ...probes,
          ];
          const budget = { reads: 0, maxReads };
          const found = await ranged.lookupMany(oids, budget, span);
          expect(budget.reads).toBe(reader.calls);
          expect(budget.reads).toBeLessThanOrEqual(maxReads);
          for (const [i, oid] of oids.entries()) {
            if (found[i] !== null) expect(found[i]).toEqual(location(idx.lookup(oid)));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("a batched lookup on a small index reads each table once", async () => {
    const input: IdxWriteInput = {
      count: 256,
      oids: Uint8Array.from({ length: 256 * OID_BYTES }, (_, i) => Math.floor(i / OID_BYTES)),
      offsets: Float64Array.from({ length: 256 }, (_, i) => 12 + i * 40),
      crc32s: new Uint32Array(256),
    };
    const written = await writeIdx(input, PACK_CHECKSUM, { createHasher: idxHasher });
    const reader = countingReader(written.bytes);
    const ranged = await openRangedIdx(reader, { fanout: written.fanout });
    const oids = Array.from({ length: 200 }, (_, i) => new Uint8Array(OID_BYTES).fill(i));
    const found = await ranged.lookupMany(oids);
    expect(found.every((f) => f !== undefined)).toBe(true);
    // The oid table and the offsets: two reads for 200 oids.
    expect(reader.calls).toBe(2);
  });

  it("a ranged lookup reads the oid's bucket and its offset, never its CRC32", async () => {
    const count = 64;
    const input: IdxWriteInput = {
      count,
      oids: Uint8Array.from({ length: count * OID_BYTES }, (_, i) =>
        i % OID_BYTES === 0 ? i / OID_BYTES : 1,
      ),
      offsets: Float64Array.from({ length: count }, (_, i) => 12 + i * 40),
      crc32s: Uint32Array.from({ length: count }, (_, i) => i + 1),
    };
    const written = await writeIdx(input, PACK_CHECKSUM, { createHasher: idxHasher });
    const reads: [number, number][] = [];
    const ranged = await openRangedIdx(
      async (offset, length) => {
        reads.push([offset, length]);
        return written.bytes.subarray(offset, offset + length);
      },
      { fanout: written.fanout },
    );
    const budget = { reads: 0, maxReads: Number.POSITIVE_INFINITY };
    const oid = input.oids.subarray(7 * OID_BYTES, 8 * OID_BYTES);
    expect(await ranged.lookup(oid, 0, budget)).toEqual({ position: 7, offset: 12 + 7 * 40 });
    // The bucket's one oid, then the offset after the CRC32 table.
    const oidsAt = 8 + 1024;
    const offsetsAt = oidsAt + count * (OID_BYTES + 4);
    expect(reads).toEqual([
      [oidsAt + 7 * OID_BYTES, OID_BYTES],
      [offsetsAt + 7 * 4, 4],
    ]);
    expect(budget.reads).toBe(2);
    expect(await ranged.crc32At(7)).toBe(8);
  });

  it("iterates by position in oid order, offsets and CRCs intact", async () => {
    await fc.assert(
      fc.asyncProperty(entriesArb, async (input) => {
        const written = await writeIdx(input, PACK_CHECKSUM, { createHasher: idxHasher });
        const idx = PackIdx.parse(written.bytes);
        const listed = [...idx.entries()];
        expect(listed.length).toBe(input.count);
        const fromInput = new Set<string>();
        for (let i = 0; i < input.count; i++) {
          const oid = hex(input.oids.subarray(i * OID_BYTES, (i + 1) * OID_BYTES));
          fromInput.add(`${oid} ${input.offsets[i]} ${input.crc32s[i]}`);
        }
        const fromIdx = new Set(listed.map((e) => `${hex(e.oid)} ${e.offset} ${e.crc32}`));
        expect(fromIdx).toEqual(fromInput);
        for (let p = 1; p < listed.length; p++) {
          const a = listed[p - 1] as IdxEntry;
          const b = listed[p] as IdxEntry;
          const order = compareOids(a.oid, b.oid);
          // Sorted by oid; copies of one oid in pack (offset) order.
          expect(order < 0 || (order === 0 && a.offset < b.offset)).toBe(true);
          expect(b.position).toBe(p);
        }
        for (const e of listed) {
          expect(idx.offsetAt(e.position)).toBe(e.offset);
          expect(idx.crc32At(e.position)).toBe(e.crc32);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("feeds markPositions for reachability bitsets", async () => {
    await fc.assert(
      fc.asyncProperty(entriesArb, fc.array(oidArb, { maxLength: 20 }), async (input, extra) => {
        const written = await writeIdx(input, PACK_CHECKSUM, { createHasher: idxHasher });
        const idx = PackIdx.parse(written.bytes);
        const commits = new OidTable();
        for (let i = 0; i < input.count; i += 2) commits.add(oidFromBytes(input.oids, i * 20));
        for (const o of extra) commits.add(o as Oid);
        const bits = new BitSet(idx.count);
        markPositions(commits, idx.positionOf, bits);
        for (const oid of commits) {
          const p = idx.find(oid);
          if (p >= 0) expect(bits.has(p)).toBe(true);
        }
        let set = 0;
        for (let p = 0; p < idx.count; p++) if (bits.has(p)) set++;
        expect(set).toBe([...commits].filter((o) => idx.find(o) >= 0).length);
      }),
      { numRuns: 50 },
    );
  });

  it("ranged reader opened without a fanout reads the header once", async () => {
    const input: IdxWriteInput = {
      count: 3,
      oids: Uint8Array.from(
        [0x10, 0x20, 0x30].flatMap((b) => [b, ...new Array<number>(19).fill(1)]),
      ),
      offsets: Float64Array.from([12, 40, 90]),
      crc32s: Uint32Array.from([1, 2, 3]),
    };
    const written = await writeIdx(input, PACK_CHECKSUM, { createHasher: idxHasher });
    const reader = countingReader(written.bytes);
    const ranged = await openRangedIdx(reader);
    expect(reader.calls).toBe(1);
    expect(ranged.count).toBe(3);
    expect(ranged.fanout).toEqual(written.fanout);
    const absent = new Uint8Array(20).fill(0x50);
    expect(await ranged.find(absent)).toBe(-1);
    expect(reader.calls).toBe(1);
    expect(await ranged.lookup(input.oids.subarray(20, 40))).toEqual({ position: 1, offset: 40 });
  });
});
