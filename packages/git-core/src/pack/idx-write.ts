import { OID_BYTES, oidFromBytes, oidToHex } from "../object/oid.js";
import type { HasherFactory } from "../ports/hasher.js";
import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";
import {
  compareAt,
  IDX_CHECKSUM_BYTES,
  IDX_FANOUT_ENTRIES,
  IDX_HEADER_BYTES,
  IDX_LARGE_OFFSET_FLAG,
  IDX_MAGIC,
  IDX_MAX_SMALL_OFFSET,
  IDX_VERSION,
  IdxError,
  idxLayout,
} from "./idx-format.js";

/**
 * A pack's entries in any order (the parser's are in pack order): oids
 * packed 20 bytes each, with each entry's pack offset and CRC32. The arrays
 * may be longer than `count`. `PackEntries` from the parser fits.
 */
export interface IdxWriteInput {
  readonly count: number;
  readonly oids: Uint8Array;
  readonly offsets: ArrayLike<number>;
  readonly crc32s: ArrayLike<number>;
}

export interface IdxWriteOptions {
  /**
   * Hashes the `.idx` checksum. Fyrden writes these bytes itself, so a
   * hasher without collision detection is fine.
   */
  readonly createHasher: HasherFactory;
  /**
   * Refuse a pack that holds the same object twice, as `git index-pack
   * --strict` does. Default false: like git, keep every copy.
   */
  readonly strict?: boolean;
  /**
   * When given, the sort scratch (8 bytes per entry, released on return)
   * and the output (held until `release()`) are reserved here first.
   */
  readonly memory?: MemoryBudget;
}

export interface WrittenIdx {
  /** The whole `.idx` file. */
  readonly bytes: Uint8Array;
  /** Cumulative counts per first oid byte, as in the file; the registry row keeps them. */
  readonly fanout: Uint32Array;
  /** The trailing `.idx` checksum. */
  readonly checksum: Uint8Array;
  /** Entries whose offset needed the 64-bit table. */
  readonly largeOffsetCount: number;
  /** Returns the output's reservation to the memory budget (no-op without one). */
  release(): void;
}

/**
 * Writes a version 2 `.idx` byte-identical to what `git index-pack` writes
 * for the same pack (pack-write.c `write_idx_file`, git v2.53.0, verified).
 *
 * Duplicates: git keeps every copy of an object that a pack stores more
 * than once (unless `--strict`), sorted by oid with libc `qsort`, which
 * leaves the order of equal oids unspecified. This writer orders copies by
 * pack offset, which is what a stable sort of git's pack-order input gives,
 * so lookups (which return the first of a run) find the earliest copy.
 */
export async function writeIdx(
  entries: IdxWriteInput,
  packChecksum: Uint8Array,
  options: IdxWriteOptions,
): Promise<WrittenIdx> {
  const { count, oids, offsets, crc32s } = entries;
  checkInput(entries, packChecksum);

  const scratchBytes = count * 8;
  const scratch = await reserve(options.memory, scratchBytes);
  let output: MemoryReservation | undefined;
  try {
    const order = sortByOid(oids, offsets, count);
    if (options.strict) rejectDuplicates(oids, order);

    let largeCount = 0;
    for (let i = 0; i < count; i++) {
      if ((offsets[i] as number) > IDX_MAX_SMALL_OFFSET) largeCount++;
    }
    if (largeCount > Math.max(count - 1, 0)) {
      throw new RangeError(
        `${largeCount} of ${count} offsets are 2^31 or more; a pack's first entry is at offset 12`,
      );
    }
    const layout = idxLayout(count, largeCount);
    output = await reserve(options.memory, layout.byteLength);

    const bytes = new Uint8Array(layout.byteLength);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, IDX_MAGIC);
    view.setUint32(4, IDX_VERSION);

    const fanout = new Uint32Array(IDX_FANOUT_ENTRIES);
    for (let p = 0; p < count; p++) {
      const i = order[p] as number;
      const first = oids[i * OID_BYTES] as number;
      fanout[first] = (fanout[first] as number) + 1;
      bytes.set(oids.subarray(i * OID_BYTES, (i + 1) * OID_BYTES), layout.oidsAt + p * OID_BYTES);
      view.setUint32(layout.crc32sAt + p * 4, crc32s[i] as number);
    }
    for (let b = 1; b < IDX_FANOUT_ENTRIES; b++) {
      fanout[b] = (fanout[b] as number) + (fanout[b - 1] as number);
    }
    for (let b = 0; b < IDX_FANOUT_ENTRIES; b++) {
      view.setUint32(IDX_HEADER_BYTES + b * 4, fanout[b] as number);
    }

    // Large offsets are numbered in oid order, as git numbers them.
    let large = 0;
    for (let p = 0; p < count; p++) {
      const offset = offsets[order[p] as number] as number;
      if (offset <= IDX_MAX_SMALL_OFFSET) {
        view.setUint32(layout.offsetsAt + p * 4, offset);
        continue;
      }
      view.setUint32(layout.offsetsAt + p * 4, (IDX_LARGE_OFFSET_FLAG | large) >>> 0);
      const at = layout.largeOffsetsAt + large * 8;
      view.setUint32(at, Math.floor(offset / 2 ** 32));
      view.setUint32(at + 4, offset >>> 0);
      large++;
    }

    bytes.set(packChecksum, layout.packChecksumAt);
    const hasher = options.createHasher();
    await hasher.update(bytes.subarray(0, layout.checksumAt));
    const checksum = await hasher.digest();
    bytes.set(checksum, layout.checksumAt);

    const held = output;
    return {
      bytes,
      fanout,
      checksum: bytes.slice(layout.checksumAt),
      largeOffsetCount: largeCount,
      release: () => held?.release(),
    };
  } catch (error) {
    output?.release();
    throw error;
  } finally {
    scratch?.release();
  }
}

