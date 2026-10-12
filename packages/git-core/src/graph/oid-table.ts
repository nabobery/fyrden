import { OID_BYTES, type Oid } from "../object/oid.js";

/**
 * A set of oids that numbers them 0, 1, 2, ... in insertion order, stored in
 * flat typed arrays: 20 bytes per oid plus an open-addressing slot table kept
 * at most half full (two to four 4-byte slots per oid). Walks use the index
 * to keep per-commit state in typed arrays instead of one object per commit.
 */
export class OidTable implements Iterable<Oid> {
  #oids: Uint8Array;
  /** Index + 1 of the oid in each slot; 0 is empty. */
  #slots: Int32Array;
  #size = 0;

  constructor(expected = 16) {
    const capacity = Math.max(1, expected);
    this.#oids = new Uint8Array(capacity * OID_BYTES);
    this.#slots = new Int32Array(slotCountFor(capacity));
  }

  get size(): number {
    return this.#size;
  }

  /** Bytes allocated for the oids and the slot table. */
  get byteLength(): number {
    return this.#oids.byteLength + this.#slots.byteLength;
  }

  /** The index of the 20 bytes at `offset` in `bytes`, or -1. */
  indexOf(bytes: Uint8Array, offset = 0): number {
    const slot = this.#find(bytes, offset);
    return (this.#slots[slot] as number) - 1;
  }

  has(oid: Oid): boolean {
    return this.indexOf(oid) >= 0;
  }

  /** Adds `oid` if absent; returns its index either way. */
  add(oid: Oid): number {
    let slot = this.#find(oid, 0);
    const existing = (this.#slots[slot] as number) - 1;
    if (existing >= 0) return existing;
    const index = this.#size;
    if ((index + 1) * OID_BYTES > this.#oids.length) {
      const grown = new Uint8Array(this.#oids.length * 2);
      grown.set(this.#oids);
      this.#oids = grown;
    }
    this.#oids.set(oid.subarray(0, OID_BYTES), index * OID_BYTES);
    this.#size++;
    if (this.#size * 2 > this.#slots.length) {
      this.#rehash(this.#slots.length * 2);
      slot = this.#find(oid, 0);
    }
    this.#slots[slot] = index + 1;
    return index;
  }

  /** A copy of the oid at `index`. */
  oidAt(index: number): Oid {
    if (!Number.isInteger(index) || index < 0 || index >= this.#size) {
      throw new RangeError(`no oid at index ${index}`);
    }
    return this.#oids.slice(index * OID_BYTES, (index + 1) * OID_BYTES) as Oid;
  }

  /**
   * The table's packed oid bytes: the oid at index `i` starts at `i * 20`.
   * A view, valid until the next `add`; callers must not change it.
   */
  packedOids(): Uint8Array {
    return this.#oids.subarray(0, this.#size * OID_BYTES);
  }

  *[Symbol.iterator](): Generator<Oid> {
    for (let i = 0; i < this.#size; i++) yield this.oidAt(i);
  }

  /** The slot holding the oid at `offset`, or the empty slot where it would go. */
  #find(bytes: Uint8Array, offset: number): number {
    const slots = this.#slots;
    const mask = slots.length - 1;
    let slot = hash(bytes, offset) & mask;
    for (;;) {
      const entry = slots[slot] as number;
      if (entry === 0 || this.#equalsAt(entry - 1, bytes, offset)) return slot;
      slot = (slot + 1) & mask;
    }
  }

  #equalsAt(index: number, bytes: Uint8Array, offset: number): boolean {
    const oids = this.#oids;
    const base = index * OID_BYTES;
    for (let i = 0; i < OID_BYTES; i++) {
      if (oids[base + i] !== bytes[offset + i]) return false;
    }
    return true;
  }

  #rehash(slotCount: number): void {
    this.#slots = new Int32Array(slotCount);
    const mask = slotCount - 1;
    for (let index = 0; index < this.#size; index++) {
      let slot = hash(this.#oids, index * OID_BYTES) & mask;
      while (this.#slots[slot] !== 0) slot = (slot + 1) & mask;
      this.#slots[slot] = index + 1;
    }
  }
}

function slotCountFor(capacity: number): number {
  let slots = 16;
  while (slots < capacity * 2) slots *= 2;
  return slots;
}

/**
 * Mixes the first eight bytes. SHA-1 output is uniform, so this is enough for
 * honest ids; someone who grinds ids to collide here only slows walks over
 * their own repository, and walks are bounded anyway.
 */
function hash(bytes: Uint8Array, offset: number): number {
  const hi =
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0;
  const lo =
    (((bytes[offset + 4] as number) << 24) |
      ((bytes[offset + 5] as number) << 16) |
      ((bytes[offset + 6] as number) << 8) |
      (bytes[offset + 7] as number)) >>>
    0;
  // murmur3's finalizer steps, folding in the second word between them.
  let h = Math.imul(hi ^ (hi >>> 16), 0x85ebca6b) ^ lo;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
