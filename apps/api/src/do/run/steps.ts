import type { Step, Text } from "@fyrden/domain/ci";
import { Result, StepStage, type StepState, type Timestamp } from "../../runner/proto/messages.js";

/* Only numbers are kept of a runner's report: names come from the workflow file, so no evaluated text is stored. */

/** Its setup, pre and post steps included. Proposed. */
export const MAX_JOB_STEPS = 256;
/** A step's name is cut to this many UTF-16 units: a page of jobs stays within an RPC answer. Proposed. */
export const MAX_NAME_UNITS = 200;

const STAGES = {
  [StepStage.SETUP]: "setup",
  [StepStage.INIT_CONTAINERS]: "containers",
  [StepStage.PRE]: "pre",
  [StepStage.MAIN]: "main",
  [StepStage.POST]: "post",
  [StepStage.CLEANUP]: "cleanup",
} as const;
type StepStageName = (typeof STAGES)[keyof typeof STAGES];

const RESULTS = {
  [Result.SUCCESS]: "success",
  [Result.FAILURE]: "failure",
  [Result.CANCELLED]: "cancelled",
  [Result.SKIPPED]: "skipped",
} as const;
export type StepConclusion = (typeof RESULTS)[keyof typeof RESULTS];

/** As stored: stage, number, result, start, stop (Unix ms, 0 for none), first log row, log rows. */
type StoredStep = readonly [number, number, number, number, number, number, number];

export interface JobStep {
  readonly number: number;
  readonly name: string;
  readonly stage: StepStageName;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: StepConclusion | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly log: { readonly from: number; readonly rows: number } | null;
}

const count = (n: number) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);

function ms(at: Timestamp | undefined): number {
  return at ? count(at.seconds * 1000 + Math.floor(at.nanos / 1_000_000)) : 0;
}

export function storedSteps(state: {
  readonly steps: readonly StepState[];
  readonly reportedSteps: readonly StepState[];
}): string | null {
  // A runner that reports stages (gitea/runner 5.4.1 and 6.0.0 do, measured) sends them in
  // `reportedSteps`; an older one only the workflow's steps, by index
  // (https://gitea.com/gitea/runner/src/tag/v6.0.0/internal/pkg/report/reporter.go).
  const all = state.reportedSteps.some((step) => step.stage in STAGES);
  const steps = all ? state.reportedSteps.filter((step) => step.stage in STAGES) : state.steps;
  if (steps.length === 0) return null;
  return JSON.stringify(
    steps
      .slice(0, MAX_JOB_STEPS)
      .map(
        (step): StoredStep => [
          all ? step.stage : StepStage.MAIN,
          count(all ? step.number : step.id),
          count(step.result),
          ms(step.startedAt),
          ms(step.stoppedAt),
          count(step.logIndex),
          count(step.logLength),
        ],
      ),
  );
}

/** A step left without a result by a job that ended was cancelled if it had started, else skipped. */
export function jobSteps(
  stored: string | null,
  written: readonly Step[],
  ended: boolean,
): JobStep[] {
  if (stored === null) return [];
  return (JSON.parse(stored) as StoredStep[]).map(
    ([stage, number, result, startedAt, stoppedAt, from, rows], k) => {
      const reported = RESULTS[result as keyof typeof RESULTS] ?? null;
      const left = ended ? (startedAt > 0 ? "cancelled" : "skipped") : null;
      const conclusion = reported ?? left;
      return {
        number: k + 1,
        name: nameOf(stage, written[number]),
        stage: STAGES[stage as keyof typeof STAGES],
        status: conclusion !== null ? "completed" : startedAt > 0 ? "in_progress" : "queued",
        conclusion,
        startedAt: startedAt || null,
        completedAt: stoppedAt || null,
        log: rows > 0 ? { from, rows } : null,
      };
    },
  );
}

function nameOf(stage: number, step: Step | undefined): string {
  switch (stage) {
    case StepStage.SETUP:
      return "Set up job";
    case StepStage.INIT_CONTAINERS:
      return "Initialize containers";
    case StepStage.CLEANUP:
      return "Complete job";
  }
  const name = (step ? writtenName(step) : "Step").slice(0, MAX_NAME_UNITS);
  return stage === StepStage.PRE ? `Pre ${name}` : stage === StepStage.POST ? `Post ${name}` : name;
}

function writtenName(step: Step): string {
  if (step.name) return step.name.value;
  const text: Text = step.kind === "run" ? step.run : step.uses;
  return `Run ${text.value.trim().split("\n", 1)[0] ?? ""}`;
}
