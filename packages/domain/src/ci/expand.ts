/*
 * A run's jobs as instances. `planWorkflow` is the check at the start of a
 * run: the job graph, every matrix with no expression expanded, the run's
 * instance count, text the runner could not read, and each job's payload
 * size without its per-instance fields. A mistake it finds fails the run
 * before any job is dispatched.
 *
 * `expandJob` runs once per job, when the job is ready and its `if:` is
 * true: the strategy is evaluated once (its matrix may read a need's
 * outputs), then each combination's name, labels, timeout and
 * continue-on-error, with `matrix` and `strategy` in context. All of it is
 * charged to the scheduling step's work budget, the one the job's
 * condition was evaluated with.
 */
import { ErrorList } from "./error-list.js";
import { type ExpressionField, evaluateField, expressionFields } from "./expression-sites.js";
import { type ExprObject, type ExprValue, exprObject, toExprString } from "./expression-values.js";
import { type ExpressionScope, newWorkBudget, type WorkBudget } from "./expressions.js";
import { buildJobGraph, type JobGraph } from "./graph.js";
import {
  expandMatrix,
  MAX_MATRIX_UNITS,
  type MatrixCombination,
  type MatrixSpec,
  type MatrixValue,
  matrixSpec,
} from "./matrix.js";
import {
  instancePayloadBytes,
  invariantPayloadBytes,
  MAX_PAYLOAD_BYTES,
  type PayloadInstance,
  unreadableByRunner,
} from "./payload.js";
import type { Job, Position, Text, Workflow, WorkflowError } from "./workflow-schema.js";

/** Job instances in one run attempt, a job without a matrix counting one. Fyrden's limit. */
export const MAX_RUN_JOBS = 256;
/** The largest `max-parallel` the runner reads as written (it saturates larger values). */
export const MAX_PARALLEL = 2_147_483_647;

export interface JobPlan {
  readonly id: string;
  /** Instances, when the job's matrix has no expression; undefined until a dynamic one expands. */
  readonly instances: number | undefined;
  /** The job's payload size without its per-instance fields. */
  readonly invariantPayloadBytes: number;
}

export interface WorkflowPlan {
  readonly graph: JobGraph;
  readonly jobs: ReadonlyMap<string, JobPlan>;
  /** Instances counted at the start: a job whose matrix is not known yet counts one. */
  readonly staticInstances: number;
}

export type PlannedWorkflow =
  | { readonly ok: true; readonly plan: WorkflowPlan }
  | { readonly ok: false; readonly errors: readonly WorkflowError[] };

/** One instance of a job, with every field Fyrden evaluated for it. Plain data. */
export interface JobInstance {
  readonly jobId: string;
  /** From 0, in GitHub's matrix order. */
  readonly index: number;
  readonly total: number;
  readonly matrix: ReadonlyMap<string, MatrixValue> | null;
  readonly name: string;
  readonly runsOn: readonly string[];
  readonly timeoutMinutes?: number;
  readonly continueOnError: boolean;
}

export interface ExpandedJob {
  readonly jobId: string;
  readonly failFast: boolean;
  readonly maxParallel?: number;
  /** Whether the job declares a strategy, and continue-on-error: the payload writes them only then. */
  readonly declares: { readonly strategy: boolean; readonly continueOnError: boolean };
  readonly instances: readonly JobInstance[];
}

export type ExpandedJobResult =
  | { readonly ok: true; readonly job: ExpandedJob }
  | { readonly ok: false; readonly errors: readonly WorkflowError[] };

export interface ExpandOptions {
  /** Instances this job may create: `MAX_RUN_JOBS` minus those counted so far, plus its own placeholder. */
  readonly remainingRunJobs: number;
  /** From the plan. */
  readonly invariantPayloadBytes: number;
  /** The scheduling step's budget, shared with the job's condition. */
  readonly budget: WorkBudget;
}

