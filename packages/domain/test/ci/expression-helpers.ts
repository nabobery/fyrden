// Shared helpers for the expression suites: plain JSON-shaped data to expression values, and
// evaluation shorthands that fail the test on an unexpected error.
import {
  type ExprValue,
  exprArray,
  exprObject,
  toExprString,
} from "../../src/ci/expression-values.js";
import {
  type ExpressionProblem,
  type ExpressionScope,
  evaluateExpression,
} from "../../src/ci/expressions.js";

/** Plain data (as `JSON.parse` gives it) to an expression value; objects as Fyrden builds them. */
export function toExpr(value: unknown): ExprValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return exprArray(value.map(toExpr));
  if (typeof value === "object") {
    return exprObject(Object.entries(value).map(([key, item]) => [key, toExpr(item)] as const));
  }
  throw new Error(`not JSON-shaped: ${String(value)}`);
}

/** A scope from plain data for each context. */
export function scopeOf(contexts: Record<string, unknown>): ExpressionScope {
  const scope: Record<string, ExprValue> = {};
  for (const [name, value] of Object.entries(contexts)) scope[name] = toExpr(value);
  return scope as ExpressionScope;
}

/** The value of `source`, or a thrown error naming the problem. */
export function evaluated(source: string, scope: ExpressionScope = {}): ExprValue {
  const result = evaluateExpression(source, scope);
  if (!result.ok) throw new Error(`${source}: ${result.problem.code}: ${result.problem.message}`);
  return result.value;
}

/** The problem `source` gives, or a thrown error if it evaluates. */
export function problemOf(source: string, scope: ExpressionScope = {}): ExpressionProblem {
  const result = evaluateExpression(source, scope);
  if (result.ok) throw new Error(`${source}: evaluated to ${toExprString(result.value)}`);
  return result.problem;
}

/** A value as the runner fixture records it: its kind and its string conversion. */
export function kindOf(
  value: ExprValue,
): "null" | "boolean" | "number" | "string" | "array" | "object" {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return value.kind;
}
