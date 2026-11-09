import { describe, expect, it } from "vitest";
import { type BlameState, decodeBlameState, encodeBlameState } from "../../src/blame/state.js";
import {
  advanceBlame,
  BlameObjectUnreadable,
  type BlameRange,
  BlameReadsSpent,
  type BlameSliceLimits,
  blameRanges,
  DEFAULT_BLAME_SLICE,
  startBlame,
} from "../../src/blame/walk.js";
import { oidToHex } from "../../src/object/oid.js";
import { PackError } from "../../src/pack/errors.js";
import { ReaderWorkSpent } from "../../src/reader/errors.js";
import { lines } from "./align-cases.js";
import { type FakeCommit, FakeSource, oidOfName, PATH } from "./fake-source.js";

/*
 * Whole blames over made-up histories, with what the oracle answered for each
 * (or, where git has no equivalent, the rule). A commit's name stands for it;
 * `name@n` is that commit's line n.
 */

type History = Readonly<Record<string, FakeCommit>>;

const SLICE: BlameSliceLimits = { ...DEFAULT_BLAME_SLICE, stepIsFresh: () => true };

async function start(source: FakeSource, tip: string): Promise<BlameState> {
  const state = await startBlame(source, oidOfName(tip), PATH);
  if ("failure" in state) throw new Error(state.failure);
  return state;
}

async function finished(source: FakeSource, tip: string, slice = SLICE): Promise<BlameState> {
  const state = await start(source, tip);
  for (let guard = 0; guard < 10_000; guard++) {
    const { stop } = await advanceBlame(state, source, slice);
    if (stop === "done") return state;
  }
  throw new Error("no end");
}

/** Each line, in order: `name@n`, or the reason. */
function answer(source: FakeSource, state: BlameState): string[] {
  const out = new Array<string>(state.lines).fill("?");
  for (const range of blameRanges(state, 0, Number.MAX_SAFE_INTEGER)) {
    for (let k = 0; k < range.lineCount; k++)
      out[range.startLine - 1 + k] = describeLine(source, range, k);
  }
  return out;
}

function describeLine(source: FakeSource, range: BlameRange, k: number): string {
  if ("unresolved" in range) return range.unresolved;
  return `${source.names.get(oidToHex(range.commit))}@${range.sourceStartLine + k}`;
}

async function blame(history: History, tip: string, slice = SLICE): Promise<string[]> {
  const source = new FakeSource(history);
  return answer(source, await finished(source, tip, slice));
}

const f = (...words: string[]) => lines(...words);

