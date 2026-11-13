/*
 * Every workflow key and value GitHub documents, with what Fyrden does with
 * it: the one list the parser reads (a key not here is unknown, an
 * unsupported one fails with its reason) and the compatibility page is
 * generated from. Keys from "Workflow syntax for GitHub Actions" and events
 * and activity types from "Events that trigger workflows"
 * (docs.github.com, both read 2026-11-13).
 *
 * A feature is a key path: `jobs.<job_id>.runs-on`, `on.push.branches`.
 * `<...>` stands for a name the workflow chooses, `[*]` for any list item.
 * An entry with a `value` is about one value of that key (an activity type,
 * an input type, a permission scope). `owner` says which part of Fyrden
 * gives a supported key its effect; a key that parses but whose owner is
 * not built yet does nothing until it is.
 */

export type FeatureArea = "yaml" | "workflow" | "trigger" | "job" | "step" | "expression";

export type WorkflowFeature =
  | {
      readonly feature: string;
      readonly value?: string;
      readonly area: FeatureArea;
      readonly status: "supported";
      readonly owner: string;
    }
  | {
      readonly feature: string;
      readonly value?: string;
      readonly area: FeatureArea;
      readonly status: "unsupported";
      /** Why, and what to do instead. */
      readonly reason: string;
      /** The smallest workflow using it; parsing it gives exactly this feature's error. */
      readonly example: string;
    };

const STEP = "      - run: echo hi\n";

/** A one-job workflow with `jobLines` added to the job (indented 4) and `stepLines` to its step. */
function job(jobLines = "", stepLines = "", on = "push"): string {
  return `on: ${on}\njobs:\n  build:\n    runs-on: ubuntu-latest\n${jobLines}    steps:\n${STEP}${stepLines}`;
}

/** A workflow whose `on:` is `onBlock` (indented 2 under `on:`). */
function trigger(onBlock: string): string {
  return `on:\n${onBlock}jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${STEP}`;
}

const NOT_YET = "Fyrden does not run workflows on this event.";

const event = (name: string) =>
  ({
    feature: `on.${name}`,
    area: "trigger",
    status: "unsupported",
    reason: NOT_YET,
    example: trigger(`  ${name}:\n`),
  }) as const;

const supported = <const F extends string>(feature: F, area: FeatureArea, owner: string) =>
  ({ feature, area, status: "supported", owner }) as const;

const PR_TYPES_SUPPORTED = [
  "assigned",
  "unassigned",
  "labeled",
  "unlabeled",
  "opened",
  "edited",
  "closed",
  "reopened",
  "synchronize",
  "converted_to_draft",
  "locked",
  "unlocked",
  "milestoned",
  "demilestoned",
  "ready_for_review",
  "review_requested",
  "review_request_removed",
] as const;

const PR_TYPES_UNSUPPORTED = [
  "enqueued",
  "dequeued",
  "auto_merge_enabled",
  "auto_merge_disabled",
] as const;

const prTypes = (on: "pull_request" | "pull_request_target") => [
  ...PR_TYPES_SUPPORTED.map(
    (value) =>
      ({
        feature: `on.${on}.types`,
        value,
        area: "trigger",
        status: "supported",
        owner: "triggers",
      }) as const,
  ),
  ...PR_TYPES_UNSUPPORTED.map(
    (value) =>
      ({
        feature: `on.${on}.types`,
        value,
        area: "trigger",
        status: "unsupported",
        reason: "Fyrden has no merge queue or auto-merge, so this activity never happens.",
        example: trigger(`  ${on}:\n    types: [${value}]\n`),
      }) as const,
  ),
];

const prKeys = <const O extends "pull_request" | "pull_request_target">(on: O) =>
  [
    supported(`on.${on}.types`, "trigger", "triggers"),
    supported(`on.${on}.branches`, "trigger", "triggers"),
    supported(`on.${on}.branches-ignore`, "trigger", "triggers"),
    supported(`on.${on}.paths`, "trigger", "triggers"),
    supported(`on.${on}.paths-ignore`, "trigger", "triggers"),
  ] as const;

