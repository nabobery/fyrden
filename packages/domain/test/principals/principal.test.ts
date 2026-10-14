import { describe, expect, it } from "vitest";
import { isReservedHandle, isValidHandle } from "../../src/principals/principal.js";

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
