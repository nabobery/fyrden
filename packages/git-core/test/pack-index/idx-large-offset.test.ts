import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OID_BYTES } from "../../src/object/oid.js";
import { openRangedIdx } from "../../src/pack/idx-range-read.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { type IdxWriteInput, writeIdx } from "../../src/pack/idx-write.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { countingReader, hex, idxHasher, randomOids } from "./support.js";

/*
 * The large-offset table, without a 2 GiB pack: an `.idx` built from
 * synthetic entries whose offsets cross 2^31, read back by `git show-index`
 * (which needs only the `.idx`) and by our readers.
 */

let git: GitSandbox;
beforeAll(async () => {
  git = await createGitSandbox();
});
afterAll(() => git.dispose());

const PACK_CHECKSUM = new Uint8Array(20).fill(0xab);

function entries(offsets: readonly number[], seed: number): IdxWriteInput {
  const count = offsets.length;
  const crc32s = new Uint32Array(count);
  for (let i = 0; i < count; i++) crc32s[i] = (i * 2654435761) >>> 0;
  return { count, oids: randomOids(count, seed), offsets: Float64Array.from(offsets), crc32s };
}

/** `git show-index` lines, as "offset oid crc" with the crc in hex. */
async function showIndex(idx: Uint8Array): Promise<string[]> {
  const { stdout } = await git.git(["show-index"], { input: idx });
  return stdout.trim().split("\n");
}

/** The lines show-index should print: entries sorted by oid. */
function expectedLines(input: IdxWriteInput): string[] {
  const rows: { oid: string; line: string }[] = [];
  for (let i = 0; i < input.count; i++) {
    const oid = hex(input.oids.subarray(i * OID_BYTES, (i + 1) * OID_BYTES));
    const crc = (input.crc32s[i] as number).toString(16).padStart(8, "0");
    rows.push({ oid, line: `${input.offsets[i]} ${oid} (${crc})` });
  }
  return rows.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0)).map((r) => r.line);
}

describe("64-bit offset table", () => {
  it("git show-index reads offsets on both sides of 2^31 exactly", async () => {
    const input = entries(
      [
        12,
        2 ** 31 - 1,
        2 ** 31,
        2 ** 31 + 1,
        2 ** 32 - 1,
        2 ** 32,
        2 ** 32 + 5,
        2 ** 40 + 3,
        2 ** 53 - 1,
      ],
      7,
    );
    const written = await writeIdx(input, PACK_CHECKSUM, { createHasher: idxHasher });
    expect(written.largeOffsetCount).toBe(7);
    // 9 entries: header, fanout, 9 × (20 + 4 + 4), 7 × 8 large offsets, two checksums.
    expect(written.bytes.length).toBe(8 + 1024 + 9 * 28 + 7 * 8 + 40);
    expect(await showIndex(written.bytes)).toEqual(expectedLines(input));

    const idx = PackIdx.parse(written.bytes);
    const ranged = await openRangedIdx(countingReader(written.bytes));
    for (let i = 0; i < input.count; i++) {
      const oid = input.oids.subarray(i * OID_BYTES, (i + 1) * OID_BYTES);
      expect(idx.lookup(oid)).toMatchObject({
        offset: input.offsets[i],
        crc32: input.crc32s[i],
      });
      const found = await ranged.lookup(oid);
      expect(found).toMatchObject({ offset: input.offsets[i] });
      expect(await ranged.crc32At(found?.position as number)).toBe(input.crc32s[i]);
    }
  });

  it("matches git show-index for random mixes of small and large offsets", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.integer({ min: 12, max: 2 ** 31 - 1 }),
            fc.integer({ min: 2 ** 31, max: Number.MAX_SAFE_INTEGER }),
          ),
          { minLength: 1, maxLength: 60 },
        ),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (rest, seed) => {
          // A real pack's first entry is at offset 12, so at most count - 1
          // offsets are large (git rejects an idx with more).
          const input = entries([12, ...rest], seed);
          const written = await writeIdx(input, PACK_CHECKSUM, { createHasher: idxHasher });
          expect(await showIndex(written.bytes)).toEqual(expectedLines(input));
          const idx = PackIdx.parse(written.bytes);
          for (let p = 0; p < idx.count; p++) {
            const [offset] = (expectedLines(input)[p] as string).split(" ");
            expect(idx.offsetAt(p)).toBe(Number(offset));
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 60_000);

  it("refuses offsets git could not index", async () => {
    const write = (offsets: number[]) =>
      writeIdx(entries(offsets, 3), PACK_CHECKSUM, { createHasher: idxHasher });
    // Every offset large: impossible for a real pack, and git's loader rejects the size.
    await expect(write([2 ** 31])).rejects.toThrow(RangeError);
    await expect(write([2 ** 31, 2 ** 32])).rejects.toThrow(RangeError);
    await expect(write([12, -1])).rejects.toThrow(RangeError);
    await expect(write([12, 1.5])).rejects.toThrow(RangeError);
    await expect(write([12, 2 ** 53])).rejects.toThrow(RangeError);
  });
});
