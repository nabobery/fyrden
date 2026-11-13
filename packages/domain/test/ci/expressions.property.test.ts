// Properties of the expression language over generated input: parsing and evaluating never
// throw; equality is symmetric; && and || return an operand and stop early; JSON round-trips;
// and quoteForRunner gives back exactly the value it was given.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareIgnoreCase,
  type ExprValue,
  exprArray,
  exprObject,
  readJson,
  writeJson,
} from "../../src/ci/expression-values.js";
import {
  evaluateCondition,
  evaluateExpression,
  evaluateTemplate,
  parseCondition,
  parseTemplate,
  quoteForRunner,
} from "../../src/ci/expressions.js";
import { scopeOf } from "./expression-helpers.js";

const scope = scopeOf({
  inputs: { s: "Ab", n: 2, arr: [1, "a", null], o: { k: "v", K2: [true] } },
  github: { ref: "refs/heads/main" },
});

/** Expression-shaped text: tokens of the language, joined. */
const tokens = fc.constantFrom(
  "inputs",
  "github",
  "inputs.s",
  "inputs.arr",
  "inputs.o",
  ".",
  ".*",
  "[",
  "]",
  "(",
  ")",
  ",",
  "!",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "&&",
  "||",
  "'a'",
  "''",
  "'",
  "1",
  "-2.5",
  "0x1f",
  "NaN",
  "Infinity",
  "null",
  "true",
  "false",
  "contains(",
  "format('{0}{{'",
  "join(",
  "toJSON(",
  "fromJSON('[1,{\"a\":2}]')",
  "fromJSON(",
  "case(",
  "success()",
  "always()",
  "*",
  " ",
  "${{",
  "}}",
  "x",
  "k",
  "K2",
  "0",
);
const expressionText = fc.array(tokens, { maxLength: 40 }).map((parts) => parts.join(""));

/** Literal expressions for values of every kind. */
const literal = fc.oneof(
  fc.constant("null"),
  fc.boolean().map(String),
  fc.integer({ min: -1000, max: 1000 }).map(String),
  fc.string({ maxLength: 6 }).map((s) => `'${s.replaceAll("'", "''")}'`),
  fc.constantFrom("inputs.arr", "inputs.o", "inputs.s", "inputs.n", "NaN", "''", "0"),
);

function value(source: string): ExprValue {
  const result = evaluateExpression(source, scope);
  if (!result.ok) throw new Error(`${source}: ${result.problem.message}`);
  return result.value;
}

describe("totality", () => {
  it("evaluateExpression never throws", () => {
    fc.assert(
      fc.property(expressionText, (text) => {
        evaluateExpression(text, scope);
      }),
      { numRuns: 3000 },
    );
  });

  it("templates and conditions never throw", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), expressionText, (prefix, text) => {
        const source = `${prefix}\${{ ${text} }}${prefix}`;
        const t = parseTemplate(source);
        if (t.ok) evaluateTemplate(t.template, scope);
        const c = parseCondition(text);
        if (c.ok) evaluateCondition(c.condition, scope, { cancelled: false, ancestors: [] });
      }),
      { numRuns: 2000 },
    );
  });
});

describe("operators", () => {
  it("== is symmetric and != is its negation", () => {
    fc.assert(
      fc.property(literal, literal, (a, b) => {
        expect(value(`${a} == ${b}`)).toBe(value(`${b} == ${a}`));
        expect(value(`${a} != ${b}`)).toBe(!value(`${a} == ${b}`));
      }),
    );
  });

  it("&& and || return one of their operands and skip the rest", () => {
    fc.assert(
      fc.property(literal, literal, (a, b) => {
        // fromJSON('{') fails if evaluated: it stands for "never evaluated".
        const and = evaluateExpression(`${a} && fromJSON('{')`, scope);
        const or = evaluateExpression(`${a} || fromJSON('{')`, scope);
        const truthy = value(`!!${a}`) === true;
        expect(and.ok).toBe(!truthy);
        expect(or.ok).toBe(truthy);
        const pick = value(`${a} && ${b}`);
        expect(pick === value(a) || pick === value(b) || Number.isNaN(pick as number)).toBe(true);
      }),
    );
  });

  it("ordering ignoring case is antisymmetric", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 8, unit: "binary" }),
        fc.string({ maxLength: 8 }),
        (a, b) => {
          expect(Math.sign(compareIgnoreCase(a, b)) + Math.sign(compareIgnoreCase(b, a))).toBe(0);
        },
      ),
    );
  });
});

/** JSON-shaped values whose numbers survive 15 significant digits and whose keys are unique ignoring case. */
const jsonValue: fc.Arbitrary<ExprValue> = fc.letrec<{ v: ExprValue }>((tie) => ({
  v: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1e9, max: 1e9 }),
    fc.string({ maxLength: 8, unit: "binary" }),
    fc.array(tie("v"), { maxLength: 4 }).map((items) => exprArray(items)),
    fc
      .uniqueArray(fc.tuple(fc.string({ maxLength: 5 }), tie("v")), {
        maxLength: 4,
        selector: ([key]) => key.toUpperCase(),
      })
      .map((entries) => exprObject(entries)),
  ),
})).v;

function same(a: ExprValue, b: ExprValue): boolean {
  const left = writeJson(a);
  const right = writeJson(b);
  return left.ok && right.ok && left.text === right.text;
}

describe("JSON", () => {
  it("readJson(writeJson(v)) gives v back", () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        const text = writeJson(v);
        if (!text.ok) throw new Error(text.message);
        const back = readJson(text.text);
        if (!back.ok) throw new Error(back.message);
        expect(same(back.value, v)).toBe(true);
      }),
    );
  });

  it("readJson never throws", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (text) => {
        readJson(text);
      }),
      { numRuns: 3000 },
    );
  });
});

describe("quoteForRunner", () => {
  it("evaluates back to exactly the value", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.string({ unit: "binary" }),
            fc.constantFrom("${{", "}}", "'", "$", "{{ insert }}"),
          ),
          {
            maxLength: 12,
          },
        ),
        (parts) => {
          const value = parts.join("");
          const parsed = parseTemplate(quoteForRunner(value));
          if (!parsed.ok) throw new Error(parsed.problem.message);
          const result = evaluateTemplate(parsed.template, {});
          expect(result.ok && result.value).toBe(value);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
