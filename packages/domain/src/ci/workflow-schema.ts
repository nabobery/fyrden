/*
 * A workflow file as Fyrden understands it: the supported subset of GitHub
 * Actions syntax (`support-matrix.ts`), checked, with the position of
 * everything a later step may need to point at. Nothing here evaluates an
 * expression, expands a matrix or orders jobs; those read this model.
 *
 * Every key a user names (env and `with` names, outputs, services, inputs,
 * matrix dimensions) is kept in an ordered list of pairs, never as a
 * property of a plain object, so `__proto__` and friends are only data.
 */

/** Where something is in the file: line and column from 1, the column in code points. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** A string as written. It may hold `${{ }}` expressions, interpolated later. */
export interface Text {
  readonly value: string;
  readonly at: Position;
}

/** A field GitHub lets an expression fill: a literal, or a string holding `${{ }}`, evaluated later. */
export type Valued<T> =
  | { readonly kind: "literal"; readonly value: T; readonly at: Position }
  | { readonly kind: "expression"; readonly source: string; readonly at: Position };

/** An `if:` as written (`${{ }}` around it optional); `true` and `false` as their text. */
export interface Condition {
  readonly source: string;
  readonly at: Position;
}

/** A scalar: its value, its text (`1.0`, `0x10`, a block scalar's decoded text) and position. */
export interface ScalarValue {
  readonly kind: "scalar";
  readonly value: string | number | boolean | null;
  readonly source: string;
  readonly at: Position;
}

/** Any YAML value, positioned all the way down; mappings are ordered pairs. */
export type Value =
  | ScalarValue
  | { readonly kind: "sequence"; readonly items: readonly Value[]; readonly at: Position }
  | {
      readonly kind: "mapping";
      readonly entries: readonly (readonly [Text, Value])[];
      readonly at: Position;
    };

/** Names and values in source order: env, `with`, outputs. A null value is the empty string. */
export type Pairs = readonly (readonly [Text, Text])[];

/** Patterns that include, or (`-ignore`) exclude; GitHub allows one of the two per filter. */
export interface Filter {
  readonly mode: "include" | "ignore";
  readonly patterns: readonly Text[];
  readonly at: Position;
}

export interface PushTrigger {
  readonly event: "push";
  readonly at: Position;
  readonly branches?: Filter;
  readonly tags?: Filter;
  readonly paths?: Filter;
}

export interface PullRequestTrigger {
  readonly event: "pull_request" | "pull_request_target";
  readonly at: Position;
  readonly types?: readonly Text[];
  readonly branches?: Filter;
  readonly paths?: Filter;
}

export interface ScheduleTrigger {
  readonly event: "schedule";
  readonly at: Position;
  /** Five-field cron lines; their meaning is the trigger code's. */
  readonly crons: readonly Text[];
}

export type DispatchInputType = "string" | "boolean" | "choice" | "number";

export interface DispatchInput {
  readonly id: Text;
  readonly description?: Text;
  readonly required: boolean;
  readonly default?: ScalarValue;
  readonly type: DispatchInputType;
  readonly options: readonly Text[];
}

export interface DispatchTrigger {
  readonly event: "workflow_dispatch";
  readonly at: Position;
  readonly inputs: readonly DispatchInput[];
}

export type Trigger = PushTrigger | PullRequestTrigger | ScheduleTrigger | DispatchTrigger;

/** The permission scopes a job token can carry in Fyrden. */
export const PERMISSION_SCOPES = [
  "actions",
  "checks",
  "contents",
  "issues",
  "pull-requests",
  "statuses",
] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/**
 * `read-all`, `write-all`, or scopes (`{}` is no scopes). Scopes given as
 * `none`, and scopes Fyrden has no capability for set to `none`, are left
 * out: an unlisted scope is `none`.
 */
export type Permissions =
  | { readonly kind: "all"; readonly access: "read" | "write"; readonly at: Position }
  | {
      readonly kind: "scopes";
      readonly scopes: readonly {
        readonly scope: PermissionScope;
        readonly access: "read" | "write";
        readonly at: Position;
      }[];
      readonly at: Position;
    };

export interface Concurrency {
  readonly group: Text;
  readonly cancelInProgress?: Valued<boolean>;
  readonly at: Position;
}

export interface RunDefaults {
  readonly shell?: Text;
  readonly workingDirectory?: Text;
}

export interface Credentials {
  readonly username: Text;
  readonly password: Text;
}

export interface Container {
  readonly image: Text;
  readonly credentials?: Credentials;
  readonly env: Pairs;
  /** As written: `5432:5432`, `80`. */
  readonly ports: readonly Text[];
  readonly volumes: readonly Text[];
  readonly options?: Text;
  readonly at: Position;
}

