/*
 * Values of workflow expressions (`${{ }}`) and GitHub's conversions between them, matching
 * the evaluator the pinned runner links (gitea.dev/actionslib v1.5.2, a port of GitHub's
 * actions/runner evaluator) so a field means the same before and after dispatch.
 *
 * Objects are `Map`s keyed by the user's text, never plain objects, so `__proto__` and
 * friends are ordinary keys. Objects Fyrden builds (`exprObject`, `fromWorkflowValue`) keep
 * their keys in code point order, as the runner orders its Go maps; objects `fromJSON` reads
 * keep document order and never hold two keys equal ignoring case, as GitHub's reader merges
 * them.
 */
import type { Value } from "./workflow-schema.js";

export type ExprValue = null | boolean | number | string | ExprArray | ExprObject;

export interface ExprArray {
  readonly kind: "array";
  readonly items: readonly ExprValue[];
}

export interface ExprObject {
  readonly kind: "object";
  /** Keys as given; see the file comment for their order. */
  readonly entries: ReadonlyMap<string, ExprValue>;
}

/** Nested arrays and objects `fromJSON` reads; the runner's limit. */
export const MAX_JSON_DEPTH = 64;
/** Nested arrays and objects `toJSON` writes; the runner's limit. */
export const MAX_JSON_WRITE_DEPTH = 100;

export function exprArray(items: Iterable<ExprValue>): ExprArray {
  return { kind: "array", items: [...items] };
}

/** An object with keys in code point order; an exact repeat of a key replaces its value. */
export function exprObject(entries: Iterable<readonly [string, ExprValue]>): ExprObject {
  const map = new Map<string, ExprValue>();
  for (const [key, value] of entries) map.set(key, value);
  const sorted = [...map].sort(([left], [right]) => compareCodePoints(left, right));
  return { kind: "object", entries: new Map(sorted) };
}

/** A positioned YAML value (matrix values) as an expression value. */
export function fromWorkflowValue(value: Value): ExprValue {
  switch (value.kind) {
    case "scalar":
      return value.value;
    case "sequence":
      return exprArray(value.items.map(fromWorkflowValue));
    case "mapping":
      return exprObject(value.entries.map(([key, item]) => [key.value, fromWorkflowValue(item)]));
  }
}

/** Null, booleans, numbers and strings. */
export function isPrimitive(value: ExprValue): value is null | boolean | number | string {
  return value === null || typeof value !== "object";
}

/** Falsy: false, 0, -0, NaN, '' and null; arrays and objects are truthy. */
export function isTruthy(value: ExprValue): boolean {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value !== "";
  return true;
}

/** GitHub's conversion to a number: null 0, booleans 1 and 0, strings parsed, collections NaN. */
export function toExprNumber(value: ExprValue): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseNumberText(value);
  return Number.NaN;
}

/** GitHub's conversion to a string; arrays and objects are 'Array' and 'Object'. */
export function toExprString(value: ExprValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return value;
  return value.kind === "array" ? "Array" : "Object";
}

/**
 * .NET's `G15` with the invariant culture, as GitHub writes numbers: 15 significant digits,
 * trailing zeros dropped, scientific notation (`1E+15`, `1E-05`) when the exponent is below
 * -4 or at least 15; `-0` is `0`. An exact half rounds to even, as Go's `FormatFloat` (the
 * runner's) does, where `toExponential` would round it up.
 */
