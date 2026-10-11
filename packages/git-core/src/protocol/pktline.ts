import { concatBytes } from "../object/bytes.js";
import { excerpt, ProtocolError } from "./errors.js";

/**
 * pkt-line framing (gitprotocol-common, gitprotocol-v2; git v2.53.0
 * pkt-line.c, verified): four hex digits giving the total length including
 * themselves, then the payload. Lengths 0000, 0001 and 0002 are the flush,
 * delim and response-end packets; 0003 means nothing and is refused.
 */

/** Longest pkt-line, length digits included (git's LARGE_PACKET_MAX). */
export const MAX_PKT_LINE_LENGTH = 65520;
/** Longest payload (git's LARGE_PACKET_DATA_MAX). */
export const MAX_PKT_DATA_LENGTH = MAX_PKT_LINE_LENGTH - 4;

export type PktLine =
  | { readonly kind: "data"; readonly data: Uint8Array }
  | { readonly kind: "flush" }
  | { readonly kind: "delim" }
  | { readonly kind: "response-end" };

const FLUSH: PktLine = Object.freeze({ kind: "flush" });
const DELIM: PktLine = Object.freeze({ kind: "delim" });
const RESPONSE_END: PktLine = Object.freeze({ kind: "response-end" });

/**
 * Caps on what one reader consumes, so a peer cannot stream lines forever.
 * Every packet counts as a line; bytes include the length digits.
 */
export interface PktLineLimits {
  readonly maxLines?: number;
  readonly maxBytes?: number;
}

/**
 * Proposed defaults, sized for request sections (v2 command requests,
 * receive-pack commands): a fetch with 100,000 haves is about 5 MiB. Tuned
 * under load. Readers of pack data over side-band set their own limits.
 */
export const DEFAULT_PKT_LINE_LIMITS = Object.freeze({
  maxLines: 500_000,
  maxBytes: 16 * 1024 * 1024,
});

/** Anything packets can be read from: a buffer reader, a stream reader, or a test double. */
export interface PktLineSource {
  read(): PktLine | undefined | Promise<PktLine | undefined>;
}

const encoder = new TextEncoder();
const HEX = "0123456789abcdef";

function header(length: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(
    HEX.charCodeAt((length >> 12) & 15),
    HEX.charCodeAt((length >> 8) & 15),
    HEX.charCodeAt((length >> 4) & 15),
    HEX.charCodeAt(length & 15),
  );
}

/**
 * One data packet. Strings are encoded as UTF-8; the caller adds any LF.
 * Throws RangeError above 65516 payload bytes, which git also refuses to send.
 */
export function encodePktLine(data: Uint8Array | string): Uint8Array<ArrayBuffer> {
  const payload = typeof data === "string" ? encoder.encode(data) : data;
  if (payload.length > MAX_PKT_DATA_LENGTH) {
    throw new RangeError(
      `pkt-line payload of ${payload.length} bytes exceeds ${MAX_PKT_DATA_LENGTH}`,
    );
  }
  const out = new Uint8Array(payload.length + 4);
  out.set(header(payload.length + 4));
  out.set(payload, 4);
  return out;
}

export const flushPkt = (): Uint8Array<ArrayBuffer> => header(0);
export const delimPkt = (): Uint8Array<ArrayBuffer> => header(1);
export const responseEndPkt = (): Uint8Array<ArrayBuffer> => header(2);

/** Collects packets into one buffer. */
export class PktLineWriter {
  readonly #parts: Uint8Array[] = [];

  data(payload: Uint8Array | string): this {
    this.#parts.push(encodePktLine(payload));
    return this;
  }

  /** A text line: `line` plus LF. */
  text(line: string): this {
    return this.data(`${line}\n`);
  }

  flush(): this {
    this.#parts.push(flushPkt());
    return this;
  }

  delim(): this {
    this.#parts.push(delimPkt());
    return this;
  }

  responseEnd(): this {
    this.#parts.push(responseEndPkt());
    return this;
  }

  packet(pkt: PktLine): this {
    switch (pkt.kind) {
      case "data":
        return this.data(pkt.data);
      case "flush":
        return this.flush();
      case "delim":
        return this.delim();
      case "response-end":
        return this.responseEnd();
    }
  }

