// biome-ignore-all lint/suspicious/noTemplateCurlyInString: messages quote `${{ }}` as text
/*
 * Where a workflow may use expressions, and who evaluates them. GitHub's "Context
 * availability" table (docs.github.com, contexts reference, read 2026-11-13) lists, for each
 * workflow key, the contexts and special functions an expression there may use; any other
 * key takes none. Fyrden evaluates the fields it needs to decide, schedule or name a job,
 * whose contexts it holds before dispatch; the runner evaluates the rest from the job it is
 * sent. Every expression is checked here when the file is parsed, whichever side evaluates
 * it, so a mistake is a named error at push time rather than a failure mid-job.
 */
import type { ExprValue } from "./expression-values.js";
import { readJson } from "./expression-values.js";
import {
  type ContextName,
  type Evaluated,
  type ExpressionProblem,
  type ExpressionScope,
  type ExprNode,
  evaluateCondition,
  evaluateTemplate,
  type JobStatus,
  type ParsedCondition,
  parseCondition,
  parseTemplate,
  type WorkBudget,
} from "./expressions.js";
import { featureOf } from "./support-matrix.js";
import type {
  Filter,
  Job,
  Pairs,
  Position,
  Step,
  Text,
  Value,
  Valued,
  Workflow,
  WorkflowError,
} from "./workflow-schema.js";

export interface ExpressionSite {
  readonly evaluatedBy: "fyrden" | "runner";
  readonly contexts: readonly ContextName[];
  /** Special functions allowed besides the ordinary ones: status functions, `hashFiles`. */
  readonly functions: readonly ("status" | "hashFiles")[];
}

const RUNNER_JOB: readonly ContextName[] = [
  "github",
  "needs",
  "strategy",
  "matrix",
  "job",
  "runner",
  "env",
  "vars",
  "secrets",
  "inputs",
];
const STEP: readonly ContextName[] = [...RUNNER_JOB, "steps"];
const BEFORE_DISPATCH: readonly ContextName[] = [
  "github",
  "needs",
  "strategy",
  "matrix",
  "vars",
  "inputs",
];

const fyrden = (contexts: readonly ContextName[], status = false): ExpressionSite => ({
  evaluatedBy: "fyrden",
  contexts,
  functions: status ? ["status"] : [],
});
const runner = (
  contexts: readonly ContextName[],
  functions: ExpressionSite["functions"] = [],
): ExpressionSite => ({
  evaluatedBy: "runner",
  contexts,
  functions,
});

/** GitHub's table, the rows for keys Fyrden supports. */
export const EXPRESSION_SITES = {
  "run-name": fyrden(["github", "inputs", "vars"]),
  concurrency: fyrden(["github", "inputs", "vars"]),
  env: runner(["github", "secrets", "inputs", "vars"]),
  "jobs.<job_id>.concurrency": fyrden(BEFORE_DISPATCH),
  "jobs.<job_id>.container": runner(BEFORE_DISPATCH),
  "jobs.<job_id>.container.credentials": runner([...BEFORE_DISPATCH, "env", "secrets"]),
  "jobs.<job_id>.container.env.<env_id>": runner(RUNNER_JOB),
  "jobs.<job_id>.container.image": runner(BEFORE_DISPATCH),
  "jobs.<job_id>.continue-on-error": fyrden(BEFORE_DISPATCH),
  "jobs.<job_id>.defaults.run": runner([...BEFORE_DISPATCH, "env"]),
  "jobs.<job_id>.env": runner([...BEFORE_DISPATCH, "secrets"]),
  "jobs.<job_id>.if": fyrden(["github", "needs", "vars", "inputs"], true),
  "jobs.<job_id>.name": fyrden(BEFORE_DISPATCH),
  "jobs.<job_id>.outputs.<output_id>": runner(STEP),
  "jobs.<job_id>.runs-on": fyrden(BEFORE_DISPATCH),
  "jobs.<job_id>.services": runner(BEFORE_DISPATCH),
  "jobs.<job_id>.services.<service_id>.credentials": runner([...BEFORE_DISPATCH, "env", "secrets"]),
  "jobs.<job_id>.services.<service_id>.env.<env_id>": runner(RUNNER_JOB),
  "jobs.<job_id>.steps.continue-on-error": runner(STEP, ["hashFiles"]),
  "jobs.<job_id>.steps.env": runner(STEP, ["hashFiles"]),
  "jobs.<job_id>.steps.if": runner(
    STEP.filter((c) => c !== "secrets"),
    ["status", "hashFiles"],
  ),
  "jobs.<job_id>.steps.name": runner(STEP, ["hashFiles"]),
  "jobs.<job_id>.steps.run": runner(STEP, ["hashFiles"]),
  "jobs.<job_id>.steps.timeout-minutes": runner(STEP, ["hashFiles"]),
  "jobs.<job_id>.steps.with": runner(STEP, ["hashFiles"]),
  "jobs.<job_id>.steps.working-directory": runner(STEP, ["hashFiles"]),
  "jobs.<job_id>.strategy": fyrden(["github", "needs", "vars", "inputs"]),
  "jobs.<job_id>.timeout-minutes": fyrden(BEFORE_DISPATCH),
} as const satisfies Record<string, ExpressionSite>;

