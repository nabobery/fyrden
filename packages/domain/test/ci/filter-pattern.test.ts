// GitHub's filter patterns for branches, tags and paths. The table rows are
// the examples of GitHub's cheat sheet (verified 2026-11-15,
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#filter-pattern-cheat-sheet),
// with non-matches of our own beside them.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compilePattern,
  compileWork,
  filterAllows,
  matchesPatterns,
  pathsAllow,
} from "../../src/ci/filter-pattern.js";

describe("compilePattern: GitHub's cheat sheet, branches and tags", () => {
  it.each([
    ["feature/*", ["feature/my-branch", "feature/your-branch"], ["feature/a/b", "feature"]],
    [
      "feature/**",
      ["feature/beta-a/my-branch", "feature/your-branch", "feature/mona/the/octocat"],
      ["features/x", "feature"],
    ],
    ["main", ["main"], ["main2", "xmain", "Main"]],
    ["releases/mona-the-octocat", ["releases/mona-the-octocat"], ["releases/mona"]],
    ["*", ["main", "releases"], ["releases/1"]],
    ["**", ["all/the/branches", "every/tag", "x"], []],
    ["*feature", ["mona-feature", "feature", "ver-10-feature"], ["a/feature", "features"]],
    ["v2*", ["v2", "v2.0", "v2.9"], ["v1", "v2/x"]],
    ["v[12].[0-9]+.[0-9]+", ["v1.10.1", "v2.0.0"], ["v3.0.0", "v1..1", "v1.a.1", "v12.0.0"]],
    ["[CB]at", ["Cat", "Bat"], ["cat", "at", "CBat"]],
    ["[1-2]00", ["100", "200"], ["300", "00"]],
    ["[0-9a-z]", ["5", "q"], ["Q", "55"]],
  ])("%s", (pattern, matches, misses) => {
    const p = compilePattern(pattern);
    for (const value of matches) expect(p.matches(value), value).toBe(true);
    for (const value of misses) expect(p.matches(value), value).toBe(false);
  });
});

describe("compilePattern: GitHub's cheat sheet, paths", () => {
  it.each([
    ["*", ["README.md", "server.rb"], ["docs/README.md"]],
    ["*.jsx?", ["page.js", "page.jsx"], ["page.jsxx", "page.j", "src/page.js"]],
    ["**", ["all/the/files.md"], []],
    ["*.js", ["app.js", "index.js"], ["js/index.js"]],
    ["**.js", ["index.js", "js/index.js", "src/js/app.js"], ["index.ts"]],
    ["docs/*", ["docs/README.md", "docs/file.txt"], ["docs/mona/octocat.txt", "x/docs/a"]],
    ["docs/**", ["docs/README.md", "docs/mona/octocat.txt"], ["doc/x", "x/docs/a"]],
    [
      "docs/**/*.md",
      ["docs/README.md", "docs/mona/hello-world.md", "docs/a/markdown/file.md"],
      ["docs/a.txt", "README.md"],
    ],
    [
      "**/docs/**",
      ["docs/hello.md", "dir/docs/my-file.txt", "space/docs/plan/space.doc"],
      ["mydocs/a", "docs"],
    ],
    ["**/README.md", ["README.md", "js/README.md"], ["xREADME.md", "js/README.mdx"]],
    ["**/*src/**", ["a/src/app.js", "my-src/code/js/app.js"], ["src", "a/source/x"]],
    ["**/*-post.md", ["my-post.md", "path/their-post.md"], ["post.md"]],
    [
      "**/migrate-*.sql",
      ["migrate-10909.sql", "db/migrate-v1.0.sql", "db/sept/migrate-v1.sql"],
      ["db/migrate-v1.sql.bak", "db/remigrate-1.sql"],
    ],
  ])("%s", (pattern, matches, misses) => {
    const p = compilePattern(pattern);
    for (const value of matches) expect(p.matches(value), value).toBe(true);
    for (const value of misses) expect(p.matches(value), value).toBe(false);
  });

  it("escapes a special character with a backslash", () => {
    expect(compilePattern("a\\*b").matches("a*b")).toBe(true);
    expect(compilePattern("a\\*b").matches("axb")).toBe(false);
    expect(compilePattern("v1\\+").matches("v1+")).toBe(true);
    expect(compilePattern("v1\\+").matches("v11")).toBe(false);
  });

  it("reads `!` as negation only at the start", () => {
    expect(compilePattern("!main").negated).toBe(true);
    expect(compilePattern("!main").matches("main")).toBe(true);
    const inner = compilePattern("a!b");
    expect(inner.negated).toBe(false);
    expect(inner.matches("a!b")).toBe(true);
  });

  it("takes an unclosed bracket and a leading quantifier literally", () => {
    expect(compilePattern("a[b").matches("a[b")).toBe(true);
    expect(compilePattern("+a").matches("+a")).toBe(true);
    expect(compilePattern("?a").matches("?a")).toBe(true);
  });

  it("compiles with work linear in the pattern, unclosed brackets included", () => {
    for (const pattern of [
      "[".repeat(20_000),
      `${"[".repeat(20_000)}]`,
      `${"[a".repeat(10_000)}]`,
      `[${"0-[".repeat(1_000)}z-a]`,
    ]) {
      const examined = compileWork(pattern);
      expect(examined).toBeGreaterThanOrEqual(pattern.length);
      expect(examined).toBeLessThanOrEqual(4 * pattern.length);
    }
    expect(compilePattern("[".repeat(3)).matches("[[[")).toBe(true);
  });

  it("matches in time linear in the input, with no backtracking blow-up", () => {
    // A backtracking matcher takes exponential steps on this pair; the NFA walk does not.
    const pattern = compilePattern(`${"*a".repeat(30)}b`);
    expect(pattern.matches("a".repeat(5_000))).toBe(false);
    expect(compilePattern(`${"**a".repeat(30)}`).matches("a/".repeat(2_000))).toBe(false);
  });
});

