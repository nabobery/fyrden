import { createSha1Hasher } from "../hash/sha1.js";
import type { ObjectType } from "../object/object.js";
import type { Oid } from "../object/oid.js";
import type { HasherFactory } from "../ports/hasher.js";
import type { MemoryBudget } from "../ports/memory-budget.js";
import type { Zlib } from "../ports/zlib.js";
import type { PackEntries } from "./index-state.js";
import { resolveDeltas } from "./resolve.js";
import { scanPack } from "./scan.js";

/*
 * Pack indexing in two passes:
 * 1. `scanPack` streams the pack once: entry headers, bounded inflate, CRC32,
 *    ids of whole objects, the trailer checksum.
 * 2. `resolveDeltas` rebuilds every delta from its base, re-reading entries
 *    by offset through `readRange`, in an order that does not depend on
 *    where bases sit in the pack, then resolves a thin pack's external bases.
 * Objects are handed to `onObject` as they are produced and not kept, so
 * memory holds the per-entry records, the current delta chain and one
 * entry's buffers, not the pack's objects.
 */

export interface PackLimits {
  /** Largest object, delta base or delta result, in bytes. 32 MiB, the product limit. */
  readonly maxObjectBytes: number;
  /** Most entries in one pack. Proposed: 1,000,000 (about 48 MB of records); tuned under load. */
  readonly maxObjects: number;
  /**
   * Longest delta chain. Proposed: 50, git's `pack.depth` default (git
   * Documentation/config/pack.adoc, v2.53.0). At most 255. git accepts up to
   * 4095, so a client that raised `pack.depth` can be refused.
   */
  readonly maxDeltaDepth: number;
  /** Bytes of delta bases kept along the current chain. Proposed: 16 MiB; tuned under load. */
  readonly deltaBaseCacheBytes: number;
  /**
   * Buffers above this size get their own reservation from the memory
   * budget before they are allocated. Proposed: 1 MiB; tuned under load.
   */
  readonly largeObjectBytes: number;
}

export const DEFAULT_PACK_LIMITS: PackLimits = {
  maxObjectBytes: 32 * 1024 * 1024,
  maxObjects: 1_000_000,
  maxDeltaDepth: 50,
  deltaBaseCacheBytes: 16 * 1024 * 1024,
  largeObjectBytes: 1024 * 1024,
};

/** An object from the pack, whole or rebuilt from a delta. */
export interface PackObject {
  /** Entry index, in pack order. */
  readonly index: number;
  readonly oid: Oid;
  readonly type: ObjectType;
  /** The object's bytes, owned by the receiver. */
  readonly data: Uint8Array;
}

/** Reads `length` bytes at `offset` of the pack being parsed. */
export type PackRangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/**
 * Finds a thin pack's base outside the pack (in the repo's objects), or
 * returns undefined. The caller decides which objects a pack may use as
 * bases (for a push: only objects reachable from the repo's own refs).
 * The returned bytes are checked against the oid.
 */
export type ExternalBaseLookup = (
  oid: Oid,
) => Promise<{ readonly type: ObjectType; readonly data: Uint8Array } | undefined>;

export interface ParsePackOptions {
  readonly zlib: Zlib;
  /** Every large buffer and the per-entry records are reserved here first. */
  readonly memory: MemoryBudget;
  /**
   * Random access to the same pack bytes, for the second pass: one call per
   * delta and per delta base. Back it with large cached ranges, not one
   * storage read per call.
   */
  readonly readRange: PackRangeReader;
  /** Bases of a thin pack; without it, a delta against an object outside the pack is rejected. */
  readonly externalBase?: ExternalBaseLookup;
  /** Called once per object, whole objects during the first pass and deltas during the second. */
  readonly onObject?: (object: PackObject) => void | Promise<void>;
  readonly limits?: Partial<PackLimits>;
  /**
   * The trailer checksum's hasher. Default: git-core's SHA-1 without
   * collision detection (the trailer is not an object id).
   */
  readonly createTrailerHasher?: HasherFactory;
}

export interface ParsedPack {
  readonly version: 2 | 3;
  /** The trailer: SHA-1 of everything before it. */
  readonly checksum: Uint8Array;
  /** Bytes in the pack, trailer included. */
  readonly packLength: number;
  readonly entries: PackEntries;
  /** External objects a thin pack's deltas used, sorted by oid. Empty for a self-contained pack. */
  readonly thinBases: readonly Oid[];
  /** Returns the entry records' memory to the budget. */
  release(): void;
}

/**
 * Parses and indexes a pack: both passes, every check. Throws `PackError`
 * for a bad pack and `Sha1CollisionError` for an object built with a SHA-1
 * collision attack; errors from `onObject`, `readRange` and `externalBase`
 * pass through.
 */
export async function parsePack(
  source: AsyncIterable<Uint8Array>,
  options: ParsePackOptions,
): Promise<ParsedPack> {
  const limits = checkLimits({ ...DEFAULT_PACK_LIMITS, ...options.limits });
  const createTrailerHasher =
    options.createTrailerHasher ?? (() => createSha1Hasher({ detectCollisions: false }));
  const scan = await scanPack(source, {
    zlib: options.zlib,
    memory: options.memory,
    limits,
    trailerHasher: createTrailerHasher(),
    onObject: options.onObject,
  });
  const { state } = scan;
  try {
    const thinBases = await resolveDeltas({
      state,
      zlib: options.zlib,
      memory: options.memory,
      limits,
      readRange: options.readRange,
      externalBase: options.externalBase,
      onObject: options.onObject,
    });
    return {
      version: scan.version,
      checksum: scan.checksum,
      packLength: scan.packLength,
      entries: state,
      thinBases,
      release: () => state.release(),
    };
  } catch (error) {
    state.release();
    throw error;
  }
}

function checkLimits(limits: PackLimits): PackLimits {
  const positive = (name: keyof PackLimits, max: number) => {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new RangeError(`pack limit ${name} must be an integer from 1 to ${max}, not ${value}`);
    }
  };
  positive("maxObjectBytes", 0xffffffff);
  positive("maxObjects", 0xffffffff);
  positive("maxDeltaDepth", 255);
  positive("deltaBaseCacheBytes", Number.MAX_SAFE_INTEGER);
  positive("largeObjectBytes", Number.MAX_SAFE_INTEGER);
  return limits;
}
