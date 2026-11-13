// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests write workflow expressions, `${{ }}` included, as plain strings
// Text with `${{ }}`: typed when one expression is the whole text, a string otherwise;
// conditions with their implicit `success()`; and quoting a value so the runner reads it back.
import { describe, expect, it } from "vitest";
import type { ExprValue } from "../../src/ci/expression-values.js";
import {
  evaluateCondition,
  evaluateExpression,
  evaluateTemplate,
  type JobStatus,
  parseCondition,
  parseExpression,
  parseTemplate,
  quoteForRunner,
} from "../../src/ci/expressions.js";
import { evaluated, scopeOf } from "./expression-helpers.js";

const scope = scopeOf({
  inputs: { n: 5, s: "x", arr: [1], o: { a: 1 }, title: "${{ github.sha }}" },
  github: { ref: "refs/heads/main", sha: "abc" },
});

function template(text: string): ExprValue {
  const parsed = parseTemplate(text);
  if (!parsed.ok) throw new Error(`${parsed.problem.code}: ${parsed.problem.message}`);
  const result = evaluateTemplate(parsed.template, scope);
  if (!result.ok) throw new Error(`${result.problem.code}: ${result.problem.message}`);
  return result.value;
}

function templateProblem(text: string): string {
  const parsed = parseTemplate(text);
  return parsed.ok ? "ok" : parsed.problem.code;
}

describe("templates", () => {
  it.each([
    ["${{ inputs.n }}", 5],
    ["${{ 1.0 }}", 1],
    ["${{ inputs.s == 'X' }}", true],
    ["${{ null }}", null],
    ["n=${{ inputs.n }}", "n=5"],
    [" ${{ 5 }} ", " 5 "],
    ["${{ 5 }}\n", "5\n"],
    ["${{ 1 }}${{ 2 }}", "12"],
    ["${{ inputs.arr }}-${{ inputs.o }}", "Array-Object"],
    ["${{ null }}x", "x"],
    ["a ${{ '}}' }} b", "a }} b"],
    ["${{ format('{{0}}') }}", "{0}"],
    ["${{ '${{' }}", "${{"],
    ["no expressions }} here", "no expressions }} here"],
    ["", ""],
  ])("%j", (text, expected) => {
    expect(template(text)).toStrictEqual(expected);
  });

  it("keeps a whole-expression array or object typed", () => {
    expect(template("${{ inputs.arr }}")).toMatchObject({ kind: "array" });
    expect(template("${{ fromJSON('{\"a\":1}') }}")).toMatchObject({ kind: "object" });
  });

  it.each([
    ["${{ ", "expression_syntax"],
    ["${{ 'a }}", "expression_syntax"],
    ["${{}}", "expression_syntax"],
    ["${{   }}", "expression_syntax"],
    ["x ${{ 1 }} ${{", "expression_syntax"],
    ["${{ nope }}", "unknown_context"],
    ["${{ nope() }}", "unknown_function"],
    ["${{ gitea.sha }}", "unknown_context"],
    ["${{ True }}", "unknown_context"],
    ["${{ contains('a') }}", "expression_syntax"],
    ["${{ case(true, 'a') }}", "expression_syntax"],
    ["${{ case(true, 'a', false, 'b') }}", "expression_syntax"],
    ["${{ success(1) }}", "expression_syntax"],
    ["${{ a.* }}", "unknown_context"],
    ["${{ github.* * }}", "expression_syntax"],
    ["${{ 1 = 1 }}", "expression_syntax"],
    ["${{ 1 & 1 }}", "expression_syntax"],
    ["${{ github. }}", "expression_syntax"],
    ["${{ github.0 }}", "expression_syntax"],
    ["${{ (1 }}", "expression_syntax"],
    ["${{ 1) }}", "expression_syntax"],
    ["${{ github[1 }}", "expression_syntax"],
    ["${{ 0x1g }}", "expression_syntax"],
    ["${{ 0x100000000 }}", "expression_syntax"],
    ["${{ 1e }}", "expression_syntax"],
  ])("%j is %s", (text, code) => {
    expect(templateProblem(text)).toBe(code);
  });

  it("names the offset of the failing token", () => {
    const parsed = parseTemplate("${{ github.sha == nope }}");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problem.message).toContain("nope");
      expect(parsed.problem.offset).toBe(18);
    }
  });
});

describe("expressions", () => {
  it("parseExpression reads one expression", () => {
    const parsed = parseExpression("github.ref == 'x'");
    expect(parsed.ok && parsed.expression.root.k).toBe("compare");
    const bad = parseExpression("github.ref ==");
    expect(bad.ok ? "ok" : bad.problem.code).toBe("expression_syntax");
  });

  it("joins a parenthesised run of the same operator into one, as GitHub counts depth", () => {
    const parsed = parseExpression("(true && (false && true)) && true");
    expect(parsed.ok && parsed.expression.root).toMatchObject({ k: "and", d: 2 });
    expect(evaluated("(true && (false && true)) && true")).toBe(false);
    expect(evaluated("(1 || 2) || 3")).toBe(1);
  });

  it("startsWith and endsWith are false for a collection on either side", () => {
    expect(evaluated("startsWith('abc', fromJSON('[]'))")).toBe(false);
    expect(evaluated("endsWith(fromJSON('{}'), 'c')")).toBe(false);
  });

  it("hashFiles is left to the runner", () => {
    const result = evaluateExpression("hashFiles('**/package-lock.json')", {});
    expect(result.ok ? "ok" : result.problem.code).toBe("expression_failed");
  });

  it("finds status functions inside indexes and arguments", () => {
    const parsed = parseCondition("fromJSON('[true]')[success() && 0]");
    if (!parsed.ok) throw new Error(parsed.problem.message);
    expect(parsed.condition.root.k).toBe("index");
  });
});

