import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alignFiles, MAX_SEARCH_ROUNDS } from "../../src/blame/align.js";
import {
  advanceBlame,
  type BlameSliceLimits,
  blameRanges,
  DEFAULT_BLAME_SLICE,
  startBlame,
} from "../../src/blame/walk.js";
import { oidFromHex, oidToHex } from "../../src/object/oid.js";
import { createGitSandbox, type GitSandbox, gitVersion } from "../../testing/git-cli.js";
import {
  blankWeightGrid,
  CROWD_FILE,
  CROWD_FILE_NEXT,
  CROWDED_FAMILIES,
  crowdedPairs,
  lines,
  WITNESSES_AT_THE_BLANK_LIMIT,
  WITNESSES_OF_THE_BLANK_WEIGHT,
  WITNESSES_PAST_THE_MARGIN,
  WITNESSES_REACHED_BY_A_REFUSAL,
} from "./align-cases.js";
import { batchChanged, type Changed, oldOfNewFrom } from "./align-oracle.js";
import {
  type GitBlameLine,
  GitBlameSource,
  latin1Path,
  parsePorcelain,
} from "./blame-git-source.js";

/*
 * Whole blames against the pinned oracle, plain `git blame`, over histories
 * built with fast-import. A settled line must be git's: the same commit and
 * source line, from the same path, since the engine never follows a rename. A
 * line git takes from another path must be unresolved. That `filename` test
 * only works one way: git can follow a rename and come back to the same name
 * (f to g to f), so a matching name proves nothing; the settled-line check is
 * what holds the guarantee. Without
 * the pin the comparison means nothing: it skips locally, and fails in CI so
 * that a dropped setting can't quietly turn parity off.
 *
 *   FYRDEN_GIT_BINARY=<git 2.53.0> npx vitest run test/blame/blame.git-oracle.test.ts
 */

const PIN = "2.53.0";
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const version = await gitVersion();
const pinned = version === PIN;
if (!pinned && process.env.CI) {
  throw new Error(`the blame oracle is pinned to git ${PIN}, and this is ${version}`);
}

const SLICE: BlameSliceLimits = { ...DEFAULT_BLAME_SLICE, stepIsFresh: () => true };

interface Node {
  readonly parents?: readonly string[];
  /** Path to its text, for every file the commit has. A mode prefix `120000 ` makes a symlink. */
  readonly files: Readonly<Record<string, string>>;
}

const ENV = { GIT_CONFIG_NOSYSTEM: "1" };
/** The test source runs git outside the sandbox's helpers, so it drops the user's config itself. */
const SOURCE_ENV = { ...process.env, ...ENV, GIT_CONFIG_GLOBAL: "/dev/null" };

