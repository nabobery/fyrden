import {
  type ExpressionField,
  expressionFields,
  parseWorkflow,
  planWorkflow,
  type Workflow,
  type WorkflowError,
  type WorkflowPlan,
} from "@fyrden/domain/ci";

/*
 * A run's workflow, parsed and planned. The object stores the source and
 * parses it once per wake-up (bounded by the parser's own limits), not per
 * scheduling step.
 */

export interface RunModel {
  readonly workflow: Workflow;
  readonly plan: WorkflowPlan;
  /** Fyrden-side expression fields by path (`jobs.build.if`, `concurrency.group`). */
  readonly fields: ReadonlyMap<string, ExpressionField>;
}

export type LoadedModel =
  | { readonly ok: true; readonly model: RunModel }
  | { readonly ok: false; readonly errors: readonly WorkflowError[] };

const utf8 = new TextEncoder();

export function loadModel(path: string, source: string): LoadedModel {
  const parsed = parseWorkflow(path, utf8.encode(source));
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const planned = planWorkflow(parsed.workflow);
  if (!planned.ok) return { ok: false, errors: planned.errors };
  const fields = new Map<string, ExpressionField>();
  for (const field of expressionFields(parsed.workflow)) fields.set(field.path, field);
  return { ok: true, model: { workflow: parsed.workflow, plan: planned.plan, fields } };
}

/** A job's display name for a check when it never expanded: its `name:` without expressions, else its id. */
export function nodeName(workflow: Workflow, jobKey: string): string {
  const job = workflow.jobs.find((j) => j.id.value === jobKey);
  const name = job?.name?.value;
  return name && !name.includes("${{") ? name : jobKey;
}
