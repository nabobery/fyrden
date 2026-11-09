import { describe, expect, it } from "vitest";
import {
  type BlameState,
  decodeBlameState,
  encodeBlameState,
  liveStateBytes,
  MAX_BLAME_LINES,
} from "../../src/blame/state.js";
import {
  advanceBlame,
  type BlameCommitInfo,
  BlameObjectUnreadable,
  type BlameRange,
  BlameReadsSpent,
  type BlameSliceLimits,
  blameRanges,
  DEFAULT_BLAME_SLICE,
  startBlame,
} from "../../src/blame/walk.js";
import type { Oid } from "../../src/object/oid.js";
import { oidToHex } from "../../src/object/oid.js";
import { lines } from "./align-cases.js";
import { type FakeCommit, FakeSource, oidOfName, PATH } from "./fake-source.js";

/*
 * Edges of the walk that whole blames rarely reach: a refusal of a whole
 * step, the state's limits met exactly, a source that changes between
 * slices, a last line with no line feed, and the queue's order where object
 * ids share a first byte or levels disagree with generations.
 */

type History = Readonly<Record<string, FakeCommit>>;
const SLICE: BlameSliceLimits = { ...DEFAULT_BLAME_SLICE, stepIsFresh: () => true };
const f = (...words: string[]) => lines(...words);

async function start(source: FakeSource, tip: string, options = {}): Promise<BlameState> {
  const state = await startBlame(source, oidOfName(tip), PATH, options);
  if ("failure" in state) throw new Error(state.failure);
  return state;
}

async function finished(source: FakeSource, tip: string, slice = SLICE): Promise<BlameState> {
  const state = await start(source, tip);
  for (let guard = 0; guard < 10_000; guard++) {
    if ((await advanceBlame(state, source, slice)).stop === "done") return state;
  }
  throw new Error("no end");
}

function describeLine(source: FakeSource, range: BlameRange, k: number): string {
  if ("unresolved" in range) return range.unresolved;
  return `${source.names.get(oidToHex(range.commit))}@${range.sourceStartLine + k}`;
}

function answer(source: FakeSource, state: BlameState): string[] {
  const out = new Array<string>(state.lines).fill("?");
  for (const range of blameRanges(state, 0, Number.MAX_SAFE_INTEGER)) {
    for (let k = 0; k < range.lineCount; k++)
      out[range.startLine - 1 + k] = describeLine(source, range, k);
  }
  return out;
}

const settled = (state: BlameState) => [...state.ranges.subarray(0, 4 * state.rangeCount)];

/** A source whose answers can be changed between reads. */
class ChangingSource extends FakeSource {
  commitGone = new Set<string>();
  fileGone = new Set<string>();
  levels = new Map<string, { generation: number; level: number }>();
  override async commit(oid: Oid) {
    const name = this.names.get(oidToHex(oid)) as string;
    if (this.commitGone.has(name)) return undefined;
    const info = await super.commit(oid);
    const override = this.levels.get(name);
    return info && override ? { ...info, ...override } : info;
  }
  override async fileAt(tree: Oid) {
    const found = await super.fileAt(tree);
    for (const name of this.fileGone)
      if (oidToHex(this.treeOf(name)) === oidToHex(tree)) return null;
    return found;
  }
}