/** Scopes a token can carry in Fyrden; GitHub's others are recognised but cannot be granted. */
const GRANTABLE = ["actions", "checks", "contents", "issues", "pull-requests", "statuses"] as const;
const UNGRANTABLE = [
  ["artifact-metadata", "Fyrden has no artifact metadata API."],
  ["attestations", "Fyrden has no attestations."],
  ["code-quality", "Fyrden has no code quality service."],
  ["copilot-requests", "Fyrden has no Copilot."],
  ["deployments", "Fyrden has no deployments."],
  ["discussions", "Fyrden has no discussions."],
  ["id-token", "Fyrden does not issue OIDC tokens yet."],
  ["packages", "Fyrden has no package registry."],
  ["pages", "Fyrden has no Pages."],
  ["security-events", "Fyrden has no code scanning."],
  ["vulnerability-alerts", "Fyrden has no vulnerability alerts."],
] as const;

export const WORKFLOW_FEATURES = [
  // YAML itself.
  supported("yaml.anchors", "yaml", "parser"),
  {
    feature: "yaml.merge-keys",
    area: "yaml",
    status: "unsupported",
    reason: "Merge keys (`<<`) are not part of YAML 1.2. Repeat the keys, or alias a whole value.",
    example: `env: &base {A: b}\n${job("    env:\n      <<: *base\n")}`,
  },
  {
    feature: "yaml.tags",
    area: "yaml",
    status: "unsupported",
    reason: "Workflow files do not use YAML tags. Remove the tag.",
    example: job("    env: !!map {A: b}\n"),
  },
  {
    feature: "yaml.directives",
    area: "yaml",
    status: "unsupported",
    reason: "Workflow files are YAML 1.2; only `%YAML 1.2` is accepted as a directive.",
    example: `%YAML 1.1\n---\n${job()}`,
  },

  // Top level.
  supported("name", "workflow", "run pages"),
  supported("run-name", "workflow", "run pages"),
  supported("on", "workflow", "triggers"),
  supported("permissions", "workflow", "job tokens"),
  supported("env", "workflow", "job expansion"),
  supported("defaults", "workflow", "job expansion"),
  supported("defaults.run", "workflow", "job expansion"),
  supported("defaults.run.shell", "workflow", "the runner"),
  supported("defaults.run.working-directory", "workflow", "the runner"),
  supported("concurrency", "workflow", "run state"),
  supported("concurrency.group", "workflow", "run state"),
  supported("concurrency.cancel-in-progress", "workflow", "run state"),
  {
    feature: "concurrency.queue",
    area: "workflow",
    status: "unsupported",
    reason: "Fyrden keeps at most one pending run per group; remove `queue`.",
    example: `concurrency:\n  group: g\n  queue: max\n${job()}`,
  },
  {
    feature: "cache-mode",
    area: "workflow",
    status: "unsupported",
    reason: "Fyrden has no shared Actions cache yet; caches stay on the runner.",
    example: `cache-mode: read\n${job()}`,
  },
  supported("jobs", "workflow", "job expansion"),

  // Events.
  supported("on.push", "trigger", "triggers"),
  supported("on.push.branches", "trigger", "triggers"),
  supported("on.push.branches-ignore", "trigger", "triggers"),
  supported("on.push.tags", "trigger", "triggers"),
  supported("on.push.tags-ignore", "trigger", "triggers"),
  supported("on.push.paths", "trigger", "triggers"),
  supported("on.push.paths-ignore", "trigger", "triggers"),
  supported("on.pull_request", "trigger", "triggers"),
  ...prKeys("pull_request"),
  ...prTypes("pull_request"),
  supported("on.pull_request_target", "trigger", "triggers and approvals"),
  ...prKeys("pull_request_target"),
  ...prTypes("pull_request_target"),
  supported("on.schedule", "trigger", "triggers"),
  supported("on.schedule[*].cron", "trigger", "triggers"),
  {
    feature: "on.schedule[*].timezone",
    area: "trigger",
    status: "unsupported",
    reason: "Schedules run in UTC; write the cron for UTC.",
    example: trigger("  schedule:\n    - cron: '0 5 * * *'\n      timezone: Europe/Oslo\n"),
  },
  supported("on.workflow_dispatch", "trigger", "triggers"),
  supported("on.workflow_dispatch.inputs", "trigger", "triggers"),
  supported("on.workflow_dispatch.inputs.<input_id>.description", "trigger", "run pages"),
  supported("on.workflow_dispatch.inputs.<input_id>.required", "trigger", "triggers"),
  supported("on.workflow_dispatch.inputs.<input_id>.default", "trigger", "triggers"),
  supported("on.workflow_dispatch.inputs.<input_id>.type", "trigger", "triggers"),
  supported("on.workflow_dispatch.inputs.<input_id>.options", "trigger", "triggers"),
  ...(["string", "boolean", "choice", "number"] as const).map(
    (value) =>
      ({
        feature: "on.workflow_dispatch.inputs.<input_id>.type",
        value,
        area: "trigger",
        status: "supported",
        owner: "triggers",
      }) as const,
  ),
  {
    feature: "on.workflow_dispatch.inputs.<input_id>.type",
    value: "environment",
    area: "trigger",
    status: "unsupported",
    reason: "Fyrden has no deployment environments yet.",
    example: trigger(
      "  workflow_dispatch:\n    inputs:\n      target:\n        type: environment\n",
    ),
  },
  event("branch_protection_rule"),
  event("check_run"),
  event("check_suite"),
  event("create"),
  event("delete"),
  event("deployment"),
  event("deployment_status"),
  event("discussion"),
  event("discussion_comment"),
  event("fork"),
  event("gollum"),
  event("image_version"),
  event("issue_comment"),
  event("issues"),
  event("label"),
  event("merge_group"),
  event("milestone"),
  event("page_build"),
  event("public"),
  event("pull_request_review"),
  event("pull_request_review_comment"),
  event("registry_package"),
  event("release"),
  event("repository_dispatch"),
  event("status"),
  event("watch"),
  {
    ...event("workflow_call"),
    reason: "Reusable workflows are not supported yet; copy the jobs into this workflow.",
  },
  event("workflow_run"),

  // Permissions, at the top level and per job: GitHub's scopes, granted only where Fyrden can.
  ...GRANTABLE.map(
    (value) =>
      ({
        feature: "permissions",
        value,
        area: "workflow",
        status: "supported",
        owner: "job tokens",
      }) as const,
  ),
  ...UNGRANTABLE.map(
    ([value, reason]) =>
      ({
        feature: "permissions",
        value,
        area: "workflow",
        status: "unsupported",
        reason: `${reason} The scope can only be \`none\`.`,
        example: `permissions:\n  ${value}: ${value === "vulnerability-alerts" ? "read" : "write"}\n${job()}`,
      }) as const,
  ),

  // Jobs.
  supported("jobs.<job_id>.name", "job", "run pages"),
  supported("jobs.<job_id>.permissions", "job", "job tokens"),
  supported("jobs.<job_id>.needs", "job", "job graph"),
  supported("jobs.<job_id>.if", "job", "expressions"),
  supported("jobs.<job_id>.runs-on", "job", "scheduler"),
  supported("jobs.<job_id>.runs-on.labels", "job", "scheduler"),
  {
    feature: "jobs.<job_id>.runs-on.group",
    area: "job",
    status: "unsupported",
    reason: "Fyrden has no runner groups; select runners by labels.",
    example: job().replace(
      "runs-on: ubuntu-latest",
      "runs-on:\n      group: large\n      labels: [linux]",
    ),
  },
  {
    feature: "jobs.<job_id>.snapshot",
    area: "job",
    status: "unsupported",
    reason: "Fyrden does not make runner images from jobs.",
    example: job("    snapshot: my-image\n"),
  },
  {
    feature: "jobs.<job_id>.environment",
    area: "job",
    status: "unsupported",
    reason: "Fyrden has no deployment environments yet.",
    example: job("    environment: production\n"),
  },
  supported("jobs.<job_id>.concurrency", "job", "run state"),
  supported("jobs.<job_id>.concurrency.group", "job", "run state"),
  supported("jobs.<job_id>.concurrency.cancel-in-progress", "job", "run state"),
  {
    feature: "jobs.<job_id>.concurrency.queue",
    area: "job",
    status: "unsupported",
    reason: "Fyrden keeps at most one pending job per group; remove `queue`.",
    example: job("    concurrency:\n      group: g\n      queue: max\n"),
  },
  {
    feature: "jobs.<job_id>.cache-mode",
    area: "job",
    status: "unsupported",
    reason: "Fyrden has no shared Actions cache yet; caches stay on the runner.",
    example: job("    cache-mode: read\n"),
  },
  supported("jobs.<job_id>.outputs", "job", "job graph"),
  supported("jobs.<job_id>.env", "job", "job expansion"),
  supported("jobs.<job_id>.defaults", "job", "job expansion"),
  supported("jobs.<job_id>.defaults.run", "job", "job expansion"),
  supported("jobs.<job_id>.defaults.run.shell", "job", "the runner"),
  supported("jobs.<job_id>.defaults.run.working-directory", "job", "the runner"),
  supported("jobs.<job_id>.steps", "job", "the runner"),
  supported("jobs.<job_id>.timeout-minutes", "job", "run state"),
  supported("jobs.<job_id>.strategy", "job", "job expansion"),
  supported("jobs.<job_id>.strategy.matrix", "job", "job expansion"),
  supported("jobs.<job_id>.strategy.matrix.include", "job", "job expansion"),
  supported("jobs.<job_id>.strategy.matrix.exclude", "job", "job expansion"),
  supported("jobs.<job_id>.strategy.fail-fast", "job", "run state"),
  supported("jobs.<job_id>.strategy.max-parallel", "job", "run state"),
  supported("jobs.<job_id>.continue-on-error", "job", "run state"),
  supported("jobs.<job_id>.container", "job", "the runner"),
  supported("jobs.<job_id>.container.image", "job", "the runner"),
  supported("jobs.<job_id>.container.credentials", "job", "the runner"),
  supported("jobs.<job_id>.container.credentials.username", "job", "the runner"),
  supported("jobs.<job_id>.container.credentials.password", "job", "the runner"),
  supported("jobs.<job_id>.container.env", "job", "the runner"),
  supported("jobs.<job_id>.container.ports", "job", "the runner"),
  supported("jobs.<job_id>.container.volumes", "job", "the runner"),
  supported("jobs.<job_id>.container.options", "job", "the runner"),
  supported("jobs.<job_id>.services", "job", "the runner"),
  supported("jobs.<job_id>.services.<service_id>.image", "job", "the runner"),
  supported("jobs.<job_id>.services.<service_id>.credentials", "job", "the runner"),
  supported("jobs.<job_id>.services.<service_id>.credentials.username", "job", "the runner"),
  supported("jobs.<job_id>.services.<service_id>.credentials.password", "job", "the runner"),
  supported("jobs.<job_id>.services.<service_id>.env", "job", "the runner"),
  supported("jobs.<job_id>.services.<service_id>.ports", "job", "the runner"),
  supported("jobs.<job_id>.services.<service_id>.volumes", "job", "the runner"),
  supported("jobs.<job_id>.services.<service_id>.options", "job", "the runner"),
  {
    feature: "jobs.<job_id>.services.<service_id>.command",
    area: "job",
    status: "unsupported",
    reason: "Not passed to the runner yet; bake the command into the image.",
    example: job(
      "    services:\n      db:\n        image: postgres\n        command: postgres -c fsync=off\n",
    ),
  },
  {
    feature: "jobs.<job_id>.services.<service_id>.entrypoint",
    area: "job",
    status: "unsupported",
    reason: "Not passed to the runner yet; bake the entrypoint into the image.",
    example: job(
      "    services:\n      db:\n        image: postgres\n        entrypoint: /bin/sh\n",
    ),
  },
  {
    feature: "jobs.<job_id>.uses",
    area: "job",
    status: "unsupported",
    reason: "Reusable workflows are not supported yet; copy the jobs into this workflow.",
    example: "on: push\njobs:\n  call:\n    uses: octo/repo/.github/workflows/ci.yml@v1\n",
  },
  {
    feature: "jobs.<job_id>.with",
    area: "job",
    status: "unsupported",
    reason: "Inputs belong to reusable workflows, which are not supported yet.",
    example: job("    with:\n      a: b\n"),
  },
  {
    feature: "jobs.<job_id>.secrets",
    area: "job",
    status: "unsupported",
    reason: "Secrets for reusable workflows are not supported yet.",
    example: job("    secrets: inherit\n"),
  },

  // Steps.
  supported("jobs.<job_id>.steps[*].id", "step", "the runner"),
  supported("jobs.<job_id>.steps[*].if", "step", "the runner"),
  supported("jobs.<job_id>.steps[*].name", "step", "the runner"),
  supported("jobs.<job_id>.steps[*].uses", "step", "the runner"),
  supported("jobs.<job_id>.steps[*].run", "step", "the runner"),
  supported("jobs.<job_id>.steps[*].working-directory", "step", "the runner"),
  supported("jobs.<job_id>.steps[*].shell", "step", "the runner"),
  supported("jobs.<job_id>.steps[*].with", "step", "the runner"),
  supported("jobs.<job_id>.steps[*].env", "step", "the runner"),
  supported("jobs.<job_id>.steps[*].continue-on-error", "step", "the runner"),
  supported("jobs.<job_id>.steps[*].timeout-minutes", "step", "the runner"),
  ...(["background", "wait", "wait-all", "cancel", "parallel"] as const).map(
    (key) =>
      ({
        feature: `jobs.<job_id>.steps[*].${key}`,
        area: "step",
        status: "unsupported",
        reason: "Background and parallel steps are not supported by the runner Fyrden uses.",
        example: job("", `        ${key}: true\n`),
      }) as const,
  ),
  // Expressions: every function and context GitHub documents (expressions and contexts
  // references, read 2026-11-13). Where each may be used is `expression-sites.ts`.
  ...(
    [
      "contains",
      "startsWith",
      "endsWith",
      "format",
      "join",
      "toJSON",
      "fromJSON",
      "case",
      "success",
      "always",
      "cancelled",
      "failure",
    ] as const
  ).map(
    (value) =>
      ({
        feature: "expression.function",
        value,
        area: "expression",
        status: "supported",
        owner: "expressions",
      }) as const,
  ),
  {
    feature: "expression.function",
    value: "hashFiles",
    area: "expression",
    status: "supported",
    owner: "the runner",
  },
  ...(["github", "vars", "strategy", "matrix", "needs", "inputs"] as const).map(
    (value) =>
      ({
        feature: "expression.context",
        value,
        area: "expression",
        status: "supported",
        owner: "expressions",
      }) as const,
  ),
  ...(["env", "job", "steps", "runner", "secrets"] as const).map(
    (value) =>
      ({
        feature: "expression.context",
        value,
        area: "expression",
        status: "supported",
        owner: "the runner",
      }) as const,
  ),
  {
    feature: "expression.context",
    value: "jobs",
    area: "expression",
    status: "unsupported",
    reason: "The `jobs` context exists only in reusable workflows, which Fyrden does not run.",
    example: job("    if: jobs.build.result == 'success'\n"),
  },
] as const satisfies readonly WorkflowFeature[];

type Entry = (typeof WORKFLOW_FEATURES)[number];
type KeyEntry = Exclude<Entry, { readonly value: string }>;

/** Every supported key path. */
export type SupportedKey = Extract<KeyEntry, { readonly status: "supported" }>["feature"];

/** The supported keys directly under `Context`, such as `"name" | "needs" | ...` for `jobs.<job_id>`. */
export type SupportedKeysOf<Context extends string> = SupportedKey extends infer F
  ? F extends `${Context}.${infer Key}`
    ? Key extends `${string}.${string}`
      ? never
      : Key
    : never
  : never;

/** Key entries by feature; value entries by `feature=value`. */
const INDEX: ReadonlyMap<string, WorkflowFeature> = new Map(
  (WORKFLOW_FEATURES as readonly WorkflowFeature[]).map((f) => [
    f.value === undefined ? f.feature : `${f.feature}=${f.value}`,
    f,
  ]),
);

/** The entry for key path `feature`, or for one of its values. */
export function featureOf(feature: string, value?: string): WorkflowFeature | undefined {
  return INDEX.get(value === undefined ? feature : `${feature}=${value}`);
}
