import { describe, expect, it } from "vitest";
import { OidBloomFilter } from "../../src/pack/existence-filter.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { idxHasher, randomOids, syntheticEntries } from "./support.js";

/*
 * Indexing 100,000 entries: sort, write the `.idx` (including its SHA-1
 * with git-core's pure-TypeScript hasher), parse it back, build the bloom
 * filter, and look every oid up once. Checked for correctness only; time is
 * never asserted (a bound passes or fails with the runner's speed).
 *
 * Measured [M] (Apple M4, Node 24, 2026-10-11, three runs): write 37 ms for
 * a 2.8 MB `.idx`, bloom filter 9 ms, 100,000 lookups 48–49 ms;
 * `FYRDEN_BENCH=1` prints the times again. A Durable Object is measured
 * separately.
 */

const N = 100_000;
const BENCH = Boolean(process.env.FYRDEN_BENCH);
// biome-ignore lint/style/noRestrictedGlobals: printed under FYRDEN_BENCH, never asserted.
const clock = () => performance.now();

describe("idx for 100k entries", () => {
  it("builds, parses, summarises and finds every entry", async () => {
    const input = syntheticEntries(randomOids(N, 31), 31);

    let started = clock();
    const written = await writeIdx(input, new Uint8Array(20), { createHasher: idxHasher });
    const writeMs = clock() - started;

    started = clock();
    const idx = PackIdx.parse(written.bytes);
    const filter = OidBloomFilter.create(idx.count);
    filter.addAll(idx.oidTable(), idx.count);
    const summaryMs = clock() - started;
    expect(idx.count).toBe(N);

    started = clock();
    for (let i = 0; i < N; i++) {
      if (idx.positionOf(input.oids, i * 20) < 0) throw new Error("missing");
    }
    const lookupMs = clock() - started;

    if (BENCH)
      console.info(
        `idx 100k: write ${writeMs.toFixed(0)} ms (${(written.bytes.length / 1e6).toFixed(2)} MB),` +
          ` bloom ${summaryMs.toFixed(0)} ms, 100k lookups ${lookupMs.toFixed(0)} ms`,
      );
  }, 30_000);
});