describe("a whole step refused", () => {
  it("refuses each pending line once, in one range, and the state still decodes", async () => {
    const source = new FakeSource({
      a: { file: f("x") },
      m: { parents: ["a"], tooManyParents: true, file: f("x", "y", "z") },
    });
    const state = await finished(source, "m");
    expect(settled(state)).toEqual([0, 3, -2, 0]);
    expect(answer(source, decodeBlameState(encodeBlameState(state)))).toEqual(
      new Array(3).fill("too_many_parents"),
    );
  });

  it("a refused diff refuses each line it can't carry once, and the state still decodes", async () => {
    const middle = Array.from({ length: 40 }, (_, k) => `u${k}`);
    const source = new FakeSource({
      p: { file: f("seal", ...middle, "end") },
      m: { parents: ["p"], file: f("seal", ...[...middle].reverse(), "end") },
    });
    const state = await finished(source, "m", {
      ...SLICE,
      align: { maxRounds: 4, maxWork: 4_000_000 },
    });
    const got = answer(source, decodeBlameState(encodeBlameState(state)));
    expect(got[0]).toBe("p@1");
    expect(got.at(-1)).toBe("p@42");
    expect(got.slice(1, 41)).toEqual(new Array(40).fill("diff_budget"));
    // The two ends, each its own range, and the refused middle.
    expect(state.rangeCount).toBe(3);
  });
});

describe("a source that changes between slices", () => {
  it("a commit gone by its own step: its lines are history_missing", async () => {
    const source = new ChangingSource({ a: { file: f("x", "y") } });
    const state = await start(source, "a");
    source.commitGone.add("a");
    await advanceBlame(state, source, SLICE);
    expect(answer(source, state)).toEqual(["history_missing", "history_missing"]);
  });

  it("its file gone by its own step: history_unreadable", async () => {
    const source = new ChangingSource({ a: { file: f("x", "y") } });
    const state = await start(source, "a");
    source.fileGone.add("a");
    await advanceBlame(state, source, SLICE);
    expect(answer(source, state)).toEqual(["history_unreadable", "history_unreadable"]);
  });

  it("its own file now too large to read: parent_too_large", async () => {
    const source = new FakeSource({
      a: { file: f("x") },
      b: { parents: ["a"], file: f("x", "y") },
    });
    const state = await start(source, "b");
    source.maxBlobBytes = 2;
    await advanceBlame(state, source, SLICE);
    expect(answer(source, state)).toEqual(["parent_too_large", "parent_too_large"]);
  });
});

describe("counting lines", () => {
  it("counts a last line with no line feed", async () => {
    const source = new FakeSource({ a: { file: "x\ny" } });
    expect((await start(source, "a")).lines).toBe(2);
  });

  it("holds a parent of exactly the line limit, unterminated, to that limit", async () => {
    const history: History = {
      a: { file: "x\ny\nz" },
      b: { parents: ["a"], file: f("x", "y", "z", "w") },
    };
    const fits = new FakeSource(history);
    const state = await start(fits, "b");
    await advanceBlame(state, fits, { ...SLICE, maxSteps: 1, maxFileLines: 3 });
    expect(answer(fits, state)).toEqual(["?", "?", "b@3", "b@4"]);
    const over = new FakeSource(history);
    const refused = await start(over, "b");
    await advanceBlame(refused, over, { ...SLICE, maxSteps: 1, maxFileLines: 2 });
    expect(answer(over, refused)).toEqual(new Array(4).fill("parent_too_large"));
  });

  it("holds a file to the checkpoint's line limit, whatever larger limit is asked for", async () => {
    // Past it the state couldn't be decoded again, so a sliced blame couldn't resume.
    const longer = MAX_BLAME_LINES + 1;
    const big = new FakeSource({ a: { file: "x\n".repeat(longer) } });
    expect(await startBlame(big, oidOfName("a"), PATH, { maxFileLines: longer })).toEqual({
      failure: "file_too_large",
    });
    const history: History = {
      a: { file: `y\n${"x\n".repeat(MAX_BLAME_LINES)}` },
      b: { parents: ["a"], file: f("y") },
    };
    const source = new FakeSource(history);
    const state = await start(source, "b");
    await advanceBlame(state, source, { ...SLICE, maxFileLines: longer });
    expect(answer(source, state)).toEqual(["parent_too_large"]);
  });

  it("a root commit takes its lines without reading its file again", async () => {
    const source = new FakeSource({ a: { file: f("x") } });
    await finished(source, "a");
    expect(source.blobReads).toEqual([f("x")]);
  });
});