describe("conditions", () => {
  const ok: JobStatus = { cancelled: false, ancestors: [] };
  const failed: JobStatus = { cancelled: false, ancestors: ["success", "failure"] };
  const cancelled: JobStatus = { cancelled: true, ancestors: ["success"] };

  function decide(source: string, status: JobStatus = ok): boolean {
    const parsed = parseCondition(source);
    if (!parsed.ok) throw new Error(`${parsed.problem.code}: ${parsed.problem.message}`);
    const result = evaluateCondition(parsed.condition, scope, status);
    if (!result.ok) throw new Error(`${result.problem.code}: ${result.problem.message}`);
    return result.value;
  }

  function conditionProblem(source: string): string {
    const parsed = parseCondition(source);
    return parsed.ok ? "ok" : parsed.problem.code;
  }

  it.each([
    ["true", true],
    ["false", false],
    ["${{ false }}", false],
    ["${{ 'false' }}", false],
    ["${{ 'true' }}", true],
    ["${{ 'a' == 'A' }}", true],
    // A lone string literal is read as the condition's text, and a blank condition is success().
    ["${{ '' }}", true],
    ["inputs.n", true],
    ["inputs.n == 4", false],
    ["github.ref == 'refs/heads/main'\n", true],
    ["github.ref == 'refs/heads/main' && inputs.s", true],
    ["", true],
    ["   ", true],
  ])("%j", (source, expected) => {
    expect(decide(source)).toBe(expected);
  });

  it("adds success() only when no status function appears", () => {
    expect(decide("true", failed)).toBe(false);
    expect(decide("always()", failed)).toBe(true);
    expect(decide("failure() || true", ok)).toBe(true);
    expect(decide("inputs.n == 5 && !cancelled()", failed)).toBe(true);
    expect(decide("contains(format('{0}', success()), 'false')", failed)).toBe(true);
    expect(decide("", cancelled)).toBe(false);
    expect(decide("", failed)).toBe(false);
  });

  it("looks at every ancestor, not only direct needs", () => {
    expect(decide("failure()", { cancelled: false, ancestors: ["skipped", "failure"] })).toBe(true);
    expect(decide("success()", { cancelled: false, ancestors: ["success", "skipped"] })).toBe(
      false,
    );
    expect(decide("success()", { cancelled: false, ancestors: ["cancelled"] })).toBe(false);
    expect(decide("cancelled()", { cancelled: false, ancestors: ["cancelled"] })).toBe(false);
  });

  it.each([
    "${{ inputs.n }} == 5",
    " ${{ false }} ",
    "${{ false }}\n",
    "${{ false }} ",
    "${{ inputs.n }} && ${{ inputs.s }}",
    "x${{ false }}",
  ])("refuses text beside an expression: %j", (source) => {
    expect(conditionProblem(source)).toBe("condition_not_single_expression");
  });

  it("explains both fixes, and |- for a trailing newline", () => {
    const parsed = parseCondition("${{ false }}\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problem.message).toContain("always true");
      expect(parsed.problem.message).toContain("|-");
    }
  });
});

describe("quoteForRunner", () => {
  function roundTrip(value: string): ExprValue {
    const parsed = parseTemplate(quoteForRunner(value));
    if (!parsed.ok) throw new Error(parsed.problem.message);
    const result = evaluateTemplate(parsed.template, {});
    if (!result.ok) throw new Error(result.problem.message);
    return result.value;
  }

  it("leaves text without `${{` alone", () => {
    expect(quoteForRunner("ubuntu-latest")).toBe("ubuntu-latest");
    expect(quoteForRunner("")).toBe("");
    expect(quoteForRunner("a } } { {")).toBe("a } } { {");
  });

  it.each([
    "${{ github.sha }}",
    "${{ insert }}",
    "x${{insert}}y",
    "It's ${{ a }} '' }} ${{",
    "${{\n}}\n'",
    "$${{{{",
    "😀${{ 😀 }}",
  ])("round-trips %j", (value) => {
    expect(roundTrip(value)).toBe(value);
  });

  it("never leaves `${{` except as an opening quote, so the runner's insert directive cannot match", () => {
    for (const value of [
      "${{ insert }}",
      "${{insert}}",
      "${{ \t insert \n }}",
      "a${{ insert }}b",
    ]) {
      const quoted = quoteForRunner(value);
      expect(quoted.replaceAll("${{ '", "")).not.toContain("${{");
      expect(/\$\{\{\s*insert\s*\}\}/.test(quoted)).toBe(false);
    }
  });

  it("splits long values so each expression stays under the runner's length limit", () => {
    const value = `${"'".repeat(30_000)}${"😀".repeat(10_000)}\${{ x }}${"z".repeat(40_000)}`;
    const quoted = quoteForRunner(value);
    for (const match of quoted.matchAll(/\$\{\{ '((?:[^']|'')*)' \}\}/g)) {
      expect((match[1] ?? "").length + 4).toBeLessThanOrEqual(21_000);
    }
    expect(roundTrip(value)).toBe(value);
  }, 60_000);
});