describe("which parent gets a line", () => {
  it("an identical parent wins, even over an earlier parent holding the line", async () => {
    expect(
      await blame(
        {
          base: { file: f("a", "b") },
          p1: { parents: ["base"], file: f("a", "b", "x") },
          p2: { parents: ["base"], file: f("a", "b", "x", "y") },
          merge: { parents: ["p1", "p2"], file: f("a", "b", "x", "y") },
        },
        "merge",
      ),
    ).toEqual(["base@1", "base@2", "p2@3", "p2@4"]);
  });

  it("otherwise parents go in listed order, and swapping them swaps the answer", async () => {
    const history = (parents: string[]): History => ({
      base: { file: f("a") },
      p1: { parents: ["base"], file: f("a", "s") },
      p2: { parents: ["base"], file: f("a", "s", "t") },
      merge: { parents, file: f("a", "s", "t", "u") },
    });
    expect(await blame(history(["p1", "p2"]), "merge")).toEqual([
      "base@1",
      "p1@2",
      "p2@3",
      "merge@4",
    ]);
    expect(await blame(history(["p2", "p1"]), "merge")).toEqual([
      "base@1",
      "p2@2",
      "p2@3",
      "merge@4",
    ]);
  });

  it("two parents identical to a merge: the first listed", async () => {
    const history = (parents: string[]): History => ({
      a: { file: f("x") },
      b: { file: f("x") },
      m: { parents, file: f("x") },
    });
    expect(await blame(history(["a", "b"]), "m")).toEqual(["a@1"]);
    expect(await blame(history(["b", "a"]), "m")).toEqual(["b@1"]);
  });

  it("an octopus: the identical third parent, then each parent's own lines", async () => {
    const base = { file: f("a", "b", "c") };
    const p1 = { parents: ["base"], file: f("b", "a", "c") };
    const p2 = { parents: ["base"], file: f("a", "b", "c", "d") };
    const p3 = { parents: ["p2"], file: f("a", "b", "c", "d", "e") };
    expect(
      await blame(
        {
          base,
          p1,
          p2,
          p3,
          oct: { parents: ["p1", "p2", "p3"], file: f("a", "b", "c", "d", "e") },
        },
        "oct",
      ),
    ).toEqual(["base@1", "base@2", "base@3", "p2@4", "p3@5"]);
  });

  it("a parent lacking the path is skipped", async () => {
    expect(
      await blame(
        {
          p1: {},
          p2: { file: f("a", "b") },
          merge: { parents: ["p1", "p2"], file: f("a", "b", "c") },
        },
        "merge",
      ),
    ).toEqual(["p2@1", "p2@2", "merge@3"]);
  });

  it("two parents with the same blob cost one alignment", async () => {
    const source = new FakeSource({
      base: { file: f("a") },
      p: { parents: ["base"], file: f("a", "b") },
      s: { parents: ["base"], file: f("a", "s") },
      t: { parents: ["base"], file: f("a", "s") },
      m: { parents: ["p", "s", "t"], file: f("a", "b", "s", "m") },
    });
    const state = await finished(source, "m");
    expect(answer(source, state)).toEqual(["base@1", "p@2", "s@2", "m@4"]);
    expect(source.blobReads.filter((text) => text === f("a", "s"))).toHaveLength(2);
  });

  it("a line both parents hold stays with the first parent's history", async () => {
    const shared = {
      base: { file: f("k", "m") },
      p1: { parents: ["base"], file: f("k", "m", "shared") },
      p2: { parents: ["p1"], file: f("k", "m", "shared", "two") },
    };
    expect(
      await blame(
        { ...shared, m: { parents: ["p1", "p2"], file: f("k", "m", "shared", "two", "own") } },
        "m",
      ),
    ).toEqual(["base@1", "base@2", "p1@3", "p2@4", "m@5"]);
  });

  it("a merge's own line belongs to it", async () => {
    expect(
      await blame(
        {
          base: { file: f("a") },
          p: { parents: ["base"], file: f("a", "b") },
          q: { parents: ["base"], file: f("a", "c") },
          m: { parents: ["p", "q"], file: f("a", "b", "own", "c") },
        },
        "m",
      ),
    ).toEqual(["base@1", "p@2", "m@3", "q@2"]);
  });

  it("lines from two children meet at one parent: the state holds pairs", async () => {
    // Line 1 of `base` is both final lines 1 and 2, through different children.
    expect(
      await blame(
        {
          base: { file: f("s") },
          a: { parents: ["base"], file: f("s", "a") },
          b: { parents: ["base"], file: f("b", "s") },
          m: { parents: ["a", "b"], file: f("s", "a", "b", "s") },
        },
        "m",
      ),
    ).toEqual(["base@1", "a@2", "b@1", "base@1"]);
  });
});

describe("which file a commit has", () => {
  it("a symlink is blamed as its text, and only a symlink parent counts", async () => {
    // At b the path changes type, which is a removal: whether git could follow a rename
    // there isn't ruled out, so the line is refused rather than settled on b.
    expect(
      await blame(
        {
          a: { kind: "file", file: "target\n" },
          b: { parents: ["a"], kind: "symlink", file: "target\n" },
          c: { parents: ["b"], kind: "symlink", file: "target\n" },
        },
        "c",
      ),
    ).toEqual(["rename_possible"]);
  });

  it("the path gone in the parent starts here, and a recreation starts again", async () => {
    expect(
      await blame(
        {
          a: { file: f("x") },
          b: { parents: ["a"] },
          c: { parents: ["b"], file: f("x") },
        },
        "c",
      ),
    ).toEqual(["c@1"]);
  });

  it("answers an empty file with no lines, and no work", async () => {
    const source = new FakeSource({ a: { file: "" } });
    const state = await start(source, "a");
    expect(state.lines).toBe(0);
    expect((await advanceBlame(state, source, SLICE)).stop).toBe("done");
    expect(blameRanges(state, 0, 10)).toEqual([]);
  });
});