function checkInput(entries: IdxWriteInput, packChecksum: Uint8Array): void {
  const { count, oids, offsets, crc32s } = entries;
  if (!Number.isSafeInteger(count) || count < 0 || count > 0xffffffff) {
    throw new RangeError(`entry count must be an integer from 0 to 2^32 - 1, not ${count}`);
  }
  if (oids.length < count * OID_BYTES || offsets.length < count || crc32s.length < count) {
    throw new RangeError(`entry arrays are shorter than the count ${count}`);
  }
  if (packChecksum.length !== IDX_CHECKSUM_BYTES) {
    throw new RangeError(
      `the pack checksum is ${IDX_CHECKSUM_BYTES} bytes, not ${packChecksum.length}`,
    );
  }
  for (let i = 0; i < count; i++) {
    const offset = offsets[i] as number;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError(`entry ${i} has offset ${offset}, not a safe non-negative integer`);
    }
    const crc = crc32s[i] as number;
    if (!Number.isInteger(crc) || crc < 0 || crc > 0xffffffff) {
      throw new RangeError(`entry ${i} has CRC32 ${crc}, not a 32-bit unsigned integer`);
    }
  }
}

/**
 * Entry indexes sorted by (oid, offset). A 32-bit prefix of each oid
 * settles almost every comparison (oids are uniform), so the full compare
 * runs only on ties.
 */
function sortByOid(oids: Uint8Array, offsets: ArrayLike<number>, count: number): Uint32Array {
  const prefix = new Uint32Array(count);
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const at = i * OID_BYTES;
    prefix[i] =
      (((oids[at] as number) << 24) |
        ((oids[at + 1] as number) << 16) |
        ((oids[at + 2] as number) << 8) |
        (oids[at + 3] as number)) >>>
      0;
    order[i] = i;
  }
  order.sort((a, b) => {
    const d = (prefix[a] as number) - (prefix[b] as number);
    if (d !== 0) return d;
    const full = compareAt(oids, a * OID_BYTES, oids, b * OID_BYTES);
    return full !== 0 ? full : (offsets[a] as number) - (offsets[b] as number);
  });
  return order;
}

function rejectDuplicates(oids: Uint8Array, order: Uint32Array): void {
  for (let p = 1; p < order.length; p++) {
    const a = (order[p - 1] as number) * OID_BYTES;
    const b = (order[p] as number) * OID_BYTES;
    if (compareAt(oids, a, oids, b) === 0) {
      // git's message (pack-write.c): "The same object %s appears twice in the pack".
      throw new IdxError(
        "duplicate-object",
        `the same object ${oidToHex(oidFromBytes(oids, b))} appears twice in the pack`,
      );
    }
  }
}

async function reserve(
  memory: MemoryBudget | undefined,
  bytes: number,
): Promise<MemoryReservation | undefined> {
  return memory && bytes > 0 ? memory.reserve(bytes) : undefined;
}
