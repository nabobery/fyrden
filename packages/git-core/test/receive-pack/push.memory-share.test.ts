import { describe, expect, it } from "vitest";
import { pushIndexMemoryBytes } from "../../src/receive-pack/indexer.js";

const MiB = 1024 * 1024;

describe("an indexing phase's share of memory", () => {
  it("is the reader's and the parser's delta-base caches and the link table's first step", () => {
    expect(pushIndexMemoryBytes()).toBe(16 * MiB + 16 * MiB + 1 * MiB);
    expect(pushIndexMemoryBytes({ pack: { deltaBaseCacheBytes: 2 * MiB } })).toBe(19 * MiB);
  });
});