export type SiteFeature = keyof typeof EXPRESSION_SITES;

/** One field of a workflow that holds an expression, or is a condition. */
export interface ExpressionField {
  readonly source: string;
  readonly kind: "template" | "condition";
  /** The field's feature as the support matrix names it, such as `jobs.<job_id>.runs-on`. */
  readonly feature: string;
  /** Its row in GitHub's table; undefined where no expression may appear. */
  readonly site: SiteFeature | undefined;
  /** Where in the file, such as `jobs.build.strategy.matrix.include[0].node`. */
  readonly path: string;
  readonly at: Position;
  /** A name or id (an env name, a matrix key, a service id), which never takes expressions. */
  readonly key?: true;
}

const JOB = "jobs.<job_id>";
const STEP_FEATURE = `${JOB}.steps[*]`;

/**
 * Every field holding `${{`, and every condition, in source order, each occurrence on its
 * own (a YAML alias repeated in several places gives several fields). Fields with no site
 * are included when they hold `${{`, so the check can refuse them.
 */
export function expressionFields(workflow: Workflow): ExpressionField[] {
  const fields: ExpressionField[] = [];
  const text = (
    t: Text | undefined,
    feature: string,
    site: SiteFeature | undefined,
    path: string,
  ) => {
    if (t?.value.includes("${{")) {
      fields.push({ source: t.value, kind: "template", feature, site, path, at: t.at });
    }
  };
  const texts = (
    list: readonly Text[],
    feature: string,
    site: SiteFeature | undefined,
    path: string,
  ) => {
    for (const [i, t] of list.entries()) text(t, feature, site, `${path}[${i}]`);
  };
  const valued = <T>(
    v: Valued<T> | undefined,
    feature: string,
    site: SiteFeature | undefined,
    path: string,
    literal?: (value: T) => void,
  ) => {
    if (v === undefined) return;
    if (v.kind === "expression")
      fields.push({ source: v.source, kind: "template", feature, site, path, at: v.at });
    else literal?.(v.value);
  };
  const key = (t: Text, feature: string, path: string) => {
    if (t.value.includes("${{")) {
      fields.push({
        source: t.value,
        kind: "template",
        feature,
        site: undefined,
        path,
        at: t.at,
        key: true,
      });
    }
  };
  const pairs = (list: Pairs, feature: string, site: SiteFeature | undefined, path: string) => {
    for (const [name, value] of list) {
      key(name, feature, `${path}.${name.value}`);
      text(value, feature, site, `${path}.${name.value}`);
    }
  };
  const value = (v: Value, feature: string, site: SiteFeature | undefined, path: string) => {
    if (v.kind === "scalar") {
      if (typeof v.value === "string" && v.value.includes("${{")) {
        fields.push({ source: v.value, kind: "template", feature, site, path, at: v.at });
      }
    } else if (v.kind === "sequence")
      for (const [i, item] of v.items.entries()) value(item, feature, site, `${path}[${i}]`);
    else
      for (const [name, item] of v.entries) {
        key(name, feature, `${path}.${name.value}`);
        value(item, feature, site, `${path}.${name.value}`);
      }
  };
  const values = (
    v: Valued<readonly Value[]> | undefined,
    feature: string,
    site: SiteFeature | undefined,
    path: string,
  ) =>
    valued(v, feature, site, path, (items) => {
      for (const [i, item] of items.entries()) value(item, feature, site, `${path}[${i}]`);
    });

  text(workflow.name, "name", undefined, "name");
  text(workflow.runName, "run-name", "run-name", "run-name");
  for (const trigger of workflow.on) {
    const on = `on.${trigger.event}`;
    if (trigger.event === "schedule")
      for (const [i, cron] of trigger.crons.entries()) {
        text(cron, "on.schedule[*].cron", undefined, `${on}[${i}].cron`);
      }
    else if (trigger.event === "workflow_dispatch") {
      for (const input of trigger.inputs) {
        const base = `${on}.inputs.${input.id.value}`;
        const feature = "on.workflow_dispatch.inputs.<input_id>";
        key(input.id, "on.workflow_dispatch.inputs", base);
        text(input.description, `${feature}.description`, undefined, `${base}.description`);
        if (input.default?.kind === "scalar" && input.default.source.includes("${{")) {
          fields.push({
            source: input.default.source,
            kind: "template",
            feature: `${feature}.default`,
            site: undefined,
            path: `${base}.default`,
            at: input.default.at,
          });
        }
        texts(input.options, `${feature}.options`, undefined, `${base}.options`);
      }
    } else {
      const filters: readonly (readonly [string, Filter | undefined])[] =
        trigger.event === "push"
          ? [
              ["branches", trigger.branches],
              ["tags", trigger.tags],
              ["paths", trigger.paths],
            ]
          : [
              ["branches", trigger.branches],
              ["paths", trigger.paths],
            ];
      for (const [name, filter] of filters) {
        if (filter === undefined) continue;
        const key = filter.mode === "ignore" ? `${name}-ignore` : name;
        texts(filter.patterns, `${on}.${key}`, undefined, `${on}.${key}`);
      }
      if (trigger.event !== "push" && trigger.types)
        texts(trigger.types, `${on}.types`, undefined, `${on}.types`);
    }
  }
  pairs(workflow.env, "env", "env", "env");
  text(workflow.defaults?.shell, "defaults.run.shell", undefined, "defaults.run.shell");
  text(
    workflow.defaults?.workingDirectory,
    "defaults.run.working-directory",
    undefined,
    "defaults.run.working-directory",
  );
  if (workflow.concurrency) {
    text(workflow.concurrency.group, "concurrency.group", "concurrency", "concurrency.group");
    valued(
      workflow.concurrency.cancelInProgress,
      "concurrency.cancel-in-progress",
      "concurrency",
      "concurrency.cancel-in-progress",
    );
  }
  for (const job of workflow.jobs)
    jobFields(job, fields, { text, texts, valued, pairs, values, key });
  // Source order, so the parser's error cap keeps the earliest errors.
  return fields.sort((a, b) => a.at.line - b.at.line || a.at.column - b.at.column);
}