const JOB = "jobs.<job_id>";
const MATRIX = `${JOB}.strategy.matrix`;

// The run's start ---------------------------------------------------------------------

/** The check at the start of a run; its work is charged to `budget`. */
export function planWorkflow(
  workflow: Workflow,
  budget: WorkBudget = newWorkBudget(),
): PlannedWorkflow {
  const errors = new ErrorList();
  const built = buildJobGraph(workflow.jobs);
  if (!built.ok) for (const e of built.errors) addError(errors, e);
  const readable = checkText(workflow, budget, errors);

  const counts = new Map<string, number | undefined>();
  let total = 0;
  for (const job of workflow.jobs) {
    const id = job.id.value;
    let instances: number | undefined = 1;
    const matrix = job.strategy?.matrix;
    if (matrix) {
      const spec = matrixSpec(id, matrix);
      if (spec.kind === "dynamic") instances = undefined;
      else if (spec.kind === "invalid") {
        for (const e of spec.errors) addError(errors, e);
        continue;
      } else {
        const expanded = expand(spec.spec, budget);
        if (!expanded.ok) {
          for (const e of expanded.errors) addError(errors, e);
          continue;
        }
        instances = expanded.combinations.length;
      }
    }
    counts.set(id, instances);
    total += instances ?? 1;
    if (total > MAX_RUN_JOBS) {
      // The rest are not expanded: the run fails here.
      errors.add(
        "limit_exceeded",
        matrix ? MATRIX : JOB,
        matrix ? `jobs.${id}.strategy.matrix` : `jobs.${id}`,
        matrix ? matrix.at : job.id.at,
        `A run may have at most ${MAX_RUN_JOBS} job instances; the jobs up to \`${id}\` already make ${total}.`,
      );
      break;
    }
  }

  const jobs = new Map<string, JobPlan>();
  if (readable) {
    for (const job of workflow.jobs) {
      const id = job.id.value;
      const bytes = invariantPayloadBytes(workflow, id);
      if (!charge(budget, textUnits(bytes))) {
        outOfWork(errors, `jobs.${id}`, job.id.at);
        break;
      }
      if (bytes > MAX_PAYLOAD_BYTES) {
        errors.add(
          "limit_exceeded",
          JOB,
          `jobs.${id}`,
          job.id.at,
          `This job's payload for the runner would be ${bytes} bytes before its per-instance fields; at most ${MAX_PAYLOAD_BYTES}.`,
        );
      }
      jobs.set(id, { id, instances: counts.get(id), invariantPayloadBytes: bytes });
    }
  }
  if (errors.any() || !built.ok) return { ok: false, errors: errors.list() };
  return { ok: true, plan: { graph: built.graph, jobs, staticInstances: total } };
}

/**
 * Every string in the workflow the runner could read exactly, or a
 * positioned `invalid_value` for each that it could not. Each object is
 * visited once, however many aliases share it, and charged: a unit per
 * object and each string as text.
 */
function checkText(workflow: Workflow, budget: WorkBudget, errors: ErrorList): boolean {
  let readable = true;
  const seen = new Set<object>();
  const stack: unknown[] = [workflow];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const at = record.at as Position | undefined;
    const text = typeof record.value === "string" ? record.value : record.source;
    if (!charge(budget, typeof text === "string" ? textUnits(text.length) : 1)) {
      errors.add(
        "limit_exceeded",
        "",
        "",
        at ?? { line: 0, column: 0 },
        "Checking this workflow needs more work than starting a run may spend; make it smaller.",
      );
      return false;
    }
    if (at && typeof text === "string") {
      const problem = unreadableByRunner(text);
      if (problem) {
        readable = false;
        errors.add("invalid_value", "", "", at, `This text ${problem}.`);
      }
    }
    for (const item of Array.isArray(value) ? value : Object.values(record)) stack.push(item);
  }
  return readable;
}

// A job when it is ready ---------------------------------------------------------------

