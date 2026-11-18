// Masking secrets in a task's log rows before they are stored or sent: the
// forms a value is covered in, `::add-mask::` registration, and a streaming
// matcher over the rows joined with no separator, which carries a partial
// match between requests as a reference into the mask set (never as text).
//
// The masked text of a row depends only on the masks in effect at that row,
// the carry at the boundary before it and the rows themselves, never on how
// requests batched the rows: a row a viewer saw live is the row stored later,
// and a resend after a reset reproduces it.

/** Values and variants shorter than this are not masked. */
export const MASK_MIN_LENGTH = 2;
/** Variants at least this long may match across a row boundary; shorter ones match within a row. */
export const MASK_CROSS_MIN_LENGTH = 8;
/** A partial match at least this long holds its rows; a shorter one is cut at the boundary. */
export const MASK_HOLD_MIN_LENGTH = 4;
/** Mask values a task may have. */
export const MASK_MAX_VALUES = 256;
/** UTF-8 bytes of mask values a task may have. */
export const MASK_MAX_TEXT_BYTES = 16 * 1024;
/** A value longer than this, in UTF-8 bytes, is covered by its trimmed lines only. */
export const MASK_WHOLE_MAX_BYTES = 4 * 1024;

const COMMAND = "::add-mask::";
const MASKED = "***";
const encoder = new TextEncoder();

export interface MaskVariant {
  readonly text: string;
  /** Whether a match may span rows: true for variants of `MASK_CROSS_MIN_LENGTH` chars or more. */
  readonly crosses: boolean;
}

/**
 * The forms a value is masked in, deduplicated, each of at least
 * `MASK_MIN_LENGTH` chars, in a fixed order (a carry names a variant by its
 * position): the value; without CR and LF; each trimmed line; for values of
 * 8+ chars, base64 of its UTF-8 bytes at the three byte alignments and the
 * exact padded encoding; JSON string escaping, plain and HTML-safe; Go's URI
 * data, query and path-segment escaping; workflow-command escaping.
 */
export function buildVariants(value: string): MaskVariant[] {
  const bytes = encoder.encode(value);
  const texts = [value, value.replace(/[\r\n]/g, ""), ...lineTexts(value)];
  if (value.length >= MASK_CROSS_MIN_LENGTH) texts.push(...base64Forms(bytes));
  const json = JSON.stringify(value).slice(1, -1);
  texts.push(json, htmlSafe(json));
  texts.push(
    percentEscape(bytes, isUnreserved, false),
    percentEscape(bytes, isUnreserved, true),
    percentEscape(bytes, isPathSegmentByte, false),
  );
  texts.push(value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A"));
  return toVariants(texts);
}

function lineTexts(value: string): string[] {
  return value.split(/\r\n|\r|\n/).map((line) => line.trim());
}

function toVariants(texts: readonly string[]): MaskVariant[] {
  const seen = new Set<string>();
  const variants: MaskVariant[] = [];
  for (const text of texts) {
    if (text.length < MASK_MIN_LENGTH || seen.has(text)) continue;
    seen.add(text);
    variants.push({ text, crosses: text.length >= MASK_CROSS_MIN_LENGTH });
  }
  return variants;
}

function variantsOf(value: string): MaskVariant[] {
  return utf8Length(value) > MASK_WHOLE_MAX_BYTES
    ? toVariants(lineTexts(value))
    : buildVariants(value);
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64.charAt(a >> 2);
    out += BASE64.charAt(((a & 3) << 4) | ((b ?? 0) >> 4));
    out += b === undefined ? "=" : BASE64.charAt(((b & 15) << 2) | ((c ?? 0) >> 6));
    out += c === undefined ? "=" : BASE64.charAt(c & 63);
  }
  return out;
}

/**
 * The value embedded at each byte offset modulo 3: encode `shift` filler
 * bytes and the value, then keep only the chars that neither the filler nor
 * the byte after the value can change. Plus the whole padded encoding.
 */
function base64Forms(bytes: Uint8Array): string[] {
  const forms: string[] = [];
  for (const shift of [0, 1, 2]) {
    const shifted = new Uint8Array(shift + bytes.length);
    shifted.set(bytes, shift);
    const encoded = base64(shifted);
    forms.push(encoded.slice(Math.ceil((8 * shift) / 6), Math.floor((8 * shifted.length) / 6)));
  }
  forms.push(base64(bytes));
  return forms;
}

