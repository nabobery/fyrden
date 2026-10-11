import type { ObjectType } from "../object/object.js";

/** An object rebuilt from a pack, as the delta-base cache keeps it. */
export interface CachedObject {
  readonly type: ObjectType;
  readonly data: Uint8Array;
}

/**
 * Bytes charged per entry on top of its data, so empty objects still count.
 * Proposed; an estimate of the Map entry and key string.
 */
export const DELTA_BASE_ENTRY_OVERHEAD = 64;

/**
 * Objects already rebuilt during one operation, keyed by where their entry
 * sits (pack position in the view, pack offset), least recently used
 * evicted first, bounded by bytes (as JGit's DeltaBaseCache). Delta chains
 * share bases, so one cached base saves inflating it and its whole chain
 * again. An object larger than the capacity is not kept.
 */
export class DeltaBaseCache {
  readonly capacity: number;
  #bytes = 0;
  // A Map iterates in insertion order: re-inserting on use keeps it in recency order.
  readonly #entries = new Map<string, CachedObject>();

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError(`bad delta-base cache capacity ${capacity}`);
    }
    this.capacity = capacity;
  }

  /** Bytes charged for the entries held. */
  get bytes(): number {
    return this.#bytes;
  }

  get count(): number {
    return this.#entries.size;
  }

  /** The cached object, now the most recently used. */
  get(pack: number, offset: number): CachedObject | undefined {
    const key = keyOf(pack, offset);
    const found = this.#entries.get(key);
    if (found === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, found);
    return found;
  }

  /** The cached object, without changing the order. */
  peek(pack: number, offset: number): CachedObject | undefined {
    return this.#entries.get(keyOf(pack, offset));
  }

  /** Keeps the object, evicting the least recently used; false when it alone exceeds the capacity. */
  put(pack: number, offset: number, value: CachedObject): boolean {
    const key = keyOf(pack, offset);
    this.#remove(key);
    const cost = costOf(value);
    if (cost > this.capacity) return false;
    this.#entries.set(key, value);
    this.#bytes += cost;
    for (const oldest of this.#entries.keys()) {
      if (this.#bytes <= this.capacity) break;
      this.#remove(oldest);
    }
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  #remove(key: string): void {
    const old = this.#entries.get(key);
    if (old === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= costOf(old);
  }
}

function keyOf(pack: number, offset: number): string {
  return `${pack}:${offset}`;
}

function costOf(value: CachedObject): number {
  return value.data.length + DELTA_BASE_ENTRY_OVERHEAD;
}
