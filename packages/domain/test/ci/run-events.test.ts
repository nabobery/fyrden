import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  JOB_ACTIONS,
  type JobAction,
  jobMoves,
  jobsDoneTo,
  runMoves,
} from "../../src/ci/run-events.js";
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

describe("what a report tells of a run's jobs", () => {
  const none = { done: 0, live: {} };
  const told = (states: Record<number, JobAction>, from = none as Parameters<typeof jobMoves>[0]) =>
    jobMoves(
      from,
      Object.entries(states).map(([id, action]) => ({ jobId: Number(id), action })),
    );

  it("is each job's latest state, once", () => {
    const first = told({ 1: "queued", 2: "completed" });
    expect(first).toEqual({
      told: { done: 0, live: { 1: "queued", 2: "completed" } },
      moves: [
        { jobId: 1, action: "queued" },
        { jobId: 2, action: "completed" },
      ],
    });
    const second = told({ 1: "completed", 2: "completed" }, first.told);
    expect(second).toEqual({
      told: { done: 2, live: {} },
      moves: [{ jobId: 1, action: "completed" }],
    });
    expect(told({ 1: "queued", 2: "completed" }, second.told)).toEqual({
      told: second.told,
      moves: [],
    });
  });

  it("is nothing for a job taken back from its runner", () => {
    const running = told({ 1: "in_progress" }).told;
    expect(told({ 1: "queued" }, running).moves).toEqual([]);
    expect(told({ 1: "in_progress" }, running).moves).toEqual([]);
  });

  it("keeps the jobs past one not told complete, reported or not", () => {
    expect(told({ 2: "completed", 3: "completed" }).told).toEqual({
      done: 0,
      live: { 2: "completed", 3: "completed" },
    });
    expect(told({ 1: "completed" }, { done: 0, live: { 2: "completed", 4: "queued" } })).toEqual({
      told: { done: 2, live: { 4: "queued" } },
      moves: [{ jobId: 1, action: "completed" }],
    });
  });

  it("takes on ends known elsewhere, and never goes back", () => {
    const at = { done: 1, live: { 3: "queued", 4: "completed", 6: "completed" } } as const;
    expect(jobsDoneTo(at, 0)).toEqual(at);
    expect(jobsDoneTo(at, 3)).toEqual({ done: 4, live: { 6: "completed" } });
    expect(jobsDoneTo(at, 9)).toEqual({ done: 9, live: {} });
  });

  it("is every end once, whichever reports arrive, in whatever order", () => {
    const job = fc.record({
      jobId: fc.integer({ min: 1, max: 12 }),
      action: fc.constantFrom(...JOB_ACTIONS),
    });
    const report = fc.uniqueArray(job, { maxLength: 12, selector: (j) => j.jobId });
    fc.assert(
      fc.property(fc.array(report, { maxLength: 20 }), (reports) => {
        let state: Parameters<typeof jobMoves>[0] = none;
        const all: string[] = [];
        const ended = new Set<number>();
        for (const jobs of reports) {
          const step = jobMoves(state, jobs);
          expect(step.told.done).toBeGreaterThanOrEqual(state.done);
          expect(jobMoves(step.told, jobs).moves).toEqual([]);
          state = step.told;
          all.push(...step.moves.map((m) => `${m.jobId}:${m.action}`));
          for (const j of jobs) if (j.action === "completed") ended.add(j.jobId);
        }
        expect(new Set(all).size).toBe(all.length);
        for (let id = 1; id <= 12; id++)
          expect(all.includes(`${id}:completed`)).toBe(ended.has(id));
        for (let id = 1; id <= state.done; id++) expect(ended.has(id)).toBe(true);
        expect(ended.has(state.done + 1)).toBe(false);
      }),
    );
  });
});
