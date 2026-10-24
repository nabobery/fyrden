import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_REFERENCES, referencesIn } from "../../src/issues/references.js";

describe("referencesIn", () => {
  it("finds numbers in this repository and in others, standing apart", () => {
    expect(referencesIn("See #12, and Ada/Demo#3; also (#4).")).toEqual([
      { number: 12, closes: false },
      { repo: { owner: "ada", name: "demo" }, number: 3, closes: false },
      { number: 4, closes: false },
    ]);
  });

  it("finds none inside words, paths, URLs, after a &, or in code", () => {
    for (const text of [
      "a#1",
      "x/y/z#2",
      "https://example.com/a/b#3",
      "&amp;#5",
      "`#6`",
      "```\n#7\n```",
      "#0",
      "#8a",
      "./..#9",
    ])
      expect(referencesIn(text), text).toEqual([]);
  });

  it("marks references right after a closing keyword, any case, with a colon or not", () => {
    expect(
      referencesIn("Fixes #1. closes: ada/demo#2, Resolved #3, refs #4, prefix#5, unfixes #6"),
    ).toEqual([
      { number: 1, closes: true },
      { repo: { owner: "ada", name: "demo" }, number: 2, closes: true },
      { number: 3, closes: true },
      { number: 4, closes: false },
      { number: 6, closes: false },
    ]);
  });

  it("names each once (closing if any naming closes), at most the cap", () => {
    expect(referencesIn("#1 then fixes #1")).toEqual([{ number: 1, closes: true }]);
    const many = Array.from({ length: MAX_REFERENCES + 5 }, (_, i) => `#${i + 1}`).join(" ");
    expect(referencesIn(many)).toHaveLength(MAX_REFERENCES);
  });
});

const KEYWORDS = [
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
];
/** A keyword in any case. */
const keyword = fc
  .tuple(fc.constantFrom(...KEYWORDS), fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }))
  .map(([word, upper]) =>
    [...word].map((c, i) => (upper[i % upper.length] ? c.toUpperCase() : c)).join(""),
  );
const blanks = fc
  .array(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 40 })
  .map((a) => a.join(""));

describe("referencesIn, as properties", () => {
  it("closes after a whole keyword, an optional colon and any run of blanks", () => {
    fc.assert(
      fc.property(
        keyword,
        fc.boolean(),
        blanks,
        fc.integer({ min: 1, max: 9_999 }),
        (k, colon, w, n) => {
          expect(referencesIn(`${k}${colon ? ":" : ""}${w}#${n}`)).toEqual([
            { number: n, closes: true },
          ]);
        },
      ),
    );
  });

  it("does not close after a word that only ends in a keyword", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_]{1,6}$/),
        keyword,
        blanks,
        fc.integer({ min: 1, max: 9_999 }),
        (prefix, k, w, n) => {
          expect(referencesIn(`${prefix}${k}${w}#${n}`)).toEqual([{ number: n, closes: false }]);
        },
      ),
    );
  });

  it("answers any text with at most the cap of distinct, positive references", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const found = referencesIn(text);
        expect(found.length).toBeLessThanOrEqual(MAX_REFERENCES);
        for (const ref of found)
          expect(Number.isSafeInteger(ref.number) && ref.number > 0).toBe(true);
        const keys = found.map(
          (r) => `${r.repo ? `${r.repo.owner}/${r.repo.name}` : ""}#${r.number}`,
        );
        expect(new Set(keys).size).toBe(keys.length);
      }),
    );
  });
});
