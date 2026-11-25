import type { AttemptStatus } from "./run-state.js";

/*
 * What a run's repository keeps of it, to list runs without asking each: the
 * facts its trigger fixed, and where its current attempt stands, in an order
 * the run's own state gives. Nothing here reads a clock or storage.
 */

/**
 * Where a run's current attempt stands. `waiting`: for a maintainer's
 * approval, which shows as GitHub shows it (completed, its action required).
 */
export const RUN_PHASES = ["waiting", "queued", "pending", "in_progress", "completed"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

/**
 * Room is left between phases, so one added later needs no other renumbered:
 * objects of two versions must agree on the order of what both know.
 */
const PHASE_ORDER: Readonly<Record<RunPhase, number>> = {
  waiting: 10,
  queued: 20,
  pending: 30,
  in_progress: 40,
  completed: 90,
};
const ATTEMPT_ORDER = 100;

/** The phase of an attempt of `status` whose run's approval is (`waiting`) undecided or not. */
export function runPhase(status: AttemptStatus, waiting: boolean): RunPhase {
  return waiting && status !== "completed" ? "waiting" : status;
}

/**
 * The order of a run's states: an attempt only moves forward through the
 * phases, an approval only leaves `waiting`, and a re-run is a later
 * attempt. A state reported late or twice is therefore never after the one
 * it would replace.
 */
export function runStateSeq(attempt: number, phase: RunPhase): number {
  return attempt * ATTEMPT_ORDER + PHASE_ORDER[phase];
}

/** What a run's trigger fixed about it, as a list shows it. */
export interface RunFacts {
  /** The workflow's run number; null for a run whose context has none. */
  readonly runNumber: number | null;
  /** The workflow's name, else its file's path. */
  readonly name: string;
  readonly title: string;
  /** The branch it runs for: a pull request's head branch, or a branch ref's; null for a tag. */
  readonly headBranch: string | null;
  readonly pullNumber: number | null;
}

/** Code points a run's title or workflow name is cut to. Proposed. */
export const MAX_RUN_TITLE_LENGTH = 256;

/** Longest branch kept, in UTF-16 units: a run's ref has the same limit. */
const MAX_BRANCH_LENGTH = 1024;
const BRANCH = "refs/heads/";
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it replaces.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * A run's facts from its `github` context (any JSON: a run may be started
 * without one). The title is the evaluated `run-name`, else the pull
 * request's title, else the head commit's first line, else the workflow's
 * name.
 */
export function runFacts(
  github: unknown,
  run: {
    readonly event: string;
    readonly ref: string;
    readonly workflowPath: string;
    readonly runName?: string | undefined;
  },
): RunFacts {
  const event = field(github, "event");
  const pull = field(event, "pull_request");
  const isPull = run.event === "pull_request" || run.event === "pull_request_target";
  const name = shown(field(github, "workflow")) ?? shown(run.workflowPath) ?? "workflow";
  return {
    runNumber: positive(field(github, "run_number")),
    name,
    title:
      shown(run.runName) ??
      (isPull ? shown(field(pull, "title")) : undefined) ??
      shown(field(field(event, "head_commit"), "message")) ??
      name,
    headBranch: isPull
      ? branch(field(github, "head_ref"))
      : run.ref.startsWith(BRANCH)
        ? branch(run.ref.slice(BRANCH.length))
        : null,
    pullNumber: isPull ? positive(field(pull, "number") ?? field(event, "number")) : null,
  };
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function branch(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= MAX_BRANCH_LENGTH
    ? value
    : null;
}

/** A positive integer, as a number or as the decimal text a context holds. */
function positive(value: unknown): number | null {
  const n = typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A text's first line as a list shows it (`MAX_RUN_TITLE_LENGTH`); undefined for nothing to show. */
export function shown(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Cut by code units first: a commit message may be long, and a code point is at most two.
  const line = (value.trimStart().split(/[\r\n]/, 1)[0] ?? "").slice(0, 2 * MAX_RUN_TITLE_LENGTH);
  const clean = [...line.trimEnd().toWellFormed().replace(CONTROL, "�")]
    .slice(0, MAX_RUN_TITLE_LENGTH)
    .join("");
  return clean === "" ? undefined : clean;
}
