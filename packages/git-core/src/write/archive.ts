import { crc32 } from "../pack/crc32.js";
import type { Zlib } from "../ports/zlib.js";

/*
 * Archive formats, built a piece at a time so a large tree can be written
 * in slices and resumed: tar entries (ustar, with pax records for long
 * names, as `git archive` writes them), gzip members (a .tar.gz may be any
 * number of members; gzip reads them as one stream), and zip entries with
 * their central directory written last. Nothing here reads a repository;
 * the caller walks the tree and hands entries in.
 */

export type ArchiveEntryKind = "file" | "executable" | "symlink" | "dir" | "submodule";

export interface ArchiveEntry {
  /** The path inside the archive, prefix included, UTF-8; no trailing slash. */
  readonly path: Uint8Array;
  readonly kind: ArchiveEntryKind;
  /** A file's content or a symlink's target; empty for directories and submodules. */
  readonly data: Uint8Array;
}

const BLOCK = 512;
const encoder = new TextEncoder();

/** File modes `git archive` writes (its default `tar.umask` of 002). */
const TAR_MODE: Record<ArchiveEntryKind, number> = {
  file: 0o664,
  executable: 0o775,
  symlink: 0o777,
  dir: 0o775,
  submodule: 0o775,
};

/**
 * The pax global header `git archive` starts a tar with: the commit id, so
 * `git get-tar-commit-id` can read it back.
 */
export function tarCommitHeader(commitHex: string, mtime: number): Uint8Array {
  const records = paxRecords([["comment", encoder.encode(commitHex)]]);
  return concat([
    tarHeader(encoder.encode("pax_global_header"), "g", records.length, 0, mtime),
    pad(records),
  ]);
}

/** One tar entry: a pax header when a name or target does not fit, the header, the data. */
export function tarEntry(entry: ArchiveEntry, mtime: number): Uint8Array {
  return concat(tarEntryParts(entry, mtime));
}

/**
 * `tarEntry` unjoined: the headers, the data itself (not copied) and its
 * padding, so a large file can be compressed straight from its bytes.
 */
export function tarEntryParts(entry: ArchiveEntry, mtime: number): Uint8Array[] {
  const isDir = entry.kind === "dir" || entry.kind === "submodule";
  const name = isDir ? concat([entry.path, encoder.encode("/")]) : entry.path;
  const parts: Uint8Array[] = [];
  const pax: [string, Uint8Array][] = [];
  const split = splitName(name);
  if (!split) pax.push(["path", name]);
  const link = entry.kind === "symlink" ? entry.data : new Uint8Array(0);
  if (link.length > 100) pax.push(["linkpath", link]);
  if (pax.length > 0) {
    const records = paxRecords(pax);
    parts.push(
      tarHeader(encoder.encode("pax_header"), "x", records.length, 0, mtime),
      pad(records),
    );
  }
  const size = entry.kind === "file" || entry.kind === "executable" ? entry.data.length : 0;
  const type = isDir ? "5" : entry.kind === "symlink" ? "2" : "0";
  parts.push(
    tarHeader(split?.name ?? name.subarray(0, 100), type, size, TAR_MODE[entry.kind], mtime, {
      prefix: split?.prefix,
      link: link.length <= 100 ? link : link.subarray(0, 100),
    }),
  );
  if (size > 0) parts.push(entry.data, new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK));
  return parts;
}

/** Two zero blocks: the end of a tar. */
export function tarEnd(): Uint8Array {
  return new Uint8Array(2 * BLOCK);
}

/** A name as ustar's `prefix/name` (155 and 100 bytes), or undefined when it does not fit. */
function splitName(name: Uint8Array): { name: Uint8Array; prefix?: Uint8Array } | undefined {
  if (name.length <= 100) return { name };
  // The prefix ends at a slash; the name after it is at most 100 bytes.
  for (let at = Math.max(0, name.length - 101); at < name.length && at <= 155; at++) {
    if (name[at] !== 0x2f) continue;
    const rest = name.subarray(at + 1);
    if (rest.length > 0 && rest.length <= 100) return { name: rest, prefix: name.subarray(0, at) };
  }
  return undefined;
}