/** The job's instances, or every reason it has none (which fail the job). */
export function expandJob(
  workflow: Workflow,
  jobId: string,
  scope: ExpressionScope,
  options: ExpandOptions,
): ExpandedJobResult {
  const job = workflow.jobs.find((j) => j.id.value === jobId);
  if (!job) throw new Error(`The workflow has no job \`${jobId}\`.`);
  const base = `jobs.${jobId}`;
  // A field is its path and position together: a key such as `x.y` can print the same path
  // as a nested `x: {y: ...}`.
  const fields = new Map<string, ExpressionField>();
  for (const field of expressionFields(workflow)) {
    if (field.path.startsWith(`${base}.`)) fields.set(fieldKey(field.path, field.at), field);
  }
  const fieldAt = (path: string, at: Position): ExpressionField => {
    const field = fields.get(fieldKey(path, at));
    if (!field) throw new Error(`No expression field at \`${path}\`.`);
    return field;
  };
  const errors = new ErrorList();
  const fail = (): ExpandedJobResult => ({ ok: false, errors: errors.list() });
  const { budget } = options;
  // Strategy fields read only the contexts available before the matrix exists.
  const outer: ExpressionScope = {
    ...(scope.github === undefined ? {} : { github: scope.github }),
    ...(scope.needs === undefined ? {} : { needs: scope.needs }),
    ...(scope.vars === undefined ? {} : { vars: scope.vars }),
    ...(scope.inputs === undefined ? {} : { inputs: scope.inputs }),
  };
  const evaluate = (path: string, at: Position, within: ExpressionScope): ExprValue | undefined => {
    const result = evaluateField(fieldAt(path, at), within, budget);
    if (result.ok) return result.value;
    addError(errors, result.error);
    return undefined;
  };
  const strategy = job.strategy;

  let failFast = true;
  if (strategy?.failFast) {
    const path = `${base}.strategy.fail-fast`;
    const value = valued(strategy.failFast, path, outer, evaluate);
    if (typeof value === "boolean") failFast = value;
    else if (value !== undefined) wrongType(errors, path, strategy.failFast.at, "a boolean");
  }
  let maxParallel: number | undefined;
  if (strategy?.maxParallel) {
    const path = `${base}.strategy.max-parallel`;
    const value = valued(strategy.maxParallel, path, outer, evaluate);
    if (typeof value !== "number") {
      if (value !== undefined) wrongType(errors, path, strategy.maxParallel.at, "a number");
    } else if (!Number.isInteger(value) || value < 1 || value > MAX_PARALLEL) {
      errors.add(
        "invalid_value",
        `${JOB}.strategy.max-parallel`,
        path,
        strategy.maxParallel.at,
        `\`${path}\` must be a whole number from 1 to ${MAX_PARALLEL}; it is ${toExprString(value)}.`,
      );
    } else maxParallel = value;
  }

  let combinations: readonly MatrixCombination[] | undefined;
  if (strategy?.matrix) {
    const spec = matrixSpec(
      jobId,
      strategy.matrix,
      (place) => evaluateField(fieldAt(place.path, place.at), outer, budget),
      (units) => charge(budget, units),
    );
    if (spec.kind === "invalid") for (const e of spec.errors) addError(errors, e);
    else if (spec.kind === "spec") {
      checkSpecText(spec.spec, errors);
      if (!errors.any()) {
        const expanded = expand(spec.spec, budget);
        if (expanded.ok) combinations = expanded.combinations;
        else for (const e of expanded.errors) addError(errors, e);
      }
    }
  }
  if (errors.any()) return fail();

  const total = combinations?.length ?? 1;
  if (total > options.remainingRunJobs) {
    errors.add(
      "limit_exceeded",
      strategy?.matrix ? MATRIX : JOB,
      strategy?.matrix ? `${base}.strategy.matrix` : base,
      strategy?.matrix ? strategy.matrix.at : job.id.at,
      `A run may have at most ${MAX_RUN_JOBS} job instances; this job has ${total} and the run has room for ${options.remainingRunJobs} more.`,
    );
    return fail();
  }

  const declares = {
    strategy: strategy !== undefined,
    continueOnError: job.continueOnError !== undefined,
  };
  const instances: JobInstance[] = [];
  for (let index = 0; index < total; index++) {
    const combination = combinations?.[index];
    const within: ExpressionScope = {
      ...outer,
      matrix: exprObject(combination ? combination.values : []),
      strategy: strategyContext(failFast, index, total, combination !== undefined, maxParallel),
    };
    const instance = expandInstance(job, base, index, total, combination, within, evaluate, errors);
    if (!instance) return fail();
    // Naming and counting the payload are work too: charged as text, a unit per 64 characters.
    if (!charge(budget, textUnits(instance.name.length))) return outOfWork(errors, base, job.id.at);
    const bytes =
      options.invariantPayloadBytes +
      instancePayloadBytes(
        toPayloadInstance(
          {
            jobId,
            failFast,
            ...(maxParallel === undefined ? {} : { maxParallel }),
            declares,
            instances: [],
          },
          instance,
        ),
      );
    if (!charge(budget, textUnits(bytes - options.invariantPayloadBytes))) {
      return outOfWork(errors, base, job.id.at);
    }
    if (bytes > MAX_PAYLOAD_BYTES) {
      errors.add(
        "limit_exceeded",
        JOB,
        base,
        job.id.at,
        `The payload for \`${instance.name.slice(0, 60)}\` would be ${bytes} bytes; at most ${MAX_PAYLOAD_BYTES}.`,
      );
      return fail();
    }
    instances.push(instance);
  }
  return {
    ok: true,
    job: {
      jobId,
      failFast,
      ...(maxParallel === undefined ? {} : { maxParallel }),
      declares,
      instances,
    },
  };
}

