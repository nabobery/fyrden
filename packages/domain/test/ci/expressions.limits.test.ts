// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests write workflow expressions, `${{ }}` included, as plain strings
// Every limit refuses with limit_exceeded at its boundary and never throws; bounds are asserted
// as work units and limits, never as time. Inputs at a limit get room on a loaded CI runner.
import { describe, expect, it } from "vitest";
import {
  evaluateExpression,
  evaluateTemplate,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_LENGTH,
  MAX_EXPRESSION_WORK,
  MAX_NESTING,
  newWorkBudget,
  parseTemplate,
} from "../../src/ci/expressions.js";
import { scopeOf } from "./expression-helpers.js";

const LARGE_INPUT = 60_000;

function code(source: string, scope = {}): string {
  const result = evaluateExpression(source, scope);
  return result.ok ? "ok" : result.problem.code;
}

describe("expression length", () => {
  it(
    "accepts 21,000 units and refuses 21,001",
    () => {
      const at = `'${"a".repeat(MAX_EXPRESSION_LENGTH - 2)}'`;
      expect(at.length).toBe(MAX_EXPRESSION_LENGTH);
      expect(code(at)).toBe("ok");
      expect(code(`${at} `)).toBe("limit_exceeded");
    },
    LARGE_INPUT,
  );
});

describe("depth (GitHub's rule)", () => {
  const chain = (links: number) => `github${".a".repeat(links)}`;

  it("counts accesses: depth 50 passes, 51 is refused", () => {
    expect(code(chain(MAX_EXPRESSION_DEPTH - 1))).toBe("ok");
    expect(code(chain(MAX_EXPRESSION_DEPTH))).toBe("limit_exceeded");
  });

  it(
    "does not count a run of the same && or ||",
    () => {
      expect(code(Array.from({ length: 2_500 }, () => "true").join(" && "))).toBe("ok");
      expect(code(Array.from({ length: 2_000 }, () => "false").join(" || "))).toBe("ok");
    },
    LARGE_INPUT,
  );

  it("counts comparisons, which are left-associative", () => {
    expect(code(Array.from({ length: 50 }, () => "1").join(" == "))).toBe("ok");
    expect(code(Array.from({ length: 52 }, () => "1").join(" == "))).toBe("limit_exceeded");
  });

  it.each([
    ["10,000 links", `github${".a".repeat(10_000)}`],
    ["6,000 indexes", `github${"[0]".repeat(6_000)}`],
    ["5,000 comparisons", Array.from({ length: 5_000 }, () => "1").join("==")],
  ])(
    "stops %s while parsing, without overflowing the stack",
    (_, source) => {
      expect(code(source)).toBe("limit_exceeded");
    },
    LARGE_INPUT,
  );
});

describe("syntactic nesting", () => {
  it.each([
    ["parentheses", (n: number) => `${"(".repeat(n)}true${")".repeat(n)}`],
    ["nots", (n: number) => `${"!".repeat(n)}true`],
    ["index arguments", (n: number) => `${"github[".repeat(n / 5)}0${"]".repeat(n / 5)}`],
    ["call arguments", (n: number) => `${"toJSON(".repeat(n / 5)}1${")".repeat(n / 5)}`],
  ])(
    "%s: thousands deep is refused, never a stack overflow",
    (_, build) => {
      expect(code(build(10_000))).toBe("limit_exceeded");
    },
    LARGE_INPUT,
  );

  it("allows up to 50 parentheses", () => {
    expect(code(`${"(".repeat(MAX_NESTING)}true${")".repeat(MAX_NESTING)}`)).toBe("ok");
    expect(code(`${"(".repeat(MAX_NESTING + 1)}true${")".repeat(MAX_NESTING + 1)}`)).toBe(
      "limit_exceeded",
    );
  });
});

describe("memory", () => {
  const big = scopeOf({ inputs: { s: "x".repeat(100_000), huge: "y".repeat(600_000) } });

  it("charges a string result once: six nested format calls of a 100,000-char string pass", () => {
    let source = "inputs.s";
    for (let i = 0; i < 6; i++) source = `format('{0}', ${source})`;
    expect(code(source, big)).toBe("ok");
  });

  it(
    "refuses reading a 600,000-char context string, as the runner does",
    () => {
      expect(code("inputs.huge", big)).toBe("limit_exceeded");
    },
    LARGE_INPUT,
  );

  it(
    "stops a doubling format bomb",
    () => {
      let source = "'xxxxxxxxxxxxxxxx'";
      for (let i = 0; i < 30; i++) source = `format('{0}{0}', ${source})`;
      expect(code(source)).toBe("limit_exceeded");
    },
    LARGE_INPUT,
  );

  it(
    "stops a template whose parts add up past the limit",
    () => {
      const parsed = parseTemplate("${{ inputs.s }}".repeat(20));
      if (!parsed.ok) throw new Error(parsed.problem.message);
      const result = evaluateTemplate(parsed.template, big);
      expect(result.ok ? "ok" : result.problem.code).toBe("limit_exceeded");
      const four = parseTemplate("${{ inputs.s }}".repeat(4));
      if (!four.ok) throw new Error(four.problem.message);
      expect(evaluateTemplate(four.template, big).ok).toBe(true);
    },
    LARGE_INPUT,
  );
});

