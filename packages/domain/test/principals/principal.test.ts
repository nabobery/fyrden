import { describe, expect, it } from "vitest";
import { isValidHandle } from "../../src/principals/principal.js";

describe("isValidHandle", () => {
  it.each(["a", "alice", "Alice-Bob", "a1-b2-c3", "x".repeat(39)])("accepts %s", (h) => {
    expect(isValidHandle(h)).toBe(true);
  });
  it.each(["", "-a", "a-", "a--b", "a_b", "a.b", "x".repeat(40), "ü"])("rejects %j", (h) => {
    expect(isValidHandle(h)).toBe(false);
  });
});
