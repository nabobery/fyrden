// Bounded pages of Markdown bodies: a page of the API's listing shown up to
// a byte budget, the rest on the next navigation after the last id gone
// through, so a deletion meanwhile skips or repeats nothing.

import { describe, expect, it } from "vitest";
import {
  type Continuation,
  readContinuation,
  utf8Length,
  within,
  writeContinuation,
} from "../app/lib/continuation.js";

describe("a continuation", () => {
  it("names the API's page and the last id gone through, and reads back", () => {
    const cases: Continuation[] = [
      { cursor: null, after: null },
      { cursor: "abc:def", after: 7 },
      { cursor: "x", after: null },
      { cursor: null, after: 123_456 },
    ];
    for (const c of cases) expect(readContinuation(writeContinuation(c))).toEqual(c);
    for (const bad of [null, "", "x", "-1:a", "a:b", "99999999999999999:a"])
      expect(readContinuation(bad), String(bad)).toEqual({ cursor: null, after: null });
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
  // Ids 1-5, of these sizes.
  const page = [4, 4, 4, 10, 1].map((size, i) => ({ id: i + 1, size }));
  const take = (
    items: typeof page,
    after: number | null,
    budget: number,
    next: string | null = "n",
  ) => within(items, { cursor: "c", after }, (i) => i.size, budget, next);
  const ids = (r: { items: { id: number }[] }) => r.items.map((i) => i.id);

  it("shows items while they fit, then continues after the last one shown", () => {
    const first = take(page, null, 8);
    expect(ids(first)).toEqual([1, 2]);
    expect(first.next).toEqual({ cursor: "c", after: 2 });
    const second = take(page, 2, 8);
    expect(ids(second)).toEqual([3]);
    expect(second.next).toEqual({ cursor: "c", after: 3 });
  });

  it("always shows one item, however large, so every navigation moves on", () => {
    const big = take(page, 3, 8);
    expect(ids(big)).toEqual([4]);
    expect(big.next).toEqual({ cursor: "c", after: 4 });
  });

  it("passes over items that cost nothing, and continues after them too", () => {
    const free = [
      { id: 1, size: 0 },
      { id: 2, size: 8 },
      { id: 3, size: 0 },
      { id: 4, size: 8 },
    ];
    const r = take(free, null, 8);
    expect(ids(r)).toEqual([1, 2, 3]);
    expect(r.next).toEqual({ cursor: "c", after: 3 });
  });

  it("goes on to the API's next page, or ends", () => {
    expect(take(page, 4, 8)).toEqual({ items: [page[4]], next: { cursor: "n", after: null } });
    expect(take(page, 4, 8, null).next).toBeNull();
    expect(take(page, 99, 8)).toEqual({ items: [], next: { cursor: "n", after: null } });
  });

  it("skips nothing and repeats nothing when items are deleted between navigations", () => {
    const first = take(page, null, 8);
    expect(ids(first)).toEqual([1, 2]);
    // Id 1 (shown) and id 4 (not yet) are deleted before the next navigation.
    const after = page.filter((i) => i.id !== 1 && i.id !== 4);
    const second = take(after, first.next?.after ?? null, 8);
    expect(ids(second)).toEqual([3, 5]);
    // An offset of 2 into the new page would have skipped id 3.
  });
});
