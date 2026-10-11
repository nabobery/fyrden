import type { ResumableHasher } from "../ports/hasher.js";
import { compress, detectCollision, STATES_WORDS } from "./sha1dc.js";

const BLOCK_BYTES = 64;
const DIGEST_BYTES = 20;
// Version 2 added the flags byte. Version 1 states are rejected: they do not
// say whether the blocks already hashed were checked for collisions.
const STATE_VERSION = 2;
const FLAG_DETECT = 0b01;
const FLAG_COLLISION = 0b10;
// version (1) + flags (1) + h0..h4 (20) + total length in bytes (8), then the
// buffered partial block (total length mod 64 bytes).
const STATE_HEADER_BYTES = 2 + DIGEST_BYTES + 8;
const INITIAL = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];

export interface Sha1Options {
  /**
   * Detect inputs built with a known SHA-1 collision attack, as git and
   * GitHub do with SHA-1DC; `digest()` then throws `Sha1CollisionError`.
   * Default: true. Turn it off only for bytes Fyrden produced itself.
   */
  readonly detectCollisions?: boolean;
}

/** The input is part of a SHA-1 collision attack (SHA-1DC found one). */
export class Sha1CollisionError extends Error {
  /** The plain SHA-1 of the input, which git also prints. */
  readonly digest: Uint8Array;
  constructor(digest: Uint8Array) {
    // git's message (sha1dc_git.c): "SHA-1 appears to be part of a collision attack: <hex>".
    super(`SHA-1 appears to be part of a collision attack: ${toHex(digest)}`);
    this.name = "Sha1CollisionError";
    this.digest = digest;
  }
}

/**
 * SHA-1 (FIPS 180-4) in plain TypeScript, with git's collision detection
 * (SHA-1DC, see `sha1dc.ts`) on by default. Unlike `crypto.DigestStream`,
 * its state can be saved with `saveState()` and restored with `fromState()`,
 * so a long pack write can be split across alarm invocations and survive an
 * eviction in between.
 */
export class Sha1 {
  readonly #h = Uint32Array.from(INITIAL);
  readonly #block = new Uint8Array(BLOCK_BYTES);
  readonly #w = new Int32Array(80);
  readonly #states = new Int32Array(STATES_WORDS);
  readonly #detect: boolean;
  #collision = false;
  #length = 0;

  constructor(options: Sha1Options = {}) {
    this.#detect = options.detectCollisions ?? true;
  }

  /** Adds bytes. The data is consumed before this returns. */
  update(data: Uint8Array): this {
    let offset = 0;
    let buffered = this.#length % BLOCK_BYTES;
    this.#length += data.length;
    if (buffered > 0) {
      const take = Math.min(BLOCK_BYTES - buffered, data.length);
      this.#block.set(data.subarray(0, take), buffered);
      buffered += take;
      offset = take;
      if (buffered < BLOCK_BYTES) return this;
      this.#collision = this.#process(this.#h, this.#block, 0, this.#collision);
    }
    for (; offset + BLOCK_BYTES <= data.length; offset += BLOCK_BYTES) {
      this.#collision = this.#process(this.#h, data, offset, this.#collision);
    }
    this.#block.set(data.subarray(offset), 0);
    return this;
  }

