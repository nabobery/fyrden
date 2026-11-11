import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IDX_FANOUT_ENTRIES, IDX_OIDS_START } from "../../src/pack/idx-format.js";
import {
  type IdxRangeReader,
  openRangedIdx,
  RangedPackIdx,
} from "../../src/pack/idx-range-read.js";

/*
 * A pack index read by ranges can be given a limit on one read. A fanout
 * bucket within it is read whole, as without one. A larger bucket is searched
 * by pages of at most the limit, and answers as a whole read does: the first
 * copy of an id, whichever pages its copies fall on. A pusher chooses the ids
 * in a pack, so a bucket can be most of it.
 */

const OID = 20;
const BUCKET = 0x42;

/** A fanout with `count` ids in the one bucket `BUCKET`. */
function fanoutOf(count: number): Uint32Array {
  const fanout = new Uint32Array(IDX_FANOUT_ENTRIES);
  fanout.fill(count, BUCKET);
  return fanout;
}

/** The id `k` of a bucket, sorted by `k`. */
function oidOf(k: number): Uint8Array {
  const oid = new Uint8Array(OID);
  oid[0] = BUCKET;
  new DataView(oid.buffer).setUint32(1, k);
  return oid;
}

/** An index's oid table and offsets, with the offset of position `p` being `p + 12`. */
function indexOver(keys: readonly number[]): { read: IdxRangeReader; reads: number[] } {
  const count = keys.length;
  const oidsAt = IDX_OIDS_START;
  const offsetsAt = oidsAt + count * OID + count * 4;
  const bytes = new Uint8Array(offsetsAt + count * 4);
  const view = new DataView(bytes.buffer);
  keys.forEach((key, position) => {
    bytes.set(oidOf(key), oidsAt + position * OID);
    view.setUint32(offsetsAt + position * 4, position + 12);
  });
  const reads: number[] = [];
  return {
    reads,
    read: async (offset, length) => {
      reads.push(length);
      return bytes.subarray(offset, offset + length);
    },
  };
}

function firstCopy(keys: readonly number[], key: number): number {
  return keys.indexOf(key);
}

describe("RangedPackIdx with a limit on one read", () => {
  it("finds the first copy on any page, and never reads more than the limit", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 200 }),
        fc.integer({ min: OID, max: 12 * OID + 19 }),
        fc.integer({ min: 0, max: 41 }),
        async (unsorted, maxReadBytes, key) => {
          const keys = [...unsorted].sort((a, b) => a - b);
          const { read, reads } = indexOver(keys);
          const idx = RangedPackIdx.withFanout(
            read,
            fanoutOf(keys.length),
            undefined,
            maxReadBytes,
          );
          expect(await idx.find(oidOf(key))).toBe(firstCopy(keys, key));
          for (const length of reads) expect(length).toBeLessThanOrEqual(maxReadBytes);
        },
      ),
    );
  });

  it("finds the first copy when its copies cross a page's start and fill whole pages", async () => {
    // Pages of 3: every position of a run of each length below.
    for (const run of [2, 3, 4, 7, 10]) {
      for (let start = 0; start <= 24 - run; start++) {
        const keys = Array.from({ length: 24 }, (_, i) =>
          i < start ? i : i < start + run ? 100 : 100 + i,
        );
        const { read } = indexOver(keys);
        const idx = RangedPackIdx.withFanout(read, fanoutOf(keys.length), undefined, 3 * OID);
        expect(await idx.find(oidOf(100))).toBe(start);
      }
    }
  });

  it("reads a bucket up to the limit whole, with one read", async () => {
    const keys = Array.from({ length: 6 }, (_, i) => i);
    const { read, reads } = indexOver(keys);
    const idx = RangedPackIdx.withFanout(read, fanoutOf(6), undefined, 6 * OID);
    expect(await idx.find(oidOf(4))).toBe(4);
    expect(reads).toEqual([6 * OID]);
  });

  it("reads one page more than a limit's worth of bucket, not the bucket", async () => {
    const keys = Array.from({ length: 7 }, (_, i) => i);
    const { read, reads } = indexOver(keys);
    const idx = RangedPackIdx.withFanout(read, fanoutOf(7), undefined, 6 * OID);
    expect(await idx.find(oidOf(6))).toBe(6);
    expect(reads).toEqual([6 * OID, OID]);
  });

  it("searches a 20 MiB bucket with 128 KiB reads, in about eight of them", async () => {
    // Made on demand: a bucket this size isn't held to test it.
    const count = 1024 * 1024;
    const maxReadBytes = 128 * 1024;
    const reads: number[] = [];
    const read: IdxRangeReader = async (offset, length) => {
      reads.push(length);
      const out = new Uint8Array(length);
      for (let at = 0; at < length; at += OID) {
        const position = (offset + at - IDX_OIDS_START) / OID;
        out.set(oidOf(position * 2), at);
      }
      return out;
    };
    const idx = RangedPackIdx.withFanout(read, fanoutOf(count), undefined, maxReadBytes);
    for (const position of [0, 1, count >> 1, count - 1]) {
      reads.length = 0;
      expect(await idx.find(oidOf(position * 2))).toBe(position);
      expect(Math.max(...reads)).toBeLessThanOrEqual(maxReadBytes);
      expect(reads.length).toBeLessThanOrEqual(9);
      reads.length = 0;
      expect(await idx.find(oidOf(position * 2 + 1))).toBe(-1);
      expect(reads.length).toBeLessThanOrEqual(9);
    }
  });

  it("stops on a table out of order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 100 }),
        fc.integer({ min: 0, max: 41 }),
        async (keys, key) => {
          const { read, reads } = indexOver(keys);
          const idx = RangedPackIdx.withFanout(read, fanoutOf(keys.length), undefined, 3 * OID);
          const found = await idx.find(oidOf(key));
          expect(found).toBeGreaterThanOrEqual(-1);
          expect(found).toBeLessThan(keys.length);
          expect(reads.length).toBeLessThanOrEqual(keys.length);
        },
      ),
    );
  });

  it("counts every page in a lookup's budget, then the offset", async () => {
    const keys = Array.from({ length: 100 }, (_, i) => i);
    const { read, reads } = indexOver(keys);
    const idx = RangedPackIdx.withFanout(read, fanoutOf(100), undefined, 4 * OID);
    const budget = { reads: 0, maxReads: Number.POSITIVE_INFINITY };
    expect(await idx.lookup(oidOf(37), 0, budget)).toEqual({ position: 37, offset: 49 });
    expect(budget.reads).toBe(reads.length);
    expect(reads.at(-1)).toBe(4);
  });

  it("takes the limit when opened from the header", async () => {
    const keys = Array.from({ length: 50 }, (_, i) => i);
    const { read, reads } = indexOver(keys);
    const idx = await openRangedIdx(read, {
      fanout: fanoutOf(50),
      maxReadBytes: 5 * OID,
    });
    expect(await idx.find(oidOf(25))).toBe(25);
    expect(Math.max(...reads)).toBeLessThanOrEqual(5 * OID);
  });

  it("refuses a limit under one id", () => {
    const { read } = indexOver([1]);
    expect(() => RangedPackIdx.withFanout(read, fanoutOf(1), undefined, OID - 1)).toThrow(
      RangeError,
    );
  });

  it("reads the bucket whole without a limit", async () => {
    const keys = Array.from({ length: 50 }, (_, i) => i);
    const { read, reads } = indexOver(keys);
    const idx = RangedPackIdx.withFanout(read, fanoutOf(50));
    expect(await idx.find(oidOf(25))).toBe(25);
    expect(reads).toEqual([50 * OID]);
  });
});
