import { OidTable } from "../graph/oid-table.js";
import { OBJECT_TYPES, type ObjectType } from "../object/object.js";
import { type Oid, oidToHex } from "../object/oid.js";
import type { MemoryBudget, MemoryReservation } from "../ports/memory-budget.js";

/**
 * Every object the new objects of a push point to, each once, with the type
 * the link requires: a commit's tree and parents, a tag's object, a tree's
 * entries (gitlinks left out). This is index-pack's `--strict` link check
 * (`mark_link`, `check_objects`): every link must resolve, in the pack or in
 * the repository, to an object of that type.
 */
export class LinkTable {
  readonly #oids = new OidTable(1024);
  #types = new Uint8Array(1024);
  readonly #memory: MemoryBudget;
  readonly #max: number;
  readonly #reservations: MemoryReservation[] = [];
  #reserved = 0;

  /** Bytes charged per link: oid table slot and oid, plus its type. Estimated. */
  static readonly BYTES_PER_LINK = 32;
  /** Reservations are taken in steps of this many bytes. */
  static readonly RESERVE_STEP = 1024 * 1024;

  constructor(memory: MemoryBudget, maxLinks: number) {
    this.#memory = memory;
    this.#max = maxLinks;
  }

  get size(): number {
    return this.#oids.size;
  }

  /**
   * Records a link. Throws `LinkError` when the oid was already linked as
   * another type, or when the table would exceed its limit.
   */
  async add(oid: Oid, type: ObjectType): Promise<void> {
    const before = this.#oids.size;
    const index = this.#oids.add(oid);
    const code = OBJECT_TYPES.indexOf(type) + 1;
    if (index < before) {
      const known = this.#types[index] as number;
      if (known !== code) {
        throw new LinkError([
          `fatal: object ${oidToHex(oid)}: expected type ${type}, found ${OBJECT_TYPES[known - 1]}`,
        ]);
      }
      return;
    }
    if (this.#oids.size > this.#max) {
      throw new LinkError([`fatal: connectivity check exceeded its limit of ${this.#max} objects`]);
    }
    const needed = this.#oids.size * LinkTable.BYTES_PER_LINK;
    while (this.#reserved < needed) {
      this.#reservations.push(await this.#memory.reserve(LinkTable.RESERVE_STEP));
      this.#reserved += LinkTable.RESERVE_STEP;
    }
    if (index >= this.#types.length) {
      const grown = new Uint8Array(this.#types.length * 2);
      grown.set(this.#types);
      this.#types = grown;
    }
    this.#types[index] = code;
  }

  /** Every link, in insertion order. */
  *entries(): Generator<readonly [Oid, ObjectType]> {
    for (let i = 0; i < this.#oids.size; i++) {
      yield [this.#oids.oidAt(i), OBJECT_TYPES[(this.#types[i] as number) - 1] as ObjectType];
    }
  }

  release(): void {
    for (const reservation of this.#reservations.splice(0)) reservation.release();
    this.#reserved = 0;
  }
}

/** A link the connectivity check refuses; the push fails as index-pack does. */
export class LinkError extends Error {
  override readonly name = "LinkError";
  /** Lines for the client, as git prints them. */
  readonly lines: readonly string[];
  constructor(lines: readonly string[]) {
    super(lines.join("\n"));
    this.lines = lines;
  }
}
