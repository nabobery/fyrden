import type { WORKFLOW_FEATURES, WorkflowErrorCode } from "@fyrden/domain/ci";

type Row = (typeof WORKFLOW_FEATURES)[number];
type SupportedRow = Extract<Row, { readonly status: "supported" }>;

/** One supported row of the support matrix: a key, or one value of a key. */
export type FeatureRef = SupportedRow extends infer R
  ? R extends { readonly feature: infer F; readonly value: infer V }
    ? { readonly feature: F; readonly value: V }
    : R extends { readonly feature: infer F }
      ? { readonly feature: F }
      : never
  : never;

/**
 * What a case shows about a feature. A runner case shows behaviour unless the entry is
 * `parse`, which says only that the parser accepts and models it, with the reason the
 * runner tier does not show more.
 */
export type Proof = FeatureRef | (FeatureRef & { readonly level: "parse"; readonly why: string });

/** As `actions.runs.get` reports a completed run (the driver checks the two agree). */
export type RunConclusion = "success" | "failure" | "cancelled" | "action_required";
/** As `actions.runs.jobs.list` reports a completed job. */
export type JobConclusion = "success" | "failure" | "cancelled" | "skipped" | "timed_out";

export type Tier = "parse" | "runner";

export interface ExpectedJob {
  readonly conclusion: JobConclusion;
  /** Workflow steps, by name, that ended in failure. */
  readonly failedSteps?: readonly string[];
  /** Lines the job's log must contain, and text it must never contain. */
  readonly log?: { readonly has?: readonly string[]; readonly never?: readonly string[] };
}

export interface CorpusCase {
  /** The workflow's file name without `.yml`, and its `name:`. */
  readonly id: string;
  readonly proves: readonly Proof[];
  readonly tiers: readonly Tier[];
  readonly trigger: "push" | "pull_request" | "workflow_dispatch";
  readonly setup?: {
    /** Repository secrets by name; each value is made per run, never written here. */
    readonly secrets?: readonly string[];
    readonly vars?: Readonly<Record<string, string>>;
    /** Files committed with the workflow, by path. */
    readonly files?: Readonly<Record<string, string>>;
    readonly inputs?: Readonly<Record<string, string>>;
  };
  /** How the runner tier runs it: its cache setting and its executable tasks, one runner run each. */
  readonly runner?: { readonly cache: "on" | "off"; readonly tasks: number };
  readonly expect: {
    readonly parse:
      | "ok"
      | {
          readonly errors: readonly {
            readonly code: WorkflowErrorCode;
            readonly feature: string;
          }[];
        };
    readonly plan?: {
      readonly jobs: readonly string[];
      readonly instances?: Readonly<
        Record<
          string,
          readonly { readonly name: string; readonly matrix: Readonly<Record<string, unknown>> }[]
        >
      >;
    };
    readonly run?: {
      readonly conclusion: RunConclusion;
      /** Jobs by the name `actions.runs.jobs.list` gives them. */
      readonly jobs: Readonly<Record<string, ExpectedJob>>;
      readonly displayTitle?: string;
      /** The run fails before any runner, with these errors. */
      readonly errors?: readonly { readonly code: string; readonly feature: string }[];
    };
  };
}

/** A supported row proven by an existing deterministic test rather than by a corpus case. */
export interface ElsewhereProof {
  readonly ref: FeatureRef;
  /** Repository-relative test files. */
  readonly tests: readonly string[];
  readonly why: string;
}
