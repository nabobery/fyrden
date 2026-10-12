import { OID_BYTES } from "../object/oid.js";
import { PACK_HEADER_BYTES } from "../pack/entry-header.js";
import { PackWriteError } from "./errors.js";

/*
 * A pack writer's saved state, so a writer split across alarm invocations
 * survives an eviction. Layout, big-endian:
 *
 *   "FPWC"                         4  magic
 *   version                        1  (1)
 *   flags                          1  bit 0: OFS_DELTA allowed
 *   object count                   4
 *   entries written                4
 *   REF_DELTA bases recorded       4
 *   bytes written                  8
 *   hasher state length            4
 *   hasher state                   n  (git-core SHA-1 `saveState`)
 *   oids                          20 × entries
 *   offsets                        8 × entries
 *   CRC32s                         4 × entries
 *   REF_DELTA base oids           20 × bases
 */

const MAGIC = [0x46, 0x50, 0x57, 0x43]; // "FPWC"
const VERSION = 1;
const FIXED_BYTES = 4 + 1 + 1 + 4 + 4 + 4 + 8 + 4;
const FLAG_OFS = 1;

export interface WriterCheckpoint {
  readonly objectCount: number;
  readonly ofsDelta: boolean;
  /** Bytes flushed to the sink and the hasher. */
  readonly offset: number;
  readonly count: number;
  readonly hasherState: Uint8Array;
  readonly oids: Uint8Array;
  readonly offsets: ArrayLike<number>;
  readonly crc32s: ArrayLike<number>;
  readonly refBaseCount: number;
  readonly refBases: Uint8Array;
}

export function encodeCheckpoint(state: WriterCheckpoint): Uint8Array {
  const { count, refBaseCount, hasherState } = state;
  const length =
    FIXED_BYTES + hasherState.length + count * (OID_BYTES + 12) + refBaseCount * OID_BYTES;
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out[5] = state.ofsDelta ? FLAG_OFS : 0;
  view.setUint32(6, state.objectCount);
  view.setUint32(10, count);
  view.setUint32(14, refBaseCount);
  setUint64(view, 18, state.offset);
  view.setUint32(26, hasherState.length);
  let at = FIXED_BYTES;
  out.set(hasherState, at);
  at += hasherState.length;
  out.set(state.oids.subarray(0, count * OID_BYTES), at);
  at += count * OID_BYTES;
  for (let i = 0; i < count; i++, at += 8) setUint64(view, at, state.offsets[i] as number);
  for (let i = 0; i < count; i++, at += 4) view.setUint32(at, state.crc32s[i] as number);
  out.set(state.refBases.subarray(0, refBaseCount * OID_BYTES), at);
  return out;
}

export interface DecodedCheckpoint extends WriterCheckpoint {
  readonly offsets: Float64Array;
  readonly crc32s: Uint32Array;
}

/** Reads a checkpoint; throws `PackWriteError` (`bad-checkpoint`) for anything malformed. */
export function decodeCheckpoint(bytes: Uint8Array): DecodedCheckpoint {
  const bad = (why: string) => new PackWriteError("bad-checkpoint", why);
  if (bytes.length < FIXED_BYTES) throw bad("truncated");
  if (MAGIC.some((b, i) => bytes[i] !== b)) throw bad("not a pack writer checkpoint");
  if (bytes[4] !== VERSION) throw bad(`version ${bytes[4]} is not supported`);
  const flags = bytes[5] as number;
  if ((flags & ~FLAG_OFS) !== 0) throw bad("unknown flags");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const objectCount = view.getUint32(6);
  const count = view.getUint32(10);
  const refBaseCount = view.getUint32(14);
  const offset = getUint64(view, 18);
  const stateLength = view.getUint32(26);
  const expected = FIXED_BYTES + stateLength + count * (OID_BYTES + 12) + refBaseCount * OID_BYTES;
  if (bytes.length !== expected) throw bad(`${bytes.length} bytes, expected ${expected}`);
  if (count > objectCount || refBaseCount > count) throw bad("entry counts out of range");
  if (!Number.isSafeInteger(offset) || offset < PACK_HEADER_BYTES) throw bad("bad offset");
  let at = FIXED_BYTES;
  const hasherState = bytes.slice(at, at + stateLength);
  at += stateLength;
  const oids = bytes.slice(at, at + count * OID_BYTES);
  at += count * OID_BYTES;
  const offsets = new Float64Array(count);
  let previous = PACK_HEADER_BYTES - 1;
  for (let i = 0; i < count; i++, at += 8) {
    const value = getUint64(view, at);
    if (!Number.isSafeInteger(value) || value <= previous || value >= offset) {
      throw bad(`entry ${i} has offset ${value}`);
    }
    offsets[i] = previous = value;
  }
  const crc32s = new Uint32Array(count);
  for (let i = 0; i < count; i++, at += 4) crc32s[i] = view.getUint32(at);
  const refBases = bytes.slice(at, at + refBaseCount * OID_BYTES);
  return {
    objectCount,
    ofsDelta: (flags & FLAG_OFS) !== 0,
    offset,
    count,
    hasherState,
    oids,
    offsets,
    crc32s,
    refBaseCount,
    refBases,
  };
}

function setUint64(view: DataView, at: number, value: number): void {
  view.setUint32(at, Math.floor(value / 2 ** 32));
  view.setUint32(at + 4, value >>> 0);
}

function getUint64(view: DataView, at: number): number {
  return view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4);
}