  bytes(): Uint8Array<ArrayBuffer> {
    return concatBytes(this.#parts);
  }
}

/** The payload without one trailing LF. Receivers must treat lines the same with or without it. */
export function chompLf(data: Uint8Array): Uint8Array {
  return data.length > 0 && data[data.length - 1] === 0x0a ? data.subarray(0, -1) : data;
}

/** Value of one hex digit in either case, as git's `hexval`, or -1. */
function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  const lower = code | 0x20;
  if (lower >= 0x61 && lower <= 0x66) return lower - 0x61 + 10;
  return -1;
}

/**
 * The total length announced by the four bytes at `offset`. Like git's
 * `packet_length`, either case of hex is accepted and anything else is not.
 * Git's reader would accept up to 65523 bytes (its buffer check is
 * `len - 4 >= 65520`); this one holds peers to the documented 65520, which
 * git itself never exceeds when writing.
 */
function packetLength(bytes: Uint8Array, offset: number): number {
  let length = 0;
  for (let i = 0; i < 4; i++) {
    const digit = hexValue(bytes[offset + i] as number);
    if (digit < 0) {
      throw new ProtocolError(
        "invalid-length",
        `protocol error: bad line length character: ${excerpt(bytes.subarray(offset, offset + 4))}`,
      );
    }
    length = (length << 4) | digit;
  }
  if (length === 3) throw new ProtocolError("invalid-length", "protocol error: bad line length 3");
  if (length > MAX_PKT_LINE_LENGTH) {
    throw new ProtocolError(
      "line-too-long",
      `protocol error: line length ${length} exceeds ${MAX_PKT_LINE_LENGTH}`,
    );
  }
  return length;
}

function specialPacket(length: number): PktLine {
  return length === 0 ? FLUSH : length === 1 ? DELIM : RESPONSE_END;
}

/** Bytes a packet with this announced length occupies. */
const packetSize = (length: number): number => (length < 4 ? 4 : length);

class Budget {
  lines = 0;
  bytes = 0;
  readonly #maxLines: number;
  readonly #maxBytes: number;

  constructor(limits: PktLineLimits) {
    this.#maxLines = limits.maxLines ?? DEFAULT_PKT_LINE_LIMITS.maxLines;
    this.#maxBytes = limits.maxBytes ?? DEFAULT_PKT_LINE_LIMITS.maxBytes;
  }

  /** Charges one packet before its payload is read. */
  charge(size: number): void {
    if (this.lines + 1 > this.#maxLines) {
      throw new ProtocolError(
        "too-many-lines",
        `protocol error: more than ${this.#maxLines} lines`,
      );
    }
    if (this.bytes + size > this.#maxBytes) {
      throw new ProtocolError(
        "too-many-bytes",
        `protocol error: more than ${this.#maxBytes} bytes`,
      );
    }
    this.lines++;
    this.bytes += size;
  }
}

const truncated = () => new ProtocolError("truncated", "the remote end hung up unexpectedly");

/**
 * Reads packets from a buffer. Data payloads are views into that buffer.
 * After an error every later `read` throws the same error.
 */
export class PktLineReader implements PktLineSource {
  readonly #bytes: Uint8Array;
  readonly #budget: Budget;
  #offset = 0;
  #failure: ProtocolError | undefined;

  constructor(bytes: Uint8Array, limits: PktLineLimits = {}) {
    this.#bytes = bytes;
    this.#budget = new Budget(limits);
  }

  /** Offset of the first unread byte. */
  get offset(): number {
    return this.#offset;
  }

  /** The next packet, or undefined at the end of the input on a packet boundary. */
  read(): PktLine | undefined {
    if (this.#failure) throw this.#failure;
    try {
      return this.#next();
    } catch (error) {
      if (error instanceof ProtocolError) this.#failure = error;
      throw error;
    }
  }

  /** The unread bytes, such as the pack after a receive-pack command list. */
  rest(): Uint8Array {
    return this.#bytes.subarray(this.#offset);
  }

  #next(): PktLine | undefined {
    const available = this.#bytes.length - this.#offset;
    if (available === 0) return undefined;
    if (available < 4) throw truncated();
    const length = packetLength(this.#bytes, this.#offset);
    this.#budget.charge(packetSize(length));
    if (length < 4) {
      this.#offset += 4;
      return specialPacket(length);
    }
    if (available < length) throw truncated();
    const data = this.#bytes.subarray(this.#offset + 4, this.#offset + length);
    this.#offset += length;
    return { kind: "data", data };
  }
}

/**
 * Reads packets from a chunked byte stream (a request body). It pulls only
 * what the next packet needs, so the bytes after the last packet read (a
 * pack) can be handed on with `rest()`. Payloads are copies, so a parsed
 * request does not keep the source's (possibly large) chunks alive. On a
 * protocol error the source is released and every later `read` throws the
 * same error.
 */
export class PktLineStreamReader implements PktLineSource {
  readonly #iterator: AsyncIterator<Uint8Array>;
  readonly #budget: Budget;
  readonly #chunks: Uint8Array[] = [];
  #buffered = 0;
  #sourceDone = false;
  #handedOver = false;
  #failure: ProtocolError | undefined;

