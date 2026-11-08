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
import { GitBlameSource, parsePorcelain } from "./blame-git-source.js";

/*
 * Whole blames against the pinned oracle, over histories built with
 * fast-import: on every resolved line, the same commit and source line. Without
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

  async function oracle(commit: string, path: string) {
    const out = await sandbox.gitBytes(
      ["blame", "--no-follow", "--line-porcelain", commit, "--", path],
      { env: ENV },
    );
    return parsePorcelain(Buffer.from(out).toString("latin1"));
  }

  /** Runs the engine over a built history, and compares each line it resolved. */
  async function compare(tip: string, path: string, slice = SLICE) {
    const source = await GitBlameSource.open(sandbox.dir, { ...process.env, ...ENV }, tip);
    try {
      const state = await startBlame(
        source,
        oidFromHex(tip),
        path.split("/").map((segment) => new TextEncoder().encode(segment)),
      );
      if ("failure" in state) throw new Error(state.failure);
      for (;;) {
        if ((await advanceBlame(state, source, slice)).stop === "done") break;
      }
      const expected = await oracle(tip, path);
      expect(state.lines).toBe(expected.length);
      const reasons = new Map<string, number>();
      let resolved = 0;
      const told = new Array<boolean>(state.lines).fill(false);
      for (const range of blameRanges(state, 0, Number.MAX_SAFE_INTEGER)) {
        for (let k = 0; k < range.lineCount; k++) {
          const line = range.startLine - 1 + k;
          told[line] = true;
          if ("unresolved" in range) {
            reasons.set(range.unresolved, (reasons.get(range.unresolved) ?? 0) + 1);
            continue;
          }
          resolved++;
          expect(`${oidToHex(range.commit)}@${range.sourceStartLine + k}`, `line ${line + 1}`).toBe(
            `${expected[line]?.commit}@${expected[line]?.line}`,
          );
        }
      }
      expect(told.every(Boolean)).toBe(true);
      return { resolved, reasons, lines: state.lines };
    } finally {
      source.close();
    }
  }

  const f = (...words: string[]) => lines(...words);
  const one = (text: string) => ({ f: text });
  const SYNTHETIC: Record<string, { history: Record<string, Node>; tip: string }> = {
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
    "rename-no-follow": {
      tip: "b",
      history: {
        a: { files: { old: f("a", "b") } },
        b: { parents: ["a"], files: { f: f("a", "b") } },
      },
    },
    "delete-recreate": {
      tip: "c",
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
      history: {
        a: { files: { f: "target\n" } },
        b: { parents: ["a"], files: { f: "120000 target\n" } },
        c: { parents: ["b"], files: { "f/inner": f("z") } },
        d: { parents: ["c"], files: { f: f("n") } },
      },
    },
  };

  it("fails loudly if `--no-follow` stops turning rename following off", async () => {
    const { history, tip } = SYNTHETIC["rename-no-follow"] as {
      history: Record<string, Node>;
      tip: string;
    };
    const commit = await build("rename-check", history, tip);
    const lastCommit = (await oracle(commit, "f"))[0]?.commit;
    expect(lastCommit).toBe(commit);
  });

  it.each(Object.keys(SYNTHETIC))("%s", async (name) => {
    const { history, tip } = SYNTHETIC[name] as { history: Record<string, Node>; tip: string };
    const commit = await build(name, history, tip);
    const { reasons, resolved, lines: count } = await compare(commit, "f");
    expect(reasons.size).toBe(0);
    expect(resolved).toBe(count);
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

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("a seeded history, seed %i", async (seed) => {
    const history = seededHistory(seed * 7919, 60);
    const commit = await build(`seeded-${seed}`, history, "c59");
    const { reasons, resolved, lines: count } = await compare(commit, "f");
    for (const reason of reasons.keys()) expect(reason).toBe("slide_unsettled");
    expect(resolved + [...reasons.values()].reduce((a, b) => a + b, 0)).toBe(count);
  });
});
