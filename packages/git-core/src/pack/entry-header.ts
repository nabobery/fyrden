import type { ObjectType } from "../object/object.js";
import { OID_BYTES, type Oid, oidFromBytes } from "../object/oid.js";
import { PackError } from "./errors.js";

/*
 * Pack and entry headers (git Documentation/gitformat-pack.txt; decoding
 * follows builtin/index-pack.c and packfile.c of git v2.53.0).
 */

export const PACK_HEADER_BYTES = 12;
export const PACK_TRAILER_BYTES = OID_BYTES;
const SIGNATURE = 0x5041434b; // "PACK"

/** What an entry holds: a whole object, or a delta against a base. */
export type EntryKind = ObjectType | "ofs-delta" | "ref-delta";

/** Entry type codes as stored in packs (git object.h). 0 and 5 are reserved. */
export const ENTRY_TYPE_CODES: Readonly<Record<EntryKind, number>> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
  "ofs-delta": 6,
  "ref-delta": 7,
};
const KIND_BY_CODE: readonly (EntryKind | undefined)[] = [
  undefined,
  "commit",
  "tree",
  "blob",
  "tag",
  undefined,
  "ofs-delta",
  "ref-delta",
];

export type EntryHeaderFields =
  | { readonly kind: ObjectType; readonly size: number }
  /** `baseOffset` is the absolute pack offset of the base entry. */
  | { readonly kind: "ofs-delta"; readonly size: number; readonly baseOffset: number }
  | { readonly kind: "ref-delta"; readonly size: number; readonly baseOid: Oid };

/** A decoded entry header; `length` is its encoded length in bytes. */
export type EntryHeader = EntryHeaderFields & { readonly length: number };

export interface PackHeader {
  readonly version: 2 | 3;
  readonly objectCount: number;
}

/** Parses the 12-byte pack header. Versions 2 and 3 have the same layout (git `pack_version_ok`). */
export function decodePackHeader(bytes: Uint8Array): PackHeader {
  if (bytes.length < PACK_HEADER_BYTES)
    throw new PackError("truncated", "pack header is incomplete");
  const view = new DataView(bytes.buffer, bytes.byteOffset, PACK_HEADER_BYTES);
  if (view.getUint32(0) !== SIGNATURE) throw new PackError("bad-header", "pack signature mismatch");
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) {
    throw new PackError("bad-header", `pack version ${version} unsupported`);
  }
  return { version, objectCount: view.getUint32(8) };
}

export function encodePackHeader(objectCount: number, version: 2 | 3 = 2): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(objectCount) || objectCount < 0 || objectCount > 0xffffffff) {
    throw new RangeError(`bad object count ${objectCount}`);
  }
  const out = new Uint8Array(PACK_HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, SIGNATURE);
  view.setUint32(4, version);
  view.setUint32(8, objectCount);
  return out;
}

// git's packfile.c refuses a size whose next 7 bits would shift past 64; the
// first byte has 4 bits, so at most 9 continuation bytes.
const MAX_SIZE_BYTES = 10;
// An OFS distance of 10 bytes already exceeds 2^63; any real one is shorter.
const MAX_OFS_BYTES = 10;

/**
 * Decodes the entry header at `bytes[start]` for the entry at pack offset
 * `entryOffset`. Returns undefined when `bytes` ends first, so a streaming
 * caller can wait for more input. A size above `maxSize` is rejected while
 * decoding, before anything is inflated or allocated.
 */
export function decodeEntryHeader(
  bytes: Uint8Array,
  start: number,
  entryOffset: number,
  maxSize: number,
): EntryHeader | undefined {
  let pos = start;
  if (pos >= bytes.length) return undefined;
  let byte = bytes[pos++] as number;
  const kind = KIND_BY_CODE[(byte >> 4) & 7];
  if (kind === undefined) {
    throw new PackError("bad-entry-header", `unknown object type ${(byte >> 4) & 7}`, entryOffset);
  }
  let size = byte & 0x0f;
  let scale = 16;
  while (byte & 0x80) {
    if (pos - start >= MAX_SIZE_BYTES) {
      throw new PackError("bad-entry-header", "object size encoding is too long", entryOffset);
    }
    if (pos >= bytes.length) return undefined;
    byte = bytes[pos++] as number;
    size += (byte & 0x7f) * scale;
    scale *= 128;
    if (size > maxSize) {
      throw new PackError(
        "object-too-large",
        `entry size above the ${maxSize}-byte cap`,
        entryOffset,
      );
    }
  }
  if (size > maxSize) {
    throw new PackError(
      "object-too-large",
      `entry size above the ${maxSize}-byte cap`,
      entryOffset,
    );
  }

  if (kind === "ref-delta") {
    if (pos + OID_BYTES > bytes.length) return undefined;
    const baseOid = oidFromBytes(bytes, pos);
    return { kind, size, baseOid, length: pos + OID_BYTES - start };
  }
  if (kind === "ofs-delta") {
    // Big-endian base 128 where each continuation adds one (index-pack.c).
    const first = pos;
    if (pos >= bytes.length) return undefined;
    byte = bytes[pos++] as number;
    let distance = byte & 0x7f;
    while (byte & 0x80) {
      if (pos - first >= MAX_OFS_BYTES || distance >= entryOffset) {
        throw new PackError(
          "bad-delta-base-offset",
          "delta base offset is out of bound",
          entryOffset,
        );
      }
      if (pos >= bytes.length) return undefined;
      byte = bytes[pos++] as number;
      distance = (distance + 1) * 128 + (byte & 0x7f);
    }
    const baseOffset = entryOffset - distance;
    if (distance <= 0 || baseOffset < PACK_HEADER_BYTES) {
      throw new PackError(
        "bad-delta-base-offset",
        "delta base offset is out of bound",
        entryOffset,
      );
    }
    return { kind, size, baseOffset, length: pos - start };
  }
  return { kind, size, length: pos - start };
}

/** Encodes an entry header as git's pack-objects does, for the entry at `entryOffset`. */
export function encodeEntryHeader(
  fields: EntryHeaderFields,
  entryOffset: number,
): Uint8Array<ArrayBuffer> {
  const { size } = fields;
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`bad entry size ${size}`);
  const out: number[] = [];
  let c = (ENTRY_TYPE_CODES[fields.kind] << 4) | (size % 16);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(c | 0x80);
    c = rest % 128;
    rest = Math.floor(rest / 128);
  }
  out.push(c);
  if (fields.kind === "ref-delta") {
    out.push(...fields.baseOid);
  } else if (fields.kind === "ofs-delta") {
    const distance = entryOffset - fields.baseOffset;
    if (!Number.isSafeInteger(distance) || distance <= 0 || fields.baseOffset < PACK_HEADER_BYTES) {
      throw new RangeError(`bad OFS_DELTA base offset ${fields.baseOffset}`);
    }
    const ofs = [distance % 128];
    let more = Math.floor(distance / 128);
    while (more > 0) {
      more -= 1;
      ofs.unshift(0x80 | (more % 128));
      more = Math.floor(more / 128);
    }
    out.push(...ofs);
  }
  return new Uint8Array(out);
}