/** Go's `encoding/json` HTML-safe escapes, applied to an already JSON-escaped string. */
function htmlSafe(json: string): string {
  return json.replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

const HEX = "0123456789ABCDEF";

function isUnreserved(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x5f ||
    byte === 0x7e
  );
}

/**
 * Go's `url.PathEscape` keeps `$&+:=@` besides the unreserved bytes
 * (verified: `shouldEscape`, `encodePathSegment`, https://go.dev/src/net/url/url.go).
 */
function isPathSegmentByte(byte: number): boolean {
  return isUnreserved(byte) || "$&+:=@".includes(String.fromCharCode(byte));
}

/** Percent-escapes every UTF-8 byte `keep` refuses, upper-case hex; `spacePlus` writes space as `+` (`url.QueryEscape`). */
function percentEscape(
  bytes: Uint8Array,
  keep: (byte: number) => boolean,
  spacePlus: boolean,
): string {
  let out = "";
  for (const byte of bytes) {
    if (keep(byte)) out += String.fromCharCode(byte);
    else if (spacePlus && byte === 0x20) out += "+";
    else out += `%${HEX.charAt(byte >> 4)}${HEX.charAt(byte & 15)}`;
  }
  return out;
}

function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/**
 * The value of an `::add-mask::` row: the exact command at the start of the
 * row, its data up to the first CR or LF, unescaped in one left-to-right pass
 * (`%25` to `%`, `%0D` to CR, `%0A` to LF), as the runner parses workflow
 * commands before registering the value
 * (verified: https://gitea.com/gitea/runner/raw/tag/v6.0.0/act/runner/command.go).
 * Null for any other row.
 */
export function parseAddMask(row: string): string | null {
  const data = commandData(row);
  return data === null ? null : data.replace(/%25|%0D|%0A/g, unescapeCommand);
}

function unescapeCommand(sequence: string): string {
  return sequence === "%25" ? "%" : sequence === "%0D" ? "\r" : "\n";
}

/** The raw data of an `::add-mask::` row, as the row shows it, or null for any other row. */
function commandData(row: string): string | null {
  if (!row.startsWith(COMMAND)) return null;
  const data = row.slice(COMMAND.length);
  const end = data.search(/[\r\n]/);
  return end === -1 ? data : data.slice(0, end);
}

/** A mask value and the first row (task log position) it applies to. */
export interface LogMask {
  readonly value: string;
  readonly fromIndex: number;
  /** Counted inside `reserve` rather than toward the caps (see `MaskRowsOptions.reserve`). */
  readonly reserved?: boolean | undefined;
}

/**
 * Raw UTF-16 units after an omitted row that may finish a crossing variant
 * registered by that row's position. Protecting this prefix does not need
 * the omitted text. Row-local variants cannot cross the gap.
 */
export function maskGapLength(masks: readonly LogMask[], index: number): number {
  let length = 0;
  for (const mask of masks) {
    if (mask.fromIndex > index) continue;
    for (const variant of variantsOf(mask.value)) {
      if (variant.crosses) length = Math.max(length, variant.text.length - 1);
    }
  }
  return length;
}

/**
 * The partial match in progress at a row boundary: the first `length` chars
 * of variant `variant` of mask `mask` (its position in the mask list, which
 * only ever grows by appending). No text, so it can be stored beside the ack.
 */
export interface LogMaskCarry {
  readonly mask: number;
  readonly variant: number;
  readonly length: number;
  /** Mask activation rows inside the prefix, with stream offsets relative to this boundary. */
  readonly starts?: readonly { readonly index: number; readonly offset: number }[] | undefined;
}

