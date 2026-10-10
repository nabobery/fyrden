import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createIdFactory, isId, ulid } from "../src/ids.js";
import { secureRandomBytes } from "../src/principals/token.js";

describe("ulid", () => {
  it("encodes time in the first 10 characters so ids sort by time", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 48 - 2 }), (t) => {
        const a = ulid(t, secureRandomBytes);
        const b = ulid(t + 1, secureRandomBytes);
        expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
      }),
    );
  });

  it("matches the reference encoding of time zero and all-ones randomness", () => {
    expect(ulid(0, (n) => new Uint8Array(n))).toBe("0".repeat(26));
    expect(ulid(2 ** 48 - 1, (n) => new Uint8Array(n).fill(255))).toBe(
      "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
    );
  });

  it("rejects times outside 48 bits", () => {
    expect(() => ulid(-1, secureRandomBytes)).toThrow(RangeError);
    expect(() => ulid(2 ** 48, secureRandomBytes)).toThrow(RangeError);
  });
});

describe("createIdFactory", () => {
  it("prefixes ids and validates them", () => {
    const newId = createIdFactory(() => 1_760_000_000_000, secureRandomBytes);
    const id = newId("usr");
    expect(isId(id)).toBe(true);
    expect(isId(id, "usr")).toBe(true);
    expect(isId(id, "org")).toBe(false);
    expect(isId("usr_short")).toBe(false);
    expect(isId(`xyz_${id.slice(4)}`)).toBe(false);
  });
});
