import type { OidTable } from "../graph/oid-table.js";
import type { Oid } from "../object/oid.js";
import { decodeEntryHeader, type EntryHeader, PACK_TRAILER_BYTES } from "../pack/entry-header.js";
import { PackError } from "../pack/errors.js";
import { inflateEntry, maxCompressedBytes, NeedMoreInput } from "../pack/inflate.js";
import { DEFAULT_PACK_LIMITS } from "../pack/parse.js";
import { PackBuilder, type PackSink } from "../pack-write/pack-builder.js";
import type { MemoryBudget } from "../ports/memory-budget.js";
import type { PackStore } from "../ports/pack-store.js";
import type { Zlib } from "../ports/zlib.js";
import { MissingObjectError } from "../reader/errors.js";
import type { ObjectReader } from "../reader/object-reader.js";
import { SequentialPackReader } from "../reader/range-planner.js";
import type { ReadStats } from "../reader/stats.js";
import type { RepoView, ViewPack } from "../reader/view.js";

/*
 * Writes a regenerated fetch pack: exactly the selected objects, each
 * once, read pack by pack in offset order with large sequential ranges.
 *
 * Stored representations are reused (JGit and git do the same): a whole
 * object is copied byte for byte, and a delta is copied when its base is
 * also in the new pack and already written, which keeps every delta
 * pointing backwards, so no chain can loop. Any other delta is rebuilt by
 * the object reader and written whole: its base may be an object the
 * client lacks and is not sent, or one outside this repository's
 * reachable closure (a pack shared with other repositories), and a
 * regenerated pack never deltas against such an object.
 *
 * With `externalBases` (the client sent `thin-pack`), a delta whose base
 * is not sent but is one of those objects is copied as a REF_DELTA against
 * it: the pack is thin, and the client completes it from its own objects.
 * Without it the pack is self-contained.
 */

export interface RegenerateOptions {
  readonly view: RepoView;
  readonly packStore: Pick<PackStore, "openRange">;
  readonly zlib: Zlib;
  readonly memory: MemoryBudget;
  /** Rebuilds deltas that cannot be copied. */
  readonly reader: Pick<ObjectReader, "readObject">;
  readonly stats: ReadStats;
  /** Write copied deltas as OFS_DELTA (the client sent `ofs-delta`). */
  readonly ofsDelta: boolean;
  /**
   * Objects the client is proven to hold, for a thin pack: a stored delta
   * against one of them is kept rather than rebuilt whole.
   */
  readonly externalBases?: OidTable;
  /** Bytes per sequential read. */
  readonly rangeBytes: number;
  readonly sink: PackSink;
}

export interface RegeneratedPack {
  readonly objectCount: number;
  readonly packLength: number;
  /** Entries copied as stored (whole or delta), and entries rebuilt and deflated. */
  readonly copied: number;
  readonly rebuilt: number;
  /** Deltas kept against an object the client holds (a thin pack). */
  readonly thin: number;
}

interface Located {
  readonly index: number;
  readonly offset: number;
  readonly crc32: number;
}

export async function writeRegeneratedPack(
  objects: OidTable,
  options: RegenerateOptions,
): Promise<RegeneratedPack> {
  const byPack = await locate(objects, options.view);
  const builder = await PackBuilder.start(objects.size, {
    sink: options.sink,
    zlib: options.zlib,
    memory: options.memory,
    ofsDelta: options.ofsDelta,
    ...(options.externalBases ? { externalBases: options.externalBases } : {}),
  });
  const written = new Float64Array(objects.size).fill(-1);
  const heldBase = options.externalBases
    ? heldBaseFinder(options.externalBases, options.view)
    : undefined;
  let copied = 0;
  let rebuilt = 0;
  let thin = 0;
  try {
    const reservation = await options.memory.reserve(options.rangeBytes);
    try {
      for (const [packIndex, entries] of byPack.entries()) {
        const pack = options.view.packs[packIndex] as ViewPack;
        if (entries.length === 0) continue;
        entries.sort((a, b) => a.offset - b.offset);
        const atOffset = new Map(entries.map((e) => [e.offset, e.index]));
        const sequential = new SequentialPackReader(
          options.packStore,
          pack,
          options.rangeBytes,
          options.stats,
        );
        for (const entry of entries) {
          const oid = objects.oidAt(entry.index);
          const raw = await readRawEntry(sequential, pack, entry.offset, options.zlib);
          const base = baseIndex(raw.header, atOffset, objects);
          const copy = { oid, bytes: raw.bytes, offset: entry.offset, crc32: entry.crc32 };
          let at: number;
          if (raw.header.kind !== "ofs-delta" && raw.header.kind !== "ref-delta") {
            at = await builder.copyEntry(copy);
            copied++;
          } else if (base !== undefined && (written[base] as number) >= 0) {
            at = await builder.copyEntry(copy, {
              oid: objects.oidAt(base),
              offset: written[base] as number,
            });
            copied++;
          } else {
            // A delta whose base is not sent: keep it against a base the
            // client holds (thin), else rebuild the object whole.
            const held = base === undefined ? await heldBase?.(raw.header, packIndex) : undefined;
            if (held !== undefined) {
              at = await builder.copyEntry(copy, { oid: held });
              thin++;
            } else {
              const object = await options.reader.readObject(oid);
              if (!object) throw new MissingObjectError([oid]);
              at = await builder.addObject(object.type, object.bytes, oid);
              rebuilt++;
            }
          }
          written[entry.index] = at;
        }
      }
    } finally {
      reservation.release();
    }
    const finished = await builder.finish();
    finished.release();
    return { objectCount: objects.size, packLength: finished.packLength, copied, rebuilt, thin };
  } catch (error) {
    builder.release();
    throw error;
  }
}

