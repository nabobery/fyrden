/*
 * Which secrets a job reads: the names its expressions reference, so only
 * those are sent to its runner. GitHub reads a secret only where a workflow
 * names it (verified: https://docs.github.com/en/actions/concepts/security/secrets);
 * a dynamic read (`toJSON(secrets)`, `secrets[expr]`) gives every secret
 * the run may see (unverified: workflows rely on it, GitHub's docs do not say).
 */
import { EXPRESSION_SITES, type ExpressionField, expressionFields } from "./expression-sites.js";
import { foldCase } from "./expression-values.js";
import { type ExprNode, parseCondition, parseTemplate } from "./expressions.js";
import type { Workflow } from "./workflow-schema.js";

export type SecretReferences =
  /**
   * Folded as the runner's ordinal ignore-case lookup folds them (`foldCase`:
   * `ß` stays `ß`, `ı` never becomes `I`), once each, in code-unit order.
   */
  { readonly kind: "names"; readonly names: readonly string[] } | { readonly kind: "all" };

const ALL: SecretReferences = { kind: "all" };

/**
 * The secrets job `jobId` references: from the workflow `env` and the job's
 * own fields and steps, wherever its site lets an expression read `secrets`
 * (`steps.if` never does). `secrets.NAME` and `secrets['NAME']` name one;
 * any other use of the context is `all`. A field that does not parse is
 * skipped: such a workflow never plans, so none of its jobs runs.
 */
export function secretReferences(workflow: Workflow, jobId: string): SecretReferences {
  const prefix = `jobs.${jobId}.`;
  const names = new Set<string>();
  for (const field of expressionFields(workflow)) {
    if (field.site === undefined) continue;
    if (!(EXPRESSION_SITES[field.site].contexts as readonly string[]).includes("secrets")) continue;
    // Job ids have no `.`, so the prefix is this job's alone.
    if (field.feature !== "env" && !field.path.startsWith(prefix)) continue;
    for (const root of roots(field)) if (!collect(root, names)) return ALL;
  }
  return { kind: "names", names: [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) };
}

function roots(field: ExpressionField): ExprNode[] {
  if (field.kind === "condition") {
    const parsed = parseCondition(field.source);
    return parsed.ok ? [parsed.condition.root] : [];
  }
  const parsed = parseTemplate(field.source);
  if (!parsed.ok) return [];
  return parsed.template.parts.flatMap((part) => (typeof part === "string" ? [] : [part.root]));
}

const isSecrets = (node: ExprNode) => node.k === "context" && node.name === "secrets";

/** Adds the names `node` reads; false when it reads `secrets` any other way. */
function collect(node: ExprNode, names: Set<string>): boolean {
  switch (node.k) {
    case "context":
      return node.name !== "secrets";
    case "property":
      if (isSecrets(node.target)) {
        names.add(foldCase(node.name));
        return true;
      }
      return collect(node.target, names);
    case "index":
      if (isSecrets(node.target)) {
        if (node.index.k !== "literal" || typeof node.index.value !== "string") return false;
        names.add(foldCase(node.index.value));
        return true;
      }
      return collect(node.target, names) && collect(node.index, names);
    case "star":
      return collect(node.target, names);
    case "not":
      return collect(node.operand, names);
    case "compare":
      return collect(node.left, names) && collect(node.right, names);
    case "and":
    case "or":
      return node.operands.every((n) => collect(n, names));
    case "call":
      return node.args.every((n) => collect(n, names));
    case "literal":
      return true;
  }
}
