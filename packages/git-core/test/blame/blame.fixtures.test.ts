import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  advanceBlame,
  blameRanges,
  DEFAULT_BLAME_SLICE,
  startBlame,
} from "../../src/blame/walk.js";
import { oidFromHex, oidToHex } from "../../src/object/oid.js";
import { gitBinary, gitVersion } from "../../testing/git-cli.js";
import { GitBlameSource, latin1Path, parsePorcelain } from "./blame-git-source.js";

/*
 * Whole blames of real files at frozen commits, against the pinned oracle,
 * plain `git blame`. No third party's text is committed or printed: a failure
 * names only commit ids, line numbers and paths, and what's committed is a
 * hash of the oracle's vector: commit, line and path for each line. Each
 * file's count of settled lines is frozen too, so it can't fall unnoticed.
 * The engine is written from git's behaviour, not its code, so git's own blame
 * and diff sources stay out of these comparisons even as fixtures.
 * Needs full clones, so it's nightly, and on request:
 *
 *   FYRDEN_BLAME_FIXTURES=<dir with express.git and git.git> \
 *   FYRDEN_GIT_BINARY=<git 2.53.0> npx vitest run test/blame/blame.fixtures.test.ts
 */

const FIXTURES = [
  ["express.git", "1faf228935aa0a13111f92c28ee795be64ce3f0f", "lib/application.js"],
  ["express.git", "1faf228935aa0a13111f92c28ee795be64ce3f0f", "lib/router/index.js"],
  ["git.git", "777489f9e09c8d0dd6b12f9d90de6376330577a2", "merge-ort.c"],
  ["git.git", "777489f9e09c8d0dd6b12f9d90de6376330577a2", "read-cache.c"],
] as const;

const CLOSED_SOURCES = /^(?:blame\.c$|builtin\/blame\.c$|xdiff\/|xdiff-interface\.)/;

const VECTORS = join(import.meta.dirname, "vectors/frozen.json");
const dir = process.env.FYRDEN_BLAME_FIXTURES;
const write = process.env.FYRDEN_BLAME_VECTORS === "write";
/**
 * Each file's settled lines may not fall below its first run under the rename
 * rule (2026-11-09), counted exactly: a share rounded down would let a large
 * file lose dozens of lines unnoticed.
 */
const MIN_SETTLED: Record<string, number> = {
  "lib/application.js": 523,
  "lib/router/index.js": 660,
  "merge-ort.c": 5281,
  "read-cache.c": 3954,
};
const run = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

/** The oracle's answer. A failure reports its exit code only: the error would carry the file's text. */
async function oracleBlame(cwd: string, commit: string, path: string): Promise<string> {
  try {
    const { stdout } = await run(gitBinary, ["blame", "--line-porcelain", commit, "--", path], {
      cwd,
      env: ENV,
      encoding: "latin1",
      maxBuffer: 1024 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new Error(`git blame of ${path} at ${commit} failed: ${String(code)}`);
  }
}

describe("the frozen public files", () => {
  it("leave out git's own blame and diff sources", () => {
    for (const [repo, , path] of FIXTURES) {
      if (repo === "git.git") expect(path).not.toMatch(CLOSED_SOURCES);
    }
  });
});

describe.skipIf(dir === undefined)("blame of frozen public files", () => {
  const frozen: Record<string, string> = {};

  it.each(FIXTURES)(
    "%s %s %s",
    async (repo, commit, path) => {
      expect(await gitVersion()).toBe("2.53.0");
      const cwd = join(dir as string, repo);
      const expected = parsePorcelain(await oracleBlame(cwd, commit, path));
      const hash = createHash("sha256");
      for (const { commit: from, line, filename } of expected)
        hash.update(`${from} ${line} ${filename}\n`);
      const sha256 = hash.digest("hex");
      if (write) frozen[`${commit} ${path}`] = sha256;
      else {
        const known = JSON.parse(readFileSync(VECTORS, "utf8")) as Record<string, string>;
        expect(sha256, "the oracle's own answer moved").toBe(known[`${commit} ${path}`]);
      }

      const source = await GitBlameSource.open(cwd, ENV, commit);
      try {
        const state = await startBlame(
          source,
          oidFromHex(commit),
          path.split("/").map((segment) => new TextEncoder().encode(segment)),
        );
        if ("failure" in state) throw new Error(state.failure);
        let requests = 0;
        let largestSlice = 0;
        for (;;) {
          requests++;
          const { stop, work } = await advanceBlame(state, source, {
            ...DEFAULT_BLAME_SLICE,
            stepIsFresh: () => true,
          });
          largestSlice = Math.max(largestSlice, work);
          if (stop === "done") break;
        }
        expect(state.lines).toBe(expected.length);
        const reasons: Record<string, number> = {};
        let resolved = 0;
        for (const range of blameRanges(state, 0, Number.MAX_SAFE_INTEGER)) {
          for (let k = 0; k < range.lineCount; k++) {
            if ("unresolved" in range) {
              reasons[range.unresolved] = (reasons[range.unresolved] ?? 0) + 1;
              continue;
            }
            resolved++;
            const want = expected[range.startLine - 1 + k];
            expect(
              `${oidToHex(range.commit)}@${range.sourceStartLine + k} ${latin1Path(path)}`,
              `final line ${range.startLine + k}`,
            ).toBe(`${want?.commit}@${want?.line} ${want?.filename}`);
          }
        }
        // Every line git takes from another path is unresolved, for whatever reason.
        const told = new Array<boolean>(state.lines).fill(false);
        for (const range of blameRanges(state, 0, Number.MAX_SAFE_INTEGER))
          if ("unresolved" in range)
            told.fill(true, range.startLine - 1, range.startLine - 1 + range.lineCount);
        expected.forEach((line, k) => {
          if (line.filename !== latin1Path(path)) expect(told[k], `final line ${k + 1}`).toBe(true);
        });
        console.log(
          `${path}: ${resolved} of ${state.lines} resolved, ${state.steps} steps, ${requests} slices, largest ${largestSlice} units of engine work, unresolved ${JSON.stringify(reasons)}`,
        );
        expect(resolved).toBeGreaterThanOrEqual(MIN_SETTLED[path] ?? state.lines);
      } finally {
        source.close();
      }
    },
    3_600_000,
  );

  it.runIf(write)("writes what the oracle answered", () => {
    expect(Object.keys(frozen)).toHaveLength(FIXTURES.length);
    writeFileSync(VECTORS, `${JSON.stringify(frozen, null, 2)}\n`);
  });
});
