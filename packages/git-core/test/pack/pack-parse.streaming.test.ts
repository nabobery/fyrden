import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { gitPackRows } from "./git-oracle.js";
import {
  buildPack,
  gitOid,
  makeDelta,
  type PackEntrySpec,
  type WholeType,
} from "./pack-builder.js";
import { parseBytes, parseCode, rowsOf, trackingBudget } from "./parse-helpers.js";

/*
 * Streaming behaviour: results do not depend on how the input is chunked;
 * every object is handed out once; the second pass re-reads only what it
 * needs and rebuilds a base dropped from its cache.
 */

let sandbox: GitSandbox;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q"]);
});
afterAll(() => sandbox.dispose());

/** Random packs of whole objects and correct deltas (OFS or REF) against earlier entries. */
const packArb = fc
  .array(
    fc.record({
      type: fc.constantFrom<WholeType>("blob", "commit", "tree", "tag"),
      data: fc.uint8Array({ maxLength: 3000 }),
      deltaOf: fc.option(fc.nat(), { nil: undefined }),
      ref: fc.boolean(),
      edit: fc.uint8Array({ minLength: 1, maxLength: 40 }),
    }),
    { minLength: 1, maxLength: 15 },
  )
  .map((specs) => {
    const datas: Uint8Array[] = [];
    const types: WholeType[] = [];
    const entries: PackEntrySpec[] = [];
    // git's verify-pack refuses a pack holding one object twice, so the
    // generated packs do not (the parser itself accepts it, as index-pack does).
    const seen = new Set<string>();
    for (const spec of specs) {
      if (spec.deltaOf === undefined || datas.length === 0) {
        if (seen.has(gitOid(spec.type, spec.data))) continue;
        seen.add(gitOid(spec.type, spec.data));
        datas.push(spec.data);
        types.push(spec.type);
        entries.push({ kind: spec.type, data: spec.data });
        continue;
      }
      const base = spec.deltaOf % datas.length;
      const baseData = datas[base] as Uint8Array;
      const type = types[base] as WholeType;
      const data = new Uint8Array([...baseData.subarray(0, baseData.length >> 1), ...spec.edit]);
      if (seen.has(gitOid(type, data))) continue;
      seen.add(gitOid(type, data));
      const delta = makeDelta(baseData, data);
      datas.push(data);
      types.push(type);
      entries.push(
        spec.ref
          ? { kind: "ref", baseOid: gitOid(type, baseData), delta }
          : { kind: "ofs", base, delta },
      );
    }
    return entries;
  });