describe("one advance at a time", () => {
  it("refuses a second advance of a state while the first runs, and the first still ends sound", async () => {
    const source = new FakeSource({
      a: { file: f("x") },
      b: { parents: ["a"], file: f("x", "y") },
    });
    const state = await start(source, "b");
    const first = advanceBlame(state, source, SLICE);
    await expect(advanceBlame(state, source, SLICE)).rejects.toThrow(
      "a blame state is already being advanced",
    );
    expect((await first).stop).toBe("done");
    expect(answer(source, decodeBlameState(encodeBlameState(state)))).toEqual(["a@1", "b@2"]);
    // Once it's done, the state can be advanced again.
    expect((await advanceBlame(state, source, SLICE)).stop).toBe("done");
  });
});

describe("the queue's order", () => {
  it("tells apart commits whose object ids share a first byte", async () => {
    // oidOfName("p14") and oidOfName("p32") both start 0x94.
    expect(oidToHex(oidOfName("p14")).slice(0, 2)).toBe(oidToHex(oidOfName("p32")).slice(0, 2));
    const history: History = {
      p14: { file: f("from14") },
      p32: { file: f("from32") },
      m: { parents: ["p32", "p14"], file: f("from14", "from32") },
    };
    const source = new FakeSource(history);
    expect(answer(source, await finished(source, "m"))).toEqual(["p14@1", "p32@1"]);
  });

  it("orders by generation before level, which settles unrelated commits in that order", async () => {
    const source = new ChangingSource({
      a: { file: f("fromA") },
      b: { file: f("fromB") },
      m: { parents: ["a", "b"], file: f("fromA", "fromB") },
    });
    source.levels.set("a", { generation: 2, level: 1 });
    source.levels.set("b", { generation: 1, level: 5 });
    source.levels.set("m", { generation: 9, level: 9 });
    const state = await finished(source, "m");
    expect(blameRanges(state, 0, 10).map((r) => describeLine(source, r, 0))).toEqual([
      "a@1",
      "b@1",
    ]);
  });
});

