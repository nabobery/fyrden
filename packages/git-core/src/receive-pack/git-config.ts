/**
 * git's config file parser (config.c `git_parse_source`, git v2.53.0,
 * verified), as `git_config_from_mem` runs it over a `.gitmodules` blob for
 * fsck. It calls `onEntry` with the full variable name (section and key
 * lowercased, a quoted subsection kept as written) and the value (null for
 * a key without '='), in file order, and returns false where git's parser
 * would report a syntax error. Entries before the error have been reported,
 * as in git. Bytes are read as latin1, one character per byte, so the
 * callback sees exactly the bytes git compares.
 *
 * git reads the blob through a `const char *`, so where `char` is signed
 * (x86-64, Apple silicon; checked against git 2.53.0 on macOS) a 0xFF byte
 * reads as EOF and a UTF-8 byte-order mark is never recognised. This port
 * does the same; git built where `char` is unsigned (Linux on ARM) differs.
 */
export function parseGitConfig(
  bytes: Uint8Array,
  onEntry: (name: string, value: string | null) => void,
): boolean {
  return new ConfigParser(bytes, onEntry).parse();
}

const EOF = -1;

/** git's `isspace` (ctype.c `sane_ctype`): tab, LF, CR and space only. */
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isKeyChar = (c: number) => isAlpha(c) || isDigit(c) || c === 0x2d;
const toLower = (c: number) => (c >= 0x41 && c <= 0x5a ? c | 0x20 : c);

class ConfigParser {
  readonly #bytes: Uint8Array;
  readonly #onEntry: (name: string, value: string | null) => void;
  #pos = 0;
  #eof = false;

  constructor(bytes: Uint8Array, onEntry: (name: string, value: string | null) => void) {
    this.#bytes = bytes;
    this.#onEntry = onEntry;
  }

  /** `get_next_char`: CRLF reads as LF, and the end of input reads as one LF. */
  #next(): number {
    let c = this.#read();
    if (c === 0x0d) {
      const after = this.#read();
      if (after === 0x0a) c = 0x0a;
      else if (after !== EOF) this.#pos--;
    }
    if (c === EOF) {
      this.#eof = true;
      return 0x0a;
    }
    return c;
  }

  #read(): number {
    if (this.#pos >= this.#bytes.length) return EOF;
    const byte = this.#bytes[this.#pos++] as number;
    // (char)0xFF is -1, which is EOF.
    return byte === 0xff ? EOF : byte;
  }

  parse(): boolean {
    let comment = false;
    let base = "";
    for (;;) {
      const c = this.#next();
      if (c === 0x0a) {
        if (this.#eof) return true;
        comment = false;
        continue;
      }
      if (comment || isSpace(c)) continue;
      if (c === 0x23 || c === 0x3b) {
        comment = true;
        continue;
      }
      if (c === 0x5b) {
        const section = this.#baseVar();
        if (section === undefined || section.length < 1) return false;
        base = `${section}.`;
        continue;
      }
      if (!isAlpha(c)) return false;
      if (!this.#value(`${base}${String.fromCharCode(toLower(c))}`)) return false;
    }
  }

  /** `get_base_var`: `[section]`, `[section.sub]` or `[section "sub"]`. */
  #baseVar(): string | undefined {
    let name = "";
    for (;;) {
      const c = this.#next();
      if (this.#eof) return undefined;
      if (c === 0x5d) return name;
      if (isSpace(c)) return this.#extendedBaseVar(name, c);
      if (!isKeyChar(c) && c !== 0x2e) return undefined;
      name += String.fromCharCode(toLower(c));
    }
  }

  #extendedBaseVar(base: string, first: number): string | undefined {
    let c = first;
    do {
      if (c === 0x0a) return undefined;
      c = this.#next();
    } while (isSpace(c));
    if (c !== 0x22) return undefined;
    let name = `${base}.`;
    for (;;) {
      let d = this.#next();
      if (d === 0x0a) return undefined;
      if (d === 0x22) break;
      if (d === 0x5c) {
        d = this.#next();
        if (d === 0x0a) return undefined;
      }
      name += String.fromCharCode(d);
    }
    return this.#next() === 0x5d ? name : undefined;
  }

  /** `get_value`: the rest of the key, then `= value` or nothing. */
  #value(start: string): boolean {
    let name = start;
    let c: number;
    for (;;) {
      c = this.#next();
      if (this.#eof || !isKeyChar(c)) break;
      name += String.fromCharCode(toLower(c));
    }
    while (c === 0x20 || c === 0x09) c = this.#next();
    let value: string | null = null;
    if (c !== 0x0a) {
      if (c !== 0x3d) return false;
      const parsed = this.#parseValue();
      if (parsed === undefined) return false;
      value = parsed;
    }
    this.#onEntry(name, value);
    return true;
  }

  /** `parse_value`: quotes, escapes, comments and trailing-space trimming. */
  #parseValue(): string | undefined {
    let quote = false;
    let comment = false;
    let trimLength = 0;
    let value = "";
    for (;;) {
      let c = this.#next();
      if (c === 0x0a) {
        if (quote) return undefined;
        return trimLength ? value.slice(0, trimLength) : value;
      }
      if (comment) continue;
      if (isSpace(c) && !quote) {
        if (!trimLength) trimLength = value.length;
        if (value.length) value += String.fromCharCode(c);
        continue;
      }
      if (!quote && (c === 0x3b || c === 0x23)) {
        comment = true;
        continue;
      }
      trimLength = 0;
      if (c === 0x5c) {
        c = this.#next();
        switch (c) {
          case 0x0a:
            continue;
          case 0x74:
            c = 0x09;
            break;
          case 0x62:
            c = 0x08;
            break;
          case 0x6e:
            c = 0x0a;
            break;
          case 0x5c:
          case 0x22:
            break;
          default:
            return undefined;
        }
        value += String.fromCharCode(c);
        continue;
      }
      if (c === 0x22) {
        quote = !quote;
        continue;
      }
      value += String.fromCharCode(c);
    }
  }
}
