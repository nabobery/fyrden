// The view compaction's batches: whole units, within a run's limits, enough to
// bring the view within its cap when they fit.
import { describe, expect, it } from "vitest";
import type { ViewPack } from "../src/network/types.js";
import { admission, batchOf, fitsAfterCompaction } from "../src/network/view-cap.js";

const pack = (id: number, objects: number, unit: string | null = null): ViewPack => ({
  packId: `p${id}`,
  networkId: "net",
  r2Key: `k${id}`,
  kind: "receive",
  origin: "borrowed",
  bytes: 1,
  objectCount: objects,
  unitId: unit,
  createdAt: id,
});

describe("batchOf", () => {
  it("is nothing when the view is within its cap", () => {
    expect(batchOf([pack(1, 1), pack(2, 1)], { limit: 2, maxPacks: 16, maxObjects: 100 })).toEqual(
      [],
    );
  });

  it("takes the oldest packs needed to bring the view within its cap", () => {
    const packs = [1, 2, 3, 4, 5].map((i) => pack(i, 1));
    expect(
      batchOf(packs, { limit: 3, maxPacks: 16, maxObjects: 100 }).map((p) => p.packId),
    ).toEqual(["p1", "p2", "p3"]);
  });

  it("skips old packs too large to merge, taking newer small ones", () => {
    const packs = [pack(1, 300), pack(2, 300), ...[3, 4, 5, 6].map((i) => pack(i, 1))];
    expect(
      batchOf(packs, { limit: 4, maxPacks: 16, maxObjects: 500 }).map((p) => p.packId),
    ).toEqual(["p1", "p3", "p4"]);
  });

  it("keeps a unit whole and within the pack limit", () => {
    const packs = [pack(1, 1, "u"), pack(2, 1, "u"), pack(3, 1), pack(4, 1), pack(5, 1)];
    expect(batchOf(packs, { limit: 1, maxPacks: 3, maxObjects: 100 }).map((p) => p.packId)).toEqual(
      ["p1", "p2", "p3"],
    );
  });

  it("keeps a unit whole when its packs are not next to each other", () => {
    // A thin pack, another push's pack, then the thin pack's completion.
    const packs = [pack(1, 1, "u"), pack(2, 1), pack(3, 1, "u")];
    expect(
      batchOf(packs, { limit: 2, maxPacks: 16, maxObjects: 100 }).map((p) => p.packId),
    ).toEqual(["p1", "p3"]);
  });

  it("starts past an old pack that pairs with nothing", () => {
    const packs = [pack(1, 499_999), pack(2, 2), pack(3, 2)];
    expect(
      batchOf(packs, { limit: 2, maxPacks: 16, maxObjects: 500_000 }).map((p) => p.packId),
    ).toEqual(["p2", "p3"]);
  });

  it("is nothing when no two packs fit", () => {
    expect(
      batchOf([pack(1, 600), pack(2, 600), pack(3, 600)], {
        limit: 1,
        maxPacks: 16,
        maxObjects: 500,
      }),
    ).toEqual([]);
  });
});

describe("fitsAfterCompaction", () => {
  it("holds a view within its cap", () => {
    const limits = { limit: 1, maxPacks: 16, maxObjects: 500 };
    expect(fitsAfterCompaction([pack(1, 600)], limits, "upper")).toBe(true);
  });

  it("holds a view the compaction's runs bring within its cap, one after another", () => {
    // Three packs a run: two runs, then their outputs merged.
    const packs = [1, 2, 3, 4, 5, 6].map((i) => pack(i, 1));
    expect(fitsAfterCompaction(packs, { limit: 1, maxPacks: 3, maxObjects: 100 }, "upper")).toBe(
      true,
    );
  });

  it("refuses a view whose smallest pair is over the rewrite budget, however outputs are sized", () => {
    const packs = [pack(1, 300), pack(2, 300), pack(3, 300)];
    const limits = { limit: 2, maxPacks: 16, maxObjects: 500 };
    expect(fitsAfterCompaction(packs, limits, "upper")).toBe(false);
    expect(fitsAfterCompaction(packs, limits, "lower")).toBe(false);
  });

  it("sizes outputs as every source object (upper) or the largest source's (lower)", () => {
    // Two runs of 400 objects each: their outputs merge only if they hold 200 each.
    const packs = [1, 2, 3, 4].map((i) => pack(i, 200));
    const limits = { limit: 1, maxPacks: 16, maxObjects: 500 };
    expect(fitsAfterCompaction(packs, limits, "upper")).toBe(false);
    expect(fitsAfterCompaction(packs, limits, "lower")).toBe(true);
  });

  it("takes the run under way first, at its written size", () => {
    // The run of the first two wrote 9 objects; the pack added after it pairs with nothing.
    // Chosen afresh, the three would fit.
    const packs = [pack(1, 3), pack(2, 6), pack(3, 3)];
    const limits = { limit: 1, maxPacks: 16, maxObjects: 10 };
    expect(fitsAfterCompaction(packs, limits, "lower")).toBe(true);
    const run = { sources: ["p1", "p2"], objects: 9 };
    expect(fitsAfterCompaction(packs, limits, "lower", run)).toBe(false);
  });

  it("sizes a run under way not written yet by the bound", () => {
    const packs = [pack(1, 3), pack(2, 6), pack(3, 3)];
    const limits = { limit: 1, maxPacks: 16, maxObjects: 10 };
    const run = { sources: ["p1", "p2"] };
    expect(fitsAfterCompaction(packs, limits, "lower", run)).toBe(true);
    expect(fitsAfterCompaction(packs, limits, "upper", run)).toBe(false);
  });

  it("chooses afresh when a run's sources left the view (the run is discarded)", () => {
    const packs = [pack(2, 6), pack(3, 3)];
    const limits = { limit: 1, maxPacks: 16, maxObjects: 10 };
    const run = { sources: ["p1", "p2"], objects: 9 };
    expect(fitsAfterCompaction(packs, limits, "upper", run)).toBe(true);
  });
});