describe("the state's limits, met exactly", () => {
  const histories: Record<string, [History, string]> = {
    merge: [
      {
        base: { file: f("k", "m", "n") },
        a: { parents: ["base"], file: f("k", "m", "a", "n") },
        b: { parents: ["base"], file: f("k", "b", "m", "n") },
        m: { parents: ["a", "b"], file: f("k", "b", "m", "a", "n", "own") },
        tip: { parents: ["m"], file: f("k", "b", "m", "a", "n", "own", "last") },
      },
      "tip",
    ],
    // Each side passes lines to base, so the second finds base already queued.
    sharedBase: [
      {
        base: { file: f("k", "m", "n") },
        a: { parents: ["base"], file: f("k", "a", "n") },
        b: { parents: ["base"], file: f("k", "m", "b", "n") },
        m: { parents: ["a", "b"], file: f("k", "m", "a", "b", "n") },
      },
      "m",
    ],
    refusedStep: [
      {
        a: { file: f("x", "y") },
        b: { parents: ["a"], file: f("x", "y", "own") },
        m: { parents: ["b"], tooManyParents: true, file: f("x", "y", "own", "z") },
        tip: { parents: ["m"], file: f("x", "y", "own", "z", "t") },
      },
      "tip",
    ],
  };

  it.each(Object.entries(histories))(
    "%s: each step fits at its size, and one byte less flags it",
    async (_, [history, tip]) => {
      const source = new FakeSource(history);
      let state = await start(source, tip);
      for (let guard = 0; guard < 50 && state.queue.length > 0; guard++) {
        const snapshot = encodeBlameState(state);
        const after = decodeBlameState(snapshot);
        await advanceBlame(after, source, { ...SLICE, maxSteps: 1 });
        const live = liveStateBytes(after);
        const encoded = encodeBlameState(after).length;
        const exact = decodeBlameState(snapshot);
        await advanceBlame(exact, source, {
          ...SLICE,
          maxSteps: 1,
          maxLiveStateBytes: live,
          maxEncodedBytes: encoded,
        });
        expect(exact.stateLimit).toBe(false);
        expect(encodeBlameState(exact)).toEqual(encodeBlameState(after));
        const lessLive = decodeBlameState(snapshot);
        await advanceBlame(lessLive, source, {
          ...SLICE,
          maxSteps: 1,
          maxLiveStateBytes: live - 1,
        });
        expect(lessLive.stateLimit).toBe(true);
        const lessEncoded = decodeBlameState(snapshot);
        await advanceBlame(lessEncoded, source, {
          ...SLICE,
          maxSteps: 1,
          maxEncodedBytes: encoded - 1,
        });
        expect(lessEncoded.stateLimit).toBe(true);
        state = after;
      }
      expect(state.queue).toEqual([]);
    },
  );

  it.each(["merge", "sharedBase"])(
    "%s: the whole blame's step limit refuses what's pending at its size, and one byte less flags it",
    async (name) => {
      const [history, tip] = histories[name] as [History, string];
      const source = new FakeSource(history);
      const state = await start(source, tip);
      let checked = 0;
      while (state.queue.length > 0) {
        const snapshot = encodeBlameState(state);
        const atLimit = { ...SLICE, maxBlameSteps: state.steps };
        const after = decodeBlameState(snapshot);
        await advanceBlame(after, source, atLimit);
        expect(after.queue).toEqual([]);
        expect(after.stateLimit).toBe(false);
        expect(after.rangeCount).toBeGreaterThan(state.rangeCount);
        const live = liveStateBytes(after);
        const encoded = encodeBlameState(after).length;
        const exact = decodeBlameState(snapshot);
        await advanceBlame(exact, source, {
          ...atLimit,
          maxLiveStateBytes: live,
          maxEncodedBytes: encoded,
        });
        expect(encodeBlameState(exact)).toEqual(encodeBlameState(after));
        for (const less of [{ maxLiveStateBytes: live - 1 }, { maxEncodedBytes: encoded - 1 }]) {
          const flagged = decodeBlameState(snapshot);
          await advanceBlame(flagged, source, { ...atLimit, ...less });
          expect({ less, flagged: flagged.stateLimit, queue: flagged.queue }).toEqual({
            less,
            flagged: true,
            queue: [],
          });
        }
        checked++;
        await advanceBlame(state, source, { ...SLICE, maxSteps: 1 });
      }
      expect(checked).toBeGreaterThan(1);
    },
  );

  it("starts a file whose state fits its room exactly, and not one byte less", async () => {
    const source = new FakeSource({ a: { file: f("x", "y", "z") } });
    const live = liveStateBytes(await start(source, "a"));
    expect(
      "failure" in (await startBlame(source, oidOfName("a"), PATH, { maxLiveStateBytes: live })),
    ).toBe(false);
    expect(await startBlame(source, oidOfName("a"), PATH, { maxLiveStateBytes: live - 1 })).toEqual(
      {
        failure: "state_too_large",
      },
    );
  });

  it("a flagged state derives its unsettled lines around the ranges that settled", async () => {
    const source = new FakeSource({
      a: { file: f("x", "y") },
      b: { parents: ["a"], file: f("x", "own", "y", "own2") },
    });
    const state = await start(source, "b");
    await advanceBlame(state, source, { ...SLICE, maxSteps: 1 });
    // b's own lines settled; a's pending. Now a step that can't fit.
    expect(answer(source, state)).toEqual(["?", "b@2", "?", "b@4"]);
    state.stateLimit = true;
    state.queue = [];
    expect(
      blameRanges(state, 0, 10).map((r) => [r.startLine, r.lineCount, "unresolved" in r]),
    ).toEqual([
      [2, 1, false],
      [4, 1, false],
      [1, 1, true],
      [3, 1, true],
    ]);
    expect(blameRanges(state, 3, 1).map((r) => r.startLine)).toEqual([3]);
  });
});