type Evaluate = (path: string, at: Position, within: ExpressionScope) => ExprValue | undefined;

const fieldKey = (path: string, at: Position) => `${path}\u0000${at.line}:${at.column}`;

/** One combination's evaluated fields, or undefined after reporting why not. */
function expandInstance(
  job: Job,
  base: string,
  index: number,
  total: number,
  combination: MatrixCombination | undefined,
  within: ExpressionScope,
  evaluate: Evaluate,
  errors: ErrorList,
): JobInstance | undefined {
  const jobId = job.id.value;
  const suffix = combination ? ` (${combination.nameValues.map(toExprString).join(", ")})` : "";
  // An empty name is the job id's, as the runner reads an empty name.
  let name = `${job.name?.value || jobId}${suffix}`;
  if (job.name?.value.includes("${{")) {
    // A name holding an expression is interpolated, with no suffix; empty falls back to the
    // job id's default name, as the runner does with an empty name.
    const value = evaluate(`${base}.name`, job.name.at, within);
    if (value === undefined) return undefined;
    const text = toExprString(value);
    name = text === "" ? `${jobId}${suffix}` : text;
    if (!readable(text, `${base}.name`, `${JOB}.name`, job.name.at, errors)) return undefined;
  }

  const runsOn = labels(job, base, within, evaluate, errors);
  if (!runsOn) return undefined;

  let timeoutMinutes: number | undefined;
  if (job.timeoutMinutes) {
    const path = `${base}.timeout-minutes`;
    const value = valued(job.timeoutMinutes, path, within, evaluate);
    if (value === undefined) return undefined;
    if (typeof value !== "number")
      return wrongType(errors, path, job.timeoutMinutes.at, "a number");
    if (!Number.isSafeInteger(value) || value < 1) {
      errors.add(
        "invalid_value",
        `${JOB}.timeout-minutes`,
        path,
        job.timeoutMinutes.at,
        `\`${path}\` must be a whole number of minutes, at least 1; it is ${toExprString(value)}.`,
      );
      return undefined;
    }
    timeoutMinutes = value;
  }

  let continueOnError = false;
  if (job.continueOnError) {
    const path = `${base}.continue-on-error`;
    const value = valued(job.continueOnError, path, within, evaluate);
    if (value === undefined) return undefined;
    if (typeof value !== "boolean")
      return wrongType(errors, path, job.continueOnError.at, "a boolean");
    continueOnError = value;
  }

  return {
    jobId,
    index,
    total,
    matrix: combination ? combination.values : null,
    name,
    runsOn,
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    continueOnError,
  };
}

