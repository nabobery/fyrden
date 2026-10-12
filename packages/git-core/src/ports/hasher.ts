/**
 * Incremental SHA-1 over a byte stream: object ids, pack trailers, `.idx`
 * checksums. Two implementations exist:
 * - `Sha1` in this package: detects SHA-1 collision attacks as git does
 *   (SHA-1DC), and its state can be saved and resumed across Durable Object
 *   evictions. Object ids of anything a client sent must be hashed with it.
 * - `crypto.DigestStream` in the Workers adapter: faster, but no collision
 *   detection, so only for checksums over a whole stream (pack trailers),
 *   where a collision cannot make two objects share an id.
 */
export interface Hasher {
  /**
   * Adds bytes. The caller must not change `chunk` until the returned
   * promise settles, and must await each update before the next call.
   */
  update(chunk: Uint8Array): Promise<void>;
  /** The 20-byte SHA-1 of everything added. Call once, after the last update. */
  digest(): Promise<Uint8Array>;
}

/** A hasher whose state can be saved and resumed, e.g. by an alarm-sliced writer. */
export interface ResumableHasher extends Hasher {
  /** The current state; pass it to the same implementation to continue. */
  saveState(): Uint8Array;
}

export type HasherFactory = () => Hasher;
