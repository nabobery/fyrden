// CODEOWNERS as GitHub reads and matches it: its documented example, the
// boundaries its rules imply, every error a file can have (kept, so merges
// needing code owners can refuse), matching bounded by a step budget, and
// paths matched as text only when they are UTF-8.
import { describe, expect, it } from "vitest";
import {
  CODEOWNERS_PATHS,
  codeOwnersTooLarge,
  compilePattern,
  MAX_CODEOWNERS_BYTES,
  MAX_CODEOWNERS_RULES,
  MAX_FILE_OWNERS,
  MAX_PATTERN_BYTES,
  MAX_PATTERN_SEGMENTS,
  MAX_PATTERN_WILDCARDS,
  MAX_RULE_OWNERS,
  MatchBudget,
  MatchBudgetExceeded,
  matchesPath,
  ownershipOf,
  parseCodeOwners,
  pathText,
  preparePath,
  quoteExcerpt,
} from "../../src/index.js";
import hmarr from "./hmarr-patterns.json" with { type: "json" };

const encoder = new TextEncoder();
const parse = (text: string) => parseCodeOwners(encoder.encode(text));
const budget = () => new MatchBudget(1_000_000);

/** Whether `pattern` owns `path`. */
function owns(pattern: string, path: string): boolean {
  const compiled = compilePattern(pattern);
  if (!compiled.ok) throw new Error(`${pattern}: ${compiled.refusal}`);
  const spent = budget();
  return matchesPath(compiled.pattern, preparePath(path, spent), spent);
}