type Helpers = {
  key: (t: Text, feature: string, path: string) => void;
  text: (t: Text | undefined, feature: string, site: SiteFeature | undefined, path: string) => void;
  texts: (
    list: readonly Text[],
    feature: string,
    site: SiteFeature | undefined,
    path: string,
  ) => void;
  valued: <T>(
    v: Valued<T> | undefined,
    feature: string,
    site: SiteFeature | undefined,
    path: string,
    literal?: (value: T) => void,
  ) => void;
  pairs: (list: Pairs, feature: string, site: SiteFeature | undefined, path: string) => void;
  values: (
    v: Valued<readonly Value[]> | undefined,
    feature: string,
    site: SiteFeature | undefined,
    path: string,
  ) => void;
};

function jobFields(job: Job, fields: ExpressionField[], h: Helpers) {
  const base = `jobs.${job.id.value}`;
  h.text(job.name, `${JOB}.name`, `${JOB}.name`, `${base}.name`);
  h.valued(job.runsOn, `${JOB}.runs-on`, `${JOB}.runs-on`, `${base}.runs-on`, (labels) =>
    h.texts(labels, `${JOB}.runs-on`, `${JOB}.runs-on`, `${base}.runs-on`),
  );
  h.texts(job.needs, `${JOB}.needs`, undefined, `${base}.needs`);
  if (job.if)
    fields.push({
      source: job.if.source,
      kind: "condition",
      feature: `${JOB}.if`,
      site: `${JOB}.if`,
      path: `${base}.if`,
      at: job.if.at,
    });
  const strategy = job.strategy;
  if (strategy) {
    const site = `${JOB}.strategy` as const;
    const matrix = `${base}.strategy.matrix`;
    h.valued(strategy.matrix, `${JOB}.strategy.matrix`, site, matrix, (m) => {
      for (const dimension of m.dimensions) {
        h.key(dimension.name, `${JOB}.strategy.matrix`, `${matrix}.${dimension.name.value}`);
        h.values(
          dimension.values,
          `${JOB}.strategy.matrix`,
          site,
          `${matrix}.${dimension.name.value}`,
        );
      }
      h.values(m.include, `${JOB}.strategy.matrix.include`, site, `${matrix}.include`);
      h.values(m.exclude, `${JOB}.strategy.matrix.exclude`, site, `${matrix}.exclude`);
    });
    h.valued(strategy.failFast, `${JOB}.strategy.fail-fast`, site, `${base}.strategy.fail-fast`);
    h.valued(
      strategy.maxParallel,
      `${JOB}.strategy.max-parallel`,
      site,
      `${base}.strategy.max-parallel`,
    );
  }
  h.pairs(job.env, `${JOB}.env`, `${JOB}.env`, `${base}.env`);
  h.text(
    job.defaults?.shell,
    `${JOB}.defaults.run.shell`,
    `${JOB}.defaults.run`,
    `${base}.defaults.run.shell`,
  );
  h.text(
    job.defaults?.workingDirectory,
    `${JOB}.defaults.run.working-directory`,
    `${JOB}.defaults.run`,
    `${base}.defaults.run.working-directory`,
  );
  h.valued(
    job.timeoutMinutes,
    `${JOB}.timeout-minutes`,
    `${JOB}.timeout-minutes`,
    `${base}.timeout-minutes`,
  );
  h.valued(
    job.continueOnError,
    `${JOB}.continue-on-error`,
    `${JOB}.continue-on-error`,
    `${base}.continue-on-error`,
  );
  h.pairs(job.outputs, `${JOB}.outputs`, `${JOB}.outputs.<output_id>`, `${base}.outputs`);
  for (const service of job.services) {
    const s = `${base}.services.${service.id.value}`;
    const f = `${JOB}.services.<service_id>`;
    const site = `${JOB}.services` as const;
    h.key(service.id, `${JOB}.services`, s);
    h.text(service.image, `${f}.image`, site, `${s}.image`);
    h.texts(service.ports, `${f}.ports`, site, `${s}.ports`);
    h.texts(service.volumes, `${f}.volumes`, site, `${s}.volumes`);
    h.text(service.options, `${f}.options`, site, `${s}.options`);
    h.text(
      service.credentials?.username,
      `${f}.credentials.username`,
      `${JOB}.services.<service_id>.credentials`,
      `${s}.credentials.username`,
    );
    h.text(
      service.credentials?.password,
      `${f}.credentials.password`,
      `${JOB}.services.<service_id>.credentials`,
      `${s}.credentials.password`,
    );
    h.pairs(service.env, `${f}.env`, `${JOB}.services.<service_id>.env.<env_id>`, `${s}.env`);
  }
  const container = job.container;
  if (container) {
    const c = `${base}.container`;
    const f = `${JOB}.container`;
    h.text(container.image, `${f}.image`, `${JOB}.container.image`, `${c}.image`);
    h.texts(container.ports, `${f}.ports`, `${JOB}.container`, `${c}.ports`);
    h.texts(container.volumes, `${f}.volumes`, `${JOB}.container`, `${c}.volumes`);
    h.text(container.options, `${f}.options`, `${JOB}.container`, `${c}.options`);
    h.text(
      container.credentials?.username,
      `${f}.credentials.username`,
      `${JOB}.container.credentials`,
      `${c}.credentials.username`,
    );
    h.text(
      container.credentials?.password,
      `${f}.credentials.password`,
      `${JOB}.container.credentials`,
      `${c}.credentials.password`,
    );
    h.pairs(container.env, `${f}.env`, `${JOB}.container.env.<env_id>`, `${c}.env`);
  }
  if (job.concurrency) {
    h.text(
      job.concurrency.group,
      `${JOB}.concurrency.group`,
      `${JOB}.concurrency`,
      `${base}.concurrency.group`,
    );
    h.valued(
      job.concurrency.cancelInProgress,
      `${JOB}.concurrency.cancel-in-progress`,
      `${JOB}.concurrency`,
      `${base}.concurrency.cancel-in-progress`,
    );
  }
  for (const [i, step] of job.steps.entries()) stepFields(step, `${base}.steps[${i}]`, fields, h);
}

