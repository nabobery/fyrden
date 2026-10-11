import { concatBytes, latin1, latin1Bytes } from "./bytes.js";
import { GitObjectError } from "./fsck.js";

/** A commit or tag header after the required ones: `gpgsig`, `encoding`, `mergetag`, or unknown. */
export interface Header {
  /** The text before the first space. Empty for a continuation line with no header before it. */
  readonly key: string;
  /** Continuation lines are joined with LF, without their leading space. */
  readonly value: Uint8Array;
}

const LF = 0x0a;
const SPACE = 0x20;

/**
 * git's `verify_headers`: the headers must end with a blank line, or the
 * object must end with a newline, and contain no NUL. Returns the offset of
 * the blank line (the end of the headers), or the body length when there is
 * no message.
 */
export function verifyHeaders(body: Uint8Array): number {
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === 0) throw new GitObjectError("nulInHeader", `unterminated header: NUL at offset ${i}`);
    if (c === LF && body[i + 1] === LF) return i + 1;
  }
  if (body.length > 0 && body[body.length - 1] === LF) return body.length;
  throw new GitObjectError("unterminatedHeader", "unterminated header");
}

/**
 * Reads header lines from `start` up to the end of the headers. Each
 * header's value is built in one copy, continuation lines included, so a
 * header of a million lines costs one array, not one per line.
 */
export function readHeaders(body: Uint8Array, start: number, end: number): Header[] {
  const headers: Header[] = [];
  for (let p = start; p < end; ) {
    // The first line: `key value`, `key` alone, or a continuation line with
    // no header before it (key "").
    const nl = body.indexOf(LF, p);
    let key = "";
    let from = p + 1;
    if (body[p] !== SPACE) {
      let space = p;
      while (space < nl && body[space] !== SPACE) space++;
      key = latin1(body.subarray(p, space));
      from = space < nl ? space + 1 : nl;
    }
    // The value's length: the rest of the first line, then LF and each
    // continuation line without its leading space.
    let length = nl - from;
    let next = nl + 1;
    while (next < end && body[next] === SPACE) {
      const lineEnd = body.indexOf(LF, next);
      length += lineEnd - next;
      next = lineEnd + 1;
    }
    const value = new Uint8Array(length);
    let at = 0;
    for (let i = from; i < nl; i++) value[at++] = body[i] as number;
    for (let q = nl + 1; q < next; ) {
      const lineEnd = body.indexOf(LF, q);
      value[at++] = LF;
      for (let i = q + 1; i < lineEnd; i++) value[at++] = body[i] as number;
      q = lineEnd + 1;
    }
    headers.push({ key, value });
    p = next;
  }
  return headers;
}

/**
 * The headers of `body` from `start` to `end`, read on first use: parsing
 * an object for its checks allocates nothing for them.
 */
export function lazyHeaders(body: Uint8Array, start: number, end: number): () => readonly Header[] {
  let headers: readonly Header[] | undefined;
  return () => {
    headers ??= readHeaders(body, start, end);
    return headers;
  };
}

/** `key value`, with each LF in the value followed by a space (a continuation line). */
export function encodeHeader({ key, value }: Header): Uint8Array<ArrayBuffer> {
  // One byte per character, and any byte but space, LF and NUL, so the key parses back unchanged.
  const keyOk =
    key.length > 0 &&
    [...key].every((c) => {
      const code = c.charCodeAt(0);
      return code > 0 && code <= 0xff && code !== SPACE && code !== LF;
    });
  if (!keyOk) throw new RangeError("a header key must be non-empty, without space, LF or NUL");
  if (value.includes(0)) throw new RangeError("a header value cannot contain NUL");
  const parts: Uint8Array[] = [latin1Bytes(`${key} `)];
  let start = 0;
  for (let nl = value.indexOf(LF); nl >= 0; nl = value.indexOf(LF, nl + 1)) {
    parts.push(value.subarray(start, nl + 1), Uint8Array.of(SPACE));
    start = nl + 1;
  }
  parts.push(value.subarray(start), Uint8Array.of(LF));
  return concatBytes(parts);
}
