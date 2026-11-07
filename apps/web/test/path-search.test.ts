// The finder's search: a case-insensitive substring over every path, the first matches and how many there are.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PathIndex } from "../app/lib/path-search.js";

const indexOf = (...pages: string[][]) => {
  const index = new PathIndex();
  for (const page of pages) index.add(page);
  return index;
};

describe("searching a path list", () => {
  const paths = ["README.md", "docs/Guide.md", "src/index.ts", "src/lib/guide.ts"];

  it("shows the first paths and counts them all when nothing is typed", () => {
    expect(indexOf(paths).search("", 2)).toEqual({
      shown: ["README.md", "docs/Guide.md"],
      total: 4,
    });
  });

  it("matches anywhere in a path, directories too, ignoring case, in the list's order", () => {
    expect(indexOf(paths).search("GUIDE", 10)).toEqual({
      shown: ["docs/Guide.md", "src/lib/guide.ts"],
      total: 2,
    });
    expect(indexOf(paths).search("src/", 10).total).toBe(2);
    expect(indexOf(paths).search("rc/li", 10).shown).toEqual(["src/lib/guide.ts"]);
  });

  it("counts matches past those it shows", () => {
    expect(indexOf(paths).search("md", 1)).toEqual({ shown: ["README.md"], total: 2 });
  });

  it("finds nothing without failing", () => {
    expect(indexOf(paths).search("zzz", 10)).toEqual({ shown: [], total: 0 });
    expect(indexOf().search("a", 10)).toEqual({ shown: [], total: 0 });
    expect(indexOf().search("", 10)).toEqual({ shown: [], total: 0 });
  });

  it("takes what is typed literally, around stray spaces", () => {
    const odd = ["a.b", "axb", "c(d)/e*", "with space/f", "naïve.txt"];
    expect(indexOf(odd).search("a.b", 10).shown).toEqual(["a.b"]);
    expect(indexOf(odd).search("(d)/e*", 10).shown).toEqual(["c(d)/e*"]);
    expect(indexOf(odd).search("  axb ", 10).shown).toEqual(["axb"]);
    expect(indexOf(odd).search("h s", 10).shown).toEqual(["with space/f"]);
    expect(indexOf(odd).search("NAÏVE", 10).shown).toEqual(["naïve.txt"]);
    expect(indexOf(odd).search("   ", 2).total).toBe(5);
  });

  it("searches pages added later, and answers one size", () => {
    const index = indexOf(["a/1"]);
    expect(index.search("a/", 10).total).toBe(1);
    index.add(["a/2", "b/3"]);
    expect(index.search("a/", 10)).toEqual({ shown: ["a/1", "a/2"], total: 2 });
    expect(index.size).toBe(3);
  });

  it("agrees with a plain filter for any paths and query", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.string({ minLength: 1 }))),
        fc.string(),
        fc.integer({ min: 1, max: 5 }),
        (pages, query, limit) => {
          const want = query.trim().toLowerCase();
          const all = pages.flat().filter((p) => p.toLowerCase().includes(want));
          expect(indexOf(...pages).search(query, limit)).toEqual({
            shown: all.slice(0, limit),
            total: all.length,
          });
        },
      ),
    );
  });
});
