import type { PackIdx } from "@fyrden/git-core";
import { DO_MEMORY } from "./memory-budget.js";

/**
 * What the cache holds for one pack: its whole `.idx`, or only the fanout
 * of an index too large to hold, which is then read by ranges.
 */
export type HeldPackIndex = PackIdx | Uint32Array;

interface Entry {
  /** Room set aside while loading (none while waiting for it), the real size once held. */
  bytes: number;
  readonly loading: Promise<HeldPackIndex>;
  held?: HeldPackIndex;
  /** Left the repository while loading: not kept once the load settles. */
  dropWhenSettled: boolean;
}

/** A load waiting for room. */
interface Waiting {
  readonly entry: Entry;
  readonly bytes: number;
  readonly load: () => Promise<HeldPackIndex>;
  readonly resolve: (loading: Promise<HeldPackIndex>) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * The `.idx` data of a repository's packs, kept in its Durable Object's
 * memory across requests (a pack never changes, so neither does its
 * index), so a lookup in a warm pack reads nothing from R2. Bounded by
 * `maxBytes`, carved out of the object's fixed memory beside the block
 * cache, with each load in flight counted at the room set aside for it.
 * Room is made by evicting held indexes, least recently used first, never
 * a load in flight: a load with no room waits, in order, for loads in
 * flight to settle. Keep one per object.
 */
export class PackIndexCache {
  readonly maxBytes: number;
  /** Every pack held, loading or waiting, least recently used first. */
  readonly #entries = new Map<string, Entry>();
  readonly #waiting: Waiting[] = [];
  #heldBytes = 0;
  #loadingBytes = 0;

  constructor(maxBytes: number = DO_MEMORY.indexCacheBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 * 1024) {
      throw new RangeError(`a pack index cache needs at least 4 KiB, not ${maxBytes}`);
    }
    this.maxBytes = maxBytes;
  }

  /** Bytes held or set aside for loads in flight. Never more than `maxBytes`. */
  get bytes(): number {
    return this.#heldBytes + this.#loadingBytes;
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
   * The pack's index: held, being loaded (or waiting to be) for another
   * caller (shared), or loaded by `load` once `bytes` of room (the expected
   * size, at most `maxWholeBytes`) is free. Once loaded it is counted at its
   * real size, and not kept if that does not fit. A failed load is not
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
    const { promise, resolve, reject } = Promise.withResolvers<HeldPackIndex>();
    const entry: Entry = { bytes: 0, loading: promise, dropWhenSettled: false };
    this.#entries.set(packId, entry);
    promise.then(
      (held) => this.#settle(packId, entry, held),
      () => this.#settle(packId, entry, undefined),
    );
    this.#waiting.push({ entry, bytes, load, resolve, reject });
    this.#startWaiting();
    return promise;
  }

  /**
   * Drops every pack not in `packIds`: they left the repository (retired or
   * deleted). A load in flight or waiting keeps its room until it settles.
   */
  retain(packIds: ReadonlySet<string>): void {
    for (const [packId, entry] of this.#entries) {
      if (entry.held === undefined) entry.dropWhenSettled = !packIds.has(packId);
      else if (!packIds.has(packId)) this.#evict(packId, entry);
    }
  }

  /** Starts the waiting loads, in order, while there is room for the next. */
  #startWaiting(): void {
    for (let next = this.#waiting[0]; next; next = this.#waiting[0]) {
      if (!this.#makeRoom(next.bytes)) return;
      this.#waiting.shift();
      next.entry.bytes = next.bytes;
      this.#loadingBytes += next.bytes;
      try {
        next.resolve(next.load());
      } catch (error) {
        next.reject(error);
      }
    }
  }

  /** Keeps a loaded index if it may stay and fits, then starts the loads its room frees. */
  #settle(packId: string, entry: Entry, held: HeldPackIndex | undefined): void {
    this.#loadingBytes -= entry.bytes;
    if (
      held === undefined ||
      entry.dropWhenSettled ||
      held.byteLength > this.maxWholeBytes ||
      !this.#makeRoom(held.byteLength)
    ) {
      this.#entries.delete(packId);
    } else {
      entry.bytes = held.byteLength;
      entry.held = held;
      this.#heldBytes += entry.bytes;
    }
    this.#startWaiting();
  }

  /**
   * Evicts held indexes, least recently used first, until `bytes` more fit.
   * False, evicting none, when the room set aside for loads leaves too little.
   */
  #makeRoom(bytes: number): boolean {
    if (this.#loadingBytes + bytes > this.maxBytes) return false;
    for (const [packId, entry] of this.#entries) {
      if (this.bytes + bytes <= this.maxBytes) break;
      if (entry.held !== undefined) this.#evict(packId, entry);
    }
    return true;
  }

  #touch(packId: string, entry: Entry): void {
    this.#entries.delete(packId);
    this.#entries.set(packId, entry);
  }

  #evict(packId: string, entry: Entry): void {
    this.#entries.delete(packId);
    this.#heldBytes -= entry.bytes;
  }
}
