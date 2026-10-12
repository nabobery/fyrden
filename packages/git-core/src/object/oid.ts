import { copyBytes } from "./bytes.js";

declare const oidBrand: unique symbol;

/**
 * A git object id: the 20-byte SHA-1 of an object. Ids stay binary inside
 * the engine; hex appears only at the edges (protocol lines, object headers,
 * logs). SHA-256 repositories are not supported in v1.
 */
export type Oid = Uint8Array<ArrayBuffer> & { readonly [oidBrand]: true };

export const OID_BYTES = 20;
export const OID_HEX_LENGTH = 40;

const HEX_PAIRS = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/**
 * Copies 20 bytes into a new oid. Copying means an oid read out of a large
 * pack buffer does not keep that buffer alive.
 */
export function oidFromBytes(bytes: Uint8Array, offset = 0): Oid {
  if (!Number.isInteger(offset) || offset < 0 || offset + OID_BYTES > bytes.length) {
    throw new RangeError(`no ${OID_BYTES}-byte object id at offset ${offset}`);
  }
  return copyBytes(bytes, offset, offset + OID_BYTES) as Oid;
}

/** Value of one hex digit (either case, as git's `hexval`), or -1. */
function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  const lower = code | 0x20;
  if (lower >= 0x61 && lower <= 0x66) return lower - 0x61 + 10;
  return -1;
}

/**
 * Parses 40 hex digits starting at `offset`, or returns undefined. Like
 * git's `parse_oid_hex`, it accepts either case and does not look past the
 * 40th digit; the caller checks what follows.
 */
export function parseOidHex(bytes: Uint8Array, offset: number): Oid | undefined {
  if (offset < 0 || offset + OID_HEX_LENGTH > bytes.length) return undefined;
  const oid = new Uint8Array(OID_BYTES);
  for (let i = 0; i < OID_BYTES; i++) {
    const hi = hexValue(bytes[offset + 2 * i] as number);
    const lo = hexValue(bytes[offset + 2 * i + 1] as number);
    if (hi < 0 || lo < 0) return undefined;
    oid[i] = (hi << 4) | lo;
  }
  return oid as Oid;
}

/** Parses exactly 40 hex digits (either case). */
export function oidFromHex(hex: string): Oid {
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new RangeError(`not a ${OID_HEX_LENGTH}-digit hex object id`);
  }
  return parseOidHex(new TextEncoder().encode(hex), 0) as Oid;
}

/** Lowercase hex, as git prints ids. */
export function oidToHex(oid: Oid): string {
  let hex = "";
  for (let i = 0; i < OID_BYTES; i++) hex += HEX_PAIRS[oid[i] as number];
  return hex;
}

/** Bytewise order: the order of pack index entries and protocol `have` lists. */
export function compareOids(a: Oid, b: Oid): number {
  for (let i = 0; i < OID_BYTES; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

export function oidEquals(a: Oid, b: Oid): boolean {
  return compareOids(a, b) === 0;
}

/**
 * All zeros: "no object" in ref updates and protocol lines. A new array each
 * call, because typed arrays cannot be frozen and a shared one could be
 * overwritten.
 */
export function zeroOid(): Oid {
  return new Uint8Array(OID_BYTES) as Oid;
}

export function isZeroOid(oid: Oid): boolean {
  return oid.every((b) => b === 0);
}
