// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests write workflow expressions, `${{ }}` included, as plain strings
// The examples in GitHub's expressions and contexts reference pages (docs source read
// 2026-11-13), each with the result the page documents.
import { describe, expect, it } from "vitest";
import { toExprString } from "../../src/ci/expression-values.js";
import {
  evaluateCondition,
  evaluateTemplate,
  parseCondition,
  parseTemplate,
} from "../../src/ci/expressions.js";
import { evaluated, scopeOf } from "./expression-helpers.js";

const github = {
  ref: "refs/heads/main",
  event_name: "push",
  event: { issue: { labels: [{ name: "bug" }, { name: "help wanted" }] } },
};
const scope = scopeOf({ github });

describe("literals", () => {
  it.each([
    ["null", null],
    ["false", false],
    ["711", 711],
    ["-9.2", -9.2],
    ["0xff", 255],
    ["-2.99e-2", -0.0299],
    ["'It''s open source!'", "It's open source!"],
  ])("%s", (source, expected) => {
    expect(evaluated(source)).toBe(expected);
  });

  it("refuses double-quoted strings", () => {
    const parsed = parseTemplate('${{ "x" }}');
    expect(parsed.ok ? "ok" : parsed.problem.code).toBe("expression_syntax");
  });

  it("strings need no braces: plain text is returned as written", () => {
    const parsed = parseTemplate("Mona the Octocat");
    if (!parsed.ok) throw new Error(parsed.problem.message);
    const result = evaluateTemplate(parsed.template, {});
    expect(result.ok && result.value).toBe("Mona the Octocat");
  });
});

describe("operators and coercion", () => {
  it.each([
    ["github.ref == 'refs/heads/main'", true],
    ["'GitHub' == 'github'", true],
    ["null == 0", true],
    ["true == 1", true],
    ["'' == 0", true],
    ["'1' == 1", true],
    ["fromJSON('[]') == fromJSON('[]')", false],
    ["NaN > 1", false],
    ["NaN <= 1", false],
  ])("%s", (source, expected) => {
    expect(evaluated(source, scope)).toBe(expected);
  });

  it.each(["false", "0", "-0", "''", "null"])("%s is falsy in a condition", (literal) => {
    expect(evaluated(`!${literal}`)).toBe(true);
  });
});

describe("functions", () => {
  it.each([
    ["contains('Hello world', 'llo')", true],
    ["contains(github.event.issue.labels.*.name, 'bug')", true],
    ['contains(fromJSON(\'["push", "pull_request"]\'), github.event_name)', true],
    ["startsWith('Hello world', 'He')", true],
    ["endsWith('Hello world', 'ld')", true],
    ["format('Hello {0} {1} {2}', 'Mona', 'the', 'Octocat')", "Hello Mona the Octocat"],
    ["format('{{Hello {0} {1} {2}!}}', 'Mona', 'the', 'Octocat')", "{Hello Mona the Octocat!}"],
    ["join(github.event.issue.labels.*.name, ', ')", "bug, help wanted"],
    ["case(github.ref == 'refs/heads/main', 'production', 'development')", "production"],
    [
      "case(github.ref == 'refs/heads/staging', 'staging', startsWith(github.ref, 'refs/heads/feature/'), 'development', 'unknown')",
      "unknown",
    ],
  ])("%s", (source, expected) => {
    expect(evaluated(source, scope)).toBe(expected);
  });

  it("toJSON pretty-prints", () => {
    expect(evaluated('toJSON(fromJSON(\'{"status":"success"}\'))')).toBe(
      '{\n  "status": "success"\n}',
    );
  });

  it("fromJSON gives a matrix from a job output, typed", () => {
    const matrix =
      '{"include":[{"project":"foo","config":"Debug"},{"project":"bar","config":"Release"}]}';
    const parsed = parseTemplate("${{ fromJSON(needs.job1.outputs.matrix) }}");
    if (!parsed.ok) throw new Error(parsed.problem.message);
    const result = evaluateTemplate(
      parsed.template,
      scopeOf({ needs: { job1: { outputs: { matrix }, result: "success" } } }),
    );
    if (!result.ok) throw new Error(result.problem.message);
    expect(
      toExprString(
        evaluated(
          "toJSON(fromJSON(needs.job1.outputs.matrix).include.*.project)",
          scopeOf({ needs: { job1: { outputs: { matrix } } } }),
        ),
      ),
    ).toBe('[\n  "foo",\n  "bar"\n]');
    expect(typeof result.value === "object" && result.value?.kind).toBe("object");
  });

  it("fromJSON gives booleans and numbers from strings", () => {
    const parsed = parseTemplate("${{ fromJSON(inputs.time) }}");
    if (!parsed.ok) throw new Error(parsed.problem.message);
    const result = evaluateTemplate(parsed.template, scopeOf({ inputs: { time: "3" } }));
    expect(result.ok && result.value).toBe(3);
    expect(evaluated("fromJSON('true')")).toBe(true);
  });
});

describe("object filters", () => {
  const fruits = [
    { name: "apple", quantity: 1 },
    { name: "orange", quantity: 2 },
    { name: "pear", quantity: 1 },
  ];
  const vegetables = {
    scallions: { colors: ["green", "white", "red"], ediblePortions: ["roots", "stalks"] },
    beets: { colors: ["purple", "red"], ediblePortions: ["roots", "stems", "leaves"] },
  };
  const local = scopeOf({ inputs: { fruits, vegetables } });

  it("fruits.*.name", () => {
    expect(evaluated("toJSON(inputs.fruits.*.name)", local)).toBe(
      '[\n  "apple",\n  "orange",\n  "pear"\n]',
    );
  });

  it("vegetables.*.ediblePortions", () => {
    expect(evaluated("toJSON(inputs.vegetables.*.ediblePortions)", local)).toBe(
      '[\n  [\n    "roots",\n    "stems",\n    "leaves"\n  ],\n  [\n    "roots",\n    "stalks"\n  ]\n]',
    );
  });
});

describe("status check functions in conditions", () => {
  const ok = { cancelled: false, ancestors: ["success"] } as const;
  const failed = { cancelled: false, ancestors: ["success", "failure"] } as const;
  const cancelled = { cancelled: true, ancestors: ["success"] } as const;

  function decide(source: string, status: Parameters<typeof evaluateCondition>[2]) {
    const parsed = parseCondition(source);
    if (!parsed.ok) throw new Error(parsed.problem.message);
    const result = evaluateCondition(parsed.condition, scope, status);
    if (!result.ok) throw new Error(result.problem.message);
    return result.value;
  }

  it.each([
    ["${{ success() }}", ok, true],
    ["${{ success() }}", failed, false],
    ["${{ always() }}", cancelled, true],
    ["${{ cancelled() }}", cancelled, true],
    ["${{ !cancelled() }}", failed, true],
    ["${{ failure() }}", failed, true],
    ["${{ failure() }}", ok, false],
    ["github.ref == 'refs/heads/main'", ok, true],
    ["github.ref == 'refs/heads/main'", failed, false],
    ["${{ github.ref == 'refs/heads/main' }}", cancelled, false],
    ["${{ ! startsWith(github.ref, 'refs/tags/') }}", ok, true],
  ] as const)("%s", (source, status, expected) => {
    expect(decide(source, status)).toBe(expected);
  });
});
