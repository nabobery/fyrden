import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/*
 * Builds pack files by hand for tests, independently of the engine's own
 * encoders, so the parser is not tested against itself. Format: git's
 * Documentation/gitformat-pack.txt.
 */

export type WholeType = "commit" | "tree" | "blob" | "tag";
const TYPE_CODE: Record<WholeType | "ofs" | "ref", number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
  ofs: 6,
  ref: 7,
};

interface EntryOverrides {
  /** Size written in the entry header instead of the real one. */
  readonly declaredSize?: number;
  /** zlib bytes written instead of deflating the body. */
  readonly compressed?: Uint8Array;
  /** Raw type code written instead of the real one (e.g. 0 or 5). */
  readonly typeCode?: number;
}

export type PackEntrySpec =
  | ({ readonly kind: WholeType; readonly data: Uint8Array } & EntryOverrides)
  /** OFS_DELTA against the entry with index `base` in this pack. */
  | ({ readonly kind: "ofs"; readonly base: number; readonly delta: Uint8Array } & EntryOverrides)
  /** OFS_DELTA with a raw backwards distance (for malformed cases). */
  | ({
      readonly kind: "ofs-raw";
      readonly distance: number;
      readonly delta: Uint8Array;
    } & EntryOverrides)
  | ({
      readonly kind: "ref";
      readonly baseOid: string;
      readonly delta: Uint8Array;
    } & EntryOverrides);

export interface BuiltPack {
  readonly bytes: Uint8Array;
  /** Entry start offsets, in entry order. */
  readonly offsets: number[];
  /** Offset of the trailer (end of the last entry). */
  readonly trailerOffset: number;
}

export interface BuildOptions {
  readonly version?: number;
  /** Object count written in the header instead of the entry count. */
  readonly count?: number;
  readonly signature?: string;
  /** Replace the trailer with these bytes (e.g. a wrong checksum, or none). */
  readonly trailer?: Uint8Array;
}

export function entryHeader(typeCode: number, size: number): number[] {
  const out: number[] = [];
  let c = (typeCode << 4) | (size % 16);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(c | 0x80);
    c = rest % 128;
    rest = Math.floor(rest / 128);
  }
  out.push(c);
  return out;
}

/** git's OFS_DELTA distance encoding (big-endian base 128 with the +1 bias). */
export function ofsDistance(distance: number): number[] {
  const out = [distance & 0x7f];
  let rest = Math.floor(distance / 128);
  while (rest > 0) {
    rest -= 1;
    out.unshift(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 128);
  }
  return out;
}

export function buildPack(
  entries: readonly PackEntrySpec[],
  options: BuildOptions = {},
): BuiltPack {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode(options.signature ?? "PACK"));
  const view = new DataView(header.buffer);
  view.setUint32(4, options.version ?? 2);
  view.setUint32(8, options.count ?? entries.length);
  parts.push(header);
  let offset = 12;
  const offsets: number[] = [];
  for (const entry of entries) {
    offsets.push(offset);
    const body = "data" in entry ? entry.data : entry.delta;
    const typeCode =
      entry.typeCode ?? (entry.kind === "ofs-raw" ? TYPE_CODE.ofs : TYPE_CODE[entry.kind]);
    const bytes: number[] = entryHeader(typeCode, entry.declaredSize ?? body.length);
    if (entry.kind === "ofs") bytes.push(...ofsDistance(offset - (offsets[entry.base] as number)));
    if (entry.kind === "ofs-raw") bytes.push(...ofsDistance(entry.distance));
    if (entry.kind === "ref") bytes.push(...Buffer.from(entry.baseOid, "hex"));
    const compressed = entry.compressed ?? deflateSync(body);
    const raw = new Uint8Array(bytes.length + compressed.length);
    raw.set(bytes);
    raw.set(compressed, bytes.length);
    parts.push(raw);
    offset += raw.length;
  }
  const body = Buffer.concat(parts);
  const trailer = options.trailer ?? createHash("sha1").update(body).digest();
  return {
    bytes: new Uint8Array(Buffer.concat([body, trailer])),
    offsets,
    trailerOffset: offset,
  };
}

/** Recomputes the trailer after a test edits a pack's bytes. */
export function withTrailer(packWithoutTrailer: Uint8Array): Uint8Array {
  const digest = createHash("sha1").update(packWithoutTrailer).digest();
  return new Uint8Array(Buffer.concat([packWithoutTrailer, digest]));
}

function deltaSize(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return out;
}

export type DeltaOp =
  | { readonly copy: readonly [offset: number, size: number] }
  | { readonly insert: Uint8Array };

/** A delta program in git's format (patch-delta.c), with explicit header sizes. */
export function encodeDelta(
  baseSize: number,
  resultSize: number,
  ops: readonly DeltaOp[],
): Uint8Array {
  const out = [...deltaSize(baseSize), ...deltaSize(resultSize)];
  for (const op of ops) {
    if ("insert" in op) {
      for (let i = 0; i < op.insert.length; i += 127) {
        const piece = op.insert.subarray(i, i + 127);
        out.push(piece.length, ...piece);
      }
      continue;
    }
    const [off, size] = op.copy;
    let cmd = 0x80;
    const args: number[] = [];
    for (let b = 0; b < 4; b++) {
      const byte = Math.floor(off / 2 ** (8 * b)) & 0xff;
      if (byte !== 0) {
        cmd |= 1 << b;
        args.push(byte);
      }
    }
    // A size of 0x10000 is written as no size bytes at all.
    if (size !== 0x10000) {
      for (let b = 0; b < 3; b++) {
        const byte = (size >> (8 * b)) & 0xff;
        if (byte !== 0) {
          cmd |= 0x10 << b;
          args.push(byte);
        }
      }
    }
    out.push(cmd, ...args);
  }
  return new Uint8Array(out);
}

/** A correct delta from `base` to `target`: copy the common prefix, insert the rest. */
export function makeDelta(base: Uint8Array, target: Uint8Array): Uint8Array {
  let common = 0;
  while (common < base.length && common < target.length && base[common] === target[common]) {
    common++;
  }
  const ops: DeltaOp[] = [];
  for (let off = 0; off < common; off += 0x10000) {
    ops.push({ copy: [off, Math.min(0x10000, common - off)] });
  }
  if (common < target.length) ops.push({ insert: target.subarray(common) });
  return encodeDelta(base.length, target.length, ops);
}

export function gitOid(type: WholeType, data: Uint8Array): string {
  return createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
}

export const text = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Splits bytes into chunks at the given cut points (an async byte stream). */
export async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
