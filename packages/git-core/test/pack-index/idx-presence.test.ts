import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { OID_BYTES } from "../../src/object/oid.js";
import { IDX_OIDS_START, idxLayout } from "../../src/pack/idx-format.js";
import { openRangedIdx } from "../../src/pack/idx-range-read.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { type IdxWriteInput, writeIdx } from "../../src/pack/idx-write.js";
import { idxHasher, randomOids } from "./support.js";

/*
 * Presence of many ids in an index read by ranges (`hasMany`) reads only
 * the oid table: neither the 32-bit offsets nor the 64-bit ones, so its
 * reads do not grow with the matches stored past 2 GiB.
 */

const PACK_CHECKSUM = new Uint8Array(20).fill(9);
const oidArb = fc.uint8Array({ minLength: OID_BYTES, maxLength: OID_BYTES });

/** An index over `input`, opened from its fanout, with every read recorded as [offset, length]. */
async function recorded(input: IdxWriteInput) {
  const written = await writeIdx(input, PACK_CHECKSUM, { createHasher: idxHasher });
  const reads: [number, number][] = [];
  const ranged = await openRangedIdx(
    async (offset, length) => {
      reads.push([offset, length]);
      return written.bytes.subarray(offset, offset + length);
    },
    { fanout: written.fanout, byteLength: written.bytes.length },
  );
  const layout = idxLayout(input.count, written.largeOffsetCount);
  /** Whether a read lies wholly inside the oid table. */
  const inOidTable = ([offset, length]: [number, number]) =>
    offset >= layout.oidsAt && offset + length <= layout.crc32sAt;
  return { written, idx: PackIdx.parse(written.bytes), ranged, reads, inOidTable };
}

/** Entries over `oids`, the first at offset 12 and every later one past 2^31 (a 64-bit offset each). */
function largeOffsetEntries(oids: Uint8Array): IdxWriteInput {
  const count = oids.length / OID_BYTES;
  return {
    count,
    oids,
    offsets: Float64Array.from({ length: count }, (_, i) => (i === 0 ? 12 : 2 ** 31 + i * 4096)),
    crc32s: Uint32Array.from({ length: count }, (_, i) => i + 1),
  };
}

const oidAt = (input: IdxWriteInput, i: number) =>
  input.oids.slice(i * OID_BYTES, (i + 1) * OID_BYTES);

/** Entries with narrow first bytes sometimes (crowded buckets), duplicates, and offsets on either side of 2^31. */
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
        oidArb.map((o) => {
          const edge = o.slice();
          edge[0] = (edge[0] as number) & 1 ? 0xff : 0x00;
          return edge;
        }),
      ),
      { maxLength: 200 },
    ),
    dupEvery: fc.integer({ min: 0, max: 4 }),
    largeFrom: fc.integer({ min: 1, max: 201 }),
  })
  .map(({ oids, dupEvery, largeFrom }): IdxWriteInput => {
    const all = [...oids];
    if (dupEvery > 0)
      for (let i = 0; i < oids.length; i += dupEvery) all.push(oids[i] as (typeof oids)[number]);
    const count = all.length;
    const packed = new Uint8Array(count * OID_BYTES);
    for (const [i, o] of all.entries()) packed.set(o, i * OID_BYTES);
    // The first entry is at 12, as in a real pack; from `largeFrom` on, past 2^31.
    const offsets = Float64Array.from({ length: count }, (_, i) =>
      i === 0 ? 12 : i < largeFrom ? 12 + i * 64 : 2 ** 31 + i * 64,
    );
    return { count, oids: packed, offsets, crc32s: new Uint32Array(count) };
  });