function stepFields(step: Step, path: string, fields: ExpressionField[], h: Helpers) {
  const site = (key: string) => `${JOB}.steps.${key}` as SiteFeature;
  h.text(step.id, `${STEP_FEATURE}.id`, undefined, `${path}.id`);
  h.text(step.name, `${STEP_FEATURE}.name`, site("name"), `${path}.name`);
  if (step.if)
    fields.push({
      source: step.if.source,
      kind: "condition",
      feature: `${STEP_FEATURE}.if`,
      site: site("if"),
      path: `${path}.if`,
      at: step.if.at,
    });
  h.pairs(step.env, `${STEP_FEATURE}.env`, site("env"), `${path}.env`);
  h.valued(
    step.continueOnError,
    `${STEP_FEATURE}.continue-on-error`,
    site("continue-on-error"),
    `${path}.continue-on-error`,
  );
  h.valued(
    step.timeoutMinutes,
    `${STEP_FEATURE}.timeout-minutes`,
    site("timeout-minutes"),
    `${path}.timeout-minutes`,
  );
  if (step.kind === "run") {
    h.text(step.run, `${STEP_FEATURE}.run`, site("run"), `${path}.run`);
    h.text(step.shell, `${STEP_FEATURE}.shell`, undefined, `${path}.shell`);
    h.text(
      step.workingDirectory,
      `${STEP_FEATURE}.working-directory`,
      site("working-directory"),
      `${path}.working-directory`,
    );
  } else {
    h.text(step.uses, `${STEP_FEATURE}.uses`, undefined, `${path}.uses`);
    h.pairs(step.with, `${STEP_FEATURE}.with`, site("with"), `${path}.with`);
  }
}

