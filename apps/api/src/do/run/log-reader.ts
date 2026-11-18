import { LOG_ROW_TOO_LARGE, type StoredLogOmission } from "@fyrden/domain/ci";
import { UPDATE_LOG_MAX_CONTENT_BYTES } from "../../runner/proto/messages.js";

export const LOG_READER_POLICY = {
  readBytes: 32768,
  segmentUnits: 32768,
  smallRowBytes: 256 * 1024,
  /** Mask replacements grow disjoint ranges by at most 3/2; the margin covers row-edge intersections. */
  maxDecodedUnits: Math.ceil((UPDATE_LOG_MAX_CONTENT_BYTES * 3) / 2) + 8,
} as const;

export interface DecodedLogText {
  readonly length: number;
  /** At most 32768 UTF-16 units, including a slice crossing segment boundaries. */
  slice(start: number, end: number): string;
  /** Only available when the original encoded record fits the 256 KiB small-row limit. */
  whole(): string;
}

export type ReadLogLine =
  | StoredLogOmission
  | {
      readonly i: number;
      readonly t: number | null;
      readonly c: DecodedLogText;
      readonly encodedBytes: number;
    };

function invalid(): never {
  throw new Error("invalid stored log");
}

class TextSegments implements DecodedLogText {
  readonly #segments: string[] = [];
  #leaf: Uint16Array | undefined;
  #filled = 0;
  #length = 0;
  #encodedBytes = 0;

  constructor(leaf: Uint16Array) {
    this.#leaf = leaf;
  }

  get length(): number {
    return this.#length;
  }

