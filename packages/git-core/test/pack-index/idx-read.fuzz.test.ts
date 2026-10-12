import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IdxError } from "../../src/pack/idx-format.js";
import { openRangedIdx } from "../../src/pack/idx-range-read.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { countingReader, idxHasher, randomOids, syntheticEntries } from "./support.js";

/*
 * Mutation fuzz: corrupt a valid `.idx` (flipped bytes, truncation, extra
 * bytes, a forged fanout or offset word) and require that both readers either
 * answer or throw `IdxError`, never anything else, and never hang.
 */

async function validIdx(count: number, seed: number, large: boolean): Promise<Uint8Array> {
  const input = syntheticEntries(randomOids(count, seed), seed);
  if (large) {
    const offsets = input.offsets as Float64Array;
    for (let i = 1; i < count; i += 3) offsets[i] = 2 ** 31 + i * 1000;
  }
  return (await writeIdx(input, new Uint8Array(20), { createHasher: idxHasher })).bytes;
}

const mutation = fc.oneof(
  fc.record({
    kind: fc.constant("flip" as const),
    at: fc.nat(),
    value: fc.integer({ min: 0, max: 255 }),
  }),
  fc.record({ kind: fc.constant("truncate" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("extend" as const), extra: fc.integer({ min: 1, max: 64 }) }),
  fc.record({
    kind: fc.constant("word" as const),
    at: fc.nat(),
    value: fc.constantFrom(0, 1, 0x7fffffff, 0x80000000, 0x80000001, 0xffffffff),
  }),
);

type Mutation = typeof mutation extends fc.Arbitrary<infer T> ? T : never;

function mutate(bytes: Uint8Array, m: Mutation): Uint8Array {
  const out = bytes.slice();
  if (out.length < 4 && m.kind !== "extend") return out;
  switch (m.kind) {
    case "flip":
      out[m.at % out.length] = m.value;
      return out;
    case "truncate":
      return out.subarray(0, m.at % out.length);
    case "extend": {
      const longer = new Uint8Array(out.length + m.extra);
      longer.set(out);
      return longer;
    }
    case "word": {
      const at = (m.at % Math.floor(out.length / 4)) * 4;
      new DataView(out.buffer).setUint32(at, m.value);
      return out;
    }
  }
}

function onlyIdxErrors(run: () => void): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof IdxError)) throw error;
  }
}

async function onlyIdxErrorsAsync(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof IdxError)) throw error;
  }
}

describe("idx readers on corrupted input", () => {
  it("throw only IdxError", async () => {
    const seeds = await Promise.all([
      validIdx(0, 1, false),
      validIdx(5, 2, false),
      validIdx(40, 3, true),
    ]);
    const probes = randomOids(8, 99);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...seeds),
        fc.array(mutation, { minLength: 1, maxLength: 3 }),
        async (seed, mutations) => {
          const bytes = mutations.reduce(mutate, seed);
          onlyIdxErrors(() => {
            const idx = PackIdx.parse(bytes);
            for (let p = 0; p < idx.count; p++) {
              onlyIdxErrors(() => idx.offsetAt(p));
              idx.crc32At(p);
              idx.find(idx.oidAt(p));
            }
            for (let i = 0; i < 8; i++) idx.find(probes.subarray(i * 20, i * 20 + 20));
          });
          await onlyIdxErrorsAsync(async () => {
            const ranged = await openRangedIdx(countingReader(bytes));
            for (let p = 0; p < Math.min(ranged.count, 64); p++) {
              await onlyIdxErrorsAsync(async () => {
                await ranged.lookup(await ranged.oidAt(p));
              });
            }
            for (let i = 0; i < 8; i++) {
              await onlyIdxErrorsAsync(async () => {
                await ranged.lookup(probes.subarray(i * 20, i * 20 + 20));
              });
            }
          });
        },
      ),
      { numRuns: 400 },
    );
  });

  it("names what is wrong", async () => {
    const good = await validIdx(5, 2, false);
    const code = (bytes: Uint8Array) => {
      try {
        PackIdx.parse(bytes);
        return "ok";
      } catch (error) {
        return error instanceof IdxError ? error.code : "other";
      }
    };
    expect(code(good)).toBe("ok");
    expect(code(good.subarray(0, 100))).toBe("truncated");
    // Past the header, but short of the tables the fanout counts.
    expect(code(good.subarray(0, good.length - 8))).toBe("truncated");
    const badMagic = good.slice();
    badMagic[0] = 0;
    expect(code(badMagic)).toBe("bad-header");
    const v3 = good.slice();
    v3[7] = 3;
    expect(code(v3)).toBe("bad-header");
    const nonMonotonic = good.slice();
    new DataView(nonMonotonic.buffer).setUint32(8 + 4 * 10, 0xffff);
    expect(code(nonMonotonic)).toBe("bad-fanout");
    const longer = new Uint8Array(good.length + 4);
    longer.set(good);
    expect(code(longer)).toBe("bad-size");
    // A checksum mismatch is reported by verifyChecksum, not by parse.
    const flipped = good.slice();
    flipped[8 + 1024] = (flipped[8 + 1024] as number) ^ 1;
    expect(await PackIdx.parse(flipped).verifyChecksum(idxHasher)).toBe(false);
  });

  it("rejects a 31-bit offset that points past the large-offset table", async () => {
    const good = await validIdx(5, 2, false);
    const bad = good.slice();
    const offsetsAt = 8 + 1024 + 5 * 24;
    new DataView(bad.buffer).setUint32(offsetsAt, 0x80000000);
    // Rejected for the reference itself, before any read of the table.
    const message = "bad-large-offset: entry 0 refers to large offset 0 of 0";
    const idx = PackIdx.parse(bad);
    expect(() => idx.offsetAt(0)).toThrow(message);
    const ranged = await openRangedIdx(countingReader(bad), { byteLength: bad.length });
    await expect(ranged.offsetAt(0)).rejects.toThrow(message);
    // Without the length, the reader lands on the pack checksum, which is not
    // a valid large offset (every value in that table is at least 2^31).
    const unbounded = await openRangedIdx(countingReader(bad));
    await expect(unbounded.offsetAt(0)).rejects.toThrow(IdxError);
  });
});
