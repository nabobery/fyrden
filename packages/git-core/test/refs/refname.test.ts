import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isValidRefname } from "../../src/refs/refname.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const valid = (name: string, allowOneLevel = false) =>
  isValidRefname(utf8(name), { allowOneLevel });

describe("isValidRefname (git's check_refname_format)", () => {
  it.each([
    "refs/heads/main",
    "refs/tags/v1.0",
    "refs/heads/feature/x-y_z",
    "refs/heads/été",
    "refs/heads/a@b",
    "refs/heads/a.b",
    "refs/heads/{x}",
  ])("accepts %j", (name) => {
    expect(valid(name)).toBe(true);
  });

  it.each([
    ["one level", "main"],
    ["a single @", "@"],
    ["an empty name", ""],
    ["a leading slash", "/refs/heads/a"],
    ["a trailing slash", "refs/heads/a/"],
    ["a double slash", "refs//heads"],
    ["a component starting with '.'", "refs/heads/.hidden"],
    ["'..'", "refs/heads/a..b"],
    ["a trailing '.'", "refs/heads/a."],
    ["'.lock' at a component end", "refs/heads/a.lock/b"],
    ["'@{'", "refs/heads/a@{b"],
    ["a space", "refs/heads/a b"],
    ["a tab", "refs/heads/a\tb"],
    ["DEL", "refs/heads/a\u007f"],
    ["a control character", "refs/heads/a\u0001"],
    ...[":", "?", "[", "\\", "^", "~", "*"].map((c) => [`'${c}'`, `refs/heads/a${c}b`]),
  ])("rejects %s", (_, name) => {
    expect(valid(name as string)).toBe(false);
  });

  it("allows one level only when asked", () => {
    expect(valid("HEAD", true)).toBe(true);
    expect(valid("HEAD")).toBe(false);
  });

  it("rejects a NUL, which no ref name can hold", () => {
    expect(isValidRefname(new Uint8Array([0x61, 0x2f, 0x00]))).toBe(false);
  });
});

describe("isValidRefname against git check-ref-format", () => {
  let sandbox: GitSandbox;
  beforeAll(async () => {
    sandbox = await createGitSandbox();
  });
  afterAll(() => sandbox.dispose());

  it("agrees on names built from the characters the rules care about", async () => {
    const pieces = [
      "a",
      "b",
      ".",
      "..",
      "/",
      "@",
      "{",
      "}",
      "@{",
      ".lock",
      "*",
      "~",
      ":",
      " ",
      "é",
      "-",
      "x",
    ];
    const names = fc.sample(
      fc
        .array(fc.constantFrom(...pieces), { minLength: 1, maxLength: 7 })
        .map((p) => `refs/${p.join("")}`),
      { seed: 20261010, numRuns: 300 },
    );
    const results = await Promise.all(
      [...new Set(names)].map(async (name) => {
        const git = await sandbox.git(["check-ref-format", name]).then(
          () => true,
          () => false,
        );
        return { name, git, ours: valid(name) };
      }),
    );
    expect(results.filter((r) => r.git !== r.ours)).toEqual([]);
    expect(results.some((r) => r.git)).toBe(true);
    expect(results.some((r) => !r.git)).toBe(true);
  });
});