  append(unit: number): void {
    if (this.#length >= LOG_READER_POLICY.maxDecodedUnits) invalid();
    const leaf = this.#leaf;
    if (!leaf) invalid();
    leaf[this.#filled++] = unit;
    this.#length++;
    if (this.#filled === leaf.length) this.#flush();
  }

  finish(encodedBytes: number): this {
    this.#flush();
    this.#encodedBytes = encodedBytes;
    this.#leaf = undefined;
    return this;
  }

  #flush(): void {
    if (this.#filled === 0) return;
    const leaf = this.#leaf;
    if (!leaf) invalid();
    this.#segments.push(String.fromCharCode(...leaf.subarray(0, this.#filled)));
    this.#filled = 0;
  }

  slice(start: number, end: number): string {
    const from = Math.max(0, Math.min(this.length, Math.trunc(start)));
    const to = Math.max(from, Math.min(this.length, Math.trunc(end)));
    if (to - from > LOG_READER_POLICY.segmentUnits) throw new Error("stored log slice limit");
    if (from === to) return "";
    const index = Math.floor(from / LOG_READER_POLICY.segmentUnits);
    const offset = from % LOG_READER_POLICY.segmentUnits;
    const first = this.#segments[index];
    if (first === undefined) invalid();
    const length = to - from;
    if (offset + length <= first.length) return first.slice(offset, offset + length);
    const second = this.#segments[index + 1];
    if (second === undefined) invalid();
    return first.slice(offset) + second.slice(0, length - first.length + offset);
  }

  whole(): string {
    if (this.#encodedBytes > LOG_READER_POLICY.smallRowBytes) {
      throw new Error("stored log small-row limit");
    }
    return this.#segments.join("");
  }
}

class LogParser {
  readonly #leaf = new Uint16Array(LOG_READER_POLICY.segmentUnits);
  #phase: "header" | "text" | "brace" | "newline" = "header";
  #header = "";
  #encodedBytes = 0;
  #i = 0;
  #t: number | null = null;
  #text: TextSegments | undefined;
  #line: ReadLogLine | undefined;
  #escape = false;
  #hexDigits = 0;
  #hex = 0;
  #utf8Left = 0;
  #codePoint = 0;
  #minimum = 0;

  byte(byte: number): ReadLogLine | undefined {
    if (this.#phase === "newline") {
      if (byte !== 10) invalid();
      const line = this.#line;
      this.#line = undefined;
      this.#phase = "header";
      this.#encodedBytes = 0;
      return line;
    }
    this.#encodedBytes++;
    if (this.#phase === "header") {
      if (byte < 32 || byte > 126 || this.#header.length >= 128) invalid();
      this.#header += String.fromCharCode(byte);
      if (this.#header.endsWith(',"c":"')) {
        const match =
          /^\{"i":(0|[1-9]\d*),"t":(null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?),"c":"$/.exec(
            this.#header,
          );
        if (!match) invalid();
        this.#i = Number(match[1]);
        this.#t = match[2] === "null" ? null : Number(match[2]);
        if (!Number.isSafeInteger(this.#i) || (this.#t !== null && !Number.isFinite(this.#t)))
          invalid();
        this.#text = new TextSegments(this.#leaf);
        this.#header = "";
        this.#phase = "text";
      } else if (byte === 125) {
        const match = /^\{"i":(0|[1-9]\d*),"omitted":"row_too_large","bytes":(0|[1-9]\d*)\}$/.exec(
          this.#header,
        );
        if (!match) invalid();
        const i = Number(match[1]);
        const bytes = Number(match[2]);
        if (!Number.isSafeInteger(i) || !Number.isSafeInteger(bytes) || bytes <= 0) invalid();
        this.#line = { i, omitted: LOG_ROW_TOO_LARGE, bytes };
        this.#header = "";
        this.#phase = "newline";
      }
      return undefined;
    }
    if (this.#phase === "brace") {
      if (byte !== 125 || !this.#text) invalid();
      this.#line = {
        i: this.#i,
        t: this.#t,
        c: this.#text.finish(this.#encodedBytes),
        encodedBytes: this.#encodedBytes,
      };
      this.#text = undefined;
      this.#phase = "newline";
      return undefined;
    }
    this.#contentByte(byte);
    return undefined;
  }

  #append(unit: number): void {
    if (!this.#text) invalid();
    this.#text.append(unit);
  }

  #contentByte(byte: number): void {
    if (this.#hexDigits > 0) {
      const digit =
        byte >= 48 && byte <= 57
          ? byte - 48
          : byte >= 65 && byte <= 70
            ? byte - 55
            : byte >= 97 && byte <= 102
              ? byte - 87
              : -1;
      if (digit < 0) invalid();
      this.#hex = this.#hex * 16 + digit;
      if (--this.#hexDigits === 0) this.#append(this.#hex);
      return;
    }
    if (this.#escape) {
      this.#escape = false;
      if (byte === 117) {
        this.#hex = 0;
        this.#hexDigits = 4;
        return;
      }
      const escaped =
        byte === 34 || byte === 47 || byte === 92
          ? byte
          : byte === 98
            ? 8
            : byte === 102
              ? 12
              : byte === 110
                ? 10
                : byte === 114
                  ? 13
                  : byte === 116
                    ? 9
                    : -1;
      if (escaped < 0) invalid();
      this.#append(escaped);
      return;
    }
    if (this.#utf8Left > 0) {
      if ((byte & 0xc0) !== 0x80) invalid();
      this.#codePoint = this.#codePoint * 64 + (byte & 0x3f);
      if (--this.#utf8Left !== 0) return;
      const point = this.#codePoint;
      if (point < this.#minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
        invalid();
      if (point <= 0xffff) this.#append(point);
      else {
        this.#append(0xd800 + ((point - 0x10000) >> 10));
        this.#append(0xdc00 + ((point - 0x10000) & 0x3ff));
      }
      return;
    }
    if (byte === 34) {
      this.#phase = "brace";
    } else if (byte === 92) {
      this.#escape = true;
    } else if (byte >= 32 && byte < 128) {
      this.#append(byte);
    } else if (byte >= 0xc2 && byte <= 0xdf) {
      this.#utf8Left = 1;
      this.#codePoint = byte & 0x1f;
      this.#minimum = 0x80;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      this.#utf8Left = 2;
      this.#codePoint = byte & 0x0f;
      this.#minimum = 0x800;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      this.#utf8Left = 3;
      this.#codePoint = byte & 7;
      this.#minimum = 0x10000;
    } else invalid();
  }

  end(): ReadLogLine | undefined {
    if (this.#phase === "newline") return this.#line;
    if (this.#phase === "header" && this.#header === "") return undefined;
    invalid();
  }
}

/** Reads the canonical RunLogs NDJSON format without retaining an encoded record. */
export async function* readLogLines(body: ReadableStream<Uint8Array>): AsyncGenerator<ReadLogLine> {
  const reader = body.getReader({ mode: "byob" });
  const parser = new LogParser();
  let readBuffer = new Uint8Array(LOG_READER_POLICY.readBytes);
  let complete = false;
  try {
    for (;;) {
      const { value, done } = await reader.read(readBuffer);
      if (value) {
        for (const byte of value) {
          const line = parser.byte(byte);
          if (line) yield line;
        }
        readBuffer = new Uint8Array(value.buffer);
      }
      if (done) {
        const final = parser.end();
        if (final) yield final;
        complete = true;
        return;
      }
    }
  } finally {
    try {
      if (!complete) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