// --- The check -----------------------------------------------------------------------------

type Parsed =
  | { readonly ok: true; readonly roots: readonly ExprNode[] }
  | { readonly ok: false; readonly problem: ExpressionProblem };

/** A problem in one field, before it is placed at the field's path and position. */
interface Finding {
  readonly code: WorkflowError["code"];
  readonly feature?: string;
  readonly message: string;
}

/**
 * The named errors for every expression in the workflow: syntax, unknown names, contexts and
 * functions the field's row does not allow, expressions where none may appear, and literal
 * `fromJSON` arguments that are not strict JSON. Each source is parsed once; every
 * occurrence gets its own errors at its own path and position.
 */
export function checkWorkflowExpressions(workflow: Workflow): WorkflowError[] {
  const errors: WorkflowError[] = [];
  const parsed = new Map<string, Parsed>();
  const checked = new Map<string, readonly Finding[]>();
  for (const field of expressionFields(workflow)) {
    let findings: readonly Finding[];
    if (field.site === undefined) {
      findings = [
        {
          code: "expression_not_allowed",
          message: field.key
            ? `\`${field.path}\` is a name, and names take no expressions.`
            : field.feature === "name"
              ? "`name` is not evaluated, so `${{ }}` cannot be used in it; `run-name` is the workflow's evaluated display name."
              : `\`${field.feature}\` takes no expressions; GitHub evaluates \`\${{ }}\` only in the keys its context availability table lists.`,
        },
      ];
    } else {
      const key = `${field.kind}\u0000${field.source}`;
      let result = parsed.get(key);
      if (result === undefined) {
        result = parseField(field);
        parsed.set(key, result);
      }
      const siteKey = `${field.site}\u0000${key}`;
      let found = checked.get(siteKey);
      if (found === undefined) {
        found = result.ok
          ? checkRoots(result.roots, field.site as SiteFeature)
          : [{ code: result.problem.code, message: result.problem.message }];
        checked.set(siteKey, found);
      }
      findings = found;
    }
    for (const finding of findings) {
      errors.push({
        code: finding.code,
        feature: finding.feature ?? field.feature,
        path: field.path,
        line: field.at.line,
        column: field.at.column,
        message: finding.message,
      });
    }
  }
  return errors;
}

