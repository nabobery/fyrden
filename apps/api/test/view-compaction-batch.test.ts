// The view compaction's batches: whole units, within a run's limits, enough to
// bring the view within its cap when they fit.
import { describe, expect, it } from "vitest";
import type { ViewPack } from "../src/network/types.js";
import { batchOf } from "../src/network/view-cap.js";

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
