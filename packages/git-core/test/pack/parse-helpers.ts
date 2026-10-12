import { PackError, type PackErrorCode } from "../../src/pack/errors.js";
import { type ParsedPack, type ParsePackOptions, parsePack } from "../../src/pack/parse.js";
import type { MemoryBudget, MemoryReservation } from "../../src/ports/memory-budget.js";
import type { Zlib } from "../../src/ports/zlib.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { chunked } from "./pack-builder.js";

export const MiB = 1024 * 1024;

/** A budget that records the most bytes held at once. */
export function trackingBudget(
  totalBytes: number,
): MemoryBudget & { peak(): number; held(): number } {
  const inner = createMemoryBudget(totalBytes);
  let held = 0;
  let peak = 0;
  const wrap = (r: MemoryReservation): MemoryReservation => {
    held += r.bytes;
    peak = Math.max(peak, held);
    let released = false;
    return {
      bytes: r.bytes,
      release() {
        if (released) return;
        released = true;
        held -= r.bytes;
        r.release();
      },
    };
  };
  return {
    async reserve(bytes, signal) {
      return wrap(await inner.reserve(bytes, signal));
    },
    tryReserve(bytes) {
      const r = inner.tryReserve(bytes);
      return r && wrap(r);
    },
    peak: () => peak,
    held: () => held,
  };
}

/** A zlib port that records every inflate call's maxOutput. */
export function spyZlib(): Zlib & { maxOutputs: number[] } {
  const zlib = createNodeZlib();
  const maxOutputs: number[] = [];
  return {
    maxOutputs,
    inflate(input, options) {
      maxOutputs.push(options.maxOutput);
      return zlib.inflate(input, options);
    },
    deflate: (input, options) => zlib.deflate(input, options),
  };
}

export interface ParseResult {
  pack: ParsedPack;
  /** Every object handed to onObject, by hex oid. */
  objects: Map<string, { type: string; data: Uint8Array }>;
}

/** Parses an in-memory pack, streamed in `chunkSize` pieces. */
export async function parseBytes(
  bytes: Uint8Array,
  options: Partial<ParsePackOptions> & { chunkSize?: number } = {},
): Promise<ParseResult> {
  const objects = new Map<string, { type: string; data: Uint8Array }>();
  const pack = await parsePack(chunked(bytes, options.chunkSize ?? 4096), {
    zlib: createNodeZlib(),
    memory: createMemoryBudget(512 * MiB),
    readRange: async (offset, length) => bytes.subarray(offset, offset + length),
    onObject: ({ oid, type, data }) => {
      objects.set(Buffer.from(oid).toString("hex"), { type, data });
    },
    ...options,
  });
  return { pack, objects };
}

/** The PackError code a parse fails with, or "ok". Anything else is rethrown. */
export async function parseCode(
  bytes: Uint8Array,
  options: Partial<ParsePackOptions> & { chunkSize?: number } = {},
): Promise<PackErrorCode | "ok"> {
  try {
    const { pack } = await parseBytes(bytes, options);
    pack.release();
    return "ok";
  } catch (error) {
    if (error instanceof PackError) return error.code;
    throw error;
  }
}

export interface EntryRow {
  oid: string;
  type: string;
  /** As `git verify-pack -v` prints it: for a delta, the delta program's size. */
  size: number;
  sizeInPack: number;
  offset: number;
  depth: number;
  baseOid: string | undefined;
  crc32?: number | undefined;
}

/** The parsed entries as rows comparable with `git verify-pack -v`. */
export function rowsOf(pack: ParsedPack, withCrc = false): EntryRow[] {
  const rows: EntryRow[] = [];
  const { entries } = pack;
  for (let i = 0; i < entries.count; i++) {
    const base = entries.baseOid(i);
    rows.push({
      oid: Buffer.from(entries.oid(i)).toString("hex"),
      type: entries.type(i),
      size: entries.entrySize(i),
      sizeInPack: entries.entryLength(i),
      offset: entries.offset(i),
      depth: entries.depth(i),
      baseOid: base && Buffer.from(base).toString("hex"),
      ...(withCrc ? { crc32: entries.crc32(i) } : {}),
    });
  }
  return rows.sort((a, b) => a.offset - b.offset);
}
