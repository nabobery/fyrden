/*
 * The two pieces of the expression language a matrix needs, so `include`
 * and `exclude` match as `${{ matrix.x == 'y' }}` would: the ordinal key
 * fold and `==` on scalars. These follow the expression language's rules
 * for the cases matrices hold (ASCII and simple Unicode case; numbers
 * exactly as the language converts them); the evaluator's own functions
 * replace them when it lands.
 */
import type { MatrixValue } from "./matrix.js";

/** The key uppercased as GitHub's ordinal ignore-case comparison does; non-ASCII never folds into ASCII. */
export function foldKey(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the whole ASCII range, controls included
  if (/^[\x00-\x7f]*$/.test(text)) return text.toUpperCase();
  let folded = "";
  for (const character of text) {
    const cp = character.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      folded += character.toUpperCase();
      continue;
    }
    const upper = character.toUpperCase();
    const single = [...upper].length === 1 ? (upper.codePointAt(0) ?? cp) : cp;
    folded += String.fromCodePoint(single < 0x80 ? cp : single);
  }
  return folded;
}

/** `==` between two values: strings ignoring case, null with null, booleans exactly, else as numbers. */
export function looseEquals(left: MatrixValue, right: MatrixValue): boolean {
  if (typeof left === "string" && typeof right === "string")
    return foldKey(left) === foldKey(right);
  const leftCollection = left !== null && typeof left === "object";
  const rightCollection = right !== null && typeof right === "object";
  if (leftCollection && rightCollection) return left === right;
  if (left === null && right === null) return true;
  if (typeof left === "boolean" && typeof right === "boolean") return left === right;
  return toNumber(left) === toNumber(right);
}

/** GitHub's string-to-number conversion: trimmed; empty is 0; decimal, 32-bit `0x`/`0o`, or `Infinity`. */
function toNumber(value: MatrixValue): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const text = trimSpace(value);
  if (text === "") return 0;
  if (isDecimal(text)) return Number(text);
  let unsigned: number | undefined;
  if (/^0x[0-9a-fA-F]+$/.test(text)) unsigned = Number.parseInt(text.slice(2), 16);
  else if (/^0o[0-7]+$/.test(text)) unsigned = Number.parseInt(text.slice(2), 8);
  if (unsigned !== undefined) return unsigned <= 0xffff_ffff ? unsigned | 0 : Number.NaN;
  const infinity = /^([+-]?)infinity$/i.exec(text);
  if (infinity) return infinity[1] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  return Number.NaN;
}

/** `[+-]? digits [. digits] [(e|E) [+-]? digits]` with a digit before or after the point, in one pass. */
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

/** White space as the runner (Go's `unicode.IsSpace`) reads it. */
function isSpace(code: number): boolean {
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

function trimSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text.charCodeAt(start))) start++;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}
