import { readFileSync } from "node:fs";
import cacheOff from "./expected/cache-off.js";
import cacheRequiredMiss from "./expected/cache-required-miss.js";
import cacheSaveRestore from "./expected/cache-save-restore.js";
import cacheV4SaveRestore from "./expected/cache-v4-save-restore.js";
import checkout from "./expected/checkout.js";
import containerAndServices from "./expected/container-and-services.js";
import dispatchInputs from "./expected/dispatch-inputs.js";
import dockerStep from "./expected/docker-step.js";
import expressions from "./expected/expressions.js";
import failureAndConditions from "./expected/failure-and-conditions.js";
import jobFields from "./expected/job-fields.js";
import localAction from "./expected/local-action.js";
import matrix from "./expected/matrix.js";
import needsAndOutputs from "./expected/needs-and-outputs.js";
import nestedReference from "./expected/nested-reference.js";
import pullRequest from "./expected/pull-request.js";
import runSteps from "./expected/run-steps.js";
import secretsAndVars from "./expected/secrets-and-vars.js";
import triggerFilters from "./expected/trigger-filters.js";
import triggerFiltersIgnore from "./expected/trigger-filters-ignore.js";
import unsupportedFeature from "./expected/unsupported-feature.js";
import usesAbsoluteGithub from "./expected/uses-absolute-github.js";
import usesAbsoluteOther from "./expected/uses-absolute-other.js";
import type { CorpusCase, ElsewhereProof, FeatureRef } from "./types.js";

/** Every case, in the order the runner tier runs them. */
export const CASES: readonly CorpusCase[] = [
  runSteps,
  needsAndOutputs,
  failureAndConditions,
  matrix,
  expressions,
  secretsAndVars,
  checkout,
  localAction,
  dockerStep,
  containerAndServices,
  pullRequest,
  dispatchInputs,
  cacheSaveRestore,
  cacheV4SaveRestore,
  cacheRequiredMiss,
  cacheOff,
  unsupportedFeature,
  nestedReference,
  usesAbsoluteGithub,
  usesAbsoluteOther,
  triggerFilters,
  triggerFiltersIgnore,
  jobFields,
];

export const MAX_RUNNER_TASKS = 30;

const TRIGGER_TESTS = [
  "packages/domain/test/ci/triggers.test.ts",
  "apps/api/test/ci-triggers.test.ts",
  "apps/api/test/ci-pull-triggers.test.ts",
] as const;

const triggers = (ref: FeatureRef, why: string): ElsewhereProof => ({
  ref,
  tests: TRIGGER_TESTS,
  why,
});

const FILTERS = "Filters are matched when the push or pull request arrives, before any runner.";
const GROUP =
  "A concurrency group is decided by the run engine before any runner is offered a job.";

export const ELSEWHERE: readonly ElsewhereProof[] = [
  ...(
    [
      { feature: "concurrency" },
      { feature: "concurrency.group" },
      { feature: "concurrency.cancel-in-progress" },
      { feature: "jobs.<job_id>.concurrency" },
      { feature: "jobs.<job_id>.concurrency.group" },
      { feature: "jobs.<job_id>.concurrency.cancel-in-progress" },
    ] as const
  ).map((ref) => ({ ref, tests: ["apps/api/test/run.concurrency.test.ts"], why: GROUP })),
  {
    ref: { feature: "jobs.<job_id>.strategy.fail-fast" },
    tests: ["packages/domain/test/ci/run-state.test.ts", "apps/api/test/run.checks.test.ts"],
    why: "Cancelling a matrix's other instances is the run engine's; one runner at a time cannot show it.",
  },
  {
    ref: { feature: "jobs.<job_id>.strategy.max-parallel" },
    tests: ["apps/api/test/run.concurrency.test.ts", "apps/api/test/runs.operations.test.ts"],
    why: "How many instances are offered at once is the run engine's; one runner at a time cannot show it.",
  },
  {
    ref: { feature: "jobs.<job_id>.continue-on-error" },
    tests: ["packages/domain/test/ci/run-state.test.ts"],
    why: "Whether an allowed failure passes the run is decided by the run engine.",
  },
  ...(
    [
      { feature: "on.workflow_dispatch.inputs.<input_id>.required" },
      { feature: "on.workflow_dispatch.inputs.<input_id>.options" },
    ] as const
  ).map((ref) => ({
    ref,
    tests: ["packages/domain/test/ci/dispatch-inputs.test.ts"],
    why: "Inputs are checked when the dispatch request arrives, before any runner.",
  })),
  {
    ref: { feature: "on.schedule" },
    tests: ["apps/api/test/ci-schedules.test.ts", "tools/ci/e2e/ci-triggers.test.ts"],
    why: "A scheduled run needs the forge to fire an alarm; its jobs then run as a push's do.",
  },
  {
    ref: { feature: "on.schedule[*].cron" },
    tests: ["packages/domain/test/ci/cron.test.ts", "apps/api/test/ci-schedules.test.ts"],
    why: "When a cron fires is decided by the forge's schedule, before any runner.",
  },
  triggers(
    { feature: "on.pull_request_target" },
    "Which workflow and commit a pull_request_target run uses is decided before any runner.",
  ),
  ...(
    [
      { feature: "on.push.branches" },
      { feature: "on.push.branches-ignore" },
      { feature: "on.push.tags" },
      { feature: "on.push.tags-ignore" },
      { feature: "on.push.paths" },
      { feature: "on.push.paths-ignore" },
      { feature: "on.pull_request.branches" },
      { feature: "on.pull_request.branches-ignore" },
      { feature: "on.pull_request.paths" },
      { feature: "on.pull_request.paths-ignore" },
    ] as const
  ).map((ref) => triggers(ref, FILTERS)),
];

/**
 * Fixed workloads for measuring what CI costs a deployment, each one job of one task. Never run
 * by CI: the driver runs them by hand (`FYRDEN_CORPUS_CAPACITY=1`), and they are frozen before a
 * measurement starts, so a change here starts a new one.
 */
export const CAPACITY_WORKLOADS = ["quiet-job", "sustained-rows", "bursts", "many-steps"] as const;

const WORKFLOWS = new URL("./workflows/", import.meta.url);
const CAPACITY = new URL("./capacity/", import.meta.url);

/** A capacity workload's workflow file, as committed. */
export function capacitySource(id: (typeof CAPACITY_WORKLOADS)[number]): string {
  return readFileSync(new URL(`${id}.yml`, CAPACITY), "utf8");
}

/** The case's workflow file, as committed. */
export function workflowSource(id: string): string {
  return readFileSync(new URL(`${id}.yml`, WORKFLOWS), "utf8");
}

/** `feature` or `feature=value`, as the support matrix indexes its rows. */
export function rowKey(ref: { readonly feature: string; readonly value?: string }): string {
  return ref.value === undefined ? ref.feature : `${ref.feature}=${ref.value}`;
}
