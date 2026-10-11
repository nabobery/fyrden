import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FALSE_POSITIVE_RATE,
  EXISTENCE_FILTER_VERSION,
  ExistenceFilterError,
  MAX_FILTER_CHUNK_BYTES,
  OidBloomFilter,
} from "../../src/pack/existence-filter.js";
import { randomOids } from "./support.js";

/*
 * The per-pack bloom filter: no false negatives ever, a measured false
 * positive rate close to the configured one, about 1.2 MB per million oids
 * at 1%, and a versioned byte form split into rows of at most 1.5 MiB.
 */

const oidArb = fc.uint8Array({ minLength: 20, maxLength: 20 });

describe("OidBloomFilter", () => {
  it("never misses an oid it holds (property)", () => {
    fc.assert(
      fc.property(
        fc.array(oidArb, { maxLength: 500 }),
        fc.constantFrom(0.5, 0.1, 0.01, 0.001),
        fc.integer({ min: 0, max: 3 }),
        (oids, rate, undersize) => {
          // Also when more oids are added than the filter was sized for.
          const filter = OidBloomFilter.create(Math.floor(oids.length / (undersize + 1)), rate);
          for (const oid of oids) filter.add(oid);
          for (const oid of oids) expect(filter.mayContain(oid)).toBe(true);
          const restored = OidBloomFilter.fromChunks(filter.toChunks(64));
          for (const oid of oids) expect(restored.mayContain(oid)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reads oids in place from a packed table", () => {
    const table = randomOids(50, 3);
    const filter = OidBloomFilter.create(50);
    filter.addAll(table, 50);
    for (let i = 0; i < 50; i++) expect(filter.mayContain(table, i * 20)).toBe(true);
  });

  it("has a measured false positive rate within tolerance of the target on 100k oids", () => {
    const n = 100_000;
    const members = randomOids(n, 11);
    const absent = randomOids(n, 12);
    for (const rate of [DEFAULT_FALSE_POSITIVE_RATE, 0.05]) {
      const filter = OidBloomFilter.create(n, rate);
      filter.addAll(members, n);
      let positives = 0;
      for (let i = 0; i < n; i++) if (filter.mayContain(absent, i * 20)) positives++;
      const measured = positives / n;
      console.info(
        `bloom at ${rate}: measured false positive rate ${(measured * 100).toFixed(2)}%`,
      );
      // Binomial standard deviation at 1% over 100k probes is 0.03 points;
      // the tolerance is ±20% of the target.
      expect(measured).toBeGreaterThan(rate * 0.8);
      expect(measured).toBeLessThan(rate * 1.2);
    }
  });

  it("costs about 1.2 MB per million oids at 1% false positives", () => {
    const filter = OidBloomFilter.create(1_000_000);
    expect(filter.hashCount).toBe(7);
    const bytes = filter.serialize().length;
    expect(bytes).toBeGreaterThan(1_190_000);
    expect(bytes).toBeLessThan(1_210_000);
  });

  it("serializes with a version byte and splits into rows of at most 1.5 MiB", () => {
    const filter = OidBloomFilter.create(2_000_000);
    filter.addAll(randomOids(1000, 4), 1000);
    const bytes = filter.serialize();
    expect(bytes[0]).toBe(EXISTENCE_FILTER_VERSION);
    const chunks = filter.toChunks();
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_FILTER_CHUNK_BYTES);
    expect(MAX_FILTER_CHUNK_BYTES).toBe(1.5 * 1024 * 1024);
    const restored = OidBloomFilter.fromChunks(chunks);
    expect(Buffer.compare(restored.serialize(), bytes)).toBe(0);
    expect(restored.count).toBe(1000);
    // Small filters are one row.
    expect(OidBloomFilter.create(1000).toChunks().length).toBe(1);
    expect(() => filter.toChunks(0)).toThrow(RangeError);
  });

  it("an empty filter holds nothing", () => {
    const filter = OidBloomFilter.create(0);
    expect(filter.mayContain(new Uint8Array(20))).toBe(false);
    const restored = OidBloomFilter.deserialize(filter.serialize());
    expect(restored.mayContain(new Uint8Array(20).fill(9))).toBe(false);
  });

  it("rejects bad parameters", () => {
    expect(() => OidBloomFilter.create(-1)).toThrow(RangeError);
    expect(() => OidBloomFilter.create(1.5)).toThrow(RangeError);
    expect(() => OidBloomFilter.create(10, 0)).toThrow(RangeError);
    expect(() => OidBloomFilter.create(10, 1)).toThrow(RangeError);
    expect(() => OidBloomFilter.create(10, Number.NaN)).toThrow(RangeError);
    const filter = OidBloomFilter.create(10);
    expect(() => filter.mayContain(new Uint8Array(19))).toThrow(RangeError);
    expect(() => filter.add(new Uint8Array(20), 1)).toThrow(RangeError);
  });

  it("names what is wrong with stored bytes", () => {
    const filter = OidBloomFilter.create(1000);
    filter.addAll(randomOids(100, 5), 100);
    const bytes = filter.serialize();
    const code = (b: Uint8Array) => {
      try {
        OidBloomFilter.deserialize(b);
        return "ok";
      } catch (error) {
        return error instanceof ExistenceFilterError ? error.code : "other";
      }
    };
    expect(code(bytes)).toBe("ok");
    const v2 = bytes.slice();
    v2[0] = 2;
    expect(code(v2)).toBe("bad-version");
    expect(code(bytes.subarray(0, 5))).toBe("bad-length");
    expect(code(bytes.subarray(0, bytes.length - 1))).toBe("bad-length");
    const noHashes = bytes.slice();
    noHashes[1] = 0;
    expect(code(noHashes)).toBe("bad-header");
    // A lost row is caught by the length check.
    const chunks = OidBloomFilter.create(2_000_000).toChunks();
    expect(() => OidBloomFilter.fromChunks(chunks.slice(0, 1))).toThrow(ExistenceFilterError);
    expect(() => OidBloomFilter.fromChunks([])).toThrow(ExistenceFilterError);
  });

  it("throws only ExistenceFilterError on mutated bytes (fuzz)", () => {
    const filter = OidBloomFilter.create(200);
    filter.addAll(randomOids(200, 6), 200);
    const good = filter.serialize();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: good.length + 8 }),
        fc.integer({ min: 0, max: good.length - 1 }),
        fc.integer({ min: 0, max: 255 }),
        (length, at, value) => {
          const bytes = new Uint8Array(length);
          bytes.set(good.subarray(0, length));
          if (at < length) bytes[at] = value;
          try {
            const restored = OidBloomFilter.deserialize(bytes);
            restored.mayContain(good, 0);
          } catch (error) {
            if (!(error instanceof ExistenceFilterError)) throw error;
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