/**
 * The instance's labels: a literal list, each label holding an expression
 * interpolated on its own, or a whole expression giving a string or a list
 * of strings. Checked as the parser checks literal labels.
 */
function labels(
  job: Job,
  base: string,
  within: ExpressionScope,
  evaluate: Evaluate,
  errors: ErrorList,
): string[] | undefined {
  const feature = `${JOB}.runs-on`;
  const path = `${base}.runs-on`;
  const found: { value: string; path: string; at: Position }[] = [];
  if (job.runsOn.kind === "expression") {
    const value = evaluate(path, job.runsOn.at, within);
    if (value === undefined) return undefined;
    const items =
      typeof value === "string"
        ? [value]
        : value !== null && typeof value === "object" && value.kind === "array"
          ? value.items
          : undefined;
    if (!items || items.some((item) => typeof item !== "string")) {
      return wrongType(errors, path, job.runsOn.at, "a label or a list of labels");
    }
    for (const item of items) found.push({ value: item as string, path, at: job.runsOn.at });
  } else {
    for (const [i, label] of job.runsOn.value.entries()) {
      const where = `${path}[${i}]`;
      found.push({
        value: interpolated(label, where, within, evaluate) ?? "",
        path: where,
        at: label.at,
      });
      if (errors.any()) return undefined;
    }
  }
  if (found.length === 0) {
    errors.add(
      "invalid_value",
      feature,
      path,
      job.runsOn.at,
      `\`${path}\` needs at least one label.`,
    );
    return undefined;
  }
  const seen = new Set<string>();
  for (const label of found) {
    if (label.value === "") {
      errors.add(
        "invalid_value",
        feature,
        label.path,
        label.at,
        `\`${label.path}\` gave an empty label.`,
      );
      return undefined;
    }
    if (seen.has(label.value)) {
      errors.add(
        "invalid_value",
        feature,
        label.path,
        label.at,
        `\`${label.value.slice(0, 60)}\` is listed twice in \`${path}\`.`,
      );
      return undefined;
    }
    seen.add(label.value);
    if (!readable(label.value, label.path, feature, label.at, errors)) return undefined;
  }
  return found.map((l) => l.value);
}

/** A literal text, or its interpolation when it holds an expression. */
function interpolated(
  text: Text,
  path: string,
  within: ExpressionScope,
  evaluate: Evaluate,
): string | undefined {
  if (!text.value.includes("${{")) return text.value;
  const value = evaluate(path, text.at, within);
  return value === undefined ? undefined : toExprString(value);
}

/** A field's literal value, or its expression's. */
function valued<T extends ExprValue>(
  field:
    | { readonly kind: "literal"; readonly value: T }
    | { readonly kind: "expression"; readonly at: Position },
  path: string,
  within: ExpressionScope,
  evaluate: Evaluate,
): ExprValue | undefined {
  return field.kind === "literal" ? field.value : evaluate(path, field.at, within);
}

function wrongType(errors: ErrorList, path: string, at: Position, wanted: string): undefined {
  errors.add(
    "invalid_type",
    path.replace(/^jobs\.[^.]+/, JOB),
    path,
    at,
    `\`${path}\` must give ${wanted}.`,
  );
  return undefined;
}