export interface Service extends Container {
  readonly id: Text;
}

export interface Matrix {
  /** Every key but `include` and `exclude`, in source order. */
  readonly dimensions: readonly {
    readonly name: Text;
    readonly values: Valued<readonly Value[]>;
  }[];
  /** Each item a mapping. */
  readonly include?: Valued<readonly Value[]>;
  readonly exclude?: Valued<readonly Value[]>;
}

export interface Strategy {
  readonly matrix?: Valued<Matrix>;
  readonly failFast?: Valued<boolean>;
  readonly maxParallel?: Valued<number>;
}

interface StepCommon {
  readonly at: Position;
  readonly id?: Text;
  readonly name?: Text;
  readonly if?: Condition;
  readonly env: Pairs;
  readonly continueOnError?: Valued<boolean>;
  readonly timeoutMinutes?: Valued<number>;
}

export interface RunStep extends StepCommon {
  readonly kind: "run";
  readonly run: Text;
  readonly shell?: Text;
  readonly workingDirectory?: Text;
}

export interface UsesStep extends StepCommon {
  readonly kind: "uses";
  /** `owner/repo[/path]@ref`, `./path` or `docker://image`. */
  readonly uses: Text;
  readonly with: Pairs;
}

export type Step = RunStep | UsesStep;

export interface Job {
  readonly id: Text;
  readonly name?: Text;
  /** Labels a runner must all have; an expression may produce them. */
  readonly runsOn: Valued<readonly Text[]>;
  readonly needs: readonly Text[];
  readonly if?: Condition;
  readonly permissions?: Permissions;
  readonly strategy?: Strategy;
  readonly env: Pairs;
  readonly defaults?: RunDefaults;
  readonly timeoutMinutes?: Valued<number>;
  readonly continueOnError?: Valued<boolean>;
  readonly outputs: Pairs;
  readonly services: readonly Service[];
  readonly container?: Container;
  readonly concurrency?: Concurrency;
  readonly steps: readonly Step[];
}

export interface Workflow {
  /** From the repository root. */
  readonly path: string;
  readonly name?: Text;
  readonly runName?: Text;
  /** In source order. */
  readonly on: readonly Trigger[];
  readonly permissions?: Permissions;
  readonly env: Pairs;
  readonly defaults?: RunDefaults;
  readonly concurrency?: Concurrency;
  /** In source order; ids unique. */
  readonly jobs: readonly Job[];
}

export type WorkflowErrorCode =
  | "unknown_key"
  | "unsupported_key"
  | "unsupported_value"
  | "invalid_type"
  | "invalid_value"
  | "missing_key"
  | "duplicate_key"
  | "yaml_syntax"
  | "yaml_too_complex"
  | "multiple_documents"
  | "invalid_encoding"
  | "file_too_large"
  | "limit_exceeded"
  | "unknown_job"
  | "dependency_cycle"
  | "too_many_errors"
  | "expression_syntax"
  | "unknown_context"
  | "unknown_function"
  | "context_not_available"
  | "function_not_available"
  | "expression_not_allowed"
  | "expression_failed"
  | "condition_not_single_expression";

/** Why a workflow file cannot run, naming the key or value. */
export interface WorkflowError {
  readonly code: WorkflowErrorCode;
  /** The feature as the support matrix names it, such as `jobs.<job_id>.environment`. */
  readonly feature: string;
  /** Where in this file, such as `jobs.deploy.environment`; empty for the file as a whole. */
  readonly path: string;
  /** From 1; 0 for the file as a whole. */
  readonly line: number;
  /** From 1, in code points; 0 for the file as a whole. */
  readonly column: number;
  readonly message: string;
}

export type ParsedWorkflow =
  | { readonly ok: true; readonly workflow: Workflow }
  | { readonly ok: false; readonly errors: readonly WorkflowError[] };

/** GitHub's limit: "500 KB or smaller to trigger a run", read as decimal. */
export const MAX_WORKFLOW_BYTES = 500_000;
/** Nodes the parser may visit, an alias's target counted at each use. Proposed. */
export const MAX_WORKFLOW_NODES = 50_000;
/** Collections nested in one another. Proposed. */
export const MAX_YAML_DEPTH = 64;
/** Errors one file reports; one more says there were more. Proposed. */
export const MAX_WORKFLOW_ERRORS = 100;
/** Jobs before matrix expansion. Proposed (GitHub's matrix cap per run is 256). */
export const MAX_JOBS = 256;
/** Steps in one job. Proposed. */
export const MAX_STEPS = 1_000;
/** GitHub's limit on `workflow_dispatch` inputs. */
export const MAX_DISPATCH_INPUTS = 25;
