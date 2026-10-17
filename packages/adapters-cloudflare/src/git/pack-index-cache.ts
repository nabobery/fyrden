import type { PackIdx } from "@fyrden/git-core";
import { DO_MEMORY } from "./memory-budget.js";

/**
 * What the cache holds for one pack: its whole `.idx`, or only the fanout
 * of an index too large to hold, which is then read by ranges.
 */
export type HeldPackIndex = PackIdx | Uint32Array;

interface Entry {
  /** Bytes counted against the bound: room made before the load, the real size after. */
  bytes: number;
  readonly loading: Promise<HeldPackIndex>;
  held?: HeldPackIndex;
}

/**
 * The `.idx` data of a repository's packs, kept in its Durable Object's
 * memory across requests (a pack never changes, so neither does its
 * index), so a lookup in a warm pack reads nothing from R2. Bounded by
 * `maxBytes`, carved out of the object's fixed memory beside the block
 * cache; the least recently used pack goes first. Keep one per object.
 */
export class PackIndexCache {
  readonly maxBytes: number;
  readonly #entries = new Map<string, Entry>();
  #bytes = 0;

  constructor(maxBytes: number = DO_MEMORY.indexCacheBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 * 1024) {
      throw new RangeError(`a pack index cache needs at least 4 KiB, not ${maxBytes}`);
    }
    this.maxBytes = maxBytes;
  }

  /** Bytes held or set aside for loads. Never more than `maxBytes`. */
  get bytes(): number {
    return this.#bytes;
  }

  get count(): number {
    return this.#entries.size;
  }

  /** Largest index held whole: a quarter of the bound, so one pack cannot take it all. */
  get maxWholeBytes(): number {
    return Math.floor(this.maxBytes / 4);
  }

  /** The pack's index when loaded, marked most recently used. */
  get(packId: string): HeldPackIndex | undefined {
    const entry = this.#entries.get(packId);
    if (entry?.held === undefined) return undefined;
    this.#touch(packId, entry);
    return entry.held;
  }

  /**
   * The pack's index: held, being loaded by another caller (shared), or
   * loaded now by `load` after making `bytes` of room (the expected size,
   * at most `maxWholeBytes`). Once loaded it is counted at its real size,
   * and dropped if that is more than `maxWholeBytes`. A failed load is not
   * kept, so the next caller tries again.
   */
  load(packId: string, bytes: number, load: () => Promise<HeldPackIndex>): Promise<HeldPackIndex> {
    const known = this.#entries.get(packId);
    if (known) {
      this.#touch(packId, known);
      return known.loading;
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maxWholeBytes) {
      throw new RangeError(`cannot hold ${bytes} bytes of index (at most ${this.maxWholeBytes})`);
    }
    this.#evictFor(bytes);
    const entry: Entry = { bytes, loading: load() };
    this.#entries.set(packId, entry);
    this.#bytes += bytes;
    entry.loading.then(
      (held) => this.#settle(packId, entry, held),
      () => this.#drop(packId, entry),
    );
    return entry.loading;
  }

  /** Drops every pack not in `packIds`: they left the repository (retired or deleted). */
  retain(packIds: ReadonlySet<string>): void {
    for (const [packId, entry] of [...this.#entries]) {
      if (!packIds.has(packId)) this.#drop(packId, entry);
    }
  }

  #settle(packId: string, entry: Entry, held: HeldPackIndex): void {
    if (this.#entries.get(packId) !== entry) return;
    const size = held.byteLength;
    if (size > this.maxWholeBytes) {
      this.#drop(packId, entry);
      return;
    }
    this.#bytes += size - entry.bytes;
    entry.bytes = size;
    entry.held = held;
    // A load larger than the room made for it: evict others, oldest first.
    for (const [other, victim] of this.#entries) {
      if (this.#bytes <= this.maxBytes) break;
      if (victim !== entry) this.#drop(other, victim);
    }
  }

  #evictFor(bytes: number): void {
    for (const [packId, entry] of this.#entries) {
      if (this.#bytes + bytes <= this.maxBytes) return;
      this.#drop(packId, entry);
    }
  }

  #touch(packId: string, entry: Entry): void {
    this.#entries.delete(packId);
    this.#entries.set(packId, entry);
  }

  #drop(packId: string, entry: Entry): void {
    if (this.#entries.get(packId) !== entry) return;
    this.#entries.delete(packId);
    this.#bytes -= entry.bytes;
  }
}