function readable(
  text: string,
  path: string,
  feature: string,
  at: Position,
  errors: ErrorList,
): boolean {
  const problem = unreadableByRunner(text);
  if (!problem) return true;
  errors.add("invalid_value", feature, path, at, `\`${path}\` ${problem}.`);
  return false;
}

/** The text in an evaluated matrix the payload carries: keys and values of its keys and `include`. */
function checkSpecText(spec: MatrixSpec, errors: ErrorList): void {
  const visit = (value: MatrixValue, path: string, at: Position): boolean => {
    if (typeof value === "string") return readable(value, path, MATRIX, at, errors);
    if (value === null || typeof value !== "object") return true;
    if (value.kind === "array") return value.items.every((item) => visit(item, path, at));
    return [...value.entries].every(
      ([key, item]) => readable(key, path, MATRIX, at, errors) && visit(item, path, at),
    );
  };
  for (const dim of spec.dimensions) {
    if (!readable(dim.name, dim.path, MATRIX, dim.at, errors)) return;
    for (const [i, value] of dim.values.entries()) {
      if (!visit(value, `${dim.path}[${i}]`, dim.at)) return;
    }
  }
  for (const entry of spec.include) {
    for (const key of entry.keys) {
      if (!readable(key.key, key.path, `${MATRIX}.include`, key.at, errors)) return;
      if (!visit(key.value, key.path, key.at)) return;
    }
  }
}

/** Adds `units` to the step's budget; false once it is spent. */
function charge(budget: WorkBudget, units: number): boolean {
  const state = budget as { spent: number; readonly limit: number };
  state.spent += units;
  return state.spent <= state.limit;
}

/** Units for text of `length` characters: one, and one more per 64. */
const textUnits = (length: number) => 1 + Math.floor(length / 64);

function outOfWork(errors: ErrorList, path: string, at: Position): ExpandedJobResult {
  errors.add(
    "limit_exceeded",
    JOB,
    path,
    at,
    "This job needs more work than one scheduling step may spend; make its matrix, names or labels smaller.",
  );
  return { ok: false, errors: errors.list() };
}

/** A matrix expanded, its work charged to the step's budget. */
function expand(spec: MatrixSpec, budget: WorkBudget) {
  const state = budget as { spent: number; readonly limit: number };
  const room = Math.max(0, Math.min(MAX_MATRIX_UNITS, state.limit - state.spent));
  const expanded = expandMatrix(spec, room);
  state.spent += expanded.units;
  return expanded;
}

function addError(errors: ErrorList, e: WorkflowError): void {
  errors.add(e.code, e.feature, e.path, e, e.message);
}

/**
 * An instance's `strategy` context, as expansion and every later evaluation of
 * the instance (its job-level concurrency group) read it. `max-parallel` is
 * the runner's rule: the total unless the job has a matrix and sets it.
 */
export function strategyContext(
  failFast: boolean,
  index: number,
  total: number,
  hasMatrix: boolean,
  maxParallel: number | undefined,
): ExprObject {
  return exprObject([
    ["fail-fast", failFast],
    ["job-index", index],
    ["job-total", total],
    ["max-parallel", hasMatrix && maxParallel !== undefined ? maxParallel : total],
  ]);
}

/** What `jobPayload` writes for an instance: the strategy only when the job declares one. */
export function toPayloadInstance(job: ExpandedJob, instance: JobInstance): PayloadInstance {
  return {
    name: instance.name,
    runsOn: instance.runsOn,
    ...(job.declares.strategy
      ? {
          strategy: {
            failFast: job.failFast,
            ...(job.maxParallel === undefined ? {} : { maxParallel: job.maxParallel }),
            ...(instance.matrix
              ? {
                  matrix: {
                    combination: instance.matrix,
                    index: instance.index,
                    total: instance.total,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(instance.timeoutMinutes === undefined ? {} : { timeoutMinutes: instance.timeoutMinutes }),
    ...(job.declares.continueOnError ? { continueOnError: instance.continueOnError } : {}),
  };
}