function parseField(field: ExpressionField): Parsed {
  if (field.kind === "condition") {
    const result = parseCondition(field.source);
    return result.ok ? { ok: true, roots: [result.condition.root] } : result;
  }
  const result = parseTemplate(field.source);
  if (!result.ok) return result;
  return {
    ok: true,
    roots: result.template.parts.flatMap((part) => (typeof part === "string" ? [] : [part.root])),
  };
}

const CONTEXT_HINTS: Partial<Record<ContextName, string>> = {
  env: " The `env` context exists only once a job runs on its runner; use `vars` for repository variables or `matrix` for job settings.",
  secrets: " Secrets are given to the runner, never to job-level fields.",
  steps: " The `steps` context exists only within a job's steps.",
};

/** The findings for every expression in one field, each named once for the whole field. */
function checkRoots(roots: readonly ExprNode[], siteFeature: SiteFeature): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const root of roots) checkNames(root, siteFeature, findings, seen);
  return findings;
}

function checkNames(
  root: ExprNode,
  siteFeature: SiteFeature,
  findings: Finding[],
  seen: Set<string>,
): void {
  const site: ExpressionSite = EXPRESSION_SITES[siteFeature];
  const once = (key: string, finding: Finding) => {
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  const visit = (node: ExprNode) => {
    switch (node.k) {
      case "context":
        if (node.name === "jobs") {
          const entry = featureOf("expression.context", "jobs");
          const reason = entry?.status === "unsupported" ? entry.reason : "";
          once("jobs", {
            code: "unsupported_value",
            feature: "expression.context",
            message: `The \`jobs\` context is not supported: ${reason}`,
          });
        } else if (!site.contexts.includes(node.name)) {
          once(`context:${node.name}`, {
            code: "context_not_available",
            message: `The \`${node.name}\` context is not available in \`${siteFeature}\`; there, an expression can use ${site.contexts.map((c) => `\`${c}\``).join(", ")}.${CONTEXT_HINTS[node.name] ?? ""}`,
          });
        }
        return;
      case "call": {
        const status =
          node.fn === "success" ||
          node.fn === "failure" ||
          node.fn === "cancelled" ||
          node.fn === "always";
        if (status && !site.functions.includes("status")) {
          once(`fn:${node.fn}`, {
            code: "function_not_available",
            message: `\`${node.fn}()\` can only be used in an \`if\` condition.`,
          });
        } else if (node.fn === "hashFiles" && !site.functions.includes("hashFiles")) {
          once("fn:hashFiles", {
            code: "function_not_available",
            message: `\`hashFiles\` reads the job's files, so it can only be used in a step's fields, not in \`${siteFeature}\`.`,
          });
        } else if (node.fn === "fromJSON") {
          const [argument] = node.args;
          if (argument?.k === "literal" && typeof argument.value === "string") {
            const json = readJson(argument.value);
            if (!json.ok)
              once(`json:${argument.at}`, {
                code: "expression_failed",
                message: `fromJSON: ${json.message}`,
              });
          }
        }
        node.args.forEach(visit);
        return;
      }
      case "property":
      case "star":
        visit(node.target);
        return;
      case "index":
        visit(node.target);
        visit(node.index);
        return;
      case "not":
        visit(node.operand);
        return;
      case "compare":
        visit(node.left);
        visit(node.right);
        return;
      case "and":
      case "or":
        node.operands.forEach(visit);
        return;
      default:
        return;
    }
  };
  visit(root);
}

