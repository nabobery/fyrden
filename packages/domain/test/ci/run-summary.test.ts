// A run's order as its repository records it: every change a list shows moves
// it forward, whatever legal sequence of events drives the run; and the facts
// read from a run's context, whose shape nothing promises.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type AttemptEvent, type AttemptState, advanceAttempt } from "../../src/ci/run-state.js";
import {
  MAX_RUN_TITLE_LENGTH,
  RUN_PHASES,
  runFacts,
  runPhase,
  runStateSeq,
} from "../../src/ci/run-summary.js";

/** U+FFFD, what a character that is not shown becomes. */
const REPLACED = String.fromCharCode(0xfffd);

describe("a run's order", () => {
  it("puts every phase of an attempt before every phase of the next", () => {
    const seqs = [1, 2, 51].flatMap((attempt) =>
      RUN_PHASES.map((phase) => runStateSeq(attempt, phase)),
    );
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.min(...seqs)).toBeGreaterThan(0);
  });

  it("names the phase a run waiting for approval is in, until its attempt completes", () => {
    expect(runPhase("queued", true)).toBe("waiting");
    expect(runPhase("queued", false)).toBe("queued");
    expect(runPhase("completed", true)).toBe("completed");
    expect(runPhase("in_progress", false)).toBe("in_progress");
  });

  // The steps a run takes: attempts through the domain's own rules, an approval that only
  // leaves `waiting` (an ended one completes the attempt with it), a re-run of a completed one.
  const events: fc.Arbitrary<AttemptEvent | { kind: "approve" } | { kind: "rerun" }> = fc.oneof(
    fc.constantFrom<AttemptEvent | { kind: "approve" } | { kind: "rerun" }>(
      { kind: "approve" },
      { kind: "rerun" },
      { kind: "admitted" },
      { kind: "pending" },
      { kind: "displaced" },
      { kind: "plan_failed" },
      { kind: "cancel", mode: "graceful" },
      { kind: "cancel", mode: "force" },
      { kind: "finished", conclusion: "success" },
      { kind: "finished", conclusion: "failure" },
    ),
  );

  it("never goes back, and moves whenever what a list shows does", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.array(events, { maxLength: 40 }), (held, steps) => {
        let waiting = held;
        let attempt = 1;
        let state: AttemptState = { status: "queued", conclusion: null, cancel: "none" };
        const seen = () => ({
          seq: runStateSeq(attempt, runPhase(state.status, waiting)),
          shown: JSON.stringify([attempt, runPhase(state.status, waiting), state.conclusion]),
        });
        let before = seen();
        for (const step of steps) {
          if (step.kind === "approve") waiting = false;
          else if (step.kind === "rerun") {
            if (state.status !== "completed" || waiting) continue;
            attempt++;
            state = { status: "queued", conclusion: null, cancel: "none" };
          } else {
            // A held run admits nothing: only an end reaches it.
            if (waiting && (step.kind === "admitted" || step.kind === "pending")) continue;
            const next = advanceAttempt(state, step);
            if (!next.ok) continue;
            state = next.state;
            if (state.status === "completed") waiting = false;
          }
          const after = seen();
          expect(after.seq).toBeGreaterThanOrEqual(before.seq);
          expect(after.seq === before.seq).toBe(after.shown === before.shown);
          before = after;
        }
      }),
    );
  });
});

describe("a run's facts", () => {
  const run = {
    event: "push",
    ref: "refs/heads/main",
    workflowPath: ".github/workflows/ci.yml",
  };
  const push = {
    run_number: "7",
    workflow: "CI",
    head_ref: "",
    event: { head_commit: { message: "Fix the parser\n\nDetails." } },
  };

  it("reads a push: its number, workflow, commit headline and branch", () => {
    expect(runFacts(push, run)).toEqual({
      runNumber: 7,
      name: "CI",
      title: "Fix the parser",
      headBranch: "main",
      pullNumber: null,
    });
  });

  it("reads a pull request event: its title, number and head branch, on either trigger", () => {
    const pull = {
      run_number: "3",
      workflow: "CI",
      head_ref: "feature/x",
      event: { number: 12, pull_request: { number: 12, title: "Add x" } },
    };
    for (const [event, ref] of [
      ["pull_request", "refs/pull/12/head"],
      ["pull_request_target", "refs/heads/main"],
    ] as const)
      expect(runFacts(pull, { ...run, event, ref })).toEqual({
        runNumber: 3,
        name: "CI",
        title: "Add x",
        headBranch: "feature/x",
        pullNumber: 12,
      });
  });

  it("titles a run by its evaluated run-name, and any other event by its workflow", () => {
    expect(runFacts(push, { ...run, runName: "  Deploy 1.2 to prod " }).title).toBe(
      "Deploy 1.2 to prod",
    );
    expect(runFacts(push, { ...run, runName: " " }).title).toBe("Fix the parser");
    expect(runFacts({ workflow: "Nightly" }, { ...run, event: "schedule" }).title).toBe("Nightly");
  });

  it("has no branch for a tag, nor a number for a context without one", () => {
    expect(runFacts(push, { ...run, ref: "refs/tags/v1" }).headBranch).toBeNull();
    for (const github of [undefined, null, "x", 3, [], { run_number: "1e3" }, { run_number: -1 }])
      expect(runFacts(github, run)).toEqual({
        runNumber: null,
        name: ".github/workflows/ci.yml",
        title: ".github/workflows/ci.yml",
        headBranch: "main",
        pullNumber: null,
      });
  });

  it("bounds and cleans what it shows, whatever the context holds", () => {
    const title = runFacts(
      {
        event: {
          head_commit: {
            message: `a${String.fromCharCode(0)}b${String.fromCharCode(0xd800)}${"🙂".repeat(1_000)}`,
          },
        },
      },
      run,
    ).title;
    expect([...title]).toHaveLength(MAX_RUN_TITLE_LENGTH);
    expect(title.startsWith(`a${REPLACED}b${REPLACED}🙂`)).toBe(true);
    fc.assert(
      fc.property(fc.jsonValue(), (github) => {
        const facts = runFacts(github, run);
        for (const text of [facts.name, facts.title]) {
          expect([...text].length).toBeLessThanOrEqual(MAX_RUN_TITLE_LENGTH);
          expect(text).not.toBe("");
          expect(text.isWellFormed()).toBe(true);
        }
        expect(facts.runNumber === null || Number.isSafeInteger(facts.runNumber)).toBe(true);
      }),
    );
  });
});