describe("starting", () => {
  it("fails with no lines when the path isn't a file, or is too large", async () => {
    const source = new FakeSource({ none: {}, big: { file: "x\n".repeat(100_001) } });
    expect(await startBlame(source, oidOfName("none"), PATH)).toEqual({
      failure: "path_not_found",
    });
    expect(await startBlame(source, oidOfName("big"), PATH)).toEqual({ failure: "file_too_large" });
    expect(await startBlame(source, oidOfName("nothing"), PATH)).toEqual({
      failure: "commit_missing",
    });
  });

  it("counts a file of exactly the line limit as legal", async () => {
    const source = new FakeSource({ at: { file: "x\n".repeat(100_000) } });
    const state = await start(source, "at");
    expect(state.lines).toBe(100_000);
  });

  it("fails rather than holds a state that doesn't fit the room", async () => {
    const source = new FakeSource({ a: { file: "x\n".repeat(1000) } });
    expect(await startBlame(source, oidOfName("a"), PATH, { maxLiveStateBytes: 1000 })).toEqual({
      failure: "state_too_large",
    });
  });
});

describe("what ends a line unresolved", () => {
  it("too many parents: every pending line, before any diff", async () => {
    const source = new FakeSource({
      a: { file: f("x") },
      m: { parents: ["a"], tooManyParents: true, file: f("x", "y") },
    });
    const state = await finished(source, "m");
    expect(answer(source, state)).toEqual(["too_many_parents", "too_many_parents"]);
    expect(source.blobReads).toEqual([f("x", "y")]);
  });

  it("a missing parent stops the step, unless an identical parent came first", async () => {
    const after = {
      a: { file: f("x") },
      m: { parents: ["a", "gone"], file: f("x") },
    };
    expect(await blame(after, "m")).toEqual(["a@1"]);
    const before = {
      a: { file: f("x") },
      m: { parents: ["gone", "a"], file: f("x") },
    };
    expect(await blame(before, "m")).toEqual(["history_missing"]);
    const different = {
      a: { file: f("x") },
      m: { parents: ["a", "gone"], file: f("x", "y") },
    };
    expect(await blame(different, "m")).toEqual(["history_missing", "history_missing"]);
  });

  it("a parent too large: everything pending, no later parent, what's taken stays", async () => {
    const source = new FakeSource({
      small: { file: f("a") },
      large: { file: `${"z\n".repeat(50)}` },
      later: { file: f("a", "b", "c") },
      m: { parents: ["small", "large", "later"], file: f("a", "b", "c") },
    });
    source.maxBlobBytes = 20;
    const blobs = source.blob.bind(source);
    source.blob = (oid, max) => blobs(oid, max);
    const state = await finished(source, "m");
    // `later` is identical, so it wins before anything's read.
    expect(answer(source, state)).toEqual(["later@1", "later@2", "later@3"]);

    const refused = new FakeSource({
      small: { file: f("a") },
      large: { file: `${"z\n".repeat(50)}` },
      later: { file: f("a", "b", "d") },
      m: { parents: ["small", "large", "later"], file: f("a", "b", "c") },
    });
    refused.maxBlobBytes = 20;
    expect(answer(refused, await finished(refused, "m"))).toEqual([
      "small@1",
      "parent_too_large",
      "parent_too_large",
    ]);
  });

  it("a parent of more lines than the limit counts as too large", async () => {
    expect(
      await blame(
        {
          huge: { file: "z\n".repeat(100_001) },
          m: { parents: ["huge"], file: f("a") },
        },
        "m",
      ),
    ).toEqual(["parent_too_large"]);
  });

  it("a costly diff: lines no alignment could change go on, the rest stop there", async () => {
    const middle = Array.from({ length: 600 }, (_, k) => `u${k}`);
    const source = new FakeSource({
      first: { file: f("seal", ...middle, "end") },
      p: { parents: ["first"], file: f("seal", ...middle, "end") },
      later: { file: f("seal", ...[...middle].reverse(), "end") },
      m: { parents: ["p", "later"], file: f("seal", ...[...middle].reverse(), "end", "own") },
    });
    const got = answer(source, await finished(source, "m"));
    expect(got[0]).toBe("first@1");
    expect(got[100]).toBe("diff_budget");
    // The refused lines went no further, though `later` has them word for word.
    expect(got.filter((line) => line.startsWith("later"))).toEqual([]);
    // A whole refusal: nothing's left to be the commit's own, not even a line only it has.
    expect(got.at(-1)).toBe("diff_budget");
  });

  it("a close call: those lines stop, the rest go on", async () => {
    const got = await blame(
      {
        base: { file: f("top", "8x", "3y", "bot", "bot") },
        m: { parents: ["base"], file: f("top", "8x", "3y", "8x", "3y", "bot", "bot") },
      },
      "m",
    );
    expect(got).toEqual([
      "base@1",
      "slide_unsettled",
      "slide_unsettled",
      "slide_unsettled",
      "slide_unsettled",
      "base@4",
      "base@5",
    ]);
  });

  it("the blame's step limit: what's pending is unresolved", async () => {
    const history: Record<string, FakeCommit> = { c0: { file: f("x") } };
    for (let k = 1; k < 10; k++) history[`c${k}`] = { parents: [`c${k - 1}`], file: f("x") };
    const got = await blame(history, "c9", { ...SLICE, maxBlameSteps: 4 });
    expect(got).toEqual(["history_limit"]);
  });
});