  /**
   * The digest of everything added so far. Hashing can continue afterwards.
   * Throws `Sha1CollisionError` if collision detection is on and found an
   * attack, now or in any block added before.
   */
  digest(): Uint8Array {
    const h = Uint32Array.from(this.#h);
    const buffered = this.#length % BLOCK_BYTES;
    const tail = new Uint8Array(buffered < 56 ? BLOCK_BYTES : 2 * BLOCK_BYTES);
    tail.set(this.#block.subarray(0, buffered));
    tail[buffered] = 0x80;
    // The message length in bits, as a 64-bit big-endian integer.
    writeUint64(tail, tail.length - 8, this.#length * 8);
    // The padding blocks are checked too, as in the reference SHA1DCFinal.
    let collision = this.#collision;
    for (let offset = 0; offset < tail.length; offset += BLOCK_BYTES) {
      collision = this.#process(h, tail, offset, collision);
    }
    const out = new Uint8Array(DIGEST_BYTES);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) view.setUint32(i * 4, h[i] as number);
    if (collision) throw new Sha1CollisionError(out);
    return out;
  }

  saveState(): Uint8Array {
    const buffered = this.#length % BLOCK_BYTES;
    const state = new Uint8Array(STATE_HEADER_BYTES + buffered);
    const view = new DataView(state.buffer);
    state[0] = STATE_VERSION;
    state[1] = (this.#detect ? FLAG_DETECT : 0) | (this.#collision ? FLAG_COLLISION : 0);
    for (let i = 0; i < 5; i++) view.setUint32(2 + i * 4, this.#h[i] as number);
    writeUint64(state, 2 + DIGEST_BYTES, this.#length);
    state.set(this.#block.subarray(0, buffered), STATE_HEADER_BYTES);
    return state;
  }

  /**
   * Restores a `saveState()` result, with the collision detection setting it
   * was saved with. The state must come from Fyrden's own storage: it cannot
   * prove which bytes were hashed or checked before it was saved, so a forged
   * state can skip detection for those bytes.
   */
  static fromState(state: Uint8Array): Sha1 {
    if (state.length < STATE_HEADER_BYTES || state[0] !== STATE_VERSION) {
      throw new RangeError("not a saved SHA-1 state");
    }
    const flags = state[1] as number;
    // Unknown flags, or a collision found while detection was off.
    if ((flags & ~(FLAG_DETECT | FLAG_COLLISION)) !== 0 || flags === FLAG_COLLISION) {
      throw new RangeError("saved SHA-1 state has invalid flags");
    }
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    const length = readUint64(view, 2 + DIGEST_BYTES);
    if (state.length !== STATE_HEADER_BYTES + (length % BLOCK_BYTES)) {
      throw new RangeError("saved SHA-1 state has the wrong length");
    }
    const sha = new Sha1({ detectCollisions: (flags & FLAG_DETECT) !== 0 });
    sha.#collision = (flags & FLAG_COLLISION) !== 0;
    for (let i = 0; i < 5; i++) sha.#h[i] = view.getUint32(2 + i * 4);
    sha.#length = length;
    sha.#block.set(state.subarray(STATE_HEADER_BYTES));
    return sha;
  }

  /**
   * Compresses one block into `h`; returns whether a collision has been
   * found, given whether one already had. Once one has, later blocks need
   * no check: the digest will throw either way.
   */
  #process(h: Uint32Array, data: Uint8Array, offset: number, collision: boolean): boolean {
    compress(h, this.#w, this.#states, data, offset);
    if (!this.#detect || collision) return collision;
    return detectCollision(h, this.#w, this.#states) !== undefined;
  }
}

/**
 * The `Hasher` port over `Sha1`: new with the given options, or resumed from
 * a saved state (which carries its own collision detection setting). As with
 * `Sha1.fromState`, a state must come from Fyrden's own storage.
 */
export function createSha1Hasher(from: Uint8Array | Sha1Options = {}): ResumableHasher {
  const sha = from instanceof Uint8Array ? Sha1.fromState(from) : new Sha1(from);
  return {
    update: async (chunk) => {
      sha.update(chunk);
    },
    digest: async () => sha.digest(),
    saveState: () => sha.saveState(),
  };
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function writeUint64(bytes: Uint8Array, offset: number, value: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(offset, Math.floor(value / 2 ** 32));
  view.setUint32(offset + 4, value >>> 0);
}

function readUint64(view: DataView, offset: number): number {
  const value = view.getUint32(offset) * 2 ** 32 + view.getUint32(offset + 4);
  if (!Number.isSafeInteger(value)) throw new RangeError("saved SHA-1 length is out of range");
  return value;
}