/** A source whose commit facts carry one long field for one commit. */
class LongFieldSource extends FakeSource {
  constructor(
    history: History,
    readonly long: { commit: string; field: keyof BlameCommitInfo; text: string },
  ) {
    super(history);
  }
  override async commitInfo(oid: Oid): Promise<BlameCommitInfo> {
    const info = await super.commitInfo(oid);
    if (this.names.get(oidToHex(oid)) !== this.long.commit) return info;
    return { ...info, [this.long.field]: this.long.text };
  }
}

describe("a commit fact too long for a checkpoint", () => {
  const history: History = { a: { file: f("x") }, b: { parents: ["a"], file: f("x", "y") } };
  const fields = ["summary", "name", "email", "date"] as const;

  it.each(fields)("settles a %s of 65,535 bytes", async (field) => {
    const source = new LongFieldSource(history, { commit: "b", field, text: "s".repeat(0xffff) });
    const state = await finished(source, "b");
    expect(answer(source, state)).toEqual(["a@1", "b@2"]);
    expect(decodeBlameState(encodeBlameState(state)).facts).toEqual(state.facts);
  });

  it.each(fields)("refuses the commit's own lines for a %s of 65,536 bytes", async (field) => {
    const source = new LongFieldSource(history, { commit: "b", field, text: "s".repeat(0x10000) });
    const state = await finished(source, "b");
    expect(answer(source, state)).toEqual(["a@1", "commit_info_too_large"]);
    expect(state.factOrder.map((oid) => source.names.get(oidToHex(oid)))).toEqual(["a"]);
    expect(decodeBlameState(encodeBlameState(state)).ranges).toEqual(
      state.ranges.subarray(0, 4 * state.rangeCount),
    );
  });

  it("counts the field's UTF-8 bytes, not its characters", async () => {
    const text = "\u00e9".repeat(0x8000);
    const source = new LongFieldSource(history, { commit: "b", field: "name", text });
    expect(answer(source, await finished(source, "b"))).toEqual(["a@1", "commit_info_too_large"]);
  });
});

describe("the walk's errors", () => {
  it("name themselves, as logs show them", () => {
    expect(new BlameReadsSpent("x").name).toBe("BlameReadsSpent");
    expect(new BlameObjectUnreadable("x").name).toBe("BlameObjectUnreadable");
  });
});