  constructor(source: AsyncIterable<Uint8Array>, limits: PktLineLimits = {}) {
    this.#iterator = source[Symbol.asyncIterator]();
    this.#budget = new Budget(limits);
  }

  /** Bytes consumed by the packets read so far. */
  get bytesRead(): number {
    return this.#budget.bytes;
  }

  async read(): Promise<PktLine | undefined> {
    if (this.#handedOver) throw new Error("the stream was handed over with rest()");
    if (this.#failure) throw this.#failure;
    try {
      return await this.#next();
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.#failure = error;
        await this.#release();
      }
      throw error;
    }
  }

  /**
   * The bytes after the last packet read, then the rest of the source,
   * unchanged. Can be taken once; the reader cannot read packets afterwards.
   * Stopping the iteration early releases the source.
   */
  rest(): AsyncIterable<Uint8Array> {
    if (this.#handedOver) throw new Error("the stream was already handed over with rest()");
    this.#handedOver = true;
    const chunks = this.#chunks.splice(0);
    this.#buffered = 0;
    const iterator = this.#iterator;
    const sourceDone = this.#sourceDone;
    return {
      async *[Symbol.asyncIterator]() {
        yield* chunks;
        if (sourceDone) return;
        let finished = false;
        try {
          for (let r = await iterator.next(); !r.done; r = await iterator.next()) {
            if (r.value.length > 0) yield r.value;
          }
          finished = true;
        } finally {
          if (!finished) await iterator.return?.();
        }
      },
    };
  }

  async #next(): Promise<PktLine | undefined> {
    if (!(await this.#fill(4))) {
      if (this.#buffered === 0) return undefined;
      throw truncated();
    }
    const length = packetLength(this.#peekHeader(), 0);
    this.#budget.charge(packetSize(length));
    if (length < 4) {
      this.#take(4);
      return specialPacket(length);
    }
    if (!(await this.#fill(length))) throw truncated();
    this.#take(4);
    return { kind: "data", data: this.#take(length - 4) };
  }

  /** Pulls chunks until `n` bytes are buffered; false if the source ends first. */
  async #fill(n: number): Promise<boolean> {
    while (this.#buffered < n && !this.#sourceDone) {
      const r = await this.#iterator.next();
      if (r.done) {
        this.#sourceDone = true;
      } else if (r.value.length > 0) {
        this.#chunks.push(r.value);
        this.#buffered += r.value.length;
      }
    }
    return this.#buffered >= n;
  }

  /** The four length bytes, without consuming them (they may span chunks). */
  #peekHeader(): Uint8Array {
    const first = this.#chunks[0] as Uint8Array;
    if (first.length >= 4) return first;
    const out = new Uint8Array(4);
    let filled = 0;
    for (const chunk of this.#chunks) {
      const part = Math.min(chunk.length, 4 - filled);
      out.set(chunk.subarray(0, part), filled);
      filled += part;
      if (filled === 4) break;
    }
    return out;
  }

  /** Removes `n` buffered bytes and returns a copy of them. */
  #take(n: number): Uint8Array {
    this.#buffered -= n;
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#chunks[0] as Uint8Array;
      const part = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, part), filled);
      filled += part;
      if (part === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(part);
    }
    return out;
  }

  async #release(): Promise<void> {
    this.#chunks.length = 0;
    this.#buffered = 0;
    if (this.#sourceDone) return;
    this.#sourceDone = true;
    try {
      await this.#iterator.return?.();
    } catch {
      // The source failing to close is not the peer's protocol error; keep that one.
    }
  }
}
