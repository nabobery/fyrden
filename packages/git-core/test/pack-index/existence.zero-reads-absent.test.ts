import { describe, expect, it } from "vitest";
import { OID_BYTES } from "../../src/object/oid.js";
import { EXISTENCE_FILTER_HEADER_BYTES, OidBloomFilter } from "../../src/pack/existence-filter.js";
import { PackExistenceSummary } from "../../src/pack/existence-summary.js";
import { encodeFanout } from "../../src/pack/idx-format.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { countingReader, idxHasher, randomOids, syntheticEntries } from "./support.js";

/*
 * Acceptance: "does this pack contain oid X" over 100k oids reads nothing
 * from R2 for absent objects in the common case. The `.idx` sits behind a
 * counting range reader standing in for R2; the summary (1 KB fanout plus
 * the bloom filter, as kept in the registry) is in memory. Only bloom
 * false positives (about 1%) reach the `.idx`; present oids are all found.
 */

const N = 100_000;

describe("existence check over a 100k-object pack", () => {
  it("does zero idx reads when the summary says no", async () => {
    const members = randomOids(N, 21);
    const written = await writeIdx(syntheticEntries(members, 21), new Uint8Array(20), {
      createHasher: idxHasher,
    });
    const idx = PackIdx.parse(written.bytes);

    // What the registry row and pack_filters rows hold, and how they come back.
    const stored = PackExistenceSummary.fromIdx(idx);
    const fanoutBlob = encodeFanout(stored.fanout);
    expect(fanoutBlob.length).toBe(1024);
    const summary = PackExistenceSummary.fromStored(fanoutBlob, stored.filter.toChunks());

    const r2 = countingReader(written.bytes);
    const ranged = summary.openIdx(r2);
    expect(r2.calls).toBe(0);

    const absent = randomOids(N, 22);
    let bloomPositives = 0;
    for (let i = 0; i < N; i++) {
      const oid = absent.subarray(i * OID_BYTES, (i + 1) * OID_BYTES);
      const before = r2.calls;
      const maybe = summary.mayContain(oid);
      expect(await summary.lookup(oid, ranged)).toBeUndefined();
      if (maybe) bloomPositives++;
      else expect(r2.calls).toBe(before);
    }
    // Each false positive costs one read of the oid's fanout bucket.
    expect(r2.calls).toBe(bloomPositives);
    expect(bloomPositives / N).toBeLessThan(0.012);

    // Present oids: every one is found at its offset.
    const reads = r2.calls;
    for (let i = 0; i < N; i += 97) {
      const oid = members.subarray(i * OID_BYTES, (i + 1) * OID_BYTES);
      expect(summary.mayContain(oid)).toBe(true);
      expect((await summary.lookup(oid, ranged))?.offset).toBe(idx.lookup(oid)?.offset);
    }
    expect(r2.calls).toBeGreaterThan(reads);
  }, 60_000);

  it("an empty fanout bucket answers no even before the bloom filter", () => {
    const oids = randomOids(10, 3);
    for (let i = 0; i < 10; i++) oids[i * 20] = 0x42;
    const summary = new PackExistenceSummary(
      Uint32Array.from({ length: 256 }, (_, b) => (b >= 0x42 ? 10 : 0)),
      // A filter that answers yes to everything.
      saturated(),
    );
    const other = new Uint8Array(20).fill(0x43);
    expect(summary.mayContain(other)).toBe(false);
    other[0] = 0x42;
    expect(summary.mayContain(other)).toBe(true);
  });
});

function saturated(): OidBloomFilter {
  const filter = OidBloomFilter.create(1, 0.5);
  const bytes = filter.serialize();
  bytes.fill(0xff, EXISTENCE_FILTER_HEADER_BYTES);
  return OidBloomFilter.deserialize(bytes);
}