describe("where git might follow a rename", () => {
  const blameOf = async (history: History, tip: string, slice = SLICE) => {
    const source = new FakeSource(history);
    return answer(source, await finished(source, tip, slice));
  };
  const body = f("a", "b", "c");

  it("a path new in a commit that removes another: every line refused", async () => {
    expect(
      await blameOf({ a: { others: { g: body } }, b: { parents: ["a"], file: body } }, "b"),
    ).toEqual(new Array(3).fill("rename_possible"));
  });

  it("removed anywhere, even unlike the file: refused, as git can't be ruled out", async () => {
    expect(
      await blameOf(
        {
          a: { others: { "d/e/other": f("q") } },
          b: { parents: ["a"], file: body, others: { "d/e/kept": f("k") } },
        },
        "b",
      ),
    ).toEqual(new Array(3).fill("rename_possible"));
  });

  it("a path new where nothing was removed: the commit's own, as before", async () => {
    expect(
      await blameOf(
        { a: { others: { g: body } }, b: { parents: ["a"], file: body, others: { g: body } } },
        "b",
      ),
    ).toEqual(["b@1", "b@2", "b@3"]);
  });

  it("a directory at the path in the parent counts as no file there", async () => {
    expect(
      await blameOf({ a: { others: { "f/inner": body } }, b: { parents: ["a"], file: body } }, "b"),
    ).toEqual(new Array(3).fill("rename_possible"));
  });

  it("a merge: a parent with the file first keeps its lines; the rest stop at the rename's parent", async () => {
    expect(
      await blameOf(
        {
          p1: { file: f("a", "b", "x") },
          p2: { others: { g: f("z") } },
          m: { parents: ["p1", "p2"], file: f("a", "b", "c") },
        },
        "m",
      ),
    ).toEqual(["p1@1", "p1@2", "rename_possible"]);
  });

  it("a merge: an identical copy removed by a later parent, inside a removed directory, takes every line", async () => {
    expect(
      await blameOf(
        {
          p1: { file: f("a", "b", "x") },
          p2: { others: { "gone/g": f("a", "b", "c") } },
          m: { parents: ["p1", "p2"], file: f("a", "b", "c") },
        },
        "m",
      ),
    ).toEqual(new Array(3).fill("rename_possible"));
  });

  it("a merge: a parent with the identical file wins over an earlier parent's removed copy", async () => {
    expect(
      await blameOf(
        {
          p1: { others: { g: body } },
          p2: { file: body },
          m: { parents: ["p1", "p2"], file: body },
        },
        "m",
      ),
    ).toEqual(["p2@1", "p2@2", "p2@3"]);
  });

  it("a merge: the rename's parent first refuses everything, even what a later parent has", async () => {
    expect(
      await blameOf(
        {
          p1: { others: { g: f("z") } },
          p2: { file: f("a", "b", "x") },
          m: { parents: ["p1", "p2"], file: f("a", "b", "c") },
        },
        "m",
      ),
    ).toEqual(new Array(3).fill("rename_possible"));
  });

  it("a merge: absent in every parent, and none removes anything: the merge's own", async () => {
    expect(
      await blameOf(
        {
          p1: { others: { y: f("y") } },
          p2: {},
          m: { parents: ["p1", "p2"], file: body, others: { y: f("y") } },
        },
        "m",
      ),
    ).toEqual(["m@1", "m@2", "m@3"]);
  });

  it("a check the budget can't finish rules nothing out", async () => {
    const dirs = (side: string) =>
      Object.fromEntries(Array.from({ length: 130 }, (_, k) => [`d${k}/x`, `${side}${k}\n`]));
    expect(
      await blameOf(
        { a: { others: dirs("a") }, b: { parents: ["a"], file: body, others: dirs("b") } },
        "b",
      ),
    ).toEqual(new Array(3).fill("rename_possible"));
    // The same history with fewer differing directories is checked to the end.
    const few = (side: string) =>
      Object.fromEntries(Array.from({ length: 100 }, (_, k) => [`d${k}/x`, `${side}${k}\n`]));
    expect(
      await blameOf(
        { a: { others: few("a") }, b: { parents: ["a"], file: body, others: few("b") } },
        "b",
      ),
    ).toEqual(["b@1", "b@2", "b@3"]);
  });

  it("a check that runs out of reads undoes the step, or refuses it when it began fresh", async () => {
    const history: History = { a: { others: { g: body } }, b: { parents: ["a"], file: body } };
    const source = new FakeSource(history);
    source.failOn = (reading) => {
      if (reading === "tree body") throw new BlameReadsSpent("spent");
    };
    const state = await start(source, "b");
    const before = encodeBlameState(state);
    const stale = await advanceBlame(state, source, { ...SLICE, stepIsFresh: () => false });
    expect(stale.stop).toBe("budget");
    expect(encodeBlameState(state)).toEqual(before);
    await advanceBlame(state, source, SLICE);
    expect(answer(source, state)).toEqual(new Array(3).fill("work_limit"));
  });

  it("a tree that doesn't parse is unreadable history", async () => {
    const history: History = { a: { others: { g: body } }, b: { parents: ["a"], file: body } };
    const source = new FakeSource(history);
    source.tree = async () => new TextEncoder().encode("100644 broken");
    expect(answer(source, await finished(source, "b"))).toEqual(
      new Array(3).fill("history_unreadable"),
    );
  });
});