export interface MaskRowsOptions {
  /** Task log position of the first row. */
  readonly start: number;
  /** The last rows of the log: nothing follows, so no partial match is masked or held. */
  readonly final?: boolean | undefined;
  /** The rows are stored now whatever is settled: a trailing partial match of 4+ chars is masked. */
  readonly force?: boolean | undefined;
  /** Raw UTF-16 units of the leading stream to mask after an omission, across rows and requests. */
  readonly gapRemaining?: number | undefined;
  /**
   * A fixed allowance kept out of the caps (values and UTF-8 bytes) for the
   * masks marked `reserved`, given now or later: a row's value is registered
   * only if it fits beside the allowance, so reserved masks appearing within
   * it never change which values register. Reserved masks past it count.
   */
  readonly reserve?: { readonly values: number; readonly bytes: number } | undefined;
  /** Counts transition lookups made while scanning the rows, so tests can bound the work. */
  readonly work?: { lookups: number } | undefined;
}

export interface MaskRowsResult {
  /** Each row's masked text. */
  readonly lines: readonly string[];
  /** Leading rows whose masked text no later row can change. */
  readonly settled: number;
  /** The carry at boundary `k` (after `k` rows), for `k` from 0 to the row count. */
  carryAt(k: number): LogMaskCarry | null;
  /**
   * Remaining gap protection after `k` rows. An end-of-row high surrogate
   * retains one unit of protection for a possible following low surrogate.
   */
  gapRemainingAt(k: number): number;
  /** Values the rows registered, in order: appended to the mask list once their row is stored. */
  readonly added: readonly { readonly value: string; readonly index: number }[];
  /** `::add-mask::` values not registered because the task is at a cap. */
  readonly dropped: readonly { readonly index: number; readonly reason: "values" | "bytes" }[];
}

interface Entry {
  readonly variants: readonly MaskVariant[];
  readonly fromIndex: number;
  /** Stream offset (from the first row) where matches may start; -Infinity before the rows, Infinity not yet in effect. */
  from: number;
}

/**
 * Masks rows as one stream joined with no separator. A variant of 8+ chars
 * matches anywhere in the stream from its value's row on; a shorter one only
 * within a row. Merged matched ranges become `***` in every row they touch,
 * and an `::add-mask::` row's value is always masked. A row that registers a
 * value applies it from that row on, counting only matches that start there
 * or later; rows before it are never masked again.
 *
 * Where the deepest partial match at a row boundary is 1 to 3 chars, the rows
 * before it settle as they are: a match completed later masks only from the
 * boundary on, so a value split there exposes at most 3 chars. A partial
 * match of 4+ chars holds every row from where it begins (`settled`), unless
 * `force` stores them, masking it.
 *
 * Linear in the rows' length (Aho–Corasick over UTF-16 code units), plus one
 * rebuild of the matcher per registering row.
 */
