import type { BitSet } from "../graph/bitset.js";
import { OID_BYTES } from "../object/oid.js";
import { decodeEntryHeader, PACK_HEADER_BYTES, PACK_TRAILER_BYTES } from "../pack/entry-header.js";
import type { PackIdx } from "../pack/idx-read.js";
import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";
import type { PackId } from "../ports/pack-store.js";
import { PackWriteError } from "./errors.js";
import { forEachOidGroup } from "./oid-merge.js";
import type { WindowReader } from "./window-reader.js";

/*
 * Which entries a compaction copies, and in what order. Every source entry
 * gets a global number `g` (source by source, in `.idx` position order).
 * The output is the sources in order, each in pack-offset order, so a
 * source's entries stay contiguous and their OFS_DELTA distances stay
 * valid.
 *
 * An object stored more than once is written once. The copy kept is the
 * first whole copy in output order, or the first copy when every copy is a
 * delta. Entry kinds are not in the `.idx`, so the headers of duplicated
 * entries (only those) are read first. The plan is a pure function of the
 * sources, so a resumed compaction recomputes it instead of saving it.
 *
 * A source may carry a keep set: then only its entries whose `.idx`
 * position is set are written, and the others count as absent (they are
 * never a kept copy of a duplicated object).
 */

/** Not written: another copy of the same object is. */
export const DROPPED = 0xffffffff;
const FLAG_DUPLICATED = 1;
const FLAG_DELTA = 2;
/** Left out by the source's keep set. */
const FLAG_EXCLUDED = 4;
/** Plan arrays per entry: order, rank, canonical, output index (4 each) and flags (1). */
const PLAN_BYTES_PER_ENTRY = 17;
/** Enough for any entry header (type and size, plus a 20-byte base oid). */
const MAX_HEADER_BYTES = 32;

export interface CompactionSource {
  readonly packId: PackId;
  /** Bytes in the pack, trailer included. */
  readonly packLength: number;
  /** The pack's `.idx`. */
  readonly idx: PackIdx;
  /**
   * The entries to write, by `.idx` position (size: the `.idx` count).
   * Absent: every entry. A resumed compaction must get the same sets.
   */
  readonly keep?: BitSet;
}

export class CompactionPlan {
  readonly sources: readonly CompactionSource[];
  /** `firsts[s]` is the global number of source `s`'s first entry; `firsts[n]` the total. */
  readonly firsts: readonly number[];
  readonly total: number;
  /** Global numbers in output order (sources in order, each by pack offset). */
  readonly order: Uint32Array;
  /** Index into `order` of each global number. */
  readonly rank: Uint32Array;
  /** The global number of the copy written for each entry's object. */
  readonly canonical: Uint32Array;
  /** Output entry index of each kept entry, or `DROPPED`. */
  readonly outIndex: Uint32Array;
  readonly #flags: Uint8Array;
  readonly #reservation: MemoryReservation;
  objectCount = 0;

  private constructor(
    sources: readonly CompactionSource[],
    reservation: MemoryReservation | undefined,
  ) {
    this.sources = sources;
    const firsts = [0];
    for (const s of sources) firsts.push((firsts.at(-1) as number) + s.idx.count);
    this.firsts = firsts;
    this.total = firsts.at(-1) as number;
    this.order = new Uint32Array(this.total);
    this.rank = new Uint32Array(this.total);
    this.canonical = new Uint32Array(this.total);
    this.outIndex = new Uint32Array(this.total);
    this.#flags = new Uint8Array(this.total);
    this.#reservation = reservation ?? { bytes: 0, release() {} };
  }

  static async build(
    sources: readonly CompactionSource[],
    reader: WindowReader,
    memory: MemoryBudget,
  ): Promise<CompactionPlan> {
    if (sources.length > 0xffff) throw new RangeError(`${sources.length} sources are too many`);
    for (const source of sources) {
      if (source.keep && source.keep.size !== source.idx.count) {
        throw new RangeError(
          `the keep set of pack ${source.packId} has ${source.keep.size} positions, not ${source.idx.count}`,
        );
      }
    }
    const total = sources.reduce((n, s) => n + s.idx.count, 0);
    if (total >= DROPPED) throw new RangeError(`${total} entries are too many to compact at once`);
    const reservation = total > 0 ? await memory.reserve(total * PLAN_BYTES_PER_ENTRY) : undefined;
    const plan = new CompactionPlan(sources, reservation);
    try {
      plan.#sortByOffset();
      plan.#exclude();
      const groups = plan.#findDuplicates();
      if (groups.length > 0) await plan.#readDuplicateKinds(reader);
      for (const group of groups) plan.#keepOne(group);
      plan.#numberOutput();
      return plan;
    } catch (error) {
      plan.release();
      throw error;
    }
  }

  sourceOf(g: number): number {
    let s = 0;
    while ((this.firsts[s + 1] as number) <= g) s++;
    return s;
  }

  /** Pack offset of entry `g` in its source. */
  offsetOf(g: number, s = this.sourceOf(g)): number {
    return (this.sources[s] as CompactionSource).idx.offsetAt(g - (this.firsts[s] as number));
  }

  /** Where entry `g` ends: the next entry's offset, or the trailer. */
  endOf(g: number, s = this.sourceOf(g)): number {
    const r = (this.rank[g] as number) + 1;
    if (r < (this.firsts[s + 1] as number)) return this.offsetOf(this.order[r] as number, s);
    return (this.sources[s] as CompactionSource).packLength - PACK_TRAILER_BYTES;
  }

