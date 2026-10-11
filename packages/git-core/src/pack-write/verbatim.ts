import { createSha1Hasher } from "../hash/sha1.js";
import { encodePackHeader, PACK_HEADER_BYTES, PACK_TRAILER_BYTES } from "../pack/entry-header.js";
import type { HasherFactory } from "../ports/hasher.js";
import type { PackId, PackStore } from "../ports/pack-store.js";
import { PackWriteError } from "./errors.js";
import { forEachOidGroup } from "./oid-merge.js";

/*
 * Clone packs served from stored packs without re-encoding:
 *
 * - as-is: one pack is the answer. Its bytes, trailer included, go out
 *   unchanged, so nothing needs hashing or even reading in JavaScript: a
 *   Worker should pipe the stored object natively rather than iterate it
 *   (per-chunk JavaScript costs hundreds of ms of CPU per 100 MiB, while a
 *   native pipe costs a few ms per GiB, measured on Workers Free on
 *   2026-10-10).
 * - stitched: several packs. A new 12-byte header with the total count,
 *   then each pack's entry region (bytes 12 to length - 20) copied as it
 *   is, then a new trailer over everything. OFS_DELTA distances are relative
 *   to the entry, so they stay valid when a region is copied whole; a
 *   REF_DELTA whose base is in another region stays a valid REF_DELTA.
 *
 * What the caller must guarantee (the fetch planner checks it from the
 * registry and the `.idx` files; nothing here reads entry headers):
 * - the union of the packs is closed under delta bases (pack units whole);
 * - no object appears in two packs: `git index-pack --strict`, which git's
 *   fetch runs when `transfer.fsckObjects` is set, refuses a pack holding
 *   an object twice. `duplicateObjectCount` finds them;
 * - the client asked for `ofs-delta` when any pack holds OFS_DELTAs.
 */

/** Proposed default; tuned under load. */
export const DEFAULT_STITCH_CHUNK_BYTES = 64 * 1024;
/** Proposed default; tuned under load. */
export const DEFAULT_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_OBJECT_COUNT = 0xffffffff;

export interface VerbatimSource {
  readonly packId: PackId;
  /** Bytes in the stored pack, trailer included. */
  readonly packLength: number;
  /** The count in the pack's header (the registry's `object_count`). */
  readonly objectCount: number;
}

export interface PackSegment {
  readonly packId: PackId;
  readonly offset: number;
  readonly length: number;
}

export type VerbatimPlan =
  | {
      readonly kind: "as-is";
      readonly packId: PackId;
      /** Bytes to send: the whole stored pack. */
      readonly length: number;
      readonly objectCount: number;
    }
  | {
      readonly kind: "stitched";
      /** The new 12-byte pack header. */
      readonly header: Uint8Array;
      /** Entry regions to copy, in order. */
      readonly segments: readonly PackSegment[];
      /** Bytes to send, header and new trailer included. */
      readonly length: number;
      readonly objectCount: number;
    };

/** Streams `length` bytes at `offset` of a stored pack (in Workers, one ranged GET). */
export type PackRangeStream = (
  packId: PackId,
  offset: number,
  length: number,
) => AsyncIterable<Uint8Array>;

export interface StreamVerbatimOptions {
  /** The stitched trailer's hasher. Default: git-core's SHA-1 without collision detection. */
  readonly createHasher?: HasherFactory;
  /**
   * Stitched output is coalesced into chunks of at least this many bytes
   * (the last may be shorter), so hashing and the consumer see few large
   * writes instead of many small ones. Default 64 KiB.
   */
  readonly minChunkBytes?: number;
}

/** The plan for sending the union of `sources` as one pack. */
export function planVerbatimPack(sources: readonly VerbatimSource[]): VerbatimPlan {
  if (sources.length === 0) throw new RangeError("a verbatim pack needs at least one source");
  let objectCount = 0;
  for (const s of sources) {
    if (
      !Number.isSafeInteger(s.packLength) ||
      s.packLength < PACK_HEADER_BYTES + PACK_TRAILER_BYTES
    ) {
      throw new RangeError(`pack ${s.packId} has a bad length ${s.packLength}`);
    }
    if (!Number.isInteger(s.objectCount) || s.objectCount < 0) {
      throw new RangeError(`pack ${s.packId} has a bad object count ${s.objectCount}`);
    }
    objectCount += s.objectCount;
  }
  if (objectCount > MAX_OBJECT_COUNT) {
    throw new RangeError(`${objectCount} objects do not fit a pack header`);
  }
  const [first] = sources as [VerbatimSource];
  if (sources.length === 1) {
    return { kind: "as-is", packId: first.packId, length: first.packLength, objectCount };
  }
  const segments = sources.map((s) => ({
    packId: s.packId,
    offset: PACK_HEADER_BYTES,
    length: s.packLength - PACK_HEADER_BYTES - PACK_TRAILER_BYTES,
  }));
  const length =
    PACK_HEADER_BYTES + segments.reduce((n, s) => n + s.length, 0) + PACK_TRAILER_BYTES;
  return {
    kind: "stitched",
    header: encodePackHeader(objectCount),
    segments,
    length,
    objectCount,
  };
}

