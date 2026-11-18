import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Picomatch {
  makeRe(pattern: string, options?: Record<string, unknown>): RegExp;
}

const require = createRequire(import.meta.url);
const vitest = createRequire(require.resolve("vitest/package.json"));
const vite = createRequire(vitest.resolve("vite/package.json"));
const tinyglobby = createRequire(vitest.resolve("tinyglobby/package.json"));
const fdir = createRequire(tinyglobby.resolve("fdir/package.json"));
const consumers = [
  { name: "vitest", require: vitest },
  { name: "vite", require: vite },
  { name: "tinyglobby", require: tinyglobby },
  { name: "fdir", require: fdir },
];

it("binds the picomatch mitigation to the single pinned version used by every consumer", () => {
  const paths = consumers.map((consumer) => realpathSync(consumer.require.resolve("picomatch")));
  expect(new Set(paths).size).toBe(1);
  for (const consumer of consumers) {
    expect(consumer.require("picomatch/package.json").version).toBe("4.0.7");
  }
  const lock = readFileSync(
    fileURLToPath(new URL("../../../pnpm-lock.yaml", import.meta.url)),
    "utf8",
  );
  const versions = [...lock.matchAll(/^ {2}picomatch@([^(:\s]+)(?:\([^\n]+\))?:$/gm)].map(
    (match) => match[1],
  );
  expect(new Set(versions)).toEqual(new Set(["4.0.7"]));
});

describe.each(consumers)("$name's installed picomatch", (consumer) => {
  const picomatch: Picomatch = consumer.require("picomatch");

  it.each([
    ["+(*)", "^(?:(?=.)(?:[^/]*?))$"],
    ["+(*a)", "^(?:(?=.)(?:[^/]*?a))$"],
    ["*(*a)", "^(?:(?=.)(?:[^/]*?a)?)$"],
    ["+(a*b)", "^(?:(?=.)(?:a[^/]*?b))$"],
    ['+(["]*a)', '^(?:(?=.)(?:(?:\\["\\]|["])[^/]*?a))$'],
    ['+([a"]*a)', '^(?:(?=.)(?:(?:\\[a"\\]|[a"])[^/]*?a))$'],
    ["*(b|*a)", "^(?:(?=.)(?:[^/]*?a)?(?:b)*)$"],
  ])("compiles %s without repeating an unbounded star", (pattern, source) => {
    const expression = picomatch.makeRe(pattern);
    // Fail before evaluating hostile input if the patched form disappears.
    expect(expression.source).toBe(source);
    expect(expression.test(`${"a".repeat(256)}/`)).toBe(false);
  });

  it.each([
    "+(@(*a))",
    "+(@(*)a)",
    "+(a@(*)b)",
    "+(*(*a)b)",
    "+(a*|*b)",
    "+([*a)",
    '*(b|["]*a)',
    '+(["]*a|b)',
    '+([]"]*a")',
    '+([[:alpha:]"]*a")',
  ])("treats %s as a literal when its repeat cannot be safely absorbed", (pattern) => {
    const expression = picomatch.makeRe(pattern);
    expect(expression.source).not.toContain("[^/]*?");
    expect(expression.test(pattern)).toBe(true);
    expect(expression.test(`${"a".repeat(256)}!`)).toBe(false);
  });

  it.each<[string, string, boolean]>([
    ["+(*a)", "ba", true],
    ["+(*a)", "bbb", false],
    ["*(b|*a)", "baba", true],
    ["+(a|b)", "abba", true],
    ["+(a|b[)*", "ab[", true],
    ["+(\\*a)", "*a*a", true],
    ['+("*"a)', "*a*a", true],
    ["+([*]a)", "*a*a", true],
    ["**/+(*a)", "dir/aa", true],
    ["**/*.test.ts", "src/runner.test.ts", true],
    ["**/*.test.ts", "src/runner.js", false],
    ["src/**/*.{ts,tsx}", "src/nested/app.tsx", true],
  ])("matches %s against %s as %s", (pattern, input, matches) => {
    expect(picomatch.makeRe(pattern).test(input)).toBe(matches);
  });

  it("preserves dot and nocase options and the explicit extglob opt-outs", () => {
    expect(picomatch.makeRe("**/*.test.ts").test(".hidden.test.ts")).toBe(false);
    expect(picomatch.makeRe("**/*.test.ts", { dot: true }).test(".hidden.test.ts")).toBe(true);
    expect(picomatch.makeRe("+(*a)", { nocase: true }).test("AA")).toBe(true);
    expect(picomatch.makeRe("+(*a)", { noextglob: true }).test("+aaa")).toBe(true);
    expect(picomatch.makeRe("+(*a)", { noextglob: true }).test("aaa")).toBe(false);
    expect(picomatch.makeRe("+(*a)", { maxExtglobRecursion: false }).source).toContain(
      "(?:[^/]*?a)+",
    );
  });

  it("keeps bracket-prefixed stars safe across parser options", () => {
    for (const options of [
      { capture: true },
      { windows: true },
      { dot: true },
      { maxExtglobRecursion: 0 },
    ]) {
      for (const pattern of ['+(["]*a)', '+([]"]*a")', '+([[:alpha:]"]*a")']) {
        const expression = picomatch.makeRe(pattern, options);
        expect(expression.source).not.toMatch(/\)[+*]/);
        expect(expression.test(`${'"a'.repeat(256)}!`)).toBe(false);
      }
    }
  });

  it("uses the literal fallback for bracketed stars when brackets are disabled", () => {
    const pattern = "+([*]a)";
    const expression = picomatch.makeRe(pattern, { nobracket: true });
    expect(expression.source).not.toContain("[^/]*?");
    expect(expression.test(pattern)).toBe(true);
    expect(expression.test(`${"[]a".repeat(256)}!`)).toBe(false);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['+([\\[:alpha:]"]*a")', {}, 'ba"'],
    ['+([:[Xalpha:]"]*a")', {}, 'ba"'],
    ['+([\\\\\\\\]"]*a")', {}, '\\"]a"'],
    ['+([\\[:alpha:]"]*a")', { maxExtglobRecursion: 0 }, 'ba"'],
    ['+([\\[:alpha:]"]*a")', { capture: true }, 'ba"'],
    ['+(\\\\\\\\"*a\\\\\\\\")', {}, '\\"a\\"'],
    ["+([x\\]*a]b)", { unescape: true }, "xa]b"],
    ['+([]|"]*a"")', {}, ']a""'],
    ['+([\\[:alpha:]|"]*a"")', {}, 'ba""'],
  ])("rejects scanner ambiguity in %s with %j", (pattern, options, unit) => {
    const expression = picomatch.makeRe(pattern, options);
    expect(expression.source).not.toMatch(/\)[+*]/);
    expect(expression.test(`${unit.repeat(256)}!`)).toBe(false);
  });

  it("also removes the repeated star in capture, bash and windows modes", () => {
    for (const options of [{ capture: true }, { bash: true }, { windows: true }]) {
      const expression = picomatch.makeRe("+(*a)", options);
      expect(expression.source).not.toMatch(/\)[+*]/);
      expect(expression.test(`${"a".repeat(256)}!`)).toBe(false);
      expect(expression.test("aaa")).toBe(true);
    }
  });
});
