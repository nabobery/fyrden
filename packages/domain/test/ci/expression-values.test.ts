// Expression values: GitHub's conversions, case-insensitive comparison, objects, and the JSON
// reader and writer behind fromJSON and toJSON.
import { describe, expect, it } from "vitest";
import {
  compareIgnoreCase,
  EXPANDING_UPPERCASE,
  type ExprValue,
  exprArray,
  exprObject,
  formatNumber,
  fromWorkflowValue,
  isTruthy,
  parseNumberText,
  readJson,
  toExprString,
  writeJson,
} from "../../src/ci/expression-values.js";
import type { Value } from "../../src/ci/workflow-schema.js";

describe("numbers to strings (.NET G15)", () => {
  it.each([
    [0, "0"],
    [-0, "0"],
    [1, "1"],
    [1.5, "1.5"],
    [-9.2, "-9.2"],
    [0.1, "0.1"],
    [0.1 + 0.2, "0.3"],
    [1e15, "1E+15"],
    [123456789012345, "123456789012345"],
    [1234567890123456, "1.23456789012346E+15"],
    [1e20, "1E+20"],
    [1e100, "1E+100"],
    [0.0001, "0.0001"],
    [0.00001, "1E-05"],
    [-0.0000123, "-1.23E-05"],
    [1.2345678901234567, "1.23456789012346"],
    [999999999999999.9, "1E+15"],
    [5e-324, "4.94065645841247E-324"],
    // Exact halves round to even, as the runner's Go formatting does.
    [100000000000000.5, "100000000000000"],
    [100000000000001.5, "100000000000002"],
    [100000000000002.5, "100000000000002"],
    [-100000000000000.5, "-100000000000000"],
    [0.5, "0.5"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
    [Number.NaN, "NaN"],
  ])("%d -> %s", (value, text) => {
    expect(formatNumber(value)).toBe(text);
  });
});

describe("strings to numbers (GitHub's ParseNumber)", () => {
  it.each([
    ["", 0],
    ["  ", 0],
    [" 1 ", 1],
    ["+1", 1],
    ["-1.5e2", -150],
    [".5", 0.5],
    ["5.", 5],
    ["0x10", 16],
    ["0xffffffff", -1],
    ["0o17", 15],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["infinity", Number.POSITIVE_INFINITY],
    ["-INFINITY", Number.NEGATIVE_INFINITY],
    ["+Infinity", Number.POSITIVE_INFINITY],
  ])("%j -> %d", (text, value) => {
    expect(parseNumberText(text)).toBe(value);
  });

  it.each(["abc", "1,000", "0x", "0X10", "0x1g", "0x100000000", "1e", "NaN", "--1", "1 2", "Inf"])(
    "%j -> NaN",
    (text) => {
      expect(parseNumberText(text)).toBeNaN();
    },
  );
});

describe("white space", () => {
  it("trims what the runner trims: U+0085 yes, U+FEFF no", () => {
    expect(parseNumberText(String.fromCharCode(0x85, 0x31, 0x2028))).toBe(1);
    expect(parseNumberText(String.fromCharCode(0x85))).toBe(0);
    expect(parseNumberText(String.fromCharCode(0xfeff))).toBeNaN();
  });

  it("parses a long malformed number in linear time", () => {
    expect(parseNumberText(`${"9".repeat(400_000)}x`)).toBeNaN();
    expect(parseNumberText(`${"9".repeat(400_000)}.${"9".repeat(400_000)}e`)).toBeNaN();
  });
});

describe("conversions", () => {
  it.each<[ExprValue, string]>([
    [null, ""],
    [true, "true"],
    [false, "false"],
    ["x", "x"],
    [exprArray([]), "Array"],
    [exprObject([]), "Object"],
  ])("toExprString(%j)", (value, text) => {
    expect(toExprString(value)).toBe(text);
  });

  it.each<[ExprValue, boolean]>([
    [null, false],
    [false, false],
    [0, false],
    [-0, false],
    [Number.NaN, false],
    ["", false],
    ["0", true],
    ["false", true],
    [exprArray([]), true],
    [exprObject([]), true],
  ])("isTruthy(%j)", (value, truthy) => {
    expect(isTruthy(value)).toBe(truthy);
  });
});

describe("ordinal ignore-case comparison", () => {
  it.each([
    ["abc", "ABC", 0],
    ["a", "B", -1],
    ["B", "a", 1],
    ["é", "É", 0],
    ["ı", "I", 1],
    ["ſ", "S", 1],
    ["ᾀ", "ᾈ", 0],
    ["ß", "SS", 1],
    ["ǅ", "Ǆ", 0],
    ["\u{10000}", "\uE000", 1],
    ["ab", "abc", -1],
    ["", "", 0],
  ])("%j vs %j", (left, right, sign) => {
    expect(Math.sign(compareIgnoreCase(left, right))).toBe(sign);
  });

  it("covers every code point V8 uppercases into more than one", () => {
    const missing: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const upper = String.fromCodePoint(cp).toUpperCase();
      if ([...upper].length !== 1 && !EXPANDING_UPPERCASE.has(cp)) missing.push(cp.toString(16));
    }
    expect(missing).toEqual([]);
  });
});