/**
 * The plan's pack bytes. An as-is plan passes the stored bytes through
 * untouched (no hashing); a stitched plan hashes its output as it goes and
 * ends with the new trailer. Throws `PackWriteError` (`corrupt-source`) when
 * a range yields more or fewer bytes than asked for.
 */
export async function* streamVerbatimPack(
  plan: VerbatimPlan,
  read: PackRangeStream,
  options: StreamVerbatimOptions = {},
): AsyncGenerator<Uint8Array> {
  if (plan.kind === "as-is") {
    yield* exactly(read(plan.packId, 0, plan.length), plan.packId, plan.length);
    return;
  }
  const minChunk = options.minChunkBytes ?? DEFAULT_STITCH_CHUNK_BYTES;
  if (!Number.isSafeInteger(minChunk) || minChunk < 1) {
    throw new RangeError(`minChunkBytes must be a positive integer, not ${minChunk}`);
  }
  const hasher = (options.createHasher ?? (() => createSha1Hasher({ detectCollisions: false })))();
  const out = new Coalescer(minChunk);
  for (const ready of out.push(plan.header)) {
    await hasher.update(ready);
    yield ready;
  }
  for (const segment of plan.segments) {
    const source = exactly(
      read(segment.packId, segment.offset, segment.length),
      segment.packId,
      segment.length,
    );
    for await (const chunk of source) {
      for (const ready of out.push(chunk)) {
        await hasher.update(ready);
        yield ready;
      }
    }
  }
  const tail = out.drain();
  if (tail.length > 0) await hasher.update(tail);
  const trailer = await hasher.digest();
  const last = new Uint8Array(tail.length + trailer.length);
  last.set(tail);
  last.set(trailer, tail.length);
  yield last;
}

/** A `PackRangeStream` over `PackStore.openRange`, in reads of `rangeBytes` (default 8 MiB). */
export function rangeStreamFromStore(
  store: Pick<PackStore, "openRange">,
  rangeBytes = DEFAULT_RANGE_BYTES,
): PackRangeStream {
  if (!Number.isSafeInteger(rangeBytes) || rangeBytes < 1) {
    throw new RangeError(`rangeBytes must be a positive integer, not ${rangeBytes}`);
  }
  return async function* (packId, offset, length) {
    for (let at = offset; at < offset + length; at += rangeBytes) {
      yield await store.openRange(packId, at, Math.min(rangeBytes, offset + length - at));
    }
  };
}

/**
 * How many entries of the given sorted oid tables (`PackIdx.oidTable()`,
 * 20 bytes per oid) repeat an oid already seen in them, within one table or
 * across tables. Zero means the packs can be stitched without duplicates.
 */
export function duplicateObjectCount(tables: readonly Uint8Array[]): number {
  let duplicates = 0;
  forEachOidGroup(tables, (copies) => {
    duplicates += copies.length - 1;
  });
  return duplicates;
}

/** Checks that a range yields exactly `length` bytes. */
async function* exactly(
  source: AsyncIterable<Uint8Array>,
  packId: PackId,
  length: number,
): AsyncGenerator<Uint8Array> {
  let seen = 0;
  for await (const chunk of source) {
    seen += chunk.length;
    if (seen > length) break;
    yield chunk;
  }
  if (seen !== length) {
    throw new PackWriteError(
      "corrupt-source",
      `pack ${packId} gave ${seen > length ? "more" : "fewer"} bytes than the ${length} asked for`,
    );
  }
}

/**
 * Turns many small chunks into fewer chunks of at least `min` bytes. A
 * chunk that is already large enough passes through without a copy; every
 * chunk it builds is a new buffer, so a consumer may keep it.
 */
class Coalescer {
  readonly #min: number;
  #buffer: Uint8Array;
  #fill = 0;

  constructor(min: number) {
    this.#min = min;
    this.#buffer = new Uint8Array(min);
  }

  *push(chunk: Uint8Array): Generator<Uint8Array> {
    let at = 0;
    while (at < chunk.length) {
      if (this.#fill === 0 && chunk.length - at >= this.#min) {
        yield chunk.subarray(at);
        return;
      }
      const take = Math.min(this.#min - this.#fill, chunk.length - at);
      this.#buffer.set(chunk.subarray(at, at + take), this.#fill);
      this.#fill += take;
      at += take;
      if (this.#fill === this.#min) {
        yield this.#buffer;
        this.#buffer = new Uint8Array(this.#min);
        this.#fill = 0;
      }
    }
  }

  drain(): Uint8Array {
    const tail = this.#buffer.subarray(0, this.#fill);
    this.#fill = 0;
    return tail;
  }
}