function tarHeader(
  name: Uint8Array,
  type: string,
  size: number,
  mode: number,
  mtime: number,
  extra: { prefix?: Uint8Array | undefined; link?: Uint8Array } = {},
): Uint8Array {
  const block = new Uint8Array(BLOCK);
  block.set(name.subarray(0, 100), 0);
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  // Eleven octal digits hold dates up to 2242; later ones are written as that.
  writeOctal(block, 136, 12, Math.min(Math.max(mtime, 0), MAX_OCTAL_11));
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  if (extra.link) block.set(extra.link.subarray(0, 100), 157);
  block.set(encoder.encode("ustar\0"), 257);
  block.set(encoder.encode("00"), 263);
  block.set(encoder.encode("root"), 265);
  block.set(encoder.encode("root"), 297);
  if (extra.prefix) block.set(extra.prefix.subarray(0, 155), 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  const text = sum.toString(8).padStart(6, "0");
  block.set(encoder.encode(`${text}\0 `), 148);
  return block;
}

const MAX_OCTAL_11 = 8 ** 11 - 1;

function writeOctal(block: Uint8Array, at: number, width: number, value: number): void {
  block.set(encoder.encode(`${value.toString(8).padStart(width - 1, "0")}\0`), at);
}

/** Pax records, `<length> <key>=<value>\n`, the length counting itself. */
function paxRecords(records: readonly [string, Uint8Array][]): Uint8Array {
  return concat(
    records.map(([key, value]) => {
      const body = value.length + key.length + 3; // " ", "=", "\n"
      let length = body + String(body).length;
      if (String(length).length !== String(body).length) length = body + String(length).length;
      return concat([encoder.encode(`${length} ${key}=`), value, encoder.encode("\n")]);
    }),
  );
}

function pad(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
  padded.set(bytes);
  return padded;
}

/** Raw DEFLATE (RFC 1951): the zlib stream without its header and Adler-32 trailer. */
export function deflateRaw(zlib: Zlib, bytes: Uint8Array): Uint8Array {
  const stream = zlib.deflate(bytes);
  return stream.subarray(2, stream.length - 4);
}

/** One gzip member (RFC 1952) holding `bytes`. */
export function gzipMember(zlib: Zlib, bytes: Uint8Array, mtime: number): Uint8Array {
  return concat(gzipMemberParts(zlib, bytes, mtime));
}

/** `gzipMember` as its header, compressed data and trailer, not joined. */
export function gzipMemberParts(zlib: Zlib, bytes: Uint8Array, mtime: number): Uint8Array[] {
  const header = new Uint8Array(10);
  header.set([0x1f, 0x8b, 8, 0]);
  new DataView(header.buffer).setUint32(4, mtime >>> 0, true);
  header[9] = 3; // Unix
  const trailer = new Uint8Array(8);
  const view = new DataView(trailer.buffer);
  view.setUint32(0, crc32(bytes) >>> 0, true);
  view.setUint32(4, bytes.length >>> 0, true);
  return [header, deflateRaw(zlib, bytes), trailer];
}

/** What the zip's central directory needs about one entry. */
export interface ZipRecord {
  readonly name: Uint8Array;
  /** General purpose flags: 0x0800 when the name is UTF-8. */
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly offset: number;
  readonly method: 0 | 8;
  readonly mode: number;
}

const ZIP_MODE: Record<ArchiveEntryKind, number> = {
  file: 0o100644,
  executable: 0o100755,
  symlink: 0o120777,
  dir: 0o40755,
  submodule: 0o40755,
};

/** Largest zip this writer makes: no ZIP64 records, so 16-bit counts and names, 32-bit sizes. */
export const ZIP_LIMITS = {
  maxEntries: 0xffff,
  maxNameBytes: 0xffff,
  maxBytes: 0xffff_ffff,
} as const;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isUtf8(bytes: Uint8Array): boolean {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * One zip entry (local header and data) at `offset`, and its central
 * directory record. Throws RangeError for what a zip without ZIP64 cannot
 * hold: a name over 65,535 bytes, or an entry past 4 GiB.
 */
export function zipEntry(
  zlib: Zlib,
  entry: ArchiveEntry,
  mtime: number,
  offset: number,
): { bytes: Uint8Array; record: ZipRecord } {
  const { parts, record } = zipEntryParts(zlib, entry, mtime, offset);
  return { bytes: concat(parts), record };
}

/** `zipEntry` unjoined: its local header, then its (compressed) data. */
export function zipEntryParts(
  zlib: Zlib,
  entry: ArchiveEntry,
  mtime: number,
  offset: number,
): { parts: Uint8Array[]; record: ZipRecord } {
  const isDir = entry.kind === "dir" || entry.kind === "submodule";
  const name = isDir ? concat([entry.path, encoder.encode("/")]) : entry.path;
  if (name.length > ZIP_LIMITS.maxNameBytes)
    throw new RangeError(`a zip entry name is ${ZIP_LIMITS.maxNameBytes} bytes at most`);
  // As git: UTF-8 names say so; other bytes go as they are, without the flag.
  const flags = isUtf8(name) ? 0x0800 : 0;
  const data = isDir ? new Uint8Array(0) : entry.data;
  const compressed = data.length > 0 && entry.kind !== "symlink" ? deflateRaw(zlib, data) : data;
  const method: 0 | 8 = compressed === data ? 0 : 8;
  const crc = crc32(data) >>> 0;
  const { time, date } = dosTime(mtime);
  const header = new Uint8Array(30 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, flags, true);
  view.setUint16(8, method, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, compressed.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, name.length, true);
  view.setUint16(28, 0, true);
  header.set(name, 30);
  if (offset + header.length + compressed.length > ZIP_LIMITS.maxBytes)
    throw new RangeError("a zip without ZIP64 holds 4 GiB at most");
  return {
    parts: [header, compressed],
    record: {
      name,
      flags,
      crc,
      compressedSize: compressed.length,
      size: data.length,
      offset,
      method,
      mode: ZIP_MODE[entry.kind],
    },
  };
}

/**
 * The central directory and its end record, written at `offset` after
 * every entry. Throws RangeError past 65,535 entries or 4 GiB.
 */
export function zipEnd(records: readonly ZipRecord[], offset: number, mtime: number): Uint8Array {
  if (records.length > ZIP_LIMITS.maxEntries)
    throw new RangeError(`a zip without ZIP64 holds ${ZIP_LIMITS.maxEntries} entries at most`);
  const { time, date } = dosTime(mtime);
  const entries = records.map((r) => {
    const header = new Uint8Array(46 + r.name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, (3 << 8) | 20, true); // made by Unix, version 2.0
    view.setUint16(6, 20, true);
    view.setUint16(8, r.flags, true);
    view.setUint16(10, r.method, true);
    view.setUint16(12, time, true);
    view.setUint16(14, date, true);
    view.setUint32(16, r.crc, true);
    view.setUint32(20, r.compressedSize, true);
    view.setUint32(24, r.size, true);
    view.setUint16(28, r.name.length, true);
    view.setUint32(38, (r.mode << 16) >>> 0, true);
    view.setUint32(42, r.offset, true);
    header.set(r.name, 46);
    return header;
  });
  const directory = concat(entries);
  if (offset + directory.length + 22 > ZIP_LIMITS.maxBytes)
    throw new RangeError("a zip without ZIP64 holds 4 GiB at most");
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, records.length, true);
  view.setUint16(10, records.length, true);
  view.setUint32(12, directory.length, true);
  view.setUint32(16, offset, true);
  return concat([directory, end]);
}

/** The range MS-DOS dates hold: 1980-01-01 to 2107-12-31 (UTC). */
const DOS_FIRST = 315_532_800;
const DOS_LAST = 4_354_819_198;

/** MS-DOS time and date of Unix seconds, in UTC (zip has no time zone), clamped to its range. */
function dosTime(seconds: number): { time: number; date: number } {
  const d = new Date(Math.min(Math.max(seconds, DOS_FIRST), DOS_LAST) * 1000);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