describe("matchesPatterns: ordered negation", () => {
  it("excludes with a later negation and re-includes with a later positive", () => {
    const md = ["*.md", "!README.md"];
    expect(matchesPatterns(md, "hello.md")).toBe(true);
    expect(matchesPatterns(md, "README.md")).toBe(false);
    expect(matchesPatterns(md, "docs/hello.md")).toBe(false);
    const again = ["*.md", "!README.md", "README*"];
    expect(matchesPatterns(again, "hello.md")).toBe(true);
    expect(matchesPatterns(again, "README.md")).toBe(true);
    expect(matchesPatterns(again, "README.doc")).toBe(true);
  });

  it("follows GitHub's releases example", () => {
    const branches = ["releases/**", "!releases/**-alpha"];
    expect(matchesPatterns(branches, "releases/10")).toBe(true);
    expect(matchesPatterns(branches, "releases/beta/mona")).toBe(true);
    expect(matchesPatterns(branches, "releases/10-alpha")).toBe(false);
    expect(matchesPatterns(branches, "releases/beta/3-alpha")).toBe(false);
  });

  it("matches nothing with only negations or no patterns", () => {
    expect(matchesPatterns(["!main"], "dev")).toBe(false);
    expect(matchesPatterns(["!main"], "main")).toBe(false);
    expect(matchesPatterns([], "main")).toBe(false);
  });
});

describe("filterAllows and pathsAllow", () => {
  it("includes or ignores one name", () => {
    expect(filterAllows({ mode: "include", patterns: ["main"] }, "main")).toBe(true);
    expect(filterAllows({ mode: "include", patterns: ["main"] }, "dev")).toBe(false);
    expect(filterAllows({ mode: "ignore", patterns: ["main"] }, "main")).toBe(false);
    expect(filterAllows({ mode: "ignore", patterns: ["main"] }, "dev")).toBe(true);
  });

  it("runs when any changed path is included, or any is not ignored", () => {
    const sub = { mode: "include" as const, patterns: ["sub-project/**", "!sub-project/docs/**"] };
    expect(pathsAllow(sub, ["sub-project/index.js"])).toBe(true);
    expect(pathsAllow(sub, ["sub-project/src/index.js"])).toBe(true);
    expect(pathsAllow(sub, ["sub-project/docs/readme.md"])).toBe(false);
    expect(pathsAllow(sub, ["sub-project/docs/readme.md", "sub-project/a"])).toBe(true);
    const docs = { mode: "ignore" as const, patterns: ["docs/**"] };
    expect(pathsAllow(docs, ["docs/a.md"])).toBe(false);
    expect(pathsAllow(docs, ["docs/a.md", "src/a.ts"])).toBe(true);
  });

  it("never runs on no changed paths", () => {
    expect(pathsAllow({ mode: "include", patterns: ["**"] }, [])).toBe(false);
    expect(pathsAllow({ mode: "ignore", patterns: ["docs/**"] }, [])).toBe(false);
  });
});

/** Text with no character the pattern syntax gives meaning to. */
const literal = fc.stringMatching(/^[A-Za-z0-9._/-]{1,24}$/).filter((s) => !s.startsWith("!"));
const path = fc.stringMatching(/^[A-Za-z0-9._/*?+[\]!-]{0,30}$/);

describe("filter patterns: properties", () => {
  it("a literal pattern matches exactly itself", () => {
    fc.assert(
      fc.property(literal, path, (pattern, other) => {
        const p = compilePattern(pattern);
        expect(p.matches(pattern)).toBe(true);
        expect(p.matches(other)).toBe(other === pattern);
      }),
    );
  });

  it("`**` matches every path", () => {
    fc.assert(fc.property(path, (value) => compilePattern("**").matches(value)));
  });

  it("a negation of the same literal after it excludes it", () => {
    fc.assert(
      fc.property(literal, fc.array(literal, { maxLength: 3 }), (pattern, before) => {
        expect(matchesPatterns([...before, pattern, `!${pattern}`], pattern)).toBe(false);
        expect(matchesPatterns([...before, `!${pattern}`, pattern], pattern)).toBe(true);
      }),
    );
  });
});