describe("CODEOWNERS patterns", () => {
  // GitHub's documented example, each line's stated meaning.
  it.each([
    ["*", ["README.md", "a/b/c.txt"], []],
    ["*.js", ["app.js", "src/lib/app.js"], ["app.ts", "app.jsx"]],
    [
      "/build/logs/",
      ["build/logs/x.log", "build/logs/deep/y.log"],
      ["build/logs", "src/build/logs/x"],
    ],
    ["docs/*", ["docs/getting-started.md"], ["docs/build-app/troubleshooting.md", "src/docs/a.md"]],
    ["apps/", ["apps/a.js", "src/apps/x/y.js"], ["apps", "myapps/a.js"]],
    ["/docs/", ["docs/a.md", "docs/x/y.md"], ["src/docs/a.md", "docs"]],
    [
      "**/logs",
      ["logs/x", "build/logs/x", "scripts/logs/y", "deeply/nested/logs/z"],
      ["logsx/a", "build/log/x"],
    ],
    ["/apps/github", ["apps/github", "apps/github/x/y"], ["apps/github2", "src/apps/github"]],
  ])("%s owns what GitHub documents", (pattern, owned, others) => {
    for (const path of owned) expect(owns(pattern, path), path).toBe(true);
    for (const path of others) expect(owns(pattern, path), path).toBe(false);
  });

  it.each([
    // Case-sensitive.
    ["*.JS", "a.js", false],
    ["Docs/", "docs/a.md", false],
    // `?` is one character within a segment.
    ["a?.txt", "ab.txt", true],
    ["a?.txt", "abc.txt", false],
    ["/a?b", "a/b", false],
    // `*` stays within a segment; as a whole segment it is one segment.
    ["/src/*.ts", "src/a/b.ts", false],
    ["/src/*/index.ts", "src/a/index.ts", true],
    ["/src/*/index.ts", "src/a/b/index.ts", false],
    // `**` in the middle is any number of directories, none included.
    ["/src/**/index.ts", "src/index.ts", true],
    ["/src/**/index.ts", "src/a/b/index.ts", true],
    // As the last segment, everything beneath (not the directory itself).
    ["/src/**", "src/a", true],
    ["/src/**", "src", false],
    // A name owns what is beneath a directory of that name; a lone `*` does not.
    ["/vendor", "vendor/lib/a.c", true],
    ["/vendor/*", "vendor/lib/a.c", false],
    ["*.d", "x/y.d/z", true],
    // A slash anywhere but the end anchors at the root.
    ["src/app", "lib/src/app", false],
    ["src/app", "src/app", true],
    ["src/app/", "lib/src/app/x", false],
    ["src/app/", "src/app/x", true],
    // Escapes: a space, a star; brackets are literal, escaped or not.
    ["my\\ file.txt", "my file.txt", true],
    ["/a\\*b", "a*b", true],
    ["/a\\*b", "axb", false],
    ["/page/\\[id\\].tsx", "page/[id].tsx", true],
    ["/page/[id].tsx", "page/[id].tsx", true],
    ["/page/[id].tsx", "page/i.tsx", false],
    // Non-ASCII is matched by character, a surrogate pair as one.
    ["/ä?ö", "äüö", true],
    ["/a?b", "a\u{1F600}b", true],
    ["/a*b", "a\u{1F600}\u{1F600}b", true],
    // `**` twice in a row is one (as the reference reads a real file's `/kms/**/**`).
    ["/kms/**/**", "kms/key.py", true],
    ["/kms/**/**", "kms/deep/key.py", true],
    ["/kms/**/**", "kms", false],
    ["/a/**/**/b", "a/b", true],
    ["/a/**/**/b", "a/x/y/b", true],
  ])("%s on %s: %s", (pattern, path, expected) => {
    expect(owns(pattern, path)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["!vendor/", "negation"],
    ["**/", "globstar_only"],
    ["**/**", "globstar_only"],
    ["/**/**", "globstar_only"],
    ["/**/", "globstar_only"],
    ["\\#notes", "escaped_comment"],
    ["a\\/b", "escaped_slash"],
    ["src/***/a", "triple_star"],
    ["***", "triple_star"],
    ["/", "root_only"],
    ["//", "root_only"],
    ["a\\", "trailing_escape"],
    ["\\", "trailing_escape"],
  ])("refuses %s (%s), as GitHub does not support it", (pattern, refusal) => {
    expect(compilePattern(pattern)).toEqual({ ok: false, refusal });
  });

  it("bound their work: a costly pattern exhausts its budget, not the CPU", () => {
    // Stars within a segment are linear (greedy, backtracking to the last star only).
    const stars = compilePattern(`/${"*a".repeat(20)}*b`);
    if (!stars.ok) throw new Error("compiled");
    const linear = new MatchBudget(1_000_000);
    expect(matchesPath(stars.pattern, preparePath("a".repeat(2_000), linear), linear)).toBe(false);
    expect(linear.spent).toBeLessThan(10_000);
    // `**` between names over a deep path is the costly shape: refused past the budget.
    const dirs = compilePattern(`/${"**/a/".repeat(20)}**/b`);
    if (!dirs.ok) throw new Error("compiled");
    const deep = `${"a/".repeat(500)}c`;
    const small = new MatchBudget(10_000);
    expect(() => matchesPath(dirs.pattern, preparePath(deep, small), small)).toThrow(
      MatchBudgetExceeded,
    );
    // A budget is shared by every match made under it.
    const shared = new MatchBudget(1_000_000);
    expect(matchesPath(dirs.pattern, preparePath(`${"a/".repeat(30)}b`, shared), shared)).toBe(
      true,
    );
    expect(shared.spent).toBeGreaterThan(0);
    expect(shared.spent).toBeLessThan(1_000_000);
  });
});

describe("CODEOWNERS patterns, against the reference implementation", () => {
  // hmarr/codeowners' fixtures (testdata/patterns.json at 11d3ff2, MIT: hmarr-patterns.LICENSE),
  // the implementation that follows GitHub's; paths are never a directory here (no trailing slash).
  for (const fixture of hmarr as {
    name: string;
    pattern: string;
    paths: Record<string, boolean>;
  }[])
    it(`${fixture.name}: ${fixture.pattern}`, () => {
      for (const [path, expected] of Object.entries(fixture.paths))
        if (!path.endsWith("/")) expect(owns(fixture.pattern, path), path).toBe(expected);
    });

  it("charge a path's preparation: a long path costs its length, once for every rule", () => {
    const spent = new MatchBudget(10_000_000);
    const file = parse(Array.from({ length: 1_000 }, (_, i) => `/z${i} @a`).join("\n"));
    const path = "a".repeat(100_000);
    expect(ownershipOf(file, path, spent)).toEqual({ kind: "unmatched" });
    // Prepared once (its length), then a step or two a rule.
    expect(spent.spent).toBeGreaterThanOrEqual(path.length);
    expect(spent.spent).toBeLessThan(path.length + 10_000);
    expect(() => ownershipOf(file, path, new MatchBudget(50_000))).toThrow(MatchBudgetExceeded);
  });

  it("charge a literal what comparing it costs: no more than the segment left (the largest file's rules, measured)", () => {
    // 1,000 rules whose first segment is a 2,000-character literal: a short path fails each one
    // at once, so the whole file costs a few steps a rule, not the literals' length.
    const rules = Array.from(
      { length: 1_000 },
      (_, r) =>
        `/r${r}s0${"x".repeat(2_000)}?/${Array.from({ length: 62 }, (_, s) => `r${r}s${s + 1}?`).join("/")}* @owner`,
    );
    const file = parse(rules.join("\n"));
    expect(file.errors).toEqual([]);
    const spent = new MatchBudget(1_000_000);
    expect(ownershipOf(file, "a.txt", spent)).toEqual({ kind: "unmatched" });
    expect(spent.spent).toBeLessThan(20_000);
    // A literal compared in full still spends its length.
    const exact = compilePattern(`/${"y".repeat(3_000)}`);
    if (!exact.ok) throw new Error("compiled");
    const full = new MatchBudget(1_000_000);
    const prepared = preparePath("y".repeat(3_000), full);
    const before = full.spent;
    expect(matchesPath(exact.pattern, prepared, full)).toBe(true);
    expect(full.spent - before).toBeGreaterThanOrEqual(3_000);
  });
});

describe("CODEOWNERS files", () => {
  it("are found where GitHub looks, in its order", () => {
    expect(CODEOWNERS_PATHS).toEqual([".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]);
  });

  it("read rules, owners and inline comments; the last matching rule decides; ownerless exempts", () => {
    const file = parse(
      [
        "# Owners of everything",
        "*       @global-owner1 @global-owner2",
        "*.js    @js-owner #This is an inline comment.",
        "",
        "  /docs/   @octo-org/Docs-Team   ",
        "/docs/generated/",
        "\r",
        "/apps/github @doctocat\r",
      ].join("\n"),
    );
    expect(file.errors).toEqual([]);
    expect(file.rules.map((r) => [r.line, r.owners])).toEqual([
      [
        2,
        [
          { kind: "user", handle: "global-owner1" },
          { kind: "user", handle: "global-owner2" },
        ],
      ],
      [3, [{ kind: "user", handle: "js-owner" }]],
      [5, [{ kind: "team", org: "octo-org", slug: "docs-team" }]],
      [6, []],
      [8, [{ kind: "user", handle: "doctocat" }]],
    ]);
    const at = (path: string) => ownershipOf(file, path, budget());
    expect(at("src/a.js")).toMatchObject({ kind: "owned", line: 3 });
    expect(at("README.md")).toMatchObject({ kind: "owned", line: 2 });
    expect(at("docs/a.md")).toMatchObject({ kind: "owned", line: 5 });
    expect(at("docs/generated/x.md")).toEqual({ kind: "ownerless", line: 6 });
    expect(at("apps/github/a.js")).toMatchObject({ kind: "owned", line: 8 });
    expect(ownershipOf(parse("/docs/ @a\n"), "src/a.ts", budget())).toEqual({ kind: "unmatched" });
  });

  it("keep every error with its line, column and reason, and only the valid rules", () => {
    const file = parse(
      [
        "*.go docs@example.com",
        "!vendor/ @a",
        "*.txt @octo-org/octocats @not/a/team",
        "*.md not-an-owner",
        "/ok/ @fine",
        "**/ @x",
      ].join("\n"),
    );
    expect(file.errors[0]?.message).toBe("Email owners (docs@example.com) are not supported.");
    expect(file.errors[3]?.message).toBe("not-an-owner is not an owner: use @user or @org/team.");
    expect(file.errors.map((e) => [e.line, e.column, e.kind])).toEqual([
      [1, 6, "Unsupported owner"],
      [2, 1, "Invalid pattern"],
      [3, 26, "Invalid owner"],
      [4, 6, "Invalid owner"],
      [6, 1, "Invalid pattern"],
    ]);
    expect(file.errors[1]).toMatchObject({
      source: "!vendor/ @a",
      message: expect.stringContaining("Negating"),
      suggestion: expect.any(String),
    });
    expect(file.rules.map((r) => r.line)).toEqual([5]);
  });

  it("refuse past their caps: size, rules, owners, pattern length", () => {
    expect(parseCodeOwners(new Uint8Array(MAX_CODEOWNERS_BYTES))).toEqual({
      rules: [],
      errors: [
        expect.objectContaining({
          line: 0,
          kind: "File too large",
          message: expect.stringContaining(String(MAX_CODEOWNERS_BYTES)),
        }),
      ],
    });
    const many = Array.from({ length: MAX_CODEOWNERS_RULES + 5 }, (_, i) => `/f${i} @a`).join("\n");
    const ruled = parse(many);
    expect(ruled.rules).toHaveLength(MAX_CODEOWNERS_RULES);
    expect(ruled.errors).toEqual([
      expect.objectContaining({
        line: MAX_CODEOWNERS_RULES + 1,
        kind: "Too many rules",
        message: expect.stringContaining(String(MAX_CODEOWNERS_RULES)),
      }),
    ]);
    // Invalid lines count too: a malformed file stops at the cap, with one error a line read.
    const malformed = parse("!\n".repeat(1_400_000));
    expect(malformed.rules).toEqual([]);
    expect(malformed.errors).toHaveLength(MAX_CODEOWNERS_RULES + 1);
    expect(malformed.errors.at(-1)).toMatchObject({ kind: "Too many rules" });
    const names = Array.from({ length: MAX_RULE_OWNERS + 1 }, (_, i) => `@u${i}`);
    const crowded = parse(`* ${names.join(" ")}`);
    // At the first owner past the cap.
    expect(crowded.errors).toEqual([
      expect.objectContaining({
        kind: "Too many owners",
        column: `* ${names.slice(0, -1).join(" ")} `.length + 1,
        message: expect.stringContaining(String(MAX_RULE_OWNERS)),
      }),
    ]);
    const perRule = Array.from({ length: MAX_RULE_OWNERS }, (_, i) => `@u${i}`).join(" ");
    const total = Math.floor(MAX_FILE_OWNERS / MAX_RULE_OWNERS) + 1;
    const owned = parse(Array.from({ length: total }, (_, i) => `/p${i} ${perRule}`).join("\n"));
    expect(owned.errors).toEqual([
      expect.objectContaining({ line: total, kind: "Too many owners" }),
    ]);
    const long = parse(`/${"a".repeat(MAX_PATTERN_BYTES)} @a`);
    expect(long.errors).toEqual([
      expect.objectContaining({
        kind: "Pattern too long",
        message: expect.stringContaining(String(MAX_PATTERN_BYTES)),
      }),
    ]);
    // At the cap exactly, it is a pattern.
    expect(parse(`/${"a".repeat(MAX_PATTERN_BYTES - 1)} @a`).errors).toEqual([]);
  });

  it("split on spaces and tabs, keep escaped spaces and `#` in a pattern, and start a comment at any other `#`", () => {
    const file = parse(
      "my\\ file.txt\t@a\t@b\nfoo#comment @c\n*.ts @alice#comment\n/a\\#b @d\n\\ lead @e",
    );
    expect(file.errors).toEqual([]);
    expect(file.rules.map((r) => [r.pattern.source, r.owners])).toEqual([
      [
        "my\\ file.txt",
        [
          { kind: "user", handle: "a" },
          { kind: "user", handle: "b" },
        ],
      ],
      // As GitHub's reference reads them: an ownerless `foo`, `@alice` owning `*.ts`.
      ["foo", []],
      ["*.ts", [{ kind: "user", handle: "alice" }]],
      ["/a\\#b", [{ kind: "user", handle: "d" }]],
      ["\\ lead", [{ kind: "user", handle: "e" }]],
    ]);
    expect(ownershipOf(file, "x/my file.txt", budget())).toMatchObject({ line: 1 });
    expect(ownershipOf(file, "a#b", budget())).toMatchObject({ line: 4 });
    expect(ownershipOf(file, " lead", budget())).toMatchObject({ line: 5 });
  });

  it("refuse owners that are not a user or a team, with a reason for each", () => {
    const file = parse(
      [
        "/a @-bad",
        "/b @/team",
        "/c @bad_org/team",
        `/d @org/${"t".repeat(101)}`,
        "/e @org/Bad_Slug",
        `/f @org/${"t".repeat(100)}`,
      ].join("\n"),
    );
    expect(file.errors.map((e) => [e.line, e.kind, e.message])).toEqual([
      [1, "Invalid owner", "@-bad is not a valid user."],
      [2, "Invalid owner", "@/team is not a valid team."],
      [3, "Invalid owner", "@bad_org/team is not a valid team."],
      [4, "Invalid owner", `@org/${"t".repeat(101)} is not a valid team.`],
      [5, "Invalid owner", "@org/Bad_Slug is not a valid team."],
    ]);
    expect(file.rules.map((r) => r.line)).toEqual([6]);
  });

  it("suggest an escape for a pattern starting with `#` that parses", () => {
    const [refused] = parse("\\#notes @a").errors;
    expect(refused?.suggestion).toContain("/**/\\#name");
    const fixed = parse("/**/\\#name @a");
    expect(fixed.errors).toEqual([]);
    expect(ownershipOf(fixed, "sub/#name", budget())).toMatchObject({ kind: "owned" });
  });

  it("hold at most a bounded number of wildcards a pattern, so a file compiles to a bounded size", () => {
    expect(compilePattern(`/${"a?".repeat(MAX_PATTERN_WILDCARDS)}`)).toMatchObject({ ok: true });
    expect(
      compilePattern(
        `/${"a*".repeat(MAX_PATTERN_WILDCARDS / 2)}${"?".repeat(MAX_PATTERN_WILDCARDS / 2 + 1)}`,
      ),
    ).toEqual({
      ok: false,
      refusal: "too_many_wildcards",
    });
    // Escaped, they are literal, and do not count.
    expect(compilePattern(`/${"\\?".repeat(MAX_PATTERN_WILDCARDS + 1)}`)).toMatchObject({
      ok: true,
    });
    // A file of patterns all wildcards: every rule refused, with a reason.
    const crowded = parse(`/${"a?".repeat(2_047)}a @x\n`.repeat(3));
    expect(crowded.rules).toEqual([]);
    expect(crowded.errors.map((e) => e.message)).toEqual(
      Array(3).fill(expect.stringContaining(String(MAX_PATTERN_WILDCARDS))),
    );
  });

  it("hold at most a bounded number of path segments a pattern", () => {
    // `/a/a/…`: the leading slash's empty segment counts too.
    expect(compilePattern("/a".repeat(MAX_PATTERN_SEGMENTS - 1))).toMatchObject({ ok: true });
    expect(compilePattern("/a".repeat(MAX_PATTERN_SEGMENTS))).toEqual({
      ok: false,
      refusal: "too_many_segments",
    });
    // A file of deep patterns: every rule refused, with a reason.
    const deep = parse(`${"/a".repeat(1_499)}\n`.repeat(3));
    expect(deep.rules).toEqual([]);
    expect(deep.errors.map((e) => e.message)).toEqual(
      Array(3).fill(expect.stringContaining(String(MAX_PATTERN_SEGMENTS))),
    );
  });

  it("keep their compiled patterns compact: literal text in runs, not a part a character", () => {
    const file = parse(`/${"a".repeat(4_000)} @x`);
    const [element] = file.rules[0]?.pattern.elements ?? [];
    expect(element).toMatchObject({ kind: "segment", parts: [{ kind: "literal" }] });
  });

  it("stop reading a line at its caps, not after taking all of it", () => {
    // A line of three million owners: one error, at the first past the cap.
    const many = parse(`* ${"a ".repeat(1_400_000)}`);
    expect(many.errors).toEqual([expect.objectContaining({ kind: "Too many owners" })]);
    // A pattern far past its cap: refused, at its column.
    const long = parse(`  /${"b".repeat(2_000_000)} @a`);
    expect(long.errors).toEqual([expect.objectContaining({ kind: "Pattern too long", column: 3 })]);
  });

  it("measure a pattern in UTF-8 bytes, and columns in characters, escapes and emoji included", () => {
    // 2-byte and 4-byte characters: the cap is on bytes, not characters.
    expect(parse(`/${"\u00e9".repeat(2_047)} @a`).errors).toEqual([]);
    expect(parse(`/${"\u00e9".repeat(2_048)} @a`).errors).toEqual([
      expect.objectContaining({ kind: "Pattern too long" }),
    ]);
    expect(parse(`/${"\u{1F600}".repeat(1_023)} @a`).errors).toEqual([]);
    expect(parse(`/${"\u{1F600}".repeat(1_024)} @a`).errors).toEqual([
      expect.objectContaining({ kind: "Pattern too long" }),
    ]);
    // An escaped character counts too.
    expect(parse(`/${"\\\u{1F600}".repeat(1_024)} @a`).errors).toEqual([
      expect.objectContaining({ kind: "Pattern too long" }),
    ]);
    // An escaped emoji is literal; columns count it, and an escape, as the characters they are.
    const file = parse("/a\\\u{1F600}\\ b @x \u{1F600}bad");
    expect(file.errors).toEqual([expect.objectContaining({ kind: "Invalid owner", column: 12 })]);
    expect(ownershipOf(parse("/a\\\u{1F600} @x"), "a\u{1F600}", budget())).toMatchObject({
      kind: "owned",
    });
    // An owner past a pattern's cap is an owner refused, not a pattern too long.
    expect(parse(`/a @${"b".repeat(5_000)}`).errors).toEqual([
      expect.objectContaining({ kind: "Invalid owner" }),
    ]);
  });

  it("give one error a line for its refused owners, saying how many", () => {
    expect(parse("/a bad1 bad2").errors[0]?.message).toBe(
      "bad1 is not an owner: use @user or @org/team. 1 more owner is not valid either.",
    );
    const file = parse("/a @ok bad1 @-bad2 bad3@example.com");
    expect(file.errors).toEqual([
      expect.objectContaining({
        line: 1,
        column: 8,
        kind: "Invalid owner",
        message:
          "bad1 is not an owner: use @user or @org/team. 2 more owners are not valid either.",
      }),
    ]);
  });

  it("explain every refused pattern and suggest a fix", () => {
    for (const pattern of ["!a", "**/", "\\#a", "a\\/b", "***", "/", "a\\"]) {
      // A trailing `\\` would escape the space before an owner: it ends its line instead.
      const [error] = parse(pattern.endsWith("\\") ? pattern : `${pattern} @a`).errors;
      expect(error, pattern).toMatchObject({
        kind: "Invalid pattern",
        line: 1,
        column: 1,
        message: expect.stringMatching(/\S/),
        suggestion: expect.stringMatching(/\S/),
      });
    }
  });

  it("are read past a leading byte order mark, which is not part of the first pattern", () => {
    const file = parse("\ufeff* @a\n");
    expect(file.errors).toEqual([]);
    expect(file.rules.map((r) => r.pattern.source)).toEqual(["*"]);
  });

  it("are not read when they are not UTF-8", () => {
    expect(parseCodeOwners(new Uint8Array([0x2a, 0x20, 0x40, 0x61, 0xff]))).toEqual({
      rules: [],
      errors: [
        expect.objectContaining({
          kind: "Invalid encoding",
          message: "The file is not valid UTF-8.",
        }),
      ],
    });
  });
});

describe("paths", () => {
  it("are matched only when UTF-8: a path that is not cannot pass as one that is", () => {
    expect(pathText(encoder.encode("docs/ä.md"))).toBe("docs/ä.md");
    // 0xff decodes to U+FFFD when not fatal: refused instead, so it cannot take that path's owners.
    expect(pathText(new Uint8Array([0x64, 0x2f, 0xff]))).toBeUndefined();
    expect(pathText(encoder.encode("d/�"))).toBe("d/�");
    // A leading byte order mark is part of the path: it cannot pass as the path without it.
    const marked = pathText(encoder.encode("\ufeffdocs/private"));
    expect(marked).toBe("\ufeffdocs/private");
    const file = parse("* @security\n/docs/\n");
    expect(ownershipOf(file, "docs/private", budget())).toEqual({ kind: "ownerless", line: 2 });
    expect(ownershipOf(file, marked ?? "", budget())).toMatchObject({ kind: "owned", line: 1 });
  });
});

describe("what errors quote", () => {
  it("cuts a quoted owner to 256 characters at a code point, marking the cut", () => {
    const token = `${"é".repeat(255)}😀😀😀`;
    const { errors } = parseCodeOwners(new TextEncoder().encode(`/a/ ${token}\n`));
    const message = errors[0]?.message ?? "";
    expect(message).toContain(`${"é".repeat(255)}😀…`);
    expect(message).not.toContain("😀😀");
    expect(quoteExcerpt("short", 256)).toBe("short");
  });

  it("answers a file too large with one whole-file error, as parsing it would", () => {
    const size = MAX_CODEOWNERS_BYTES + 5;
    expect(codeOwnersTooLarge(size)).toEqual(parseCodeOwners(new Uint8Array(size)));
  });
});