export function maskRows(
  masks: readonly LogMask[],
  carry: LogMaskCarry | null,
  rows: readonly string[],
  options: MaskRowsOptions,
): MaskRowsResult {
  const { start } = options;
  let gapRemaining = options.gapRemaining ?? 0;
  if (!Number.isSafeInteger(gapRemaining) || gapRemaining < 0) {
    throw new RangeError("gapRemaining must be a nonnegative safe integer");
  }
  const final = options.final === true;
  const force = !final && options.force === true;
  const reserved = options.reserve ?? { values: 0, bytes: 0 };

  const entries: Entry[] = [];
  const pending = new Map<number, Entry[]>();
  const known = new Map<string, number>();
  let bytes = 0;
  let reservedValues = 0;
  let reservedBytes = 0;
  for (const mask of masks) {
    const entry: Entry = {
      variants: variantsOf(mask.value),
      fromIndex: mask.fromIndex,
      from: mask.fromIndex < start ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    };
    entries.push(entry);
    if (mask.fromIndex >= start)
      pending.set(mask.fromIndex, [...(pending.get(mask.fromIndex) ?? []), entry]);
    known.set(
      mask.value,
      Math.min(known.get(mask.value) ?? Number.POSITIVE_INFINITY, mask.fromIndex),
    );
    if (mask.reserved === true) {
      reservedValues++;
      reservedBytes += utf8Length(mask.value);
    } else bytes += utf8Length(mask.value);
  }

  const resumed = resumable(entries, carry, start);
  if (resumed?.starts !== undefined) {
    const starts = new Map(resumed.starts.map(({ index, offset }) => [index, offset]));
    for (const entry of entries) {
      const offset = starts.get(entry.fromIndex);
      if (entry.fromIndex < start && offset !== undefined) entry.from = offset;
    }
  }

  const activated = new Map<number, number>();
  for (const entry of entries) {
    if (Number.isFinite(entry.from)) activated.set(entry.fromIndex, entry.from);
  }
  const activations = [...activated].map(([index, offset]) => ({ index, offset }));
  activations.sort((a, b) => a.offset - b.offset);
  const boundary = (at: LogMaskCarry | null, end: number): LogMaskCarry | null => {
    if (at === null) return null;
    let low = 0;
    let high = activations.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((activations[middle]?.offset ?? 0) <= end - at.length) low = middle + 1;
      else high = middle;
    }
    return low === activations.length
      ? at
      : {
          ...at,
          starts: activations
            .slice(low)
            .map(({ index, offset }) => ({ index, offset: offset - end })),
        };
  };

  const work = options.work;
  let long = new Matcher(entries, true, work);
  let short = new Matcher(entries, false, work);
  const prefixOf = (c: LogMaskCarry | null): string =>
    c === null ? "" : (entries[c.mask]?.variants[c.variant]?.text.slice(0, c.length) ?? "");

  let state = long.walk(prefixOf(resumed));
  const carries: (LogMaskCarry | null)[] = [boundary(long.carry(state, 0), 0)];
  const added: { value: string; index: number }[] = [];
  const dropped: { index: number; reason: "values" | "bytes" }[] = [];
  const ranges = new Ranges();
  const rowStarts: number[] = [];
  const gaps = [gapRemaining];
  let pos = 0;
  let lastCut = 0;

  rows.forEach((row, t) => {
    const index = start + t;
    rowStarts.push(pos);
    let gapEnd = Math.min(gapRemaining, row.length);
    if (gapEnd > 0 && isHighSurrogate(row.charCodeAt(gapEnd - 1))) {
      if (gapEnd < row.length && isLowSurrogate(row.charCodeAt(gapEnd))) gapEnd++;
      else if (gapEnd === row.length && gapRemaining === row.length) gapRemaining++;
    }
    ranges.add(pos, pos + gapEnd);
    gapRemaining = Math.max(0, gapRemaining - row.length);
    gaps.push(gapRemaining);
    let changed = false;
    for (const entry of pending.get(index) ?? []) {
      entry.from = pos;
      changed = true;
    }
    const data = commandData(row);
    const value = data === null ? null : parseAddMask(row);
    let commandEnd = -1;
    if (data !== null && value !== null && data !== "") {
      commandEnd = pos + COMMAND.length + data.length;
      if (
        value.length >= MASK_MIN_LENGTH &&
        (known.get(value) ?? Number.POSITIVE_INFINITY) > index
      ) {
        const size = utf8Length(value);
        const values = entries.length - reservedValues + Math.max(reserved.values, reservedValues);
        if (values >= MASK_MAX_VALUES) dropped.push({ index, reason: "values" });
        else if (bytes + Math.max(reserved.bytes, reservedBytes) + size > MASK_MAX_TEXT_BYTES)
          dropped.push({ index, reason: "bytes" });
        else {
          entries.push({ variants: variantsOf(value), fromIndex: index, from: pos });
          known.set(value, index);
          bytes += size;
          added.push({ value, index });
          changed = true;
        }
      }
    }
    if (changed) {
      activations.push({ index, offset: pos });
      // Partial matches in progress here are of earlier values only.
      const prefix = prefixOf(long.carry(state, pos));
      long = new Matcher(entries, true, work);
      short = new Matcher(entries, false, work);
      state = long.walk(prefix);
    }
    let local = 0;
    for (let i = 0; i < row.length; i++) {
      const unit = row.charCodeAt(i);
      state = long.step(state, unit);
      local = short.step(local, unit);
      pos++;
      const length = Math.max(long.longestMatch(state, pos), short.longestMatch(local, pos));
      if (length > 0) ranges.add(Math.max(pos - length, lastCut), pos);
      if (pos === commandEnd) ranges.add(commandEnd - (data as string).length, commandEnd);
    }
    const carried = boundary(long.carry(state, pos), pos);
    carries.push(carried);
    if (carried !== null && carried.length < MASK_HOLD_MIN_LENGTH) lastCut = pos;
  });

  let settled = rows.length;
  const tail = carries[rows.length] ?? null;
  if (!final && tail !== null && tail.length >= MASK_HOLD_MIN_LENGTH) {
    const from = Math.max(pos - tail.length, lastCut);
    // The first row with text at or after `from`; none when the partial lies wholly before these rows.
    const held = rows.findIndex((row, t) => (rowStarts[t] as number) + row.length > from);
    settled = held === -1 ? rows.length : held;
    if (force) ranges.add(from, pos);
  }

  return {
    lines: ranges.render(rows, rowStarts),
    settled,
    carryAt(k: number): LogMaskCarry | null {
      if (!Number.isInteger(k) || k < 0 || k > rows.length) {
        throw new RangeError(`no row boundary ${k} in ${rows.length} rows`);
      }
      return carries[k] ?? null;
    },
    gapRemainingAt(k: number): number {
      if (!Number.isInteger(k) || k < 0 || k > rows.length) {
        throw new RangeError(`no row boundary ${k} in ${rows.length} rows`);
      }
      return gaps[k] as number;
    },
    added,
    dropped,
  };
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** The carry if it names a crossing variant of a mask in effect before `start`, else null. */
function resumable(
  entries: readonly Entry[],
  carry: LogMaskCarry | null,
  start: number,
): LogMaskCarry | null {
  if (carry === null) return null;
  const entry = entries[carry.mask];
  if (entry === undefined || entry.fromIndex >= start) return null;
  const variant = entry.variants[carry.variant];
  if (variant === undefined || !variant.crosses) return null;
  if (!Number.isInteger(carry.length) || carry.length < 1 || carry.length >= variant.text.length) {
    return null;
  }
  return carry;
}