/**
 * The held object a stored delta's base is, if any. A REF_DELTA names its
 * base; an OFS_DELTA's base is found by where the held objects are stored,
 * located once (in memory, one lookup per held object and pack) on first
 * need.
 */
function heldBaseFinder(held: OidTable, view: RepoView) {
  let stored: Promise<Map<string, Oid>> | undefined;
  const locateHeld = async () => {
    const at = new Map<string, Oid>();
    for (let i = 0; i < held.size; i++) {
      const oid = held.oidAt(i);
      for (const [p, pack] of view.packs.entries()) {
        if (pack.summary && !pack.summary.mayContain(oid)) continue;
        const hit = await pack.idx.lookup(oid);
        if (hit) at.set(`${p}:${hit.offset}`, oid);
      }
    }
    return at;
  };
  return async (header: EntryHeader, packIndex: number): Promise<Oid | undefined> => {
    if (header.kind === "ref-delta") {
      return held.has(header.baseOid) ? header.baseOid : undefined;
    }
    if (header.kind !== "ofs-delta") return undefined;
    stored ??= locateHeld();
    return (await stored).get(`${packIndex}:${header.baseOffset}`);
  };
}

/** Where each object is: the first pack of the view holding it, as the reader looks it up. */
async function locate(objects: OidTable, view: RepoView): Promise<Located[][]> {
  const byPack: Located[][] = view.packs.map(() => []);
  const missing: Oid[] = [];
  for (let index = 0; index < objects.size; index++) {
    const oid = objects.oidAt(index);
    let found = false;
    for (const [p, pack] of view.packs.entries()) {
      if (pack.summary && !pack.summary.mayContain(oid)) continue;
      const hit = await pack.idx.lookup(oid);
      if (!hit) continue;
      byPack[p]?.push({ index, offset: hit.offset, crc32: hit.crc32 });
      found = true;
      break;
    }
    if (!found) missing.push(oid);
  }
  if (missing.length > 0) throw new MissingObjectError(missing);
  return byPack;
}

/** The selected object a delta's base is, when the base is selected and stored in the same place. */
function baseIndex(
  header: EntryHeader,
  atOffset: ReadonlyMap<number, number>,
  objects: OidTable,
): number | undefined {
  if (header.kind === "ofs-delta") return atOffset.get(header.baseOffset);
  if (header.kind === "ref-delta") {
    const i = objects.indexOf(header.baseOid);
    return i >= 0 ? i : undefined;
  }
  return undefined;
}

/** First read for an entry: its header and, usually, its whole zlib stream. Proposed. */
const FIRST_READ_BYTES = 64 * 1024;

/**
 * The entry at `offset` as stored: header and zlib stream. The stream's
 * length is found by inflating it (bounded by the size in the header), as
 * the reader's entry decoder does.
 */
async function readRawEntry(
  sequential: SequentialPackReader,
  pack: ViewPack,
  offset: number,
  zlib: Zlib,
): Promise<{ header: EntryHeader; bytes: Uint8Array }> {
  const end = pack.bytes - PACK_TRAILER_BYTES;
  const max = DEFAULT_PACK_LIMITS.maxObjectBytes;
  let want = Math.min(end, offset + FIRST_READ_BYTES);
  let bytes = (await sequential.advance(offset, want)).subarray(0, end - offset);
  const header = decodeEntryHeader(bytes, 0, offset, max);
  if (header === undefined)
    throw new PackError("truncated", "entry header runs into the trailer", offset);
  const bound = Math.min(end, offset + header.length + maxCompressedBytes(header.size));
  for (;;) {
    const available = Math.min(bytes.length, bound - offset);
    try {
      const { consumed } = inflateEntry(
        zlib,
        bytes.subarray(header.length, available),
        header.size,
        offset,
      );
      return { header, bytes: bytes.subarray(0, header.length + consumed) };
    } catch (error) {
      if (!(error instanceof NeedMoreInput)) throw error;
      if (offset + available >= bound) {
        throw new PackError("truncated", "zlib stream runs past the bound for its size", offset);
      }
      want = Math.min(bound, offset + 2 * Math.max(available, FIRST_READ_BYTES));
      bytes = (await sequential.advance(offset, want)).subarray(0, end - offset);
    }
  }
}
