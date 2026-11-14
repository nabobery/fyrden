// A bounded protobuf wire reader and writer: just what the runner protocol's
// messages use (varints, fixed64 doubles, length-delimited fields), with no
// protobuf dependency. Every malformed input is a ProtoError.

/** The wire types the protocol uses; groups (3, 4) and 6, 7 are refused. */
export const WireType = { Varint: 0, Fixed64: 1, Bytes: 2, Fixed32: 5 } as const;
export type WireType = (typeof WireType)[keyof typeof WireType];

/**
 * Bytes that are not a well-formed message. `endOfInput` is set when the
 * bytes ran out inside a field, which is how a truncated prefix ends.
 */
export class ProtoError extends Error {
  readonly endOfInput: boolean;

  constructor(message: string, endOfInput = false) {
    super(message);
    this.name = "ProtoError";
    this.endOfInput = endOfInput;
  }
}

const TWO_32 = 2 ** 32;
// 2^53 - 1 is hi = 0x1fffff, lo = 0xffffffff.
const MAX_SAFE_HI = 0x1fffff;
const MAX_FIELD_NUMBER = 2 ** 29 - 1;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

/** UTF-8 as protobuf's `string` requires: invalid bytes are a ProtoError. */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new ProtoError("invalid UTF-8");
  }
}

export class Reader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** The next field's number and wire type. */
  tag(): { field: number; wire: WireType } {
    const [lo, hi] = this.varint();
    const field = lo >>> 3;
    const wire = lo & 7;
    if (hi !== 0 || field > MAX_FIELD_NUMBER) throw new ProtoError("field number too large");
    if (field === 0) throw new ProtoError("field number 0");
    if (wire !== 0 && wire !== 1 && wire !== 2 && wire !== 5) {
      throw new ProtoError(`unsupported wire type ${wire}`);
    }
    return { field, wire };
  }

  /**
   * A varint as an unsigned 64-bit integer. The protocol's ids, indexes and
   * counts are int64 fields that are never negative: read unsigned, a
   * negative one (a ten-byte varint) is far above the safe range. Anything
   * above 2^53 - 1 is refused rather than rounded, so a corrupt id can never
   * read as another task's.
   */
  uint64(): number {
    const [lo, hi] = this.varint();
    if (hi > MAX_SAFE_HI) throw new ProtoError("integer above the safe range");
    return hi * TWO_32 + lo;
  }

  /** A varint as a signed 64-bit integer within the safe range. */
  int64(): number {
    const [lo, hi] = this.varint();
    if (hi < 0x80000000) {
      if (hi > MAX_SAFE_HI) throw new ProtoError("integer above the safe range");
      return hi * TWO_32 + lo;
    }
    const negLo = (~lo + 1) >>> 0;
    const negHi = (~hi + (negLo === 0 ? 1 : 0)) >>> 0;
    if (negHi > MAX_SAFE_HI) throw new ProtoError("integer below the safe range");
    return -(negHi * TWO_32 + negLo);
  }

  /** int32 and enums: the low 32 bits, as protobuf reads them. */
  int32(): number {
    return this.varint()[0] | 0;
  }

  bool(): boolean {
    const [lo, hi] = this.varint();
    return (lo | hi) !== 0;
  }

  /** A length-delimited field's content, as a view into the input. */
  bytes(): Uint8Array {
    const length = this.uint64();
    if (length > this.buf.length - this.pos) throw new ProtoError("length past the end", true);
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  string(): string {
    return decodeUtf8(this.bytes());
  }

  double(): number {
    const at = this.advance(8);
    return new DataView(this.buf.buffer, this.buf.byteOffset + at, 8).getFloat64(0, true);
  }

  skip(wire: WireType): void {
    switch (wire) {
      case WireType.Varint:
        this.varint();
        return;
      case WireType.Fixed64:
        this.advance(8);
        return;
      case WireType.Bytes:
        this.bytes();
        return;
      case WireType.Fixed32:
        this.advance(4);
        return;
    }
  }

  private advance(count: number): number {
    if (count > this.buf.length - this.pos) throw new ProtoError("fixed field past the end", true);
    const at = this.pos;
    this.pos += count;
    return at;
  }

  /** At most ten bytes, as the low and high 32 bits (unsigned). */
  private varint(): [number, number] {
    const buf = this.buf;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= buf.length) throw new ProtoError("truncated varint", true);
      const b = buf[this.pos++] as number;
      if (i < 4) lo |= (b & 0x7f) << (7 * i);
      else if (i === 4) {
        lo |= (b & 0x0f) << 28;
        hi = (b & 0x7f) >>> 4;
      } else if (i < 9) hi |= (b & 0x7f) << (7 * i - 32);
      else if (b > 1) break;
      else hi |= b << 31;
      if ((b & 0x80) === 0) return [lo >>> 0, hi >>> 0];
    }
    throw new ProtoError("varint longer than ten bytes or above 64 bits");
  }
}

