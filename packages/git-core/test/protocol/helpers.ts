import { expect } from "vitest";
import { ProtocolError, type ProtocolErrorCode } from "../../src/protocol/errors.js";

/** One byte per character (U+0000 to U+00FF), so test inputs can hold any byte. */
export const bin = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** The inverse of `bin`. */
export const str = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

export const concat = (...parts: Uint8Array[]): Uint8Array =>
  new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));

/** Yields `bytes` split at the given offsets (sorted and deduplicated), as a network body would. */
export async function* chunked(
  bytes: Uint8Array,
  cuts: readonly number[] = [],
): AsyncGenerator<Uint8Array> {
  const points = [...new Set(cuts.map((c) => Math.min(Math.max(c, 0), bytes.length)))].sort(
    (a, b) => a - b,
  );
  let start = 0;
  for (const point of [...points, bytes.length]) {
    yield bytes.slice(start, point);
    start = point;
  }
}

export async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of source) parts.push(part);
  return concat(...parts);
}

/** Runs `fn` and returns the ProtocolError it throws; fails the test on success or any other error. */
export async function protocolError(fn: () => unknown): Promise<ProtocolError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ProtocolError) return error;
    throw error;
  }
  throw new Error("expected a ProtocolError, but nothing was thrown");
}

export async function expectCode(fn: () => unknown, code: ProtocolErrorCode): Promise<void> {
  expect((await protocolError(fn)).code).toBe(code);
}

/** One pkt-line as a latin1 string: hex length, then `text` (whose characters are bytes). */
export const pkt = (text: string): string => (text.length + 4).toString(16).padStart(4, "0") + text;