// --- Evaluating a field --------------------------------------------------------------------

function place(field: ExpressionField, problem: ExpressionProblem): WorkflowError {
  return {
    code: problem.code,
    feature: field.feature,
    path: field.path,
    line: field.at.line,
    column: field.at.column,
    message: problem.message,
  };
}

function fyrdenSite(field: ExpressionField): WorkflowError | undefined {
  if (field.site !== undefined && EXPRESSION_SITES[field.site].evaluatedBy === "fyrden")
    return undefined;
  return place(field, {
    code: "expression_failed",
    message: `\`${field.path}\` is evaluated by the runner, not by Fyrden.`,
    offset: 0,
  });
}

export type FieldValue<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorkflowError };

/**
 * A Fyrden-side field's value: one `${{ x }}` alone keeps `x`'s type, anything else is a
 * string. A field the runner evaluates is refused, so a secret-bearing field is never
 * evaluated here. The field is checked again, so a caller cannot skip the static check.
 */
export function evaluateField(
  field: ExpressionField,
  scope: ExpressionScope,
  budget?: WorkBudget,
): FieldValue<ExprValue> {
  if (field.kind === "condition") {
    return {
      ok: false,
      error: place(field, {
        code: "expression_failed",
        message: `\`${field.path}\` is a condition; evaluateJobCondition decides it.`,
        offset: 0,
      }),
    };
  }
  const refused = fyrdenSite(field) ?? firstError(field);
  if (refused) return { ok: false, error: refused };
  const parsed = parseTemplate(field.source);
  if (!parsed.ok) return { ok: false, error: place(field, parsed.problem) };
  return settle(field, evaluateTemplate(parsed.template, scope, budget));
}

/**
 * Whether a job runs. No condition is `success()`. The condition is checked again, so only
 * contexts a job `if` may use are read.
 */
export function evaluateJobCondition(
  field: ExpressionField | undefined,
  scope: ExpressionScope,
  status: JobStatus,
  budget?: WorkBudget,
): FieldValue<boolean> {
  let condition: ParsedCondition;
  if (field === undefined) {
    // No condition is `success()` alone.
    const parsed = parseCondition("");
    if (!parsed.ok)
      return {
        ok: false,
        error: {
          code: parsed.problem.code,
          feature: "jobs.<job_id>.if",
          path: "",
          line: 0,
          column: 0,
          message: parsed.problem.message,
        },
      };
    condition = parsed.condition;
  } else {
    if (field.kind !== "condition" || field.site !== "jobs.<job_id>.if") {
      return {
        ok: false,
        error: place(field, {
          code: "expression_failed",
          message: `\`${field.path}\` is not a job's \`if\`; evaluateJobCondition decides only those.`,
          offset: 0,
        }),
      };
    }
    const refused = fyrdenSite(field) ?? firstError(field);
    if (refused) return { ok: false, error: refused };
    const parsed = parseCondition(field.source);
    if (!parsed.ok) return { ok: false, error: place(field, parsed.problem) };
    condition = parsed.condition;
  }
  const result = evaluateCondition(condition, scope, status, budget);
  if (result.ok) return result;
  return field === undefined
    ? {
        ok: false,
        error: {
          code: result.problem.code,
          feature: "jobs.<job_id>.if",
          path: "",
          line: 0,
          column: 0,
          message: result.problem.message,
        },
      }
    : { ok: false, error: place(field, result.problem) };
}

function firstError(field: ExpressionField): WorkflowError | undefined {
  const parsed = parseField(field);
  if (!parsed.ok) return place(field, parsed.problem);
  const [finding] = checkRoots(parsed.roots, field.site as SiteFeature);
  if (finding === undefined) return undefined;
  return {
    ...place(field, { code: "expression_failed", message: finding.message, offset: 0 }),
    code: finding.code,
    feature: finding.feature ?? field.feature,
  };
}

function settle<T>(field: ExpressionField, result: Evaluated<T>): FieldValue<T> {
  return result.ok ? result : { ok: false, error: place(field, result.problem) };
}
