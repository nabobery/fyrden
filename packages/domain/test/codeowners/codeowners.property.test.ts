// The matcher against an independent oracle: a regular expression built
// from the documented rules (anchoring, a trailing slash as everything
// beneath, `**` as any directories, `*` and `?` within a segment, a final
// name owning what is beneath it unless it is `*` alone), compared over
// generated patterns and paths.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compilePattern, MatchBudget, matchesPath, preparePath } from "../../src/index.js";

/** A segment's glob as a regular expression. */
const glob = (segment: string) =>
  segment === "*"
    ? "[^/]+"
    : [...segment]
        .map((c) =>
          c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");

/** The oracle: a pattern (no escapes) as a regular expression over whole paths. */
function oracle(pattern: string): RegExp {
  let segments = pattern.split("/");
  if (segments[0] === "") segments = segments.slice(1);
  else if (segments.length === 1 || (segments.length === 2 && segments[1] === "")) {
    if (segments[0] !== "**") segments = ["**", ...segments];
  }
  if (segments.length > 1 && segments.at(-1) === "") segments[segments.length - 1] = "**";
  const last = segments.length - 1;
  let re = "";
  for (const [i, segment] of segments.entries()) {
    if (segment === "**") {
      if (i === 0 && i === last) re += ".+";
      else if (i === 0) re += "(?:[^/]+/)*";
      else if (i === last) re += "/.+";
      else re += "(?:/[^/]+)*";
      continue;
    }
    if (i > 0 && !(i === 1 && segments[0] === "**")) re += "/";
    re += glob(segment);
    if (i === last && segment !== "*") re += "(?:/.+)?";
  }
  return new RegExp(`^${re}$`, "u");
}

const segment = fc.constantFrom("a", "b", "ab", "*", "?", "a*", "*b", "?b", "**");
const pattern = fc
  .tuple(fc.boolean(), fc.array(segment, { minLength: 1, maxLength: 4 }), fc.boolean())
  // `**` twice in a row is pinned against the reference instead (the oracle has no rule for it).
  .filter(([, segments]) => !segments.some((s, i) => s === "**" && segments[i + 1] === "**"))
  .map(([lead, segments, trail]) => `${lead ? "/" : ""}${segments.join("/")}${trail ? "/" : ""}`);
const path = fc
  .array(fc.constantFrom("a", "b", "ab", "ba", "aa", "abb"), { minLength: 1, maxLength: 6 })
  .map((segments) => segments.join("/"));

describe("the CODEOWNERS matcher", () => {
  it("agrees with the oracle on generated patterns and paths", () => {
    fc.assert(
      fc.property(pattern, path, (p, q) => {
        const compiled = compilePattern(p);
        if (!compiled.ok) return true;
        const budget = new MatchBudget(1_000_000);
        expect(matchesPath(compiled.pattern, preparePath(q, budget), budget), `${p} on ${q}`).toBe(
          oracle(p).test(q),
        );
      }),
      { numRuns: 5_000 },
    );
  });
});
