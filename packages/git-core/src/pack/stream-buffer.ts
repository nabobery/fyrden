import { PackError } from "./errors.js";

const INITIAL_BYTES = 64 * 1024;

/**
 * The unread part of a byte stream in one contiguous buffer, so a zlib
 * stream that spans several chunks can be inflated in one call. Holds at
 * most one entry's bytes plus the last chunk read.
 */
export class StreamBuffer {
  readonly #source: AsyncIterator<Uint8Array>;
  #buffer = new Uint8Array(INITIAL_BYTES);
  #start = 0;
  #end = 0;
  #done = false;
  /** Pack offset of the first unread byte. */
  position = 0;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#source = source[Symbol.asyncIterator]();
  }

  get available(): number {
    return this.#end - this.#start;
  }

  /** True once the source has ended. */
  get done(): boolean {
    return this.#done;
  }

  /** The next `length` unread bytes (default: all), without consuming them. Valid until the next read. */
  peek(length = this.available): Uint8Array {
    return this.#buffer.subarray(this.#start, this.#start + Math.min(length, this.available));
  }

  /** Consumes `length` bytes and returns them. Valid until the next read. */
  take(length: number): Uint8Array {
    if (length > this.available) throw new RangeError("take past the buffered bytes");
    const out = this.#buffer.subarray(this.#start, this.#start + length);
    this.#start += length;
    this.position += length;
    return out;
  }

  /** Reads one more non-empty chunk; false when the source has ended. */
  async readMore(): Promise<boolean> {
    while (!this.#done) {
      const next = await this.#source.next();
      if (next.done) {
        this.#done = true;
        return false;
      }
      if (next.value.length === 0) continue;
      this.#append(next.value);
      return true;
    }
    return false;
  }

  /** Reads until `length` bytes are buffered; a `truncated` PackError if the stream ends first. */
  async need(length: number, what: string): Promise<void> {
    while (this.available < length) {
      if (!(await this.readMore())) {
        throw new PackError("truncated", `stream ended inside the ${what}`, this.position);
      }
    }
  }

  #append(chunk: Uint8Array): void {
    const unread = this.available;
    if (this.#end + chunk.length > this.#buffer.length) {
      const needed = unread + chunk.length;
      // Grow for a large entry; shrink again once it has been consumed.
      let size = this.#buffer.length;
      if (needed > size / 2) size = Math.max(needed, size * 2);
      else if (size > 4 * Math.max(needed, INITIAL_BYTES))
        size = Math.max(INITIAL_BYTES, 2 * needed);
      if (size !== this.#buffer.length) {
        const next = new Uint8Array(size);
        next.set(this.#buffer.subarray(this.#start, this.#end));
        this.#buffer = next;
      } else {
        this.#buffer.copyWithin(0, this.#start, this.#end);
      }
      this.#start = 0;
      this.#end = unread;
    }
    this.#buffer.set(chunk, this.#end);
    this.#end += chunk.length;
  }
}
