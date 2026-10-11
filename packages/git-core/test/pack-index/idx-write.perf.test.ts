import { describe, expect, it } from "vitest";
import { OidBloomFilter } from "../../src/pack/existence-filter.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { idxHasher, randomOids, syntheticEntries } from "./support.js";

/*
 * CPU for indexing 100,000 entries: sort, write the `.idx` (including its
 * SHA-1 with git-core's pure-TypeScript hasher), parse it back, build the
 * bloom filter, and look every oid up once.
 *
 * Measured [M] (Apple M4, Node 24, 2026-10-11, three runs): write 37 ms for
 * a 2.8 MB `.idx`, bloom filter 9 ms, 100,000 lookups 48–49 ms. The bounds
 * below are deliberately generous so the test does not flake on slow CI
 * machines; a Durable Object is measured separately.
 */

const N = 100_000;

describe("idx for 100k entries", () => {
  it("builds, parses, summarises and looks up within budget", async () => {
    const input = syntheticEntries(randomOids(N, 31), 31);

    let started = performance.now();
    const written = await writeIdx(input, new Uint8Array(20), { createHasher: idxHasher });
    const writeMs = performance.now() - started;

    started = performance.now();
    const idx = PackIdx.parse(written.bytes);
    const filter = OidBloomFilter.create(idx.count);
    filter.addAll(idx.oidTable(), idx.count);
    const summaryMs = performance.now() - started;

    started = performance.now();
    for (let i = 0; i < N; i++) {
      if (idx.positionOf(input.oids, i * 20) < 0) throw new Error("missing");
    }
    const lookupMs = performance.now() - started;

    console.info(
      `idx 100k: write ${writeMs.toFixed(0)} ms (${(written.bytes.length / 1e6).toFixed(2)} MB),` +
        ` bloom ${summaryMs.toFixed(0)} ms, 100k lookups ${lookupMs.toFixed(0)} ms`,
    );
    expect(writeMs).toBeLessThan(2000);
    expect(summaryMs).toBeLessThan(1000);
    expect(lookupMs).toBeLessThan(1000);
  }, 30_000);
});