describe("a step is atomic", () => {
  const history: History = {
    base: { file: f("a") },
    p: { parents: ["base"], file: f("a", "b") },
    q: { parents: ["base"], file: f("a", "b", "c") },
    m: { parents: ["p", "q"], file: f("a", "b", "c", "d") },
  };

  const failingOn = (what: string, error: () => Error) => {
    const source = new FakeSource(history);
    let armed = true;
    source.failOn = (reading) => {
      if (armed && reading === what) {
        armed = false;
        throw error();
      }
    };
    return source;
  };

  it("an R2 failure fails the request, state unchanged", async () => {
    const source = failingOn("info m", () => new Error("R2 unavailable"));
    const state = await start(source, "m");
    const before = encodeBlameState(state);
    await expect(advanceBlame(state, source, SLICE)).rejects.toThrow("R2 unavailable");
    expect(encodeBlameState(state)).toEqual(before);
    // It may pass next time.
    await advanceBlame(state, source, SLICE);
    expect(answer(source, state)).toEqual(["base@1", "p@2", "q@3", "m@4"]);
  });

  for (const [what, error] of [
    ["reads", () => new BlameReadsSpent()],
    ["decoding work", () => new ReaderWorkSpent(10)],
  ] as const) {
    it(`${what} spent in a fresh step: that commit's pending lines, and the walk goes on`, async () => {
      const source = failingOn(`blob ${f("a", "b", "c")}`, error);
      const state = await finished(source, "m");
      expect(answer(source, state)).toEqual([
        "work_limit",
        "work_limit",
        "work_limit",
        "work_limit",
      ]);
    });

    it(`${what} spent in any other step: undone, the slice ends, and the next request tries it fresh`, async () => {
      const source = failingOn(`blob ${f("a", "b", "c")}`, error);
      const state = await start(source, "m");
      const before = encodeBlameState(state);
      const { stop, steps } = await advanceBlame(state, source, {
        ...SLICE,
        stepIsFresh: () => false,
      });
      expect(stop).toBe("budget");
      expect(steps).toBe(0);
      expect(encodeBlameState(state)).toEqual(before);
      await advanceBlame(state, source, SLICE);
      expect(answer(source, state)).toEqual(["base@1", "p@2", "q@3", "m@4"]);
    });
  }

  it("decides freshness when a step begins, not when the slice does", async () => {
    const source = new FakeSource(history);
    const asked: number[] = [];
    await advanceBlame(await start(source, "m"), source, {
      ...SLICE,
      stepIsFresh: () => {
        asked.push(1);
        return true;
      },
    });
    expect(asked.length).toBeGreaterThan(1);
  });

  it("an object over the cap: terminal at once, with no credit for earlier parents", async () => {
    const source = failingOn(
      `blob ${f("a", "b", "c")}`,
      () => new PackError("object-too-large", "over the cap"),
    );
    const state = await finished(source, "m", { ...SLICE, stepIsFresh: () => false });
    expect(answer(source, state)).toEqual([
      "object_limit",
      "object_limit",
      "object_limit",
      "object_limit",
    ]);
  });

  it("a chain too deep: terminal, fresh or not", async () => {
    const source = failingOn(
      `blob ${f("a", "b", "c")}`,
      () => new PackError("delta-too-deep", "a long chain"),
    );
    const state = await finished(source, "m", { ...SLICE, stepIsFresh: () => false });
    expect(answer(source, state)).toEqual(["work_limit", "work_limit", "work_limit", "work_limit"]);
  });

  it("a read that always fails: unreadable for that commit, and the walk moves on", async () => {
    for (const error of [
      () => new PackError("bad-delta", "corrupt"),
      () => new BlameObjectUnreadable("in no pack"),
    ]) {
      const source = new FakeSource({
        base: { file: f("a") },
        bad: { parents: ["base"], file: f("a", "b") },
        m: { parents: ["bad"], file: f("a", "b", "c") },
      });
      source.failOn = (reading) => {
        if (reading === `blob ${f("a")}`) throw error();
      };
      const state = await finished(source, "m");
      expect(answer(source, state)).toEqual(["history_unreadable", "history_unreadable", "m@3"]);
    }
  });

  it("a code bug isn't read as corruption", async () => {
    const source = failingOn(`blob ${f("a", "b", "c")}`, () => new TypeError("a bug"));
    const state = await start(source, "m");
    await expect(advanceBlame(state, source, SLICE)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("slices", () => {
  const chain = (n: number): History => {
    const history: Record<string, FakeCommit> = { c0: { file: f("l0") } };
    for (let k = 1; k < n; k++) {
      history[`c${k}`] = {
        parents: [`c${k - 1}`],
        file: f(...Array.from({ length: k + 1 }, (_, j) => `l${j}`)),
      };
    }
    return history;
  };

  it("ends at its step limit, and each slice makes progress", async () => {
    const source = new FakeSource(chain(10));
    const state = await start(source, "c9");
    const slice = { ...SLICE, maxSteps: 3 };
    expect(await advanceBlame(state, source, slice)).toMatchObject({ steps: 3, stop: "slice" });
    expect(await advanceBlame(state, source, slice)).toMatchObject({ steps: 3, stop: "slice" });
    expect(await advanceBlame(state, source, slice)).toMatchObject({ steps: 3, stop: "slice" });
    expect(await advanceBlame(state, source, slice)).toMatchObject({ steps: 1, stop: "done" });
  });

  it("checks engine work between steps, so its first step always finishes", async () => {
    const source = new FakeSource(chain(10));
    const state = await start(source, "c9");
    const { steps, stop, work } = await advanceBlame(state, source, { ...SLICE, maxWork: 1 });
    expect(steps).toBe(1);
    expect(stop).toBe("slice");
    expect(work).toBeGreaterThan(1);
  });

  it("charges setup and pairs moved to engine work, even where no diff runs", async () => {
    const source = new FakeSource({
      a: { file: f("x", "y") },
      b: { parents: ["a"], file: f("x", "y") },
    });
    const state = await start(source, "b");
    expect((await advanceBlame(state, source, { ...SLICE, maxSteps: 1 })).work).toBe(2);
    const text = f("x", "y");
    const changed = new FakeSource({
      a: { file: text },
      b: { parents: ["a"], file: f("x", "y", "z") },
    });
    const next = await start(changed, "b");
    const { work } = await advanceBlame(next, changed, { ...SLICE, maxSteps: 1 });
    const bytes = text.length + f("x", "y", "z").length;
    expect(work).toBeGreaterThanOrEqual(Math.floor(bytes / 8) + 2 + 3 + 3);
  });

  it("restored from encoded state after every step, gives the same answer", async () => {
    const history: History = {
      base: { file: f("k", "m", "n") },
      a: { parents: ["base"], file: f("k", "m", "a", "n") },
      b: { parents: ["base"], file: f("k", "b", "m", "n") },
      m: { parents: ["a", "b"], file: f("k", "b", "m", "a", "n", "own") },
      tip: { parents: ["m"], file: f("k", "b", "m", "a", "n", "own", "last") },
    };
    const whole = await blame(history, "tip");
    const source = new FakeSource(history);
    let state = await start(source, "tip");
    let stop = "";
    for (let guard = 0; guard < 100 && stop !== "done"; guard++) {
      const result = await advanceBlame(state, source, { ...SLICE, maxSteps: 1 });
      stop = result.stop;
      if (stop !== "done") expect(result.steps).toBe(1);
      state = decodeBlameState(encodeBlameState(state));
    }
    expect(answer(source, state)).toEqual(whole);
    expect(whole.slice(0, 2)).toEqual(["base@1", "b@2"]);
  });

  it("reads a commit's facts once, when it first settles lines", async () => {
    const source = new FakeSource({
      a: { file: f("x") },
      b: { parents: ["a"], file: f("x", "y") },
      c: { parents: ["b"], file: f("x", "y", "z") },
    });
    const state = await finished(source, "c");
    expect(source.factsRead.sort()).toEqual(["a", "b", "c"]);
    expect(Object.keys(state.facts).length).toBe(3);
  });

  it("takes a single flag when the state wouldn't fit, and settled lines stay", async () => {
    const source = new FakeSource({
      base: { file: f("a", "b", "c", "d") },
      m: { parents: ["base"], file: f("a", "b", "c", "d", "own") },
    });
    const state = await start(source, "m");
    const { stop } = await advanceBlame(state, source, { ...SLICE, maxEncodedBytes: 1 });
    expect(stop).toBe("done");
    expect(state.stateLimit).toBe(true);
    expect(state.queue).toEqual([]);
    expect(answer(source, state)).toEqual(new Array(5).fill("state_limit"));
    expect(decodeBlameState(encodeBlameState(state)).stateLimit).toBe(true);
  });
});

describe("delivering ranges", () => {
  it("in settled order, merged only within a step, from an offset, with a limit", async () => {
    const source = new FakeSource({
      a: { file: f("x", "y") },
      b: { parents: ["a"], file: f("x", "n", "y", "m") },
    });
    const state = await finished(source, "b");
    const ranges = blameRanges(state, 0, 100);
    expect(ranges.map((r) => [r.startLine, r.lineCount])).toEqual([
      [2, 1],
      [4, 1],
      [1, 1],
      [3, 1],
    ]);
    expect(blameRanges(state, 1, 2).map((r) => r.startLine)).toEqual([4, 1]);
    expect(blameRanges(state, 10, 2)).toEqual([]);
  });

  it("derives a state flag's ranges after what settled", async () => {
    const source = new FakeSource({
      base: { file: f("a", "b", "c") },
      m: { parents: ["base"], file: f("a", "b", "c", "own") },
    });
    const state = await start(source, "m");
    await advanceBlame(state, source, { ...SLICE, maxLiveStateBytes: 1 });
    expect(blameRanges(state, 0, 10)).toEqual([
      { startLine: 1, lineCount: 4, unresolved: "state_limit" },
    ]);
  });
});
