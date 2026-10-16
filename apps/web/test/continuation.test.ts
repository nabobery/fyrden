// Bounded pages of Markdown bodies: a page of the API's listing shown up to
// a byte budget, the rest on the next navigation, none skipped or repeated.

import { describe, expect, it } from "vitest";
import {
  readContinuation,
  utf8Length,
  within,
  writeContinuation,
} from "../app/lib/continuation.js";

describe("a continuation", () => {
  it("names the API's page and how many of its items were shown, and reads back", () => {
    for (const c of [
      { cursor: null, skip: 0 },
      { cursor: "abc:def", skip: 7 },
      { cursor: "x", skip: 0 },
    ])
      expect(readContinuation(writeContinuation(c))).toEqual(c);
    for (const bad of [null, "", "x", "-1:a", "1234:a", "a:b"])
      expect(readContinuation(bad), String(bad)).toEqual({ cursor: null, skip: 0 });
  });

  it("counts UTF-8 bytes", () => {
    expect(utf8Length("a")).toBe(1);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("€")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
    expect(utf8Length("a😀é")).toBe(new TextEncoder().encode("a😀é").length);
  });
});

describe("a page's items within a budget", () => {
  const sizes = [4, 4, 4, 10, 1];
  const take = (skip: number, budget: number, next: string | null = "n") =>
    within(sizes, { cursor: "c", skip }, (s) => s, budget, next);

  it("shows items while they fit, then continues in the same page", () => {
    expect(take(0, 8)).toEqual({ items: [4, 4], next: { cursor: "c", skip: 2 } });
    expect(take(2, 8)).toEqual({ items: [4], next: { cursor: "c", skip: 3 } });
  });

  it("always shows one item, however large, so every navigation moves on", () => {
    expect(take(3, 8)).toEqual({ items: [10], next: { cursor: "c", skip: 4 } });
  });

  it("goes on to the API's next page, or ends", () => {
    expect(take(4, 8)).toEqual({ items: [1], next: { cursor: "n", skip: 0 } });
    expect(take(4, 8, null)).toEqual({ items: [1], next: null });
    // A continuation past the page's end (the page shrank) moves on too.
    expect(take(9, 8)).toEqual({ items: [], next: { cursor: "n", skip: 0 } });
  });
});
