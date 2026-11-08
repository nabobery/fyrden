// A whole blame through the repository's blame source, over packs a real
// push stored, against what git blame says of the same history: every line
// agrees with git, or is refused for the reason the limits give.
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import {
  advanceBlame,
  blameRanges,
  DEFAULT_BLAME_SLICE,
  oidFromHex,
  oidToHex,
  startBlame,
} from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import { MAX_COMMIT_INFO_BYTES, repoBlameSource } from "../src/do/repo/blame-source.js";
import { openLiveReader } from "../src/git/live-reader.js";
import { BLAME_PATHS } from "./helpers/blame-fixtures.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("blameFixtures");
const SLICE = { ...DEFAULT_BLAME_SLICE, stepIsFresh: () => true };

type Line =
  | { commit: string; line: number; summary: string; name: string; email: string; date: string }
  | { unresolved: string };

async function pushed() {
  const target = await pushTarget();
  const reply = await postPush(
    target,
    pushBody([{ old: ZERO, new: fx.tip, ref: "refs/heads/main" }], { pack: fx.pack }),
  );
  expect(reply.report).toContain("ok refs/heads/main\n");
  return target.repo.stub;
}

/** Blames `path` at the tip through the repository's source, inside its object. */
function blame(stub: Awaited<ReturnType<typeof pushed>>, path: string) {
  return inRepo(stub, async (repo) => {
    const reader = await openLiveReader(
      { git: repo.git, memoryBlocks: createClockBlockCache() },
      { deltaBaseCacheBytes: 1 << 20, maxCacheCalls: 0 },
    );
    if (!reader) throw new Error("no packs");
    try {
      const source = repoBlameSource(reader, repo.git.commitGraph);
      const segments = path.split("/").map((s) => new TextEncoder().encode(s));
      const state = await startBlame(source, oidFromHex(fx.tip), segments);
      if ("failure" in state) return { failure: state.failure };
      for (let guard = 0; (await advanceBlame(state, source, SLICE)).stop !== "done"; guard++)
        if (guard > 1000) throw new Error("no end");
      const lines: Line[] = new Array(state.lines);
      for (const range of blameRanges(state, 0, Number.MAX_SAFE_INTEGER)) {
        for (let k = 0; k < range.lineCount; k++) {
          if ("unresolved" in range) {
            lines[range.startLine - 1 + k] = { unresolved: range.unresolved };
            continue;
          }
          const hex = oidToHex(range.commit);
          const fact = state.facts[hex];
          if (!fact) throw new Error(`no facts for ${hex}`);
          lines[range.startLine - 1 + k] = {
            commit: hex,
            line: range.sourceStartLine + k,
            summary: fact.summary,
            name: fact.name,
            email: fact.email,
            date: fact.date,
          };
        }
      }
      return { lines };
    } finally {
      reader.release();
    }
  });
}

/** What git says of each line, in the source's shape. */
const fromGit = (path: string): Line[] =>
  (fx.blames[path] ?? []).map((g) => ({
    commit: g.commit,
    line: g.line,
    summary: g.summary,
    name: g.name,
    email: g.email,
    date: new Date(g.time * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  }));

describe("blame through the repository's source, against git", () => {
  it("has commit objects at the facts read's limit and one byte past it", () => {
    expect(fx.sizes).toEqual({ fits: MAX_COMMIT_INFO_BYTES, over: MAX_COMMIT_INFO_BYTES + 1 });
  });

  it("agrees with git on every line where nothing is refused", async () => {
    const stub = await pushed();
    for (const path of ["f.txt", "link", "dir/inner.txt"]) {
      const got = await blame(stub, path);
      expect({ path, got }).toEqual({ path, got: { lines: fromGit(path) } });
    }
  });

  it("refuses a 17-parent commit's lines, where git names the branch that made them", async () => {
    const stub = await pushed();
    const git = fromGit("o16.txt");
    expect(git.map((l) => "commit" in l && l.commit)).toEqual([fx.commits.branch16]);
    expect(await blame(stub, "o16.txt")).toEqual({ lines: [{ unresolved: "too_many_parents" }] });
  });

  it("reads a commit of 64 KiB for its facts, and refuses the lines of one a byte larger", async () => {
    const stub = await pushed();
    const git = fromGit("big.txt");
    expect(git.map((l) => "commit" in l && l.commit)).toEqual([fx.commits.fits, fx.commits.over]);
    expect(await blame(stub, "big.txt")).toEqual({
      lines: [git[0], { unresolved: "commit_info_too_large" }],
    });
  });

  it("finds no file at a directory or a submodule", async () => {
    const stub = await pushed();
    expect(await blame(stub, "dir")).toEqual({ failure: "path_not_found" });
    expect(await blame(stub, "module")).toEqual({ failure: "path_not_found" });
  });

  it("covers every path the fixtures recorded", () => {
    expect(Object.keys(fx.blames).sort()).toEqual([...BLAME_PATHS].sort());
  });
});
