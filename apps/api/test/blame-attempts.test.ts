// The attempt policy: what an attempt on one checkpoint may do, and how a
// ledger counts attempts. RepoBlame applies them (blame.attempts.test.ts).
import { type BlameSliceLimits, DEFAULT_BLAME_SLICE } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import { MemoryAttemptLedger, sliceAttempt } from "../src/do/repo/blame-attempts.js";

const LIMITS: BlameSliceLimits = { ...DEFAULT_BLAME_SLICE, stepIsFresh: () => true };

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