describe("RangedPackIdx.hasMany", () => {
  it("answers each id as present or absent, as find does, reading only the oid table", async () => {
    await fc.assert(
      fc.asyncProperty(
        entriesArb,
        fc.array(oidArb, { maxLength: 30 }),
        fc.constantFrom(1, 20, 64, 1000, 1 << 20),
        async (input, probes, span) => {
          const { idx, ranged, reads, inOidTable } = await recorded(input);
          const present = Array.from({ length: input.count }, (_, i) => oidAt(input, i));
          // Present ids, absent ones, and repeats of both.
          const oids = [...present, ...probes, ...present.slice(0, 5), ...probes.slice(0, 5)];
          const want = oids.map((oid) => idx.find(oid) >= 0);
          expect(await ranged.hasMany(oids, span)).toEqual(want);
          expect(reads.filter((read) => !inOidTable(read))).toEqual([]);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("reads neither offset table when every match has a 64-bit offset", async () => {
    const input = largeOffsetEntries(randomOids(40, 11));
    const { written, ranged, reads, inOidTable } = await recorded(input);
    expect(written.largeOffsetCount).toBe(39);
    const absent = randomOids(10, 12);
    const oids = [
      ...Array.from({ length: input.count }, (_, i) => oidAt(input, i)),
      ...Array.from({ length: 10 }, (_, i) => absent.slice(i * OID_BYTES, (i + 1) * OID_BYTES)),
    ];
    const found = await ranged.hasMany(oids);
    expect(found).toEqual([
      ...new Array<boolean>(40).fill(true),
      ...new Array<boolean>(10).fill(false),
    ]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((read) => !inOidTable(read))).toEqual([]);
  });

  it("costs one read for many large-offset matches, where lookupMany reads each one's offset", async () => {
    // One id per fanout bucket, so the whole oid table is one coalesced read.
    const count = 256;
    const input = largeOffsetEntries(
      Uint8Array.from({ length: count * OID_BYTES }, (_, i) => Math.floor(i / OID_BYTES)),
    );
    const oids = Array.from({ length: 200 }, (_, i) => new Uint8Array(OID_BYTES).fill(i + 56));

    const presence = await recorded(input);
    expect(await presence.ranged.hasMany(oids)).toEqual(new Array<boolean>(200).fill(true));
    // Buckets 56 to 255: one span of their 200 ids.
    expect(presence.reads).toEqual([[IDX_OIDS_START + 56 * OID_BYTES, 200 * OID_BYTES]]);
    expect(presence.reads.every(presence.inOidTable)).toBe(true);

    // The offset-returning lookup is unchanged: the oid table, the 32-bit offsets, then one
    // read of a 64-bit offset per match.
    const located = await recorded(input);
    const found = await located.ranged.lookupMany(oids);
    expect(found.every((f) => f !== undefined && f !== null && f.offset >= 2 ** 31)).toBe(true);
    expect(located.reads.length).toBe(2 + 200);
  });

  it("answers ids in empty buckets, and an empty batch, without a read", async () => {
    // Only buckets 0x00 and 0xff hold ids: the first and last of the fanout.
    const oids = new Uint8Array(4 * OID_BYTES);
    oids.fill(0x00, 0, OID_BYTES);
    oids.fill(0x00, OID_BYTES, 2 * OID_BYTES - 1).fill(0x01, 2 * OID_BYTES - 1, 2 * OID_BYTES);
    oids.fill(0xff, 2 * OID_BYTES, 3 * OID_BYTES - 1).fill(0xfe, 3 * OID_BYTES - 1, 3 * OID_BYTES);
    oids.fill(0xff, 3 * OID_BYTES);
    const input = largeOffsetEntries(oids);
    const { ranged, reads, inOidTable } = await recorded(input);

    expect(await ranged.hasMany([])).toEqual([]);
    const emptyBuckets = [0x01, 0x7f, 0xfe].map((b) => new Uint8Array(OID_BYTES).fill(b));
    expect(await ranged.hasMany(emptyBuckets)).toEqual([false, false, false]);
    expect(reads).toEqual([]);

    // The edge buckets' ids, and absent ids in those buckets, one id per read at most.
    const probe = (first: number, last: number) => {
      const oid = new Uint8Array(OID_BYTES).fill(first);
      oid[OID_BYTES - 1] = last;
      return oid;
    };
    const asked = [
      oidAt(input, 3),
      oidAt(input, 0),
      probe(0x00, 0x02),
      oidAt(input, 1),
      oidAt(input, 2),
      probe(0xff, 0x00),
      probe(0xff, 0xfd),
    ];
    expect(await ranged.hasMany(asked, OID_BYTES)).toEqual([
      true,
      true,
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(inOidTable)).toBe(true);
  });
});