describe("work", () => {
  const big = scopeOf({ inputs: { body: "a".repeat(400_000) } });

  it(
    "counts the characters functions read",
    () => {
      const budget = newWorkBudget();
      const result = evaluateExpression("contains(inputs.body, 'b')", big, budget);
      expect(result.ok).toBe(true);
      expect(budget.spent).toBeGreaterThanOrEqual(400_000);
      expect(budget.spent).toBeLessThan(1_000_000);
    },
    LARGE_INPUT,
  );

  it(
    "refuses many scans of a large context",
    () => {
      const source = Array.from({ length: 40 }, () => "contains(inputs.body, 'b')").join(" || ");
      const budget = newWorkBudget();
      const result = evaluateExpression(source, big, budget);
      expect(result.ok ? "ok" : result.problem.code).toBe("limit_exceeded");
      expect(budget.spent).toBeLessThanOrEqual(MAX_EXPRESSION_WORK + 400_100);
    },
    LARGE_INPUT,
  );

  it(
    "a shared budget bounds several evaluations together",
    () => {
      const budget = newWorkBudget(1_000_000);
      expect(evaluateExpression("contains(inputs.body, 'b')", big, budget).ok).toBe(true);
      expect(evaluateExpression("contains(inputs.body, 'b')", big, budget).ok).toBe(true);
      const third = evaluateExpression("contains(inputs.body, 'b')", big, budget);
      expect(third.ok ? "ok" : third.problem.code).toBe("limit_exceeded");
    },
    LARGE_INPUT,
  );

  it(
    "case-insensitive key lookups over a wide object are charged",
    () => {
      const keys = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`key${i}`, i]));
      const wide = scopeOf({ inputs: { keys } });
      const budget = newWorkBudget();
      expect(evaluateExpression("inputs.keys.KEY99999", wide, budget)).toEqual({
        ok: true,
        value: 99_999,
      });
      expect(budget.spent).toBeGreaterThan(100_000);
    },
    LARGE_INPUT,
  );
});

describe("JSON depth", () => {
  it("fromJSON at 64 passes, 65 is refused", () => {
    expect(code(`fromJSON('${"[".repeat(64)}${"]".repeat(64)}')`)).toBe("ok");
    expect(code(`fromJSON('${"[".repeat(65)}${"]".repeat(65)}')`)).toBe("expression_failed");
  });
});

describe("functions past the memory limit", () => {
  const big = scopeOf({
    inputs: {
      quotes: '"'.repeat(300_000),
      parts: ["a".repeat(200_000), "b".repeat(200_000), "c".repeat(200_000)],
    },
  });

  it(
    "toJSON whose escaped text is too large",
    () => {
      expect(code("toJSON(inputs.quotes)", big)).toBe("limit_exceeded");
    },
    LARGE_INPUT,
  );

  it(
    "join whose result is too large",
    () => {
      expect(code("join(inputs.parts, '')", big)).toBe("limit_exceeded");
      expect(code("length(inputs.parts)", big)).toBe("unknown_function");
    },
    LARGE_INPUT,
  );
});

describe("review regressions", () => {
  it(
    "a malformed long number is parsed in linear time",
    () => {
      const scope = scopeOf({ inputs: { v: `${"9".repeat(200_000)}x` } });
      const budget = newWorkBudget();
      expect(evaluateExpression("inputs.v == 0", scope, budget)).toEqual({
        ok: true,
        value: false,
      });
      expect(budget.spent).toBeLessThan(250_000);
    },
    LARGE_INPUT,
  );

  it(
    "charges converting a string index to a number, once per array it is applied to",
    () => {
      const scope = scopeOf({
        inputs: {
          arr: [0],
          a: Array.from({ length: 1_000 }, () => [0]),
          s: `${"9".repeat(400_000)}x`,
        },
      });
      const direct = newWorkBudget();
      expect(evaluateExpression("inputs.arr[inputs.s]", scope, direct).ok).toBe(true);
      expect(direct.spent).toBeGreaterThan(400_000);
      const projected = newWorkBudget(10_000);
      const result = evaluateExpression("inputs.a.*[inputs.s]", scope, projected);
      expect(result.ok ? "ok" : result.problem.code).toBe("limit_exceeded");
    },
    LARGE_INPUT,
  );

  it(
    "projects a wide array without overflowing the stack",
    () => {
      const scope = scopeOf({ inputs: { v: Array.from({ length: 125_000 }, () => 0) } });
      const result = evaluateExpression("inputs.v.*", scope);
      expect(
        result.ok &&
          typeof result.value === "object" &&
          result.value?.kind === "array" &&
          result.value.items.length,
      ).toBe(125_000);
    },
    LARGE_INPUT,
  );

  it(
    "toJSON of a wide array stops on the work budget before writing it all",
    () => {
      const scope = scopeOf({ inputs: { v: Array.from({ length: 100_000 }, () => 0) } });
      const budget = newWorkBudget(1_000);
      const result = evaluateExpression("toJSON(inputs.v)", scope, budget);
      expect(result.ok ? "ok" : result.problem.code).toBe("limit_exceeded");
      expect(budget.spent).toBeLessThan(1_100);
    },
    LARGE_INPUT,
  );

  it(
    "toJSON counts each token as the runner does: many short tokens pass the limit",
    () => {
      const wide = (n: number) => scopeOf({ inputs: { v: Array.from({ length: n }, () => "") } });
      expect(code("toJSON(inputs.v)", wide(10_000))).toBe("ok");
      expect(code("toJSON(inputs.v)", wide(30_000))).toBe("limit_exceeded");
    },
    LARGE_INPUT,
  );

  it(
    "format charges each escaped brace's segment as the runner does",
    () => {
      const braces = (n: number) => scopeOf({ inputs: { v: "{{".repeat(n) } });
      expect(code("format(inputs.v)", braces(30_000))).toBe("ok");
      expect(code("format(inputs.v)", braces(40_000))).toBe("limit_exceeded");
      expect(code("format(inputs.v)", scopeOf({ inputs: { v: "}}".repeat(40_000) } }))).toBe(
        "limit_exceeded",
      );
    },
    LARGE_INPUT,
  );
});
