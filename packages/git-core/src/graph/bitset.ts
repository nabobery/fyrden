const MAX_SIZE = 2 ** 32;

/**
 * A fixed-size set of positions, one bit each: the reachability mark of a
 * pack, indexed by an object's position in the pack's `.idx`. A pack of 1M
 * objects needs 125,000 bytes.
 */
export class BitSet {
  readonly size: number;
  readonly #words: Uint32Array;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 0 || size > MAX_SIZE) {
      throw new RangeError(`bit set size must be a whole number from 0 to 2^32, got ${size}`);
    }
    this.size = size;
    this.#words = new Uint32Array(Math.ceil(size / 32));
  }

  get byteLength(): number {
    return this.#words.byteLength;
  }

  /** Sets bit `i`; returns true when it was clear before. */
  set(i: number): boolean {
    this.#check(i);
    const word = i >>> 5;
    const mask = 1 << (i & 31);
    const before = this.#words[word] as number;
    this.#words[word] = before | mask;
    return (before & mask) === 0;
  }

  has(i: number): boolean {
    this.#check(i);
    return ((this.#words[i >>> 5] as number) & (1 << (i & 31))) !== 0;
  }

  /** Number of set bits. */
  count(): number {
    let total = 0;
    for (const word of this.#words) total += popcount(word);
    return total;
  }

  /** Adds every bit of `other`, which must have the same size. */
  or(other: BitSet): void {
    if (other.size !== this.size) {
      throw new RangeError(`cannot combine bit sets of sizes ${this.size} and ${other.size}`);
    }
    const words = this.#words;
    const theirs = other.#words;
    for (let w = 0; w < words.length; w++) words[w] = (words[w] as number) | (theirs[w] as number);
  }

  /** The positions not set, as a new set of the same size. */
  complement(): BitSet {
    const out = new BitSet(this.size);
    const words = out.#words;
    for (let w = 0; w < words.length; w++) words[w] = ~(this.#words[w] as number);
    out.#clearTail();
    return out;
  }

  /** A copy of the bits as bytes (little-endian 32-bit words), for `fromBytes`. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.#words.byteLength);
    const view = new DataView(out.buffer);
    for (let w = 0; w < this.#words.length; w++)
      view.setUint32(w * 4, this.#words[w] as number, true);
    return out;
  }

  /** A set of `size` positions from `toBytes` output. Throws RangeError for bytes that do not fit. */
  static fromBytes(size: number, bytes: Uint8Array): BitSet {
    const out = new BitSet(size);
    if (bytes.length !== out.byteLength) {
      throw new RangeError(
        `a bit set of size ${size} is ${out.byteLength} bytes, not ${bytes.length}`,
      );
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let w = 0; w < out.#words.length; w++) out.#words[w] = view.getUint32(w * 4, true);
    const before = out.count();
    out.#clearTail();
    if (out.count() !== before) throw new RangeError("bits are set past the end of the set");
    return out;
  }

  /** Clears the unused bits of the last word, so counts stay exact. */
  #clearTail(): void {
    const used = this.size & 31;
    const last = this.#words.length - 1;
    if (used !== 0 && last >= 0) {
      this.#words[last] = (this.#words[last] as number) & ((1 << used) - 1);
    }
  }

  /** Set positions in increasing order. */
  *indices(): Generator<number> {
    const words = this.#words;
    for (let w = 0; w < words.length; w++) {
      let word = words[w] as number;
      while (word !== 0) {
        const low = word & -word;
        yield w * 32 + (31 - Math.clz32(low));
        word ^= low;
      }
    }
  }

  #check(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.size) {
      throw new RangeError(`bit ${i} outside 0..${this.size - 1}`);
    }
  }
}

function popcount(word: number): number {
  let v = word - ((word >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}