  /** The entry of source `s` that starts at `offset`, or -1. */
  entryAt(s: number, offset: number): number {
    let lo = this.firsts[s] as number;
    let hi = (this.firsts[s + 1] as number) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = this.offsetOf(this.order[mid] as number, s);
      if (at === offset) return this.order[mid] as number;
      if (at < offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Some entry holding this object, or -1 when no source has it. */
  find(oid: Uint8Array): number {
    for (let s = 0; s < this.sources.length; s++) {
      const p = (this.sources[s] as CompactionSource).idx.find(oid);
      if (p >= 0) return (this.firsts[s] as number) + p;
    }
    return -1;
  }

  /** The entry written for this object, or -1 when no source writes it. */
  findKept(oid: Uint8Array): number {
    for (let s = 0; s < this.sources.length; s++) {
      const p = (this.sources[s] as CompactionSource).idx.find(oid);
      if (p < 0) continue;
      const g = (this.firsts[s] as number) + p;
      if (!this.isExcluded(g)) return this.canonical[g] as number;
    }
    return -1;
  }

  /** Whether entry `g` is left out by its source's keep set. */
  isExcluded(g: number): boolean {
    return ((this.#flags[g] as number) & FLAG_EXCLUDED) !== 0;
  }

  isDuplicated(g: number): boolean {
    return ((this.#flags[g] as number) & FLAG_DUPLICATED) !== 0;
  }

  /** Whether entry `g` is a delta; known only for entries whose object is stored more than once. */
  isKnownDelta(g: number): boolean {
    return ((this.#flags[g] as number) & FLAG_DELTA) !== 0;
  }

  release(): void {
    this.#reservation.release();
  }

  #sortByOffset(): void {
    this.sources.forEach((source, s) => {
      const first = this.firsts[s] as number;
      const { idx, packLength } = source;
      const offsets = new Float64Array(idx.count);
      for (let p = 0; p < idx.count; p++) offsets[p] = idx.offsetAt(p);
      const positions = new Uint32Array(idx.count).map((_, p) => p);
      positions.sort((a, b) => (offsets[a] as number) - (offsets[b] as number));
      let previous = PACK_HEADER_BYTES - 1;
      positions.forEach((p, k) => {
        const offset = offsets[p] as number;
        if (offset <= previous || offset >= packLength - PACK_TRAILER_BYTES) {
          throw new PackWriteError(
            "corrupt-source",
            `pack ${source.packId}: .idx offset ${offset} is repeated or outside the pack`,
          );
        }
        previous = offset;
        this.order[first + k] = first + p;
        this.rank[first + p] = first + k;
      });
    });
    for (let g = 0; g < this.total; g++) this.canonical[g] = g;
  }

  #exclude(): void {
    this.sources.forEach((source, s) => {
      const { keep } = source;
      if (!keep) return;
      const first = this.firsts[s] as number;
      for (let p = 0; p < source.idx.count; p++) {
        if (!keep.has(p)) this.#flags[first + p] = FLAG_EXCLUDED;
      }
    });
  }

  #findDuplicates(): number[][] {
    const groups: number[][] = [];
    const tables = this.sources.map((s) => s.idx.oidTable());
    forEachOidGroup(tables, (copies) => {
      if (copies.length < 2) return;
      const group = copies
        .map((c) => (this.firsts[c.table] as number) + c.at / OID_BYTES)
        .filter((g) => !this.isExcluded(g));
      if (group.length < 2) return;
      for (const g of group) this.#flags[g] = FLAG_DUPLICATED;
      groups.push(group);
    });
    return groups;
  }

  async #readDuplicateKinds(reader: WindowReader): Promise<void> {
    for (let s = 0; s < this.sources.length; s++) {
      const source = this.sources[s] as CompactionSource;
      const limit = source.packLength - PACK_TRAILER_BYTES;
      for (let r = this.firsts[s] as number; r < (this.firsts[s + 1] as number); r++) {
        const g = this.order[r] as number;
        if (!this.isDuplicated(g)) continue;
        const offset = this.offsetOf(g, s);
        const length = Math.min(MAX_HEADER_BYTES, this.endOf(g, s) - offset);
        const bytes = await reader.bytes(source.packId, offset, length, limit);
        let header: ReturnType<typeof decodeEntryHeader>;
        try {
          header = decodeEntryHeader(bytes, 0, offset, Number.MAX_SAFE_INTEGER);
        } catch (error) {
          throw new PackWriteError("corrupt-source", `entry header: ${(error as Error).message}`);
        }
        if (header === undefined)
          throw new PackWriteError("corrupt-source", "entry header is truncated");
        if (header.kind === "ofs-delta" || header.kind === "ref-delta")
          this.#flags[g] = (this.#flags[g] as number) | FLAG_DELTA;
      }
    }
  }

  #keepOne(group: readonly number[]): void {
    let kept = -1;
    for (const g of group) {
      if (kept < 0) {
        kept = g;
        continue;
      }
      const whole = !this.isKnownDelta(g);
      const keptWhole = !this.isKnownDelta(kept);
      if (
        (whole && !keptWhole) ||
        (whole === keptWhole && (this.rank[g] as number) < (this.rank[kept] as number))
      ) {
        kept = g;
      }
    }
    for (const g of group) this.canonical[g] = kept;
  }

  #numberOutput(): void {
    let k = 0;
    for (let r = 0; r < this.total; r++) {
      const g = this.order[r] as number;
      this.outIndex[g] = this.canonical[g] === g && !this.isExcluded(g) ? k++ : DROPPED;
    }
    this.objectCount = k;
  }
}