describe("admission", () => {
  const limits = { limit: 16, maxPacks: 16, maxObjects: 500_000 };
  const disjoint = (n: number) => Array.from({ length: n }, (_, i) => pack(i + 1, 200_000));

  it("never admits disjoint packs past the cap: compacted first, then refused", () => {
    // 33 packs of 200,000 objects: two fit a run, three do not. Were every pair's objects
    // shared, they would merge down; were none, 17 outputs of 400,000 would never merge.
    const view = disjoint(33);
    const current = view.slice(0, 32);
    expect(admission(view, current, limits)).toBe("learn");
    // Compacted with nothing shared: 16 outputs of 400,000; the 33rd pack fits no run.
    const compacted = Array.from({ length: 16 }, (_, i) => pack(100 + i, 400_000));
    expect(admission([...compacted, pack(33, 200_000)], compacted, limits)).toBe("full");
  });

  it("admits what fits were nothing shared", () => {
    const view = disjoint(17);
    expect(admission(view, view.slice(0, 16), limits)).toBe("admit");
  });

  it("refuses what cannot fit even were everything shared", () => {
    const big = { limit: 1, maxPacks: 16, maxObjects: 500 };
    const view = [pack(1, 300), pack(2, 300)];
    expect(admission(view, view.slice(0, 1), big)).toBe("full");
  });

  it("waits for a run under way to tell its size", () => {
    const small = { limit: 1, maxPacks: 16, maxObjects: 10 };
    const view = [pack(1, 3), pack(2, 6), pack(3, 3)];
    const current = view.slice(0, 2);
    expect(admission(view, current, small, { sources: ["p1", "p2"] })).toBe("learn");
    // Written: 9 (nothing shared) leaves no room; 6 (all shared) does.
    expect(admission(view, current, small, { sources: ["p1", "p2"], objects: 9 })).toBe("full");
    expect(admission(view, current, small, { sources: ["p1", "p2"], objects: 6 })).toBe("admit");
  });

  it("does not admit packs the run under way's output sorts before", () => {
    // Fourteen large packs, then 32,000, 128,000 and 64,000 objects; the run merges the first two
    // of those into an output begun before the import's three packs. In storage order the next
    // run merges 64,000 + 160,000 + 64,000, leaving 17 packs no pair of which fits (taken as
    // the newest, the output would pair with a 288,000 one: 16).
    const large = Array.from({ length: 14 }, (_, i) => pack(i + 1, 500_000));
    const current = [...large, pack(15, 32_000), pack(16, 128_000), pack(17, 64_000)];
    const view = [...current, pack(19, 64_000), pack(20, 288_000), pack(21, 288_000)];
    const run = { sources: ["p15", "p16"], output: { packId: "p18", createdAt: 18 } };
    expect(admission(view, current, limits, { ...run, objects: 160_000 })).toBe("learn");
    expect(admission(view, current, limits, run)).toBe("learn");
  });

  it("refuses when only shared objects could make room and nothing is left to compact", () => {
    // Merged two by two, 4 + 4 + 4 fits one run only were objects shared; the current view (one
    // pack) is within its cap, so compacting it tells nothing.
    const small = { limit: 1, maxPacks: 16, maxObjects: 10 };
    const view = [pack(1, 4), pack(2, 4), pack(3, 4)];
    expect(admission(view, view.slice(0, 1), small)).toBe("full");
  });
});
