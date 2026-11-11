// A slice that dies, by a reset, the CPU limit or an eviction, leaves no
// answer and an unmoved checkpoint. The attempt mark survives it, so the next
// slice on that checkpoint runs one step only, and the one after refuses the
// step as step_lost: no step can be retried forever. A death is simulated
// here by beginning an attempt that never ends.
import {
  type BlameSliceLimits,
  type BlameSource,
  type BlameState,
  blameRanges,
  DEFAULT_BLAME_SLICE,
  type Oid,
  oidFromHex,
  oidToHex,
  startBlame,
} from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import {
  MemoryAttemptLedger,
  runSliceAttempt,
  sliceAttempt,
} from "../src/do/repo/blame-attempts.js";

const LIMITS: BlameSliceLimits = { ...DEFAULT_BLAME_SLICE, stepIsFresh: () => true };
const PATH = [new TextEncoder().encode("f")];
const oid = (n: number): Oid => oidFromHex(n.toString(16).padStart(40, "0"));

/** A line history c -> b -> a: each commit adds one line to f. */
function history(): { source: BlameSource; tip: Oid; name: (oid: Oid) => string } {
  const commits = new Map<string, { parents: Oid[]; file: string; name: string }>([
    [oidToHex(oid(1)), { parents: [], file: "a\n", name: "a" }],
    [oidToHex(oid(2)), { parents: [oid(1)], file: "a\nb\n", name: "b" }],
    [oidToHex(oid(3)), { parents: [oid(2)], file: "a\nb\nc\n", name: "c" }],
  ]);
  const at = (o: Oid) => commits.get(oidToHex(o));
  const source: BlameSource = {
    async commit(o) {
      const found = at(o);
      if (!found) return undefined;
      const generation = Number.parseInt(oidToHex(o), 16);
      return { tree: o, parents: found.parents, generation, level: generation };
    },
    async fileAt(tree) {
      return at(tree) ? { oid: tree, kind: "file" } : null;
    },
    async blob(o) {
      return new TextEncoder().encode(at(o)?.file ?? "");
    },
    async tree() {
      throw new Error("every commit has f, so no rename check reads a tree");
    },
    async commitInfo(o) {
      const name = at(o)?.name ?? "?";
      return { summary: name, name, email: `${name}@test`, date: "2026-01-01T00:00:00Z" };
    },
  };
  return { source, tip: oid(3), name: (o) => at(o)?.name ?? "?" };
}

async function started(): Promise<{
  state: BlameState;
  source: BlameSource;
  name: (o: Oid) => string;
}> {
  const { source, tip, name } = history();
  const state = await startBlame(source, tip, PATH);
  if ("failure" in state) throw new Error(state.failure);
  return { state, source, name };
}

/** Each line's commit name or reason, by line: ranges come in the order they settled. */
function answer(state: BlameState, name: (o: Oid) => string): string[] {
  const out = new Array<string>(state.lines).fill("?");
  for (const range of blameRanges(state, 0, Number.MAX_SAFE_INTEGER))
    out.fill(
      "unresolved" in range ? range.unresolved : name(range.commit),
      range.startLine - 1,
      range.startLine - 1 + range.lineCount,
    );
  return out;
}

describe("sliceAttempt", () => {
  it("runs a whole slice first, then one step, then refuses the step", () => {
    expect(sliceAttempt(1, LIMITS)).toEqual({ kind: "slice", limits: LIMITS });
    expect(sliceAttempt(2, LIMITS)).toEqual({ kind: "slice", limits: { ...LIMITS, maxSteps: 1 } });
    expect(sliceAttempt(3, LIMITS)).toEqual({ kind: "refuse" });
    expect(sliceAttempt(4, LIMITS)).toEqual({ kind: "refuse" });
  });
});

describe("MemoryAttemptLedger", () => {
  it("counts attempts at one generation, and starts again at a new one or after a clear", async () => {
    const ledger = new MemoryAttemptLedger();
    expect(await ledger.begin("r", 5)).toBe(1);
    expect(await ledger.begin("r", 5)).toBe(2);
    expect(await ledger.begin("other", 5)).toBe(1);
    expect(await ledger.begin("r", 6)).toBe(1);
    ledger.clear("r");
    expect(await ledger.begin("r", 6)).toBe(1);
  });
});

describe("runSliceAttempt", () => {
  it("runs a whole slice and clears its mark", async () => {
    const { state, source, name } = await started();
    const ledger = new MemoryAttemptLedger();
    const result = await runSliceAttempt({
      ledger,
      run: "r",
      generation: 1,
      state,
      source,
      limits: LIMITS,
    });
    expect(result).toMatchObject({ outcome: "advanced", advance: { stop: "done", steps: 3 } });
    expect(answer(state, name)).toEqual(["a", "b", "c"]);
    expect(await ledger.begin("r", 1)).toBe(1);
  });

  it("after one death on the checkpoint, runs one step only", async () => {
    const { state, source } = await started();
    const ledger = new MemoryAttemptLedger();
    await ledger.begin("r", 1);
    const result = await runSliceAttempt({
      ledger,
      run: "r",
      generation: 1,
      state,
      source,
      limits: LIMITS,
    });
    expect(result).toMatchObject({ outcome: "advanced", advance: { stop: "slice", steps: 1 } });
    expect(await ledger.begin("r", 1)).toBe(1);
  });

  it("after two, refuses the head step as step_lost, and the walk goes on", async () => {
    const { state, source, name } = await started();
    const ledger = new MemoryAttemptLedger();
    await ledger.begin("r", 1);
    await ledger.begin("r", 1);
    const steps = state.steps;
    const result = await runSliceAttempt({
      ledger,
      run: "r",
      generation: 1,
      state,
      source,
      limits: LIMITS,
    });
    expect(result).toEqual({ outcome: "refused" });
    expect(state.steps).toBe(steps + 1);
    expect(answer(state, name)).toEqual(["step_lost", "step_lost", "step_lost"]);
    expect(await ledger.begin("r", 2)).toBe(1);
  });

  it("counts deaths per checkpoint: a moved generation starts again", async () => {
    const { state, source } = await started();
    const ledger = new MemoryAttemptLedger();
    await ledger.begin("r", 1);
    await ledger.begin("r", 1);
    const result = await runSliceAttempt({
      ledger,
      run: "r",
      generation: 2,
      state,
      source,
      limits: LIMITS,
    });
    expect(result).toMatchObject({ outcome: "advanced", advance: { stop: "done" } });
  });

  it("clears its mark when the slice fails in a way it can report", async () => {
    const { state, source } = await started();
    const failing: BlameSource = {
      ...source,
      blob: async () => {
        throw new Error("storage unavailable");
      },
    };
    const ledger = new MemoryAttemptLedger();
    await expect(
      runSliceAttempt({ ledger, run: "r", generation: 1, state, source: failing, limits: LIMITS }),
    ).rejects.toThrow("storage unavailable");
    expect(await ledger.begin("r", 1)).toBe(1);
  });
});
