import { describe, expect, it } from "vitest";
import { oidFromHex } from "../../src/object/oid.js";
import { type RegeneratedKeyInput, regeneratedPackKey } from "../../src/upload-pack/cache-key.js";

/*
 * A regenerated pack's key covers every input that can change its bytes,
 * the extra tips a caller vouches for included (they decide which shallow
 * boundaries are lifted). Requests without extra tips keep the keys they
 * had, so packs already cached are still found.
 */

const hex = (c: string) => c.repeat(40);

const input: RegeneratedKeyInput = {
  repoId: "rep_1",
  refsVersion: 7,
  registryVersion: 3,
  wants: [oidFromHex(hex("a"))],
  commonHaves: [],
  shallow: [oidFromHex(hex("c"))],
  deepen: 2147483647,
  deepenRelative: false,
  deepenSince: undefined,
  deepenNot: [],
  ofsDelta: true,
  thinPack: false,
  includeTag: false,
  framedPayload: undefined,
};

describe("upload-pack.cache-key", () => {
  it("keeps the key of a request without extra tips", () => {
    // SHA-1 of the canonical description, as keys were before extra tips existed.
    const before = "e73e5c27741a16d8e26f9eaea672a7e3cda0ad46";
    expect(regeneratedPackKey(input)).toBe(before);
    expect(regeneratedPackKey({ ...input, extraTips: [] })).toBe(before);
  });

  it("separates requests by the extra tips vouched for, whatever their order or repeats", () => {
    const plain = regeneratedPackKey(input);
    const c = regeneratedPackKey({ ...input, extraTips: [oidFromHex(hex("c"))] });
    const d = regeneratedPackKey({ ...input, extraTips: [oidFromHex(hex("d"))] });
    const cd = regeneratedPackKey({
      ...input,
      extraTips: [oidFromHex(hex("d")), oidFromHex(hex("c")), oidFromHex(hex("d"))],
    });
    expect(c).toMatch(/^[0-9a-f]{40}$/);
    expect(new Set([plain, c, d, cd]).size).toBe(4);
    expect(
      regeneratedPackKey({ ...input, extraTips: [oidFromHex(hex("c")), oidFromHex(hex("d"))] }),
    ).toBe(cd);
  });
});