/** Merged matched ranges of the stream, added in order of their end. */
class Ranges {
  readonly #starts: number[] = [];
  readonly #ends: number[] = [];

  add(from: number, to: number): void {
    if (to <= from) return;
    let a = from;
    let b = to;
    while (this.#ends.length > 0 && (this.#ends.at(-1) as number) >= a) {
      a = Math.min(a, this.#starts.pop() as number);
      b = Math.max(b, this.#ends.pop() as number);
    }
    this.#starts.push(a);
    this.#ends.push(b);
  }

  render(rows: readonly string[], rowStarts: readonly number[]): string[] {
    let first = 0;
    return rows.map((row, t) => {
      const rowStart = rowStarts[t] as number;
      const rowEnd = rowStart + row.length;
      while (first < this.#ends.length && (this.#ends[first] as number) <= rowStart) first++;
      let out = "";
      let cursor = rowStart;
      for (let r = first; r < this.#starts.length; r++) {
        const a = Math.max(this.#starts[r] as number, rowStart);
        if (a >= rowEnd) break;
        const b = Math.min(this.#ends[r] as number, rowEnd);
        out += row.slice(cursor - rowStart, a - rowStart) + MASKED;
        cursor = b;
        if (b === rowEnd) break;
      }
      return out + row.slice(cursor - rowStart);
    });
  }
}

/**
 * An Aho–Corasick automaton over the crossing (or the row-local) variants of
 * the masks in effect. Each pattern keeps the stream offset from which its
 * matches count, so a value registered mid-stream does not match text that
 * starts before its row.
 */
class Matcher {
  /** Transitions keyed `node * 0x10000 + unit`: one lookup whatever a node's fan-out. */
  readonly #edges = new Map<number, number>();
  /** Children as a linked list, walked only while building. */
  readonly #firstChild: number[] = [-1];
  readonly #nextSibling: number[] = [-1];
  readonly #unit: number[] = [0];
  readonly #fail: number[] = [0];
  readonly #depth: number[] = [0];
  /** Lowest `from` of the patterns ending at the node. */
  readonly #term: number[] = [Number.POSITIVE_INFINITY];
  /** Nearest node on the failure chain with a pattern ending there, or -1. */
  readonly #dict: number[] = [-1];
  /** Lowest `from` of the patterns continuing past the node, and the first such pattern. */
  readonly #proper: number[] = [Number.POSITIVE_INFINITY];
  readonly #properRef: number[] = [-1];
  /** Deepest node on the failure chain (itself included) that some pattern continues past. */
  readonly #partialNode: number[] = [0];
  readonly #refs: { mask: number; variant: number }[] = [];

  readonly #work: { lookups: number } | undefined;

  constructor(entries: readonly Entry[], crosses: boolean, work?: { lookups: number }) {
    entries.forEach((entry, mask) => {
      if (entry.from === Number.POSITIVE_INFINITY) return;
      entry.variants.forEach((variant, index) => {
        if (variant.crosses !== crosses) return;
        const ref = this.#refs.length;
        this.#refs.push({ mask, variant: index });
        this.#insert(variant.text, entry.from, ref);
      });
    });
    this.#link();
    this.#work = work;
  }

  #child(node: number, unit: number): number {
    if (this.#work !== undefined) this.#work.lookups++;
    return this.#edges.get(node * 0x10000 + unit) ?? 0;
  }

  #insert(text: string, from: number, ref: number): void {
    let node = 0;
    for (let i = 0; i < text.length; i++) {
      if (node !== 0 && from < (this.#proper[node] as number)) {
        this.#proper[node] = from;
        this.#properRef[node] = ref;
      }
      const unit = text.charCodeAt(i);
      let next = this.#child(node, unit);
      if (next === 0) {
        next = this.#unit.length;
        this.#unit.push(unit);
        this.#depth.push(i + 1);
        this.#firstChild.push(-1);
        this.#fail.push(0);
        this.#term.push(Number.POSITIVE_INFINITY);
        this.#dict.push(-1);
        this.#proper.push(Number.POSITIVE_INFINITY);
        this.#properRef.push(-1);
        this.#partialNode.push(0);
        this.#edges.set(node * 0x10000 + unit, next);
        this.#nextSibling.push(this.#firstChild[node] as number);
        this.#firstChild[node] = next;
      }
      node = next;
    }
    this.#term[node] = Math.min(this.#term[node] as number, from);
  }

  #link(): void {
    const queue: number[] = [];
    for (let node = 1; node < this.#unit.length; node++) {
      if (this.#depth[node] === 1) queue.push(node);
    }
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head] as number;
      // A node's failure link was set when its parent was dequeued (0 at depth 1).
      const fail = this.#fail[node] as number;
      this.#dict[node] =
        (this.#term[fail] as number) < Number.POSITIVE_INFINITY
          ? fail
          : (this.#dict[fail] as number);
      this.#partialNode[node] =
        this.#firstChild[node] !== -1 ? node : (this.#partialNode[fail] as number);
      for (let c = this.#firstChild[node] as number; c !== -1; c = this.#nextSibling[c] as number) {
        this.#fail[c] = this.step(fail, this.#unit[c] as number);
        queue.push(c);
      }
    }
  }

  /** The state after reading `unit`. */
  step(node: number, unit: number): number {
    let at = node;
    for (;;) {
      const next = this.#child(at, unit);
      if (next !== 0 || at === 0) return next;
      at = this.#fail[at] as number;
    }
  }

  /** The state for a prefix of a pattern, or the root when it is empty or unknown. */
  walk(prefix: string): number {
    let node = 0;
    for (let i = 0; i < prefix.length && (i === 0 || node !== 0); i++) {
      node = this.#child(node, prefix.charCodeAt(i));
    }
    return node;
  }

  /** Length of the longest match ending at stream offset `end` that counts, or 0. */
  longestMatch(node: number, end: number): number {
    let at =
      (this.#term[node] as number) < Number.POSITIVE_INFINITY ? node : (this.#dict[node] as number);
    while (at > 0) {
      const depth = this.#depth[at] as number;
      if ((this.#term[at] as number) <= end - depth) return depth;
      at = this.#dict[at] as number;
    }
    return 0;
  }

  /** The deepest partial match in progress at stream offset `end` that would count if completed. */
  carry(node: number, end: number): LogMaskCarry | null {
    let at = this.#partialNode[node] as number;
    while (at !== 0) {
      const depth = this.#depth[at] as number;
      if ((this.#proper[at] as number) <= end - depth) {
        const ref = this.#refs[this.#properRef[at] as number] as { mask: number; variant: number };
        return { mask: ref.mask, variant: ref.variant, length: depth };
      }
      at = this.#partialNode[this.#fail[at] as number] as number;
    }
    return null;
  }
}