describe("pack-parse streaming", () => {
  it("gives the same result for any chunking, and hands out each object once", async () => {
    await fc.assert(
      fc.asyncProperty(packArb, fc.integer({ min: 1, max: 700 }), async (entries, chunkSize) => {
        const { bytes } = buildPack(entries);
        const whole = await parseBytes(bytes, { chunkSize: bytes.length });
        const seen: string[] = [];
        const chunked = await parseBytes(bytes, {
          chunkSize,
          onObject: ({ oid }) => {
            seen.push(Buffer.from(oid).toString("hex"));
          },
        });
        expect(rowsOf(chunked.pack, true)).toEqual(rowsOf(whole.pack, true));
        expect(seen.length).toBe(entries.length);
        expect(seen.sort()).toEqual(
          rowsOf(whole.pack)
            .map((r) => r.oid)
            .sort(),
        );
        whole.pack.release();
        chunked.pack.release();
      }),
      { numRuns: 150 },
    );
  });

  it("matches git on random hand-built packs", async () => {
    await fc.assert(
      fc.asyncProperty(packArb, async (entries) => {
        const { bytes } = buildPack(entries);
        const { pack } = await parseBytes(bytes, { chunkSize: 97 });
        expect(rowsOf(pack, true)).toEqual((await gitPackRows(sandbox, bytes))?.rows);
        pack.release();
      }),
      { numRuns: 40 },
    );
  }, 60_000);

  it("rebuilds a base dropped from the cache, and re-reads only entries with work to do", async () => {
    const big = (seed: number) => new Uint8Array(4000).map((_, i) => (i * seed) % 251);
    const b0 = big(7);
    const d1 = new Uint8Array([...b0.subarray(0, 3000), ...big(11).subarray(0, 1000)]);
    const d2 = new Uint8Array([...d1.subarray(0, 3500), ...big(13).subarray(0, 600)]);
    const d3 = new Uint8Array([...d2.subarray(0, 3900), ...big(17).subarray(0, 300)]);
    const e2 = new Uint8Array([...d1.subarray(0, 2000), ...big(19).subarray(0, 2100)]);
    const leaf = new Uint8Array(50).fill(1);
    const entries: PackEntrySpec[] = [
      { kind: "blob", data: b0 },
      { kind: "ofs", base: 0, delta: makeDelta(b0, d1) },
      { kind: "ofs", base: 1, delta: makeDelta(d1, d2) },
      { kind: "ofs", base: 2, delta: makeDelta(d2, d3) },
      { kind: "ofs", base: 1, delta: makeDelta(d1, e2) },
      { kind: "blob", data: leaf },
    ];
    const { bytes, offsets } = buildPack(entries);
    const reads: number[] = [];
    const readRange = async (offset: number, length: number) => {
      reads.push(offset);
      return bytes.subarray(offset, offset + length);
    };
    const tight = await parseBytes(bytes, {
      readRange,
      limits: { deltaBaseCacheBytes: 1, largeObjectBytes: 100 },
    });
    expect(rowsOf(tight.pack, true)).toEqual((await gitPackRows(sandbox, bytes))?.rows);
    // Nothing is a delta of the leaf blob, so the second pass never reads it.
    expect(reads).not.toContain(offsets[5]);
    // With no cache, d1 is rebuilt (b0 and d1 read again) before e2 is resolved.
    expect(reads.filter((o) => o === offsets[0]).length).toBeGreaterThan(1);

    // The same with small bases: dropped because the cache is full, not because they are large.
    reads.length = 0;
    const smallBases = await parseBytes(bytes, { readRange, limits: { deltaBaseCacheBytes: 1 } });
    expect(rowsOf(smallBases.pack, true)).toEqual(rowsOf(tight.pack, true));
    expect(reads.filter((o) => o === offsets[0]).length).toBeGreaterThan(1);
    smallBases.pack.release();

    reads.length = 0;
    const roomy = await parseBytes(bytes, { readRange });
    expect(rowsOf(roomy.pack, true)).toEqual(rowsOf(tight.pack, true));
    // With room, every entry with work to do is read exactly once.
    expect([...reads].sort((a, b) => a - b)).toEqual(offsets.slice(0, 5));
    tight.pack.release();
    roomy.pack.release();
  });

  it("rejects bytes that change between the two passes", async () => {
    const data = new Uint8Array(500).fill(3);
    const { bytes } = buildPack([
      { kind: "blob", data },
      { kind: "ofs", base: 0, delta: makeDelta(data, new Uint8Array([...data, 1])) },
    ]);
    const changed = bytes.slice();
    changed[14] = (changed[14] as number) ^ 1;
    expect(
      await parseCode(bytes, {
        readRange: async (offset, length) => changed.subarray(offset, offset + length),
      }),
    ).toBe("bad-checksum");
  });

  it("returns every reservation to the budget, after success and after failure", async () => {
    const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 7);
    const next = new Uint8Array([...data, 1, 2, 3]);
    const { bytes } = buildPack([
      { kind: "blob", data },
      { kind: "ref", baseOid: gitOid("blob", data), delta: makeDelta(data, next) },
    ]);
    const memory = trackingBudget(256 * 1024 * 1024);
    const { pack } = await parseBytes(bytes, { memory, zlib: createNodeZlib() });
    expect(memory.peak()).toBeGreaterThan(3 * 1024 * 1024);
    pack.release();
    expect(memory.held()).toBe(0);
    const broken = bytes.slice(0, bytes.length - 30);
    expect(await parseCode(broken, { memory })).toBe("truncated");
    expect(memory.held()).toBe(0);
    const badDelta = buildPack([
      { kind: "blob", data },
      { kind: "ofs", base: 0, delta: makeDelta(next, data) },
    ]).bytes;
    expect(await parseCode(badDelta, { memory })).toBe("delta-base-size-mismatch");
    expect(memory.held()).toBe(0);
  });
});
