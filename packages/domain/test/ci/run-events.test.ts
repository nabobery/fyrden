import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { runMoves } from "../../src/ci/run-events.js";
import { RUN_PHASES, type RunPhase, runStateSeq } from "../../src/ci/run-summary.js";

const moves = (told: number, attempt: number, phase: RunPhase, earlier: number[] = []) =>
  runMoves(told, { attempt, phase }, earlier).moves.map((m) => `${m.attempt}:${m.action}`);

describe("what a report tells of a run", () => {
  it("is requested once, before whatever the first report already shows", () => {
    expect(moves(0, 1, "waiting")).toEqual(["1:requested"]);
    expect(moves(0, 1, "queued")).toEqual(["1:requested"]);
    expect(moves(0, 1, "pending")).toEqual(["1:requested"]);
    expect(moves(0, 1, "in_progress")).toEqual(["1:requested", "1:in_progress"]);
    expect(moves(0, 1, "completed")).toEqual(["1:requested", "1:completed"]);
  });

  it("is not requested again for a re-run", () => {
    const told = runStateSeq(1, "completed");
    expect(moves(told, 2, "queued", [1])).toEqual([]);
    expect(moves(told, 2, "in_progress", [1])).toEqual(["2:in_progress"]);
  });

  it("is each phase after the one told", () => {
    const at = (phase: RunPhase) => runStateSeq(1, phase);
    expect(moves(at("waiting"), 1, "queued")).toEqual([]);
    expect(moves(at("queued"), 1, "in_progress")).toEqual(["1:in_progress"]);
    expect(moves(at("queued"), 1, "completed")).toEqual(["1:completed"]);
    expect(moves(at("completed"), 1, "in_progress")).toEqual([]);
    expect(moves(at("completed"), 1, "completed")).toEqual([]);
  });

  it("is every earlier attempt's end not told yet, oldest first", () => {
    expect(moves(runStateSeq(1, "in_progress"), 4, "in_progress", [1, 2, 3])).toEqual([
      "1:completed",
      "2:completed",
      "3:completed",
      "4:in_progress",
    ]);
    expect(moves(0, 2, "in_progress", [1])).toEqual([
      "1:requested",
      "1:completed",
      "2:in_progress",
    ]);
  });

  it("is each end once and the request once, whichever reports arrive, repeated and late ones too", () => {
    const state = fc.record({
      attempt: fc.integer({ min: 1, max: 6 }),
      phase: fc.constantFrom(...RUN_PHASES),
    });
    fc.assert(
      fc.property(fc.array(state, { minLength: 1, maxLength: 30 }), (reports) => {
        let told = 0;
        const all: string[] = [];
        for (const report of reports) {
          const earlier = Array.from({ length: report.attempt - 1 }, (_, i) => i + 1);
          const step = runMoves(told, report, earlier);
          expect(step.told).toBeGreaterThanOrEqual(told);
          told = step.told;
          all.push(...step.moves.map((m) => `${m.attempt}:${m.action}`));
          expect(runMoves(told, report, earlier).moves).toEqual([]);
        }
        expect(new Set(all).size).toBe(all.length);
        expect(all.filter((m) => m.endsWith(":requested"))).toHaveLength(1);
        const last = Math.floor(told / 100);
        for (let attempt = 1; attempt < last; attempt++)
          expect(all).toContain(`${attempt}:completed`);
      }),
    );
  });
});