describe("objects", () => {
  it("keeps every key Fyrden is given, in code point order, as the runner's maps do", () => {
    const object = exprObject([
      ["b", 1],
      ["Build", 2],
      ["build", 3],
      ["a", 4],
    ]);
    expect([...object.entries.keys()]).toEqual(["Build", "a", "b", "build"]);
  });

  it("an exact repeat replaces the value", () => {
    expect([
      ...exprObject([
        ["a", 1],
        ["a", 2],
      ]).entries,
    ]).toEqual([["a", 2]]);
  });

  it("keeps __proto__, constructor and prototype as ordinary keys", () => {
    const object = exprObject([
      ["__proto__", 1],
      ["constructor", 2],
      ["prototype", 3],
    ]);
    expect(object.entries.get("__proto__")).toBe(1);
    expect(Object.getPrototypeOf(object.entries)).toBe(Map.prototype);
  });
});

describe("fromWorkflowValue", () => {
  const at = { line: 1, column: 1 };
  const scalar = (value: string | number | boolean | null): Value => ({
    kind: "scalar",
    value,
    source: String(value),
    at,
  });

  it("converts scalars, sequences and mappings, sorting keys", () => {
    const value: Value = {
      kind: "mapping",
      at,
      entries: [
        [{ value: "os", at }, scalar("linux")],
        [
          { value: "Node", at },
          { kind: "sequence", at, items: [scalar(20), scalar(null)] },
        ],
      ],
    };
    const converted = fromWorkflowValue(value);
    expect(writeJson(converted)).toEqual({
      ok: true,
      text: '{\n  "Node": [\n    20,\n    null\n  ],\n  "os": "linux"\n}',
    });
  });
});

describe("readJson (strict RFC 8259)", () => {
  function read(text: string): ExprValue {
    const result = readJson(text);
    if (!result.ok) throw new Error(result.message);
    return result.value;
  }

  it.each([
    ["1", 1],
    [" -0.5e1 ", -5],
    ["1e999", Number.POSITIVE_INFINITY],
    ['"a\\"b\\\\\\/\\b\\f\\n\\r\\t\\u00e9"', 'a"b\\/\b\f\n\r\té'],
    ['"\\ud83d\\ude00"', "😀"],
    ["true", true],
    ["null", null],
  ])("%s", (text, value) => {
    expect(read(text)).toBe(value);
  });

  it("merges keys that differ only in case, keeping the first spelling and the last value", () => {
    const value = read('{"a":1,"b":0,"A":2}');
    expect(value).toMatchObject({ kind: "object" });
    if (value !== null && typeof value === "object" && value.kind === "object") {
      expect([...value.entries]).toEqual([
        ["a", 2],
        ["b", 0],
      ]);
    }
  });

  it("reads an unpaired surrogate escape as U+FFFD, as the runner does", () => {
    const pad = (hex: string) => `"${"\\"}u${hex}"`;
    expect(read(pad("d800"))).toBe(String.fromCharCode(0xfffd));
    expect(read(pad("d801"))).toBe(read(pad("d800")));
  });

  it("keeps document order", () => {
    const value = read('{"b":1,"a":2}');
    expect(writeJson(value)).toEqual({ ok: true, text: '{\n  "b": 1,\n  "a": 2\n}' });
  });

  it("keeps __proto__ as data", () => {
    const value = read('{"__proto__":{"polluted":1}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(writeJson(value)).toEqual({
      ok: true,
      text: '{\n  "__proto__": {\n    "polluted": 1\n  }\n}',
    });
  });

  it.each([
    "",
    " ",
    "[1,]",
    "{'a':1}",
    "{a:1}",
    "/* c */ 1",
    "NaN",
    "Infinity",
    "undefined",
    "01",
    "0x10",
    "1 2",
    "-",
    "1.",
    ".5",
    "+1",
    '"\u0001"',
    '"\\x"',
    '"\\u12"',
    "[",
    '{"a"}',
    '{"a":}',
    '{"a":1,}',
    '{"a":1 "b":2}',
    "[1 2]",
    "tru",
  ])("refuses %j and names RFC 8259", (text) => {
    const result = readJson(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("RFC 8259");
  });

  it("says what is wrong with single quotes and bare keys", () => {
    const quotes = readJson("{'a':1}");
    expect(!quotes.ok && quotes.message).toContain("double quotes");
    const bare = readJson("{a:1}");
    expect(!bare.ok && bare.message).toContain("double quotes");
  });

  it("stops at 64 levels of nesting", () => {
    expect(readJson(`${"[".repeat(64)}${"]".repeat(64)}`).ok).toBe(true);
    const deep = readJson(`${"[".repeat(65)}${"]".repeat(65)}`);
    expect(deep.ok).toBe(false);
    expect(readJson("[".repeat(1_000_000)).ok).toBe(false);
  });
});

describe("writeJson (toJSON)", () => {
  it.each<[ExprValue, string]>([
    [null, "null"],
    [true, "true"],
    [1.5, "1.5"],
    [1.2345678901234567, "1.23456789012346"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    ['a"b\\c\n\u0001é\u2028', '"a\\"b\\\\c\\n\\u0001é\u2028"'],
    [exprArray([]), "[]"],
    [exprObject([]), "{}"],
    [exprArray([1, exprArray([])]), "[\n  1,\n  []\n]"],
  ])("%j", (value, text) => {
    expect(writeJson(value)).toEqual({ ok: true, text });
  });

  it("charges every token, closing brackets included", () => {
    expect(writeJson(exprArray([0]), { maxBytes: 26 * 3 + 2 * 7 }).ok).toBe(true);
    expect(writeJson(exprArray([0]), { maxBytes: 26 * 3 + 2 * 7 - 1 }).ok).toBe(false);
  });

  it("refuses values nested deeper than 100, the runner's limit", () => {
    let value: ExprValue = 1;
    for (let i = 0; i < 100; i++) value = exprArray([value]);
    expect(writeJson(value).ok).toBe(true);
    expect(writeJson(exprArray([value])).ok).toBe(false);
  });
});
