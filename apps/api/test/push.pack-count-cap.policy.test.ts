// Which packs a push's commit merges to stay under the pack-count cap: the
// pure selection, on its own and over long simulated push histories.
import type { PackId } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import {
  type CapUnit,
  PACK_CAP_DEFAULTS,
  type PackCapPolicy,
  packCapPolicy,
  selectTailMerge,
} from "../src/git/maintenance/tail-merge-plan.js";

const MiB = 1024 * 1024;
let next = 0;

function unit(bytes: number, options: { packs?: number; leased?: boolean } = {}): CapUnit {
  const n = next++;
  return {
    id: `u${n}`,
    packIds: Array.from({ length: options.packs ?? 1 }, (_, i) => `p${n}.${i}` as PackId),
    bytes,
    objects: Math.ceil(bytes / 100),
    createdAt: n,
    leased: options.leased ?? false,
  };
}

const policy = (overrides: Partial<PackCapPolicy> = {}): PackCapPolicy => ({
  ...PACK_CAP_DEFAULTS,
  ...overrides,
});

const packCount = (units: readonly CapUnit[]) => units.reduce((n, u) => n + u.packIds.length, 0);

describe("pack-count cap: tail selection", () => {
  it("merges nothing while the push fits under the cap", () => {
    const live = Array.from({ length: 15 }, () => unit(1000));
    expect(selectTailMerge(live, unit(10), policy())).toEqual({ kind: "within-cap" });
    // A thin push's unit counts as its two packs.
    expect(selectTailMerge(live, unit(10, { packs: 2 }), policy()).kind).toBe("merge");
  });

  it("merges the push with the smallest packs, and stops before a pack larger than what it merged", () => {
    const big = unit(17_000);
    const small = Array.from({ length: 15 }, () => unit(1000));
    const selection = selectTailMerge([big, ...small], unit(1000), policy());
    expect(selection.kind).toBe("merge");
    if (selection.kind !== "merge") return;
    expect(selection.withIncoming).toBe(true);
    expect(selection.units.map((u) => u.id).sort()).toEqual(small.map((u) => u.id).sort());
    expect(selection.livePacksAfter).toBe(2);
  });

  it("never picks a leased unit, and says so when leases leave too little to merge", () => {
    const leased = Array.from({ length: 15 }, () => unit(10, { leased: true }));
    const free = unit(5000);
    const selection = selectTailMerge([...leased, free], unit(10), policy());
    expect(selection).toMatchObject({ kind: "merge", withIncoming: true });
    if (selection.kind === "merge") expect(selection.units.map((u) => u.id)).toEqual([free.id]);

    const allLeased = Array.from({ length: 16 }, () => unit(10, { leased: true }));
    expect(selectTailMerge(allLeased, unit(10), policy())).toEqual({
      kind: "over-budget",
      reason: "leased",
    });
  });

  it("rejects when the smallest packs that would make room exceed the byte or object budget", () => {
    const live = Array.from({ length: 16 }, () => unit(40 * MiB));
    expect(selectTailMerge(live, unit(30 * MiB), policy())).toEqual({
      kind: "over-budget",
      reason: "budget",
    });
    const many = Array.from({ length: 16 }, () => unit(1000));
    expect(selectTailMerge(many, unit(1000), policy({ maxMergeObjects: 5 }))).toEqual({
      kind: "over-budget",
      reason: "budget",
    });
  });

  it("keeps a push too large to merge as its own pack and merges older packs instead", () => {
    const live = Array.from({ length: 16 }, () => unit(MiB));
    const selection = selectTailMerge(live, unit(90 * MiB), policy());
    expect(selection).toMatchObject({ kind: "merge", withIncoming: false });
    if (selection.kind !== "merge") return;
    expect(selection.livePacksAfter).toBeLessThanOrEqual(16);
    expect(selection.units.length).toBeGreaterThanOrEqual(2);
  });

  it("without a push, makes room below the target by merging at least two units", () => {
    const live = Array.from({ length: 16 }, () => unit(1000));
    const selection = selectTailMerge(live, undefined, policy(), { target: 15 });
    expect(selection.kind).toBe("merge");
    if (selection.kind === "merge") {
      expect(selection.units.length).toBeGreaterThanOrEqual(2);
      expect(selection.livePacksAfter).toBeLessThanOrEqual(15);
    }
    expect(selectTailMerge(live.slice(0, 15), undefined, policy(), { target: 15 })).toEqual({
      kind: "within-cap",
    });
  });

  it("over 5,000 simulated pushes of random sizes, stays under the cap and rewrites a bounded amount", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const cap = PACK_CAP_DEFAULTS.cap;
    let live: CapUnit[] = [];
    let pushed = 0;
    let rewritten = 0;
    let maxRewrite = 0;
    for (let i = 0; i < 5000; i++) {
      const size =
        random() < 0.005 ? Math.floor(random() * 8 * MiB) : 200 + Math.floor(random() * 4000);
      const incoming = unit(size, { packs: random() < 0.3 ? 2 : 1 });
      pushed += size;
      const selection = selectTailMerge(live, incoming, policy());
      if (selection.kind === "over-budget") throw new Error(`push ${i} rejected`);
      if (selection.kind === "within-cap") {
        live.push(incoming);
      } else {
        const chosen = new Set(selection.units.map((u) => u.id));
        const merged = [...selection.units, ...(selection.withIncoming ? [incoming] : [])];
        const bytes = merged.reduce((n, u) => n + u.bytes, 0);
        rewritten += bytes;
        maxRewrite = Math.max(maxRewrite, bytes);
        live = live.filter((u) => !chosen.has(u.id));
        live.push({ ...unit(bytes), objects: merged.reduce((n, u) => n + u.objects, 0) });
        if (!selection.withIncoming) live.push(incoming);
        expect(packCount(live)).toBe(selection.livePacksAfter);
      }
      expect(packCount(live)).toBeLessThanOrEqual(cap);
    }
    expect(maxRewrite).toBeLessThanOrEqual(PACK_CAP_DEFAULTS.maxMergeBytes);
    // Each pushed byte is copied a bounded number of times, not once per push.
    expect(rewritten / pushed).toBeLessThan(40);
  });
});

describe("pack-count cap: policy from Worker variables", () => {
  it("uses the defaults unless a variable sets a positive integer", () => {
    expect(packCapPolicy({})).toEqual(PACK_CAP_DEFAULTS);
    expect(PACK_CAP_DEFAULTS.cap).toBe(16);
    expect(
      packCapPolicy({
        GIT_PACK_CAP: "8",
        GIT_TAIL_MERGE_MAX_BYTES: 1024,
        GIT_TAIL_MERGE_MAX_OBJECTS: "x",
      }),
    ).toEqual({ ...PACK_CAP_DEFAULTS, cap: 8, maxMergeBytes: 1024 });
    expect(packCapPolicy({ GIT_PACK_CAP: "1" }).cap).toBe(PACK_CAP_DEFAULTS.cap);
  });
});
