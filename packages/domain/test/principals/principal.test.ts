import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  HANDLE_PATTERN,
  HANDLE_SHAPE,
  isReservedHandle,
  isValidHandle,
  MAX_HANDLE_LENGTH,
} from "../../src/principals/principal.js";

describe("isValidHandle", () => {
  it.each(["a", "alice", "Alice-Bob", "a1-b2-c3", "x".repeat(39)])("accepts %s", (h) => {
    expect(isValidHandle(h)).toBe(true);
  });
  it.each(["", "-a", "a-", "a--b", "a_b", "a.b", "x".repeat(40), "ü"])("rejects %j", (h) => {
    expect(isValidHandle(h)).toBe(false);
  });
});

describe("isReservedHandle", () => {
  it.each(["api", "API", "mcp", "oauth", "auth", "v0", "settings", "Sign-Out", "healthz"])(
    "reserves %s",
    (h) => {
      expect(isReservedHandle(h)).toBe(true);
    },
  );
  it.each(["alice", "mcperson", "apis", "authors"])("leaves %s", (h) => {
    expect(isReservedHandle(h)).toBe(false);
  });
});

describe("HANDLE_SHAPE", () => {
  it("accepts, within the length bound, exactly the handles HANDLE_PATTERN does", () => {
    const shaped = (s: string) =>
      s.length >= 1 && s.length <= MAX_HANDLE_LENGTH && HANDLE_SHAPE.test(s);
    const handleChars = fc.string({
      unit: fc.constantFrom(..."aZ09-_.".split("")),
      maxLength: MAX_HANDLE_LENGTH + 4,
    });
    fc.assert(
      fc.property(fc.oneof(handleChars, fc.string({ maxLength: 50 })), (s) => {
        expect(shaped(s)).toBe(HANDLE_PATTERN.test(s));
      }),
      { numRuns: 5_000 },
    );
    for (const s of ["a", "a-b", "-a", "a-", "a--b", "x".repeat(39), "x".repeat(40), ""])
      expect(shaped(s), s).toBe(HANDLE_PATTERN.test(s));
  });
});