/** A field's number and wire type as one value, for a `switch` over fields. */
export function fieldKey(field: number, wire: WireType): number {
  return field * 8 + wire;
}

/**
 * Reads every field of a message, handing each to `onField` with its
 * `fieldKey`; a field `onField` does not consume (returns false) is skipped.
 */
export function readFields(bytes: Uint8Array, onField: (r: Reader, key: number) => boolean): void {
  const r = new Reader(bytes);
  while (!r.done) {
    const { field, wire } = r.tag();
    if (!onField(r, fieldKey(field, wire))) r.skip(wire);
  }
}

/**
 * Writes fields in call order. A scalar equal to its proto3 default is
 * omitted, as protobuf does, unless `always` is set (a oneof member or an
 * optional field, whose presence is meaningful).
 */
export class Writer {
  private buf = new Uint8Array(64);
  private length = 0;

  /** A non-negative int64 (ids, indexes, counts). */
  uint64(field: number, value: number, always = false): this {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`not a non-negative safe integer: ${value}`);
    }
    if (value === 0 && !always) return this;
    this.key(field, WireType.Varint);
    this.varint(value >>> 0, Math.floor(value / TWO_32));
    return this;
  }

  int64(field: number, value: number, always = false): this {
    if (!Number.isSafeInteger(value)) throw new RangeError(`not a safe integer: ${value}`);
    if (value >= 0) return this.uint64(field, value, always);
    const bits = BigInt.asUintN(64, BigInt(value));
    this.key(field, WireType.Varint);
    this.varint(Number(bits & 0xffffffffn), Number(bits >> 32n));
    return this;
  }

  /** int32 and enums; a negative value is sign-extended to ten bytes. */
  int32(field: number, value: number, always = false): this {
    if (!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 31) {
      throw new RangeError(`not an int32: ${value}`);
    }
    if (value === 0 && !always) return this;
    this.key(field, WireType.Varint);
    this.varint(value >>> 0, value < 0 ? 0xffffffff : 0);
    return this;
  }

  bool(field: number, value: boolean, always = false): this {
    if (!value && !always) return this;
    this.key(field, WireType.Varint);
    this.push(value ? 1 : 0);
    return this;
  }

  double(field: number, value: number, always = false): this {
    if (Object.is(value, 0) && !always) return this;
    this.key(field, WireType.Fixed64);
    this.reserve(8);
    new DataView(this.buf.buffer).setFloat64(this.length, value, true);
    this.length += 8;
    return this;
  }

  string(field: number, value: string, always = false): this {
    if (value === "" && !always) return this;
    return this.bytes(field, utf8Encoder.encode(value), true);
  }

  bytes(field: number, value: Uint8Array, always = false): this {
    if (value.length === 0 && !always) return this;
    this.key(field, WireType.Bytes);
    this.varint(value.length, 0);
    this.reserve(value.length);
    this.buf.set(value, this.length);
    this.length += value.length;
    return this;
  }

  /** An embedded message, written even when empty. */
  message(field: number, encoded: Uint8Array): this {
    return this.bytes(field, encoded, true);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }

  private key(field: number, wire: WireType): void {
    this.varint(fieldKey(field, wire), 0);
  }

  private varint(lo: number, hi: number): void {
    let low = lo >>> 0;
    let high = hi >>> 0;
    while (high !== 0 || low > 0x7f) {
      this.push((low & 0x7f) | 0x80);
      low = ((low >>> 7) | (high << 25)) >>> 0;
      high >>>= 7;
    }
    this.push(low);
  }

  private push(byte: number): void {
    this.reserve(1);
    this.buf[this.length++] = byte;
  }

  private reserve(count: number): void {
    if (this.length + count <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + count) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
}
