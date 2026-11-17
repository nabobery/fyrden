// Each row of the fixture was evaluated by the expression evaluator the pinned runner links
// (its source line says which); Fyrden must give the same kind, string and JSON, or an error
// where the runner gave one. The rows where Fyrden differs on purpose are listed below.
import { describe, expect, it } from "vitest";
import { toExprString } from "../../src/ci/expression-values.js";
import { evaluateExpression } from "../../src/ci/expressions.js";
import { kindOf, scopeOf } from "./expression-helpers.js";
import fixtureText from "./fixtures/expressions-runner.json?raw";

interface Row {
  readonly expr: string;
  readonly kind?: string;
  readonly string?: string;
  readonly json?: string;
  readonly error?: string;
}
const fixture = JSON.parse(fixtureText) as {
  readonly scope: Record<string, unknown>;
  readonly rows: readonly Row[];
};
const scope = scopeOf(fixture.scope);

/** Strict JSON: the runner accepts these lenient forms, Fyrden refuses them. */
const LENIENT_JSON = new Set([
  "fromJSON('[1, 2, ]')",
  "fromJSON('{''a'':1}')",
  "fromJSON('/* c */ 1')",
  "fromJSON('NaN')",
  "fromJSON('{a:1}')",
  "fromJSON('1 2')",
  "fromJSON('0x10')",
  "fromJSON('01')",
]);
/** Case mapping that changed between the runner's Unicode (15.0) and V8's. */
const UNICODE_SKEW = new Set(["'ɤ' < 'Ω'"]);

describe("expressions agree with the runner's evaluator", () => {
  it("covers the fixture", () => {
    expect(fixture.rows.length).toBeGreaterThan(200);
  });

  for (const row of fixture.rows) {
    if (UNICODE_SKEW.has(row.expr)) continue;
    it(row.expr, () => {
      const result = evaluateExpression(row.expr, scope);
      if (LENIENT_JSON.has(row.expr)) {
        expect(result.ok ? "ok" : result.problem.code).toBe("expression_failed");
        return;
      }
      if (row.error !== undefined) {
        expect(result.ok, `runner: ${row.error}`).toBe(false);
        return;
      }
      if (!result.ok) throw new Error(`${result.problem.code}: ${result.problem.message}`);
      expect(kindOf(result.value)).toBe(row.kind);
      expect(toExprString(result.value)).toBe(row.string ?? "");
      if (row.json !== undefined) {
        const json = evaluateExpression(`toJSON(${row.expr})`, scope);
        expect(json.ok && json.value).toBe(row.json);
      }
    });
  }
});
