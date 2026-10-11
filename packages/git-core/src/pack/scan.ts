import type { ObjectType } from "../object/object.js";
import { type Oid, oidFromBytes } from "../object/oid.js";
import type { Hasher } from "../ports/hasher.js";
import type { MemoryBudget } from "../ports/memory-budget.js";
import type { Zlib } from "../ports/zlib.js";
import { crc32 } from "./crc32.js";
import { readDeltaHeader } from "./delta-apply.js";
import {
  decodeEntryHeader,
  decodePackHeader,
  type EntryHeader,
  PACK_HEADER_BYTES,
  PACK_TRAILER_BYTES,
} from "./entry-header.js";
import { PackError } from "./errors.js";
import { PackIndexState } from "./index-state.js";
import { inflateEntry, maxCompressedBytes, NeedMoreInput } from "./inflate.js";
import { EntryReservation } from "./memory.js";
import { receivedObjectId } from "./object-id.js";
import type { PackLimits, PackObject } from "./parse.js";
import { StreamBuffer } from "./stream-buffer.js";

export interface ScanContext {
  readonly zlib: Zlib;
  readonly memory: MemoryBudget;
  readonly limits: PackLimits;
  readonly trailerHasher: Hasher;
  readonly onObject: ((object: PackObject) => void | Promise<void>) | undefined;
}

export interface PackScan {
  readonly version: 2 | 3;
  readonly state: PackIndexState;
  readonly checksum: Uint8Array;
  readonly packLength: number;
}

/**
 * Pass 1: reads the pack once, in order. For each entry it checks the
 * header, inflates the zlib stream (bounded, exact size), computes the CRC32
 * of the raw entry, and records it. Whole objects are hashed and handed to
 * `onObject`; deltas are only recorded, with their result size from the
 * program header. Ends by checking the object count and the trailer.
 */
export async function scanPack(
  source: AsyncIterable<Uint8Array>,
  ctx: ScanContext,
): Promise<PackScan> {
  const { limits } = ctx;
  const input = new StreamBuffer(source);
  await input.need(PACK_HEADER_BYTES, "pack header");
  const header = decodePackHeader(input.peek(PACK_HEADER_BYTES));
  if (header.objectCount > limits.maxObjects) {
    throw new PackError(
      "too-many-objects",
      `pack declares ${header.objectCount} objects, the limit is ${limits.maxObjects}`,
    );
  }
  await ctx.trailerHasher.update(input.take(PACK_HEADER_BYTES));

  const state = new PackIndexState(ctx.memory, header.objectCount);
  try {
    for (let n = 0; n < header.objectCount; n++) await scanEntry(input, state, ctx);
    const dataEnd = input.position;
    state.finish(dataEnd);
    await input.need(PACK_TRAILER_BYTES, "pack trailer");
    const checksum = new Uint8Array(input.take(PACK_TRAILER_BYTES));
    const digest = await ctx.trailerHasher.digest();
    if (!digest.every((byte, i) => byte === checksum[i])) {
      throw new PackError("bad-checksum", "pack trailer does not match its contents", dataEnd);
    }
    if (input.available > 0 || (await input.readMore())) {
      throw new PackError("trailing-bytes", "pack has junk at the end", input.position);
    }
    return { version: header.version, state, checksum, packLength: input.position };
  } catch (error) {
    state.release();
    throw error;
  }
}

async function scanEntry(
  input: StreamBuffer,
  state: PackIndexState,
  ctx: ScanContext,
): Promise<void> {
  const { limits } = ctx;
  const offset = input.position;
  let header: EntryHeader | undefined = decodeEntryHeader(
    input.peek(),
    0,
    offset,
    limits.maxObjectBytes,
  );
  while (header === undefined) {
    if (!(await input.readMore()))
      throw new PackError("truncated", "stream ended inside an entry header", offset);
    header = decodeEntryHeader(input.peek(), 0, offset, limits.maxObjectBytes);
  }
  let base: number | Uint8Array | undefined;
  if (header.kind === "ofs-delta") {
    base = state.findOffset(header.baseOffset);
    if (base < 0) {
      throw new PackError("bad-delta-base-offset", "delta base offset is not an entry", offset);
    }
  } else if (header.kind === "ref-delta") {
    base = header.baseOid;
  }
  const rawHeader = input.take(header.length);
  let crc = crc32(rawHeader);
  await ctx.trailerHasher.update(rawHeader);

  const size = header.size;
  // A large entry's inflate is reserved from the bytes that arrive, not its declared size.
  const reservation =
    size > limits.largeObjectBytes ? new EntryReservation(ctx.memory, size, offset) : undefined;
  try {
    const { data, consumed } = await inflateFromStream(input, ctx.zlib, size, offset, reservation);
    const raw = input.take(consumed);
    crc = crc32(raw, crc);
    await ctx.trailerHasher.update(raw);
    if (header.kind === "ofs-delta" || header.kind === "ref-delta") {
      // Both sizes are checked against the cap now, before anything is resolved.
      const delta = readDeltaHeader(data, limits.maxObjectBytes);
      await state.add({
        offset,
        headerLength: header.length,
        kind: header.kind,
        entrySize: size,
        size: delta.resultSize,
        crc32: crc,
        base,
      });
      return;
    }
    const type: ObjectType = header.kind;
    const oid = receivedObjectId(type, data);
    const index = await state.add({
      offset,
      headerLength: header.length,
      kind: type,
      entrySize: size,
      size,
      crc32: crc,
      oid,
    });
    await ctx.onObject?.({ index, oid: oidFromBytes(oid) as Oid, type, data });
  } finally {
    reservation?.release();
  }
}

/**
 * Inflates the entry starting at the buffer's read position, reading more
 * input while the zlib stream continues. Attempts double the buffered length
 * each time, so a large entry arriving in small chunks costs at most about
 * twice a single inflate. Before each attempt `reservation` grows to cover
 * the bytes given and what they can inflate to.
 */
async function inflateFromStream(
  input: StreamBuffer,
  zlib: Zlib,
  size: number,
  offset: number,
  reservation: EntryReservation | undefined,
): Promise<{ data: Uint8Array; consumed: number }> {
  const limit = maxCompressedBytes(size);
  let attemptAt = 0;
  for (;;) {
    const available = input.available;
    if (available >= attemptAt || input.done) {
      const attempt = Math.min(available, limit);
      await reservation?.cover(attempt);
      try {
        return inflateEntry(zlib, input.peek(attempt), size, offset);
      } catch (error) {
        if (!(error instanceof NeedMoreInput)) throw error;
        if (available >= limit) {
          throw new PackError(
            "compressed-too-large",
            `zlib stream longer than ${limit} bytes`,
            offset,
          );
        }
        if (input.done) throw new PackError("truncated", "stream ended inside an entry", offset);
        attemptAt = Math.min(limit, Math.max(available * 2, available + 4096));
      }
    }
    await input.readMore();
  }
}
