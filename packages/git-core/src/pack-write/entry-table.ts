import { OID_BYTES } from "../object/oid.js";
import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";

/*
 * The entries written so far, in pack order, as flat typed arrays (what the
 * `.idx` writer takes and what a checkpoint saves): 20-byte oid, offset and
 * CRC32 per entry, 32 bytes in all. Every byte is reserved from the memory
 * budget before it is allocated.
 */

export const ENTRY_TABLE_BYTES_PER_ENTRY = OID_BYTES + 8 + 4;
const MIN_CAPACITY = 256;

export class EntryTable {
  readonly #memory: MemoryBudget;
  readonly #maxCount: number;
  #reservation: MemoryReservation | undefined;
  #capacity = 0;
  count = 0;
  oids = new Uint8Array(0);
  offsets = new Float64Array(0);
  crc32s = new Uint32Array(0);

  /** The table never grows past `maxCount` entries (the pack's object count). */
  constructor(memory: MemoryBudget, maxCount: number) {
    this.#memory = memory;
    this.#maxCount = maxCount;
  }

  async add(oid: Uint8Array, offset: number, crc: number): Promise<void> {
    if (this.count === this.#capacity) await this.#grow(this.count + 1);
    const i = this.count++;
    this.oids.set(oid.subarray(0, OID_BYTES), i * OID_BYTES);
    this.offsets[i] = offset;
    this.crc32s[i] = crc;
  }

  /** Makes room for `count` entries at once (restoring a checkpoint). */
  async ensure(count: number): Promise<void> {
    if (count > this.#capacity) await this.#grow(count);
  }

  release(): void {
    this.#reservation?.release();
    this.#reservation = undefined;
  }

  async #grow(atLeast: number): Promise<void> {
    const capacity = Math.min(
      Math.max(this.#capacity * 2, MIN_CAPACITY, atLeast),
      Math.max(this.#maxCount, atLeast),
    );
    const reservation = await this.#memory.reserve(capacity * ENTRY_TABLE_BYTES_PER_ENTRY);
    const oids = new Uint8Array(capacity * OID_BYTES);
    oids.set(this.oids);
    const offsets = new Float64Array(capacity);
    offsets.set(this.offsets);
    const crc32s = new Uint32Array(capacity);
    crc32s.set(this.crc32s);
    this.oids = oids;
    this.offsets = offsets;
    this.crc32s = crc32s;
    this.#reservation?.release();
    this.#reservation = reservation;
    this.#capacity = capacity;
  }
}

/** A growable list of 20-byte oids (the bases of REF_DELTA entries written). */
export class OidList {
  readonly #memory: MemoryBudget;
  #reservation: MemoryReservation | undefined;
  count = 0;
  bytes = new Uint8Array(0);

  constructor(memory: MemoryBudget) {
    this.#memory = memory;
  }

  async add(oid: Uint8Array): Promise<void> {
    await this.ensure(this.count + 1);
    this.bytes.set(oid.subarray(0, OID_BYTES), this.count * OID_BYTES);
    this.count++;
  }

  async ensure(count: number): Promise<void> {
    if (count * OID_BYTES <= this.bytes.length) return;
    const slots = Math.max(count, this.count * 2, MIN_CAPACITY);
    const reservation = await this.#memory.reserve(slots * OID_BYTES);
    const next = new Uint8Array(slots * OID_BYTES);
    next.set(this.bytes);
    this.bytes = next;
    this.#reservation?.release();
    this.#reservation = reservation;
  }

  release(): void {
    this.#reservation?.release();
    this.#reservation = undefined;
  }
}
