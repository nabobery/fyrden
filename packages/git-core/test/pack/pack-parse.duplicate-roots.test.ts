import { afterEach, describe, expect, it, vi } from "vitest";
import { PackIndexState } from "../../src/pack/index-state.js";
import { buildPack, gitOid, makeDelta, type PackEntrySpec, text } from "./pack-builder.js";
import { parseBytes } from "./parse-helpers.js";

/*
 * Duplicate whole objects are legal in a pack. N copies of a base plus N
 * REF_DELTAs against its oid must cost about N log N base comparisons, not
 * N^2: each copy used to rescan the whole group of REF_DELTAs naming it.
 */

afterEach(() => vi.restoreAllMocks());

const a = text("a");
const b = text("b");

function duplicateRoots(n: number): PackEntrySpec[] {
  const entries: PackEntrySpec[] = [];
  for (let i = 0; i < n; i++) entries.push({ kind: "blob", data: a });
  for (let i = 0; i < n; i++)
    entries.push({ kind: "ref", baseOid: gitOid("blob", a), delta: makeDelta(a, b) });
  return entries;
}

/** Base oid lookups (one per comparison against a REF_DELTA's base) while parsing. */
async function lookups(entries: PackEntrySpec[]): Promise<number> {
  const spy = vi.spyOn(PackIndexState.prototype, "refBaseAt");
  const { pack, objects } = await parseBytes(buildPack(entries).bytes);
  const count = spy.mock.calls.length;
  spy.mockRestore();
  expect([...objects.keys()].sort()).toEqual([gitOid("blob", a), gitOid("blob", b)].sort());
  for (let i = 0; i < pack.entries.count; i++) expect(pack.entries.type(i)).toBe("blob");
  pack.release();
  return count;
}

describe("pack-parse: duplicate REF_DELTA bases", () => {
  it("resolves N duplicate roots with N shared REF_DELTAs in about N log N lookups", async () => {
    const n = 128;
    const count = await lookups(duplicateRoots(n));
    // Sorting and one binary search per root and per result: well under 16 N log2 N.
    expect(count).toBeLessThan(16 * n * Math.log2(n));
  });

  it("grows close to linearly when N doubles", async () => {
    const small = await lookups(duplicateRoots(64));
    const large = await lookups(duplicateRoots(128));
    expect(large / small).toBeLessThan(2.6);
  });

  it("still resolves the OFS_DELTA children of every duplicate root", async () => {
    const c = text("c");
    const entries: PackEntrySpec[] = [
      { kind: "blob", data: a },
      { kind: "ofs", base: 0, delta: makeDelta(a, b) },
      { kind: "blob", data: a },
      { kind: "ofs", base: 2, delta: makeDelta(a, c) },
      { kind: "ref", baseOid: gitOid("blob", a), delta: makeDelta(a, c) },
    ];
    const { pack, objects } = await parseBytes(buildPack(entries).bytes);
    expect([...objects.keys()].sort()).toEqual(
      [gitOid("blob", a), gitOid("blob", b), gitOid("blob", c)].sort(),
    );
    const oids = Array.from({ length: pack.entries.count }, (_, i) =>
      Buffer.from(pack.entries.oid(i)).toString("hex"),
    );
    expect(oids).toEqual([a, b, a, c, c].map((v) => gitOid("blob", v)));
    pack.release();
  });
});