describe.skipIf(!pinned)(`blame against git ${PIN}`, () => {
  let sandbox: GitSandbox;

  beforeAll(async () => {
    sandbox = await createGitSandbox();
    await sandbox.git(["init", "-q", "-b", "main"]);
  });
  afterAll(async () => {
    await sandbox.dispose();
  });

  /** Builds the history; each commit named on its own ref. Returns the tip's id. */
  async function build(prefix: string, history: Readonly<Record<string, Node>>, tip: string) {
    let stream = "";
    let mark = 0;
    const marks = new Map<string, number>();
    const data = (text: string) => `data ${Buffer.byteLength(text, "latin1")}\n${text}\n`;
    let stamp = 1_700_000_000;
    for (const [name, node] of Object.entries(history)) {
      mark++;
      marks.set(name, mark);
      stamp += 60;
      stream += `commit refs/heads/${prefix}/${name}\nmark :${mark}\n`;
      stream += `author T <t@t> ${stamp} +0000\ncommitter T <t@t> ${stamp} +0000\n`;
      stream += data(`${name}\n`);
      const [first, ...rest] = (node.parents ?? []).map((parent) => {
        const at = marks.get(parent);
        if (at === undefined) throw new Error(`${parent} comes after ${name}`);
        return at;
      });
      if (first !== undefined) stream += `from :${first}\n`;
      for (const other of rest) stream += `merge :${other}\n`;
      stream += "deleteall\n";
      for (const [path, text] of Object.entries(node.files)) {
        const symlink = text.startsWith("120000 ");
        const body = symlink ? text.slice(7) : text;
        stream += `M ${symlink ? "120000" : "100644"} inline ${path}\n${data(body)}`;
      }
      stream += "\n";
    }
    await sandbox.git(["fast-import", "--quiet", "--force"], {
      input: Buffer.from(stream, "latin1"),
    });
    return (await sandbox.git(["rev-parse", `refs/heads/${prefix}/${tip}`])).stdout.trim();
  }

  async function oracle(commit: string, path: string): Promise<GitBlameLine[]> {
    const out = await sandbox.gitBytes(["blame", "--line-porcelain", commit, "--", path], {
      env: ENV,
    });
    return parsePorcelain(Buffer.from(out).toString("latin1"));
  }

  /** Each commit's name in a built history, by id: its ref under the prefix. */
  async function namesOf(prefix: string): Promise<Map<string, string>> {
    const out = await sandbox.git([
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      `refs/heads/${prefix}/`,
    ]);
    const names = new Map<string, string>();
    for (const row of out.stdout.trim().split("\n")) {
      const [oid, ref] = row.split(" ");
      names.set(oid as string, (ref as string).slice(`refs/heads/${prefix}/`.length));
    }
    return names;
  }

  /**
   * Runs the engine over a built history and holds it to git: each settled line is
   * git's commit and source line, from this path; each line git takes from another
   * path is unresolved. Returns each line's answer, `<commit>@<line>` or a reason.
   */
  async function compare(
    tip: string,
    path: string,
    slice = SLICE,
    begin: { maxFileBytes?: number } = {},
  ) {
    const source = await GitBlameSource.open(sandbox.dir, SOURCE_ENV, tip);
    try {
      const state = await startBlame(
        source,
        oidFromHex(tip),
        path.split("/").map((segment) => new TextEncoder().encode(segment)),
        begin,
      );
      if ("failure" in state) throw new Error(state.failure);
      for (;;) {
        if ((await advanceBlame(state, source, slice)).stop === "done") break;
      }
      const expected = await oracle(tip, path);
      expect(state.lines).toBe(expected.length);
      const reasons = new Map<string, number>();
      let resolved = 0;
      const answers = new Array<string>(state.lines).fill("");
      for (const range of blameRanges(state, 0, Number.MAX_SAFE_INTEGER)) {
        for (let k = 0; k < range.lineCount; k++) {
          const line = range.startLine - 1 + k;
          const git = expected[line] as GitBlameLine;
          if ("unresolved" in range) {
            answers[line] = range.unresolved;
            reasons.set(range.unresolved, (reasons.get(range.unresolved) ?? 0) + 1);
            continue;
          }
          resolved++;
          answers[line] = `${oidToHex(range.commit)}@${range.sourceStartLine + k}`;
          expect(`${answers[line]} ${latin1Path(path)}`, `line ${line + 1}`).toBe(
            `${git.commit}@${git.line} ${git.filename}`,
          );
        }
      }
      expect(answers.every((a) => a !== "")).toBe(true);
      expected.forEach((git, line) => {
        if (git.filename !== latin1Path(path))
          expect([line + 1, answers[line]], "git took it from another path").toEqual([
            line + 1,
            expect.not.stringMatching(/@/),
          ]);
      });
      return { resolved, reasons, lines: state.lines, answers, git: expected };
    } finally {
      source.close();
    }
  }

  const f = (...words: string[]) => lines(...words);
  const one = (text: string) => ({ f: text });
  const SYNTHETIC: Record<
    string,
    { history: Record<string, Node>; tip: string; refused?: Record<string, number> }
  > = {
    "merge-two": {
      tip: "m",
      history: {
        base: { files: one(f("a", "b")) },
        p: { parents: ["base"], files: one(f("a", "b", "p")) },
        q: { parents: ["base"], files: one(f("q", "a", "b")) },
        m: { parents: ["p", "q"], files: one(f("q", "a", "b", "p", "own")) },
      },
    },
    "merge-octopus": {
      tip: "o",
      history: {
        base: { files: one(f("a", "b", "c")) },
        p1: { parents: ["base"], files: one(f("b", "a", "c")) },
        p2: { parents: ["base"], files: one(f("a", "b", "c", "d")) },
        p3: { parents: ["p2"], files: one(f("a", "b", "c", "d", "e")) },
        o: { parents: ["p1", "p2", "p3"], files: one(f("a", "b", "c", "d", "e", "own")) },
      },
    },
    "identical-second-parent": {
      tip: "m",
      history: {
        base: { files: one(f("a", "b")) },
        p1: { parents: ["base"], files: one(f("a", "b", "x")) },
        p2: { parents: ["base"], files: one(f("a", "b", "x", "y")) },
        m: { parents: ["p1", "p2"], files: one(f("a", "b", "x", "y")) },
      },
    },
    "repeated-lines": {
      tip: "c",
      history: {
        a: { files: one(f("x", "y", "x", "y", "x")) },
        b: { parents: ["a"], files: one(f("y", "x", "x", "y", "x", "y")) },
        c: { parents: ["b"], files: one(f("x", "y", "x", "x", "y")) },
      },
    },
    "crlf-no-final-lf": {
      tip: "b",
      history: {
        a: { files: one("a\r\nb\nc") },
        b: { parents: ["a"], files: one("a\nb\nc\n") },
      },
    },
    "delete-recreate": {
      tip: "c",
      // c's path is new where b removed `other`: git doesn't follow it (too unlike), but
      // that isn't knowable without git's similarity measure.
      refused: { rename_possible: 1 },
      history: {
        a: { files: one(f("x")) },
        b: { parents: ["a"], files: { other: f("y") } },
        c: { parents: ["b"], files: one(f("x")) },
      },
    },
    empty: {
      tip: "b",
      history: { a: { files: one("") }, b: { parents: ["a"], files: one("") } },
    },
    "path-kinds": {
      tip: "d",
      // At d a directory became the file, removing f/inner.
      refused: { rename_possible: 1 },
      history: {
        a: { files: { f: "target\n" } },
        b: { parents: ["a"], files: { f: "120000 target\n" } },
        c: { parents: ["b"], files: { "f/inner": f("z") } },
        d: { parents: ["c"], files: { f: f("n") } },
      },
    },
  };

  it.each(Object.keys(SYNTHETIC))("%s", async (name) => {
    const { history, tip, refused = {} } = SYNTHETIC[name] as (typeof SYNTHETIC)[string];
    const commit = await build(name, history, tip);
    const { reasons, resolved, lines: count } = await compare(commit, "f");
    expect(Object.fromEntries(reasons)).toEqual(refused);
    const refusedLines = Object.values(refused).reduce((a, b) => a + b, 0);
    expect(resolved).toBe(count - refusedLines);
  });

  describe("renames: what git does, then what the engine answers", () => {
    // Each probe pins git's own answer for every line (commit, path, source line), so a
    // change in what git follows fails here even where the engine refuses every line;
    // then the engine's answer: a commit and line, or the reason.
    const BODY = Array.from(
      { length: 12 },
      (_, k) => `line ${k} of the original text, long enough`,
    );
    const OTHER = Array.from({ length: 12 }, (_, k) => `unrelated ${k} words sharing nothing`);
    const B = (...range: number[]) => BODY.slice(...range);
    const runOf = (who: string, from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, k) => `${who}@${from + k}`);
    const times = (n: number, what: string) => new Array<string>(n).fill(what);
    const R = "rename_possible";
    const dirs = (side: string, n = 130, prefix = "d") =>
      Object.fromEntries(Array.from({ length: n }, (_, k) => [`${prefix}${k}/x`, `${side}${k}\n`]));

    const PROBES: Record<
      string,
      {
        history: Record<string, Node>;
        tip: string;
        git: string[];
        engine: string[];
        slice?: BlameSliceLimits;
        begin?: { maxFileBytes?: number };
      }
    > = {
      "exact rename": {
        tip: "b",
        history: {
          a: { files: { g: f(...BODY) } },
          b: { parents: ["a"], files: { f: f(...BODY) } },
        },
        git: runOf("a:g", 1, 12),
        engine: times(12, R),
      },
      "an edited rename git follows": {
        tip: "b",
        history: {
          a: { files: { g: f(...BODY) } },
          b: { parents: ["a"], files: { f: f(...B(0, 7), ...OTHER.slice(0, 5)) } },
        },
        git: [...runOf("a:g", 1, 7), ...runOf("b:f", 8, 12)],
        engine: times(12, R),
      },
      "an edited rename git doesn't follow: refused anyway": {
        tip: "b",
        history: {
          a: { files: { g: f(...BODY) } },
          b: { parents: ["a"], files: { f: f(...B(0, 3), ...OTHER.slice(0, 9)) } },
        },
        git: runOf("b:f", 1, 12),
        engine: times(12, R),
      },
      "a rename and another deletion": {
        tip: "b",
        history: {
          a: { files: { g: f(...BODY), h: f(...OTHER) } },
          b: { parents: ["a"], files: { f: f(...BODY) } },
        },
        git: runOf("a:g", 1, 12),
        engine: times(12, R),
      },
      "a deletion with no rename: refused anyway": {
        tip: "b",
        history: {
          a: { files: { h: f(...OTHER) } },
          b: { parents: ["a"], files: { f: f(...BODY) } },
        },
        git: runOf("b:f", 1, 12),
        engine: times(12, R),
      },
      "a copy, nothing removed": {
        tip: "b",
        history: {
          a: { files: { g: f(...BODY) } },
          b: { parents: ["a"], files: { g: f(...BODY), f: f(...BODY) } },
        },
        git: runOf("b:f", 1, 12),
        engine: runOf("b", 1, 12),
      },
      "a swap: the path was there": {
        tip: "b",
        history: {
          a: { files: { f: f(...OTHER), g: f(...BODY) } },
          b: { parents: ["a"], files: { f: f(...BODY), g: f(...OTHER) } },
        },
        git: runOf("b:f", 1, 12),
        engine: runOf("b", 1, 12),
      },
      "a rewrite with the old text's path deleted: the path was there": {
        tip: "b",
        history: {
          a: { files: { f: f(...OTHER), g: f(...BODY) } },
          b: { parents: ["a"], files: { f: f(...BODY) } },
        },
        git: runOf("b:f", 1, 12),
        engine: runOf("b", 1, 12),
      },
      "the path was a directory": {
        tip: "b",
        history: {
          a: { files: { "f/x": f(...OTHER), g: f(...BODY) } },
          b: { parents: ["a"], files: { f: f(...BODY) } },
        },
        git: runOf("a:g", 1, 12),
        engine: times(12, R),
      },
      "the path was a symlink, and another path was deleted": {
        tip: "b",
        history: {
          a: { files: { f: "120000 target", g: f(...BODY) } },
          b: { parents: ["a"], files: { f: f(...BODY) } },
        },
        git: runOf("b:f", 1, 12),
        engine: times(12, R),
      },
      "another path changed type": {
        tip: "b",
        history: {
          a: { files: { g: f(...BODY) } },
          b: { parents: ["a"], files: { g: "120000 target", f: f(...BODY) } },
        },
        git: runOf("b:f", 1, 12),
        engine: times(12, R),
      },
      "a rename across directories": {
        tip: "b",
        history: {
          a: { files: { "d1/d2/g": f(...BODY), "d3/keep": f("k") } },
          b: { parents: ["a"], files: { f: f(...BODY), "d3/keep": f("k") } },
        },
        git: runOf("a:d1/d2/g", 1, 12),
        engine: times(12, R),
      },
      "a rename, then an edit": {
        tip: "c",
        history: {
          a: { files: { g: f(...BODY) } },
          b: { parents: ["a"], files: { f: f(...BODY) } },
          c: { parents: ["b"], files: { f: f(...BODY, "added in c") } },
        },
        git: [...runOf("a:g", 1, 12), "c:f@13"],
        engine: [...times(12, R), "c@13"],
      },
      "away and back to the same name": {
        tip: "c",
        history: {
          a: { files: { f: f(...BODY) } },
          b: { parents: ["a"], files: { g: f(...BODY) } },
          c: { parents: ["b"], files: { f: f(...BODY) } },
        },
        git: runOf("a:f", 1, 12),
        engine: times(12, R),
      },
      "away and back, edited each way": {
        tip: "c",
        history: {
          a: { files: { f: f(...BODY) } },
          b: { parents: ["a"], files: { g: f(...BODY, "edit in b") } },
          c: { parents: ["b"], files: { f: f(...BODY, "edit in b", "edit in c") } },
        },
        git: [...runOf("a:f", 1, 12), "b:g@13", "c:f@14"],
        engine: times(14, R),
      },
      "a large parent before the rename: refused for that first": {
        tip: "c",
        history: {
          a: { files: { g: f(...BODY) } },
          b: { parents: ["a"], files: { f: f(...BODY) } },
          c: { parents: ["b"], files: { f: f(...B(0, 6)) } },
        },
        begin: { maxFileBytes: 400 },
        slice: { ...SLICE, maxFileBytes: 400 },
        git: runOf("a:g", 1, 6),
        engine: times(6, "parent_too_large"),
      },
      "a check too large for its budget: refused, though git finds nothing": {
        tip: "b",
        history: {
          a: { files: dirs("a") },
          b: { parents: ["a"], files: { ...dirs("b"), f: f(...BODY) } },
        },
        git: runOf("b:f", 1, 12),
        engine: times(12, R),
      },
      "merge: an identity check that runs out of budget before the identical copy": {
        tip: "m",
        history: {
          p1: { files: { f: f("a", "b", "x") } },
          p2: { files: { "gone/g": f("a", "b", "c"), ...dirs("p", 128) } },
          m: { parents: ["p1", "p2"], files: { f: f("a", "b", "c"), ...dirs("m", 128) } },
        },
        git: runOf("p2:gone/g", 1, 3),
        engine: times(3, R),
      },
      "octopus: checks that share one budget, too much together": {
        tip: "m",
        history: {
          p1: { files: { f: f("a", "b", "x") } },
          p2: { files: dirs("p2", 100) },
          p3: { files: dirs("p3", 27, "e") },
          m: {
            parents: ["p1", "p2", "p3"],
            files: { f: f("a", "b", "c"), ...dirs("m", 100), ...dirs("m", 27, "e") },
          },
        },
        git: ["p1:f@1", "p1:f@2", "m:f@3"],
        engine: times(3, R),
      },
      "octopus: checks that share one budget, just enough": {
        tip: "m",
        history: {
          p1: { files: { f: f("a", "b", "x") } },
          p2: { files: dirs("p2", 100) },
          p3: { files: dirs("p3", 26, "e") },
          m: {
            parents: ["p1", "p2", "p3"],
            files: { f: f("a", "b", "c"), ...dirs("m", 100), ...dirs("m", 26, "e") },
          },
        },
        git: ["p1:f@1", "p1:f@2", "m:f@3"],
        engine: ["p1@1", "p1@2", "m@3"],
      },
      "merge: a rename in the second parent": {
        tip: "m",
        history: {
          base: { files: { g: f(...BODY) } },
          p1: { parents: ["base"], files: { g: f(...BODY), f: f(...B(0, 6), "p1 line") } },
          p2: { parents: ["base"], files: { g: f(...BODY), x: f("x") } },
          m: { parents: ["p1", "p2"], files: { f: f(...B(0, 6), "p1 line", ...B(6)), x: f("x") } },
        },
        git: [...runOf("p1:f", 1, 7), ...runOf("base:g", 7, 12)],
        engine: [...runOf("p1", 1, 7), ...times(6, R)],
      },
      "merge: a rename in the first parent": {
        tip: "m",
        history: {
          base: { files: { g: f(...BODY) } },
          p1: { parents: ["base"], files: { g: f(...BODY), x: f("x") } },
          p2: { parents: ["base"], files: { g: f(...BODY), f: f(...B(0, 6), "p2 line") } },
          m: { parents: ["p1", "p2"], files: { f: f(...B(0, 6), "p2 line", ...B(6)), x: f("x") } },
        },
        git: [...runOf("base:g", 1, 6), "p2:f@7", ...runOf("base:g", 7, 12)],
        engine: times(13, R),
      },
      "merge: the first parent's file differs, the second removed an identical copy": {
        tip: "m",
        history: {
          p1: { files: { f: f(...B(0, 6), "p1 line") } },
          base: { files: { g: f(...BODY) } },
          p2: { parents: ["base"], files: { g: f(...BODY), x: f("x") } },
          m: { parents: ["p1", "p2"], files: { f: f(...BODY), x: f("x") } },
        },
        git: runOf("base:g", 1, 12),
        engine: times(12, R),
      },
      "merge: the first parent's file is identical, the second renamed one": {
        tip: "m",
        history: {
          p1: { files: { f: f(...BODY) } },
          base: { files: { g: f(...BODY) } },
          p2: { parents: ["base"], files: { g: f(...BODY), x: f("x") } },
          m: { parents: ["p1", "p2"], files: { f: f(...BODY), x: f("x") } },
        },
        git: runOf("p1:f", 1, 12),
        engine: runOf("p1", 1, 12),
      },
      "merge: an identical file in the second parent beats the first's removed copy": {
        tip: "m",
        history: {
          p1: { files: { g: f(...BODY) } },
          p2: { files: { f: f(...BODY) } },
          m: { parents: ["p1", "p2"], files: { f: f(...BODY) } },
        },
        git: runOf("p2:f", 1, 12),
        engine: runOf("p2", 1, 12),
      },
      "merge: an identical copy inside a removed directory": {
        tip: "m",
        history: {
          p1: { files: { f: f("a", "b", "x") } },
          p2: { files: { "gone/g": f("a", "b", "c") } },
          m: { parents: ["p1", "p2"], files: { f: f("a", "b", "c") } },
        },
        git: runOf("p2:gone/g", 1, 3),
        engine: times(3, R),
      },
      "merge: an identical copy in a nested removed directory": {
        tip: "m",
        history: {
          p1: { files: { f: f("a", "b", "x") } },
          p2: { files: { "deep/er/g": f("a", "b", "c") } },
          m: { parents: ["p1", "p2"], files: { f: f("a", "b", "c") } },
        },
        git: runOf("p2:deep/er/g", 1, 3),
        engine: times(3, R),
      },
      "merge: an identical copy in a directory that became a file": {
        tip: "m",
        history: {
          p1: { files: { f: f("a", "b", "x") } },
          p2: { files: { "p/g": f("a", "b", "c") } },
          m: { parents: ["p1", "p2"], files: { f: f("a", "b", "c"), p: f("now a file") } },
        },
        git: runOf("p2:p/g", 1, 3),
        engine: times(3, R),
      },
      "octopus: an identical copy inside the third parent's removed directory": {
        tip: "m",
        history: {
          p1: { files: { f: f("a", "b", "x") } },
          p2: { files: { y: f("y") } },
          p3: { files: { "gone/g": f("a", "b", "c") } },
          m: { parents: ["p1", "p2", "p3"], files: { f: f("a", "b", "c"), y: f("y") } },
        },
        git: runOf("p3:gone/g", 1, 3),
        engine: times(3, R),
      },
      "merge: git names another path at the same commit and line": {
        tip: "m",
        history: {
          root: { files: { f: f(...BODY), g: f(...BODY) } },
          p1: { parents: ["root"], files: { f: f(...BODY, "x"), g: f(...BODY) } },
          p2: { parents: ["root"], files: { g: f(...BODY) } },
          m: { parents: ["p1", "p2"], files: { f: f(...BODY) } },
        },
        git: runOf("root:g", 1, 12),
        engine: times(12, R),
      },
      "merge: absent in both parents, one deletes": {
        tip: "m",
        history: {
          base: { files: { g: f(...BODY), h: f(...OTHER) } },
          p1: { parents: ["base"], files: { g: f(...BODY), h: f(...OTHER), y: f("y") } },
          p2: { parents: ["base"], files: { g: f(...BODY), h: f(...OTHER), z: f("z") } },
          m: {
            parents: ["p1", "p2"],
            files: { h: f(...OTHER), y: f("y"), z: f("z"), f: f(...BODY) },
          },
        },
        git: runOf("base:g", 1, 12),
        engine: times(12, R),
      },
      "octopus: a rename in the third parent": {
        tip: "m",
        history: {
          base: { files: { g: f(...BODY) } },
          p1: { parents: ["base"], files: { g: f(...BODY), f: f(...B(0, 4), "p1 line") } },
          p2: {
            parents: ["base"],
            files: { g: f(...BODY), f: f(...B(0, 4), "p2 line"), y: f("y") },
          },
          p3: { parents: ["base"], files: { g: f(...BODY), x: f("x") } },
          m: {
            parents: ["p1", "p2", "p3"],
            files: { f: f(...B(0, 4), "p1 line", "p2 line", ...B(4)), x: f("x"), y: f("y") },
          },
        },
        git: [...runOf("p1:f", 1, 5), "p2:f@5", ...runOf("base:g", 5, 12)],
        engine: [...runOf("p1", 1, 5), "p2@5", ...times(8, R)],
      },
    };

    it.each(Object.keys(PROBES))("%s", async (name) => {
      const probe = PROBES[name] as (typeof PROBES)[string];
      const prefix = `probe-${Object.keys(PROBES).indexOf(name)}`;
      const tip = await build(prefix, probe.history, probe.tip);
      const names = await namesOf(prefix);
      const path = "f";
      const git = (await oracle(tip, path)).map(
        (l) => `${names.get(l.commit) ?? l.summary}:${l.filename}@${l.line}`,
      );
      expect(git, "git's own answer").toEqual(probe.git);
      const { answers } = await compare(tip, path, probe.slice ?? SLICE, probe.begin ?? {});
      const engine = answers.map((a) => {
        const [oid, line] = a.split("@");
        return line === undefined ? a : `${names.get(oid as string)}@${line}`;
      });
      expect(engine, "the engine's answer").toEqual(probe.engine);
    });
  });

  it("a run of crowded lines at a common prefix: no line goes to the wrong commit", async () => {
    const commit = await build(
      "crowd-at-prefix",
      {
        a: { files: one(lines(...CROWD_FILE)) },
        b: { parents: ["a"], files: one(lines(...CROWD_FILE_NEXT)) },
      },
      "b",
    );
    const { reasons, resolved, lines: count } = await compare(commit, "f");
    expect(reasons.size).toBe(0);
    expect(resolved).toBe(count);
  });

  it.each([199, 200, 201])(
    "a whitespace-only line of %i columns, through a whole history",
    async (columns) => {
      const blank = " ".repeat(columns);
      const commit = await build(
        `wide-blank-${columns}`,
        {
          a: { files: one(`  }\n${blank}\n`) },
          b: { parents: ["a"], files: one(`  }\n  }\n${blank}\n`) },
        },
        "b",
      );
      const { reasons, resolved, lines: count } = await compare(commit, "f");
      expect(resolved + [...reasons.values()].reduce((a, b) => a + b, 0)).toBe(count);
      if (columns < 200) expect(resolved).toBe(count);
    },
  );

  it.each([19, 20])("%i blank lines above a group: settled lines agree", (n) => {
    const blanks = Array.from({ length: n }, () => "");
    const pairs: [string, string][] = [
      [lines("top", ...blanks, "  x", "    ", "  x", "  y"), lines("top", ...blanks, "  x", "  y")],
    ];
    const [answer] = batchChanged(pairs);
    const [[old, new_]] = pairs as [[string, string]];
    const result = alignFiles(bytesOf(old), bytesOf(new_));
    const expected = oldOfNewFrom(answer as Changed, result.oldOfNew.length);
    const skipped = new Uint8Array(expected.length);
    if (result.kind === "aligned")
      for (const { start, end } of result.unsettled) skipped.fill(1, start, end);
    for (let line = 0; line < expected.length; line++) {
      if (!skipped[line]) expect(result.oldOfNew[line], `line ${line + 1}`).toBe(expected[line]);
    }
  });

  describe("pairs a search found wrong, shrunk", () => {
    it.each([
      ["a refusal reaching a later group", WITNESSES_REACHED_BY_A_REFUSAL],
      ["a blank run at the scan's limit", WITNESSES_AT_THE_BLANK_LIMIT],
      ["a comparison past the margin", WITNESSES_PAST_THE_MARGIN],
    ] as const)("%s: says so, or agrees", (_title, witnesses) => {
      const pairs = witnesses.map(
        ([old, new_]) => [lines(...old), lines(...new_)] as [string, string],
      );
      const answers = batchChanged(pairs);
      pairs.forEach(([old, new_], k) => {
        const result = alignFiles(bytesOf(old), bytesOf(new_));
        const expected = oldOfNewFrom(answers[k] as Changed, result.oldOfNew.length);
        const skipped = new Uint8Array(expected.length);
        if (result.kind === "aligned") {
          for (const { start, end } of result.unsettled) skipped.fill(1, start, end);
        }
        for (let line = 0; line < expected.length; line++) {
          if (skipped[line] || (result.kind === "refused" && result.oldOfNew[line] === -1))
            continue;
          expect(result.oldOfNew[line], `witness ${k} line ${line + 1}`).toBe(expected[line]);
        }
      });
    });
  });

  it.each([
    ["a review's pair, whose lines are all but blank", WITNESSES_OF_THE_BLANK_WEIGHT],
    ["every length of blank run, above and below", blankWeightGrid()],
  ] as const)("what a blank line weighs: %s", (_title, pairs) => {
    const answers = batchChanged(pairs);
    pairs.forEach(([old, new_], k) => {
      const result = alignFiles(bytesOf(old), bytesOf(new_));
      const expected = oldOfNewFrom(answers[k] as Changed, result.oldOfNew.length);
      const skipped = new Uint8Array(expected.length);
      if (result.kind === "aligned") {
        for (const { start, end } of result.unsettled) skipped.fill(1, start, end);
      }
      for (let line = 0; line < expected.length; line++) {
        if (skipped[line] || (result.kind === "refused" && result.oldOfNew[line] === -1)) continue;
        expect(result.oldOfNew[line], `pair ${k} line ${line + 1}`).toBe(expected[line]);
      }
    });
  });

  describe("generated pairs where lines repeat", () => {
    // Whatever the engine settles has to be the oracle's; what it can't, it says.
    const PAIRS = Number(process.env.FYRDEN_BLAME_SEARCH ?? 5000);
    it.each(Object.keys(CROWDED_FAMILIES))(
      `%s: ${PAIRS} pairs`,
      (family) => {
        const pairs = crowdedPairs(family, 20261107, PAIRS);
        const answers = batchChanged(pairs);
        let lineCount = 0;
        let unsettled = 0;
        pairs.forEach(([old, new_], k) => {
          const result = alignFiles(bytesOf(old), bytesOf(new_));
          const expected = oldOfNewFrom(answers[k] as Changed, result.oldOfNew.length);
          const skipped = new Uint8Array(expected.length);
          if (result.kind === "aligned") {
            for (const { start, end } of result.unsettled) skipped.fill(1, start, end);
          }
          for (let line = 0; line < expected.length; line++) {
            lineCount++;
            if (skipped[line] || (result.kind === "refused" && result.oldOfNew[line] === -1)) {
              unsettled++;
              continue;
            }
            expect(result.oldOfNew[line], `${family} pair ${k} line ${line + 1}`).toBe(
              expected[line],
            );
          }
        });
        console.log(`${family}: ${PAIRS} pairs, ${lineCount} lines, ${unsettled} not settled`);
      },
      600_000,
    );
  });

  it("over-budget island: exactly its 20 lines, and one refused diff", async () => {
    const unique = Array.from({ length: 500 }, (_, k) => `l${k}`);
    const island = Array.from({ length: 20 }, (_, k) => `i${k}`);
    const tail = Array.from({ length: 500 }, (_, k) => `r${k}`);
    const commit = await build(
      "island",
      {
        a: { files: one(f(...unique, ...island, ...tail)) },
        b: { parents: ["a"], files: one(f(...unique, ...[...island].reverse(), ...tail)) },
      },
      "b",
    );
    const { reasons, resolved } = await compare(commit, "f", {
      ...SLICE,
      align: { maxRounds: 2, maxWork: 4_000_000 },
    });
    expect(reasons).toEqual(new Map([["diff_budget", 20]]));
    expect(resolved).toBe(1000);
  });

  it("a search of more than the round limit: stated, and what's resolved agrees", async () => {
    const lines2 = Array.from({ length: 2 * MAX_SEARCH_ROUNDS }, (_, k) => `l${k}`);
    const commit = await build(
      "rounds",
      {
        a: { files: one(f("keep", ...lines2)) },
        b: { parents: ["a"], files: one(f("keep", ...[...lines2].reverse())) },
      },
      "b",
    );
    const { reasons, resolved } = await compare(commit, "f");
    expect(reasons.get("diff_budget")).toBe(lines2.length);
    expect(resolved).toBe(1);
  });

  /** A seeded history: commits edit a parent's file, and some merge two. */
  function seededHistory(seed: number, size: number): Record<string, Node> {
    let state = seed >>> 0 || 1;
    const rand = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    };
    const indents = ["", "  ", "    ", "\t"];
    const word = () =>
      rand() < 0.15
        ? ""
        : `${indents[Math.floor(rand() * indents.length)]}w${Math.floor(rand() * 30)}`;
    const history: Record<string, Node> = {};
    const files: string[][] = [];
    for (let k = 0; k < size; k++) {
      const name = `c${k}`;
      const parents: string[] = [];
      let file: string[];
      if (k === 0) {
        file = Array.from({ length: 40 }, word);
      } else {
        const first = Math.max(0, k - 1 - Math.floor(rand() * 4));
        parents.push(`c${first}`);
        file = [...(files[first] as string[])];
        if (k > 2 && rand() < 0.25) {
          const second = Math.floor(rand() * k);
          if (second !== first) {
            parents.push(`c${second}`);
            // A merge takes some of the second parent's text.
            const other = files[second] as string[];
            const at = Math.floor(rand() * other.length);
            file.splice(Math.floor(rand() * file.length), 0, ...other.slice(at, at + 8));
          }
        }
        const edits = Math.floor(rand() * 4);
        for (let e = 0; e < edits; e++) {
          const at = Math.floor(rand() * (file.length + 1));
          if (rand() < 0.5)
            file.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rand() * 5) }, word));
          else file.splice(at, 1 + Math.floor(rand() * 3));
        }
      }
      files.push(file);
      history[name] = {
        parents,
        files: one(file.length > 0 ? `${file.join("\n")}\n` : ""),
      };
    }
    return history;
  }

  it.each([
    ["a tab", "f\tname"],
    ["a control byte", "f\u0001x"],
    ["a quote and a backslash", 'q"b\\s'],
  ])(
    "a path git quotes, with %s: its lines settle, and git's name is decoded",
    async (title, path) => {
      const prefix = `quoted-${title.replaceAll(" ", "-")}`;
      const tip = await build(
        prefix,
        {
          a: { files: { [path]: f("x") } },
          b: { parents: ["a"], files: { [path]: f("x", "y") } },
        },
        "b",
      );
      const raw = Buffer.from(
        await sandbox.gitBytes(["blame", "--line-porcelain", tip, "--", path], { env: ENV }),
      ).toString("latin1");
      expect(raw).toContain('\nfilename "');
      const { resolved, lines: count } = await compare(tip, path);
      expect(resolved).toBe(count);
    },
  );

  it("the test source reads no tree body past the bytes it may", async () => {
    const tip = await build("tree-bytes", { a: { files: { f: f("x"), g: f("y") } } }, "a");
    const root = (await sandbox.git(["rev-parse", `${tip}^{tree}`])).stdout.trim();
    const blob = (await sandbox.git(["rev-parse", `${tip}:f`])).stdout.trim();
    const size = Number((await sandbox.git(["cat-file", "-s", root])).stdout.trim());
    const source = await GitBlameSource.open(sandbox.dir, SOURCE_ENV, tip);
    try {
      expect(await source.tree(oidFromHex(root), size - 1)).toBe("too_large");
      expect(source.bodiesRead).toBe(0);
      expect(((await source.tree(oidFromHex(root), size)) as Uint8Array).length).toBe(size);
      expect(source.bodiesRead).toBe(1);
      await expect(source.tree(oidFromHex(blob), 1 << 20)).rejects.toThrow("isn't a tree");
      expect(source.bodiesRead).toBe(1);
    } finally {
      source.close();
    }
  });

  /**
   * A seeded history where the blamed file is renamed (sometimes back), edited and
   * copied, other paths come and go, and some commits merge. Returns the file's
   * name at the tip.
   */
  function renamingHistory(
    seed: number,
    size: number,
  ): { history: Record<string, Node>; path: string } {
    let state = seed >>> 0 || 1;
    const rand = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    };
    const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)] as T;
    const NAMES = ["f", "g", "dir/h", "dir/sub/f"];
    const OTHERS = ["o1", "o2", "dir/o3", "far/o4", "far/deep/o5"];
    const word = () => `w${Math.floor(rand() * 40)} of a line long enough to weigh`;
    const history: Record<string, Node> = {};
    const states: { name: string; text: string[]; others: Record<string, string> }[] = [];
    for (let k = 0; k < size; k++) {
      let current: { name: string; text: string[]; others: Record<string, string> };
      const parents: string[] = [];
      if (k === 0) {
        current = { name: "f", text: Array.from({ length: 30 }, word), others: { o1: f(word()) } };
      } else {
        const first = Math.max(0, k - 1 - Math.floor(rand() * 3));
        parents.push(`c${first}`);
        const base = states[first] as (typeof states)[number];
        current = { name: base.name, text: [...base.text], others: { ...base.others } };
        if (k > 2 && rand() < 0.2) {
          const second = Math.floor(rand() * k);
          if (second !== first) {
            parents.push(`c${second}`);
            const other = states[second] as (typeof states)[number];
            const at = Math.floor(rand() * other.text.length);
            current.text.splice(
              Math.floor(rand() * current.text.length),
              0,
              ...other.text.slice(at, at + 6),
            );
            for (const [path, text] of Object.entries(other.others))
              if (rand() < 0.5) current.others[path] = text;
          }
        }
        const roll = rand();
        if (roll < 0.15) current.name = pick(NAMES.filter((n) => n !== current.name));
        else if (roll < 0.25) {
          const gone = pick(Object.keys(current.others));
          if (gone) delete current.others[gone];
        } else if (roll < 0.35) current.others[pick(OTHERS)] = f(word(), word());
        else if (roll < 0.4) current.others[pick(OTHERS)] = f(...current.text);
        const edits = Math.floor(rand() * 3);
        for (let e = 0; e < edits; e++) {
          const at = Math.floor(rand() * (current.text.length + 1));
          if (rand() < 0.6)
            current.text.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rand() * 4) }, word));
          else current.text.splice(at, 1 + Math.floor(rand() * 2));
        }
      }
      // A path can't be both a file and a directory: other paths under the file's name go.
      for (const path of Object.keys(current.others)) {
        if (
          path === current.name ||
          path.startsWith(`${current.name}/`) ||
          current.name.startsWith(`${path}/`)
        )
          delete current.others[path];
      }
      states.push(current);
      history[`c${k}`] = {
        parents,
        files: {
          ...current.others,
          [current.name]: current.text.length > 0 ? f(...current.text) : "",
        },
      };
    }
    return { history, path: (states[size - 1] as (typeof states)[number]).name };
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("a seeded history with renames, seed %i", async (seed) => {
    const { history, path } = renamingHistory(seed * 104_729, 60);
    const commit = await build(`renaming-${seed}`, history, "c59");
    const { resolved, reasons, lines: count, git } = await compare(commit, path);
    expect(resolved + [...reasons.values()].reduce((a, b) => a + b, 0)).toBe(count);
    console.log(
      `seed ${seed}: ${count} lines, ${resolved} settled, git through another path ${git.filter((l) => l.filename !== latin1Path(path)).length}, ${JSON.stringify(Object.fromEntries(reasons))}`,
    );
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("a seeded history, seed %i", async (seed) => {
    const history = seededHistory(seed * 7919, 60);
    const commit = await build(`seeded-${seed}`, history, "c59");
    const { reasons, resolved, lines: count } = await compare(commit, "f");
    for (const reason of reasons.keys()) expect(reason).toBe("slide_unsettled");
    expect(resolved + [...reasons.values()].reduce((a, b) => a + b, 0)).toBe(count);
  });
});