export function formatNumber(value: number): string {
  if (value === 0) return "0";
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  const sign = value < 0 ? "-" : "";
  const { digits: rounded, exponent } = significant(Math.abs(value));
  const digits = rounded.replace(/0+$/, "");
  if (exponent < -4 || exponent >= 15) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
    const exponentSign = exponent < 0 ? "-" : "+";
    return `${sign}${digits[0]}${fraction}E${exponentSign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  const fraction = digits.slice(exponent + 1);
  return fraction === "" ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/** The 15 significant digits of a positive finite number, half to even, and its exponent. */
function significant(value: number): { digits: string; exponent: number } {
  const split = (text: string) => {
    const [mantissa = "", exponent = "0"] = text.split("e");
    return { digits: mantissa.replace(".", ""), exponent: Number(exponent) };
  };
  const up = split(value.toExponential(14));
  const sixteen = split(value.toExponential(15));
  if (sixteen.digits[15] !== "5") return up;
  const exact = exactDigits(value);
  if (
    exact.digits !== sixteen.digits.slice(0, 16).replace(/0+$/, "") ||
    exact.exponent !== sixteen.exponent
  )
    return up;
  const down = sixteen.digits.slice(0, 15);
  return Number(down[14]) % 2 === 0 ? { digits: down, exponent: sixteen.exponent } : up;
}

/** The exact decimal digits of a positive finite double (no trailing zeros) and its exponent. */
function exactDigits(value: number): { digits: string; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  let power: number;
  if (biased === 0) power = -1074;
  else {
    mantissa |= 1n << 52n;
    power = biased - 1075;
  }
  const scaled = power >= 0 ? mantissa << BigInt(power) : mantissa * 5n ** BigInt(-power);
  const text = scaled.toString();
  const exponent = text.length - 1 + Math.min(power, 0);
  return { digits: text.replace(/0+$/, ""), exponent };
}

const HEX = /^0x[0-9a-fA-F]+$/;
const OCTAL = /^0o[0-7]+$/;
const INFINITY = /^([+-]?)infinity$/i;

/** `[+-]? digits [. digits] [(e|E) [+-]? digits]` with a digit before or after the point: linear. */
function isDecimal(text: string): boolean {
  let i = 0;
  const digits = () => {
    const start = i;
    while (i < text.length && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
    return i - start;
  };
  if (text[i] === "+" || text[i] === "-") i++;
  let count = digits();
  if (text[i] === ".") {
    i++;
    count += digits();
  }
  if (count === 0) return false;
  if (text[i] === "e" || text[i] === "E") {
    i++;
    if (text[i] === "+" || text[i] === "-") i++;
    if (digits() === 0) return false;
  }
  return i === text.length;
}

/** Whether a UTF-16 unit is white space as the runner (Go's `unicode.IsSpace`) reads it. */
export function isSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** The text without leading and trailing white space, by the runner's definition of it. */
export function trimSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text.charCodeAt(start))) start++;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

/**
 * GitHub's string-to-number conversion (`ExpressionUtility.ParseNumber`): trimmed; empty is 0;
 * a decimal with sign, point and exponent; `0x…` and `0o…` as signed 32-bit integers;
 * `Infinity` in any case with an optional sign (.NET's `Double.TryParse`); otherwise NaN.
 */
export function parseNumberText(text: string): number {
  const trimmed = trimSpace(text);
  if (trimmed === "") return 0;
  if (isDecimal(trimmed)) return Number(trimmed);
  const based = parseBased(trimmed);
  if (based !== undefined) return based;
  const infinity = INFINITY.exec(trimmed);
  if (infinity) return infinity[1] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  return Number.NaN;
}

/** A `0x` or `0o` literal as a signed 32-bit value, or undefined (not one, or past 32 bits). */
function parseBased(text: string): number | undefined {
  let unsigned: number;
  if (HEX.test(text)) unsigned = Number.parseInt(text.slice(2), 16);
  else if (OCTAL.test(text)) unsigned = Number.parseInt(text.slice(2), 8);
  else return undefined;
  return unsigned <= 0xffff_ffff ? unsigned | 0 : undefined;
}

/**
 * A number literal as the expression lexer reads it, or undefined if it is not one: a
 * decimal, a `0x` or `0o` 32-bit literal, or `±Infinity` in any case.
 */
export function parseNumberLiteral(text: string): number | undefined {
  if (/^[+-]infinity$/i.test(text)) {
    return text.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (text.length > 2 && (text.startsWith("0x") || text.startsWith("0o"))) return parseBased(text);
  return isDecimal(text) ? Number(text) : undefined;
}

/** Strings by code point, as Go compares UTF-8 bytes (JavaScript's `<` compares UTF-16 units). */
export function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const a = left.charCodeAt(i);
    const b = right.charCodeAt(i);
    if (a === b) continue;
    // Surrogates (astral code points) sort after every other BMP unit at or above U+E000.
    const surrogateA = a >= 0xd800 && a <= 0xdfff;
    const surrogateB = b >= 0xd800 && b <= 0xdfff;
    if (surrogateA !== surrogateB && (a >= 0xe000 || b >= 0xe000)) return surrogateA ? 1 : -1;
    return a - b;
  }
  return left.length - right.length;
}

/**
 * Code points whose full uppercase (what JavaScript's `toUpperCase()` gives) is more than one
 * code point, mapped to their simple uppercase as Go's `unicode.ToUpper` (Unicode 15.0, the
 * runner's) gives it: the ones listed in `KEEP` have none and stay themselves. Generated from
 * V8 (Unicode 17.0) and Go 1.25's tables on 2026-11-13; a test checks every code point V8
 * expands is here.
 */
const KEEP = [
  0xdf, 0x149, 0x1f0, 0x390, 0x3b0, 0x587, 0x1e96, 0x1e97, 0x1e98, 0x1e99, 0x1e9a, 0x1f50, 0x1f52,
  0x1f54, 0x1f56, 0x1f88, 0x1f89, 0x1f8a, 0x1f8b, 0x1f8c, 0x1f8d, 0x1f8e, 0x1f8f, 0x1f98, 0x1f99,
  0x1f9a, 0x1f9b, 0x1f9c, 0x1f9d, 0x1f9e, 0x1f9f, 0x1fa8, 0x1fa9, 0x1faa, 0x1fab, 0x1fac, 0x1fad,
  0x1fae, 0x1faf, 0x1fb2, 0x1fb4, 0x1fb6, 0x1fb7, 0x1fbc, 0x1fc2, 0x1fc4, 0x1fc6, 0x1fc7, 0x1fcc,
  0x1fd2, 0x1fd3, 0x1fd6, 0x1fd7, 0x1fe2, 0x1fe3, 0x1fe4, 0x1fe6, 0x1fe7, 0x1ff2, 0x1ff4, 0x1ff6,
  0x1ff7, 0x1ffc, 0xfb00, 0xfb01, 0xfb02, 0xfb03, 0xfb04, 0xfb05, 0xfb06, 0xfb13, 0xfb14, 0xfb15,
  0xfb16, 0xfb17,
];
const SIMPLE: readonly (readonly [number, number])[] = [
  [0x1f80, 0x1f88],
  [0x1f81, 0x1f89],
  [0x1f82, 0x1f8a],
  [0x1f83, 0x1f8b],
  [0x1f84, 0x1f8c],
  [0x1f85, 0x1f8d],
  [0x1f86, 0x1f8e],
  [0x1f87, 0x1f8f],
  [0x1f90, 0x1f98],
  [0x1f91, 0x1f99],
  [0x1f92, 0x1f9a],
  [0x1f93, 0x1f9b],
  [0x1f94, 0x1f9c],
  [0x1f95, 0x1f9d],
  [0x1f96, 0x1f9e],
  [0x1f97, 0x1f9f],
  [0x1fa0, 0x1fa8],
  [0x1fa1, 0x1fa9],
  [0x1fa2, 0x1faa],
  [0x1fa3, 0x1fab],
  [0x1fa4, 0x1fac],
  [0x1fa5, 0x1fad],
  [0x1fa6, 0x1fae],
  [0x1fa7, 0x1faf],
  [0x1fb3, 0x1fbc],
  [0x1fc3, 0x1fcc],
  [0x1ff3, 0x1ffc],
];
export const EXPANDING_UPPERCASE: ReadonlyMap<number, number> = new Map([
  ...KEEP.map((cp) => [cp, cp] as const),
  ...SIMPLE,
]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: the whole ASCII range, controls included
const ASCII = /^[\x00-\x7f]*$/;

/** One code point's simple uppercase, except that non-ASCII never maps into ASCII (`ı`, `ſ`). */
function upperCodePoint(cp: number): number {
  if (cp < 0x80) return cp >= 0x61 && cp <= 0x7a ? cp - 0x20 : cp;
  const listed = EXPANDING_UPPERCASE.get(cp);
  if (listed !== undefined) return listed;
  const upper = String.fromCodePoint(cp).toUpperCase().codePointAt(0) ?? cp;
  return upper < 0x80 ? cp : upper;
}

/** The text with every code point uppercased as GitHub's ordinal ignore-case comparison does. */
export function foldCase(text: string): string {
  if (ASCII.test(text)) return text.toUpperCase();
  let folded = "";
  for (const character of text)
    folded += String.fromCodePoint(upperCodePoint(character.codePointAt(0) ?? 0));
  return folded;
}

/** .NET `OrdinalIgnoreCase`: negative, zero or positive as `left` sorts before, with or after `right`. */
export function compareIgnoreCase(left: string, right: string): number {
  return compareCodePoints(foldCase(left), foldCase(right));
}

export function equalsIgnoreCase(left: string, right: string): boolean {
  return foldCase(left) === foldCase(right);
}

// --- JSON -----------------------------------------------------------------------------------

export type JsonRead =
  | { readonly ok: true; readonly value: ExprValue }
  | { readonly ok: false; readonly message: string };

type Frame =
  | { readonly kind: "array"; readonly items: ExprValue[] }
  | {
      readonly kind: "object";
      /** By exact key: the last value, at the key's first position. */
      readonly entries: Map<string, ExprValue>;
      key: string;
    };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WHITESPACE = /[ \t\n\r]*/y;

/**
 * Strict RFC 8259 JSON (GitHub's reader is lenient; Fyrden is not, see the design note), read
 * without recursion and without `JSON.parse`, so nesting is bounded by `maxDepth` and keys
 * stay data. Keys merge as GitHub's reader merges them: an exact repeat keeps the last value
 * at the first position, then a key equal to an earlier one ignoring case replaces that one's
 * value and keeps its spelling.
 */
export function readJson(text: string, maxDepth = MAX_JSON_DEPTH): JsonRead {
  let position = 0;
  const stack: Frame[] = [];

  const fail = (reason: string): JsonRead => {
    const found = text[position];
    const quotes =
      found === "'" || (reason.includes("key") && found !== undefined && /[A-Za-z_$]/.test(found));
    const hint = quotes ? " (strings and keys need double quotes)" : "";
    return {
      ok: false,
      message: `not valid JSON (RFC 8259): ${reason} at character ${position + 1}${hint}`,
    };
  };
  const skip = () => {
    WHITESPACE.lastIndex = position;
    WHITESPACE.exec(text);
    position = WHITESPACE.lastIndex;
  };
  const readString = (): string | undefined => {
    position++;
    let value = "";
    let start = position;
    while (position < text.length) {
      const code = text.charCodeAt(position);
      if (code === 0x22) {
        value += text.slice(start, position);
        position++;
        // The runner's Go strings hold no unpaired surrogates: it reads them as U+FFFD.
        return value.toWellFormed();
      }
      if (code < 0x20) return undefined;
      if (code === 0x5c) {
        value += text.slice(start, position);
        const escaped = text[position + 1];
        const simple = escaped === undefined ? undefined : SIMPLE_ESCAPES.get(escaped);
        if (simple !== undefined) {
          value += simple;
          position += 2;
        } else if (
          escaped === "u" &&
          /^[0-9a-fA-F]{4}$/.test(text.slice(position + 2, position + 6))
        ) {
          value += String.fromCharCode(Number.parseInt(text.slice(position + 2, position + 6), 16));
          position += 6;
        } else {
          return undefined;
        }
        start = position;
        continue;
      }
      position++;
    }
    return undefined;
  };
  /** After `{` or `,` in an object: the key and its colon. */
  const readKey = (frame: Frame & { kind: "object" }): string | undefined => {
    skip();
    if (text[position] !== '"') return "a string key";
    const key = readString();
    if (key === undefined) return "an invalid string";
    skip();
    if (text[position] !== ":") return "':' after a key";
    position++;
    frame.key = key;
    return undefined;
  };

  for (;;) {
    // A value starts here.
    skip();
    let value: ExprValue;
    const character = text[position];
    if (character === "[" || character === "{") {
      if (stack.length + 1 > maxDepth) return fail(`nesting deeper than ${maxDepth}`);
      position++;
      skip();
      if (character === "[") {
        if (text[position] === "]") {
          position++;
          value = exprArray([]);
        } else {
          stack.push({ kind: "array", items: [] });
          continue;
        }
      } else if (text[position] === "}") {
        position++;
        value = { kind: "object", entries: new Map() };
      } else {
        const frame: Frame = { kind: "object", entries: new Map(), key: "" };
        const problem = readKey(frame);
        if (problem !== undefined) return fail(`expected ${problem}`);
        stack.push(frame);
        continue;
      }
    } else if (character === '"') {
      const string = readString();
      if (string === undefined) return fail("an invalid string");
      value = string;
    } else if (character === "t" && text.startsWith("true", position)) {
      position += 4;
      value = true;
    } else if (character === "f" && text.startsWith("false", position)) {
      position += 5;
      value = false;
    } else if (character === "n" && text.startsWith("null", position)) {
      position += 4;
      value = null;
    } else {
      NUMBER.lastIndex = position;
      const match = NUMBER.exec(text);
      if (!match || match[0] === "" || match[0] === "-") return fail("expected a value");
      position = NUMBER.lastIndex;
      value = Number(match[0]);
    }

    // Attach the value to the containers it closes.
    for (;;) {
      const frame = stack.at(-1);
      if (frame === undefined) {
        skip();
        if (position !== text.length) return fail("text after the value");
        return { ok: true, value };
      }
      if (frame.kind === "array") frame.items.push(value);
      else frame.entries.set(frame.key, value);
      skip();
      const next = text[position];
      const close = frame.kind === "array" ? "]" : "}";
      if (next === ",") {
        position++;
        if (frame.kind === "object") {
          const problem = readKey(frame);
          if (problem !== undefined) return fail(`expected ${problem}`);
        }
        break;
      }
      if (next !== close) return fail(`expected ',' or '${close}'`);
      position++;
      stack.pop();
      value =
        frame.kind === "array"
          ? exprArray(frame.items)
          : { kind: "object", entries: foldKeys(frame.entries) };
    }
  }
}

/** Keys equal ignoring case merged into the first spelling, the later value winning. */
function foldKeys(exact: ReadonlyMap<string, ExprValue>): Map<string, ExprValue> {
  const merged = new Map<string, ExprValue>();
  const spelling = new Map<string, string>();
  for (const [key, value] of exact) {
    const fold = foldCase(key);
    const first = spelling.get(fold);
    if (first === undefined) spelling.set(fold, key);
    merged.set(first ?? key, value);
  }
  return merged;
}

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

export type JsonWrite =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: "limit_exceeded"; readonly message: string };

export interface JsonWriteLimits {
  /** Bytes of tokens, in GitHub's sizes (26 + 2 per unit, a token being one value, key or bracket with the separator before it). */
  readonly maxBytes?: number;
  /** Called before each step with the units it is about to read or write; may throw to stop. */
  readonly work?: (units: number) => void;
}

type Open =
  | { readonly kind: "array"; readonly items: readonly ExprValue[]; index: number }
  | { readonly kind: "object"; readonly entries: Iterator<[string, ExprValue]>; first: boolean };

/**
 * GitHub's `toJSON` pretty print: two spaces per level, `": "` after keys, `[]` and `{}` when
 * empty, numbers as G15, keys in the object's order. Written step by step without recursion
 * or copies of the input, charging each token as the runner's writer does, so it stops past
 * `maxBytes`, past `MAX_JSON_WRITE_DEPTH` nested containers, or when `work` throws.
 */
export function writeJson(value: ExprValue, limits: JsonWriteLimits = {}): JsonWrite {
  const maxBytes = limits.maxBytes ?? Number.POSITIVE_INFINITY;
  const work = limits.work ?? (() => {});
  const parts: string[] = [];
  let token = 0;
  let bytes = 0;
  const emit = (part: string) => {
    parts.push(part);
    token += part.length;
  };
  /** Bills everything written since the last charge as one token; false once over the limit. */
  const charge = (): boolean => {
    bytes += 26 + 2 * token;
    token = 0;
    return bytes <= maxBytes;
  };
  const tooLarge: JsonWrite = {
    ok: false,
    code: "limit_exceeded",
    message: "toJSON: the result is larger than the memory limit",
  };
  const stack: Open[] = [];
  let pending: ExprValue | undefined = value;

  for (;;) {
    if (pending !== undefined) {
      const current: ExprValue = pending;
      pending = undefined;
      work(1);
      if (stack.length > MAX_JSON_WRITE_DEPTH) {
        return {
          ok: false,
          code: "limit_exceeded",
          message: `toJSON: the value nests deeper than ${MAX_JSON_WRITE_DEPTH}`,
        };
      }
      if (current !== null && typeof current === "object") {
        if (current.kind === "array" ? current.items.length === 0 : current.entries.size === 0) {
          emit(current.kind === "array" ? "[]" : "{}");
        } else {
          emit(current.kind === "array" ? "[" : "{");
          stack.push(
            current.kind === "array"
              ? { kind: "array", items: current.items, index: 0 }
              : { kind: "object", entries: current.entries[Symbol.iterator](), first: true },
          );
        }
      } else if (typeof current === "string") {
        work(current.length);
        emit(jsonString(current));
      } else emit(current === null ? "null" : toExprString(current));
      if (!charge()) return tooLarge;
    }
    const open = stack.at(-1);
    if (open === undefined) return { ok: true, text: parts.join("") };
    let next: { key?: string; item: ExprValue } | undefined;
    let first: boolean;
    if (open.kind === "array") {
      first = open.index === 0;
      if (open.index < open.items.length) next = { item: open.items[open.index++] as ExprValue };
    } else {
      first = open.first;
      open.first = false;
      const entry = open.entries.next();
      if (!entry.done) next = { key: entry.value[0], item: entry.value[1] };
    }
    if (next === undefined) {
      stack.pop();
      emit(`\n${"  ".repeat(stack.length)}${open.kind === "array" ? "]" : "}"}`);
      if (!charge()) return tooLarge;
      continue;
    }
    emit(`${first ? "" : ","}\n${"  ".repeat(stack.length)}`);
    if (next.key !== undefined) {
      work(next.key.length);
      emit(jsonString(next.key));
      if (!charge()) return tooLarge;
      emit(": ");
    }
    pending = next.item;
  }
}

/** A JSON string as GitHub's writer quotes it: `"` `\` and controls escaped, the rest as is. */
function jsonString(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control characters
  return `"${text.replace(/["\\\u0000-\u001f]/g, (c) => JSON_ESCAPES.get(c) ?? `\\u00${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}"`;
}

const JSON_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
]);
