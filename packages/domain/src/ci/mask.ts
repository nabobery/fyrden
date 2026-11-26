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
/** Secret masks a task may have, counted apart from the caps above. Proposed. */
export const MASK_SECRET_MAX_VALUES = 200;
/** UTF-8 bytes of secret mask values a task may have. Proposed. */
export const MASK_SECRET_MAX_TEXT_BYTES = 256 * 1024;
/** UTF-8 bytes of the variants of a task's secret masks, which bound the matcher's size. Proposed. */
export const MASK_SECRET_MAX_VARIANT_BYTES = 32 * 1024;

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
  /** A delivered secret: never counted toward the caps or the reserve (see `checkSecretMasks`). */
  readonly secret?: boolean | undefined;
}

/** A stored mask's first row and crossing length (`maskCrossLength` of its value), without the value. */
export interface LogMaskReach {
  readonly fromIndex: number;
  readonly crossLen: number;
}

/**
 * The length of the longest variant of `value` that may cross a row
 * boundary, minus one (0 when none does): what an omitted row's gap must
 * cover for this value.
 */
export function maskCrossLength(value: string): number {
  let length = 0;
  for (const variant of variantsOf(value)) {
    if (variant.crosses) length = Math.max(length, variant.text.length - 1);
  }
  return length;
}

/**
 * Raw UTF-16 units after an omitted row that may finish a crossing variant
 * registered by that row's position. Protecting this prefix does not need
 * the omitted text. Row-local variants cannot cross the gap. A mask given by
 * its stored crossing length counts the same as one given by its value.
 */
export function maskGapLength(masks: readonly (LogMask | LogMaskReach)[], index: number): number {
  let length = 0;
  for (const mask of masks) {
    if (mask.fromIndex > index) continue;
    length = Math.max(length, "crossLen" in mask ? mask.crossLen : maskCrossLength(mask.value));
  }
  return length;
}

/** UTF-8 bytes of every variant the masker builds for `value`. */
export function maskVariantBytes(value: string): number {
  let bytes = 0;
  for (const variant of variantsOf(value)) bytes += utf8Length(variant.text);
  return bytes;
}

/** A delivered secret offered to be masked: its name, for a refusal, and its value. */
export interface SecretMaskOffer {
  readonly name: string;
  readonly value: string;
}

export type SecretMaskCheck =
  | {
      readonly ok: true;
      /** The offered values the task does not mask yet, once each, in order. */
      readonly added: readonly string[];
    }
  | {
      readonly ok: false;
      readonly limit: "values" | "bytes" | "variants";
      /** The offered secrets new to the task, by name and size; never their values. */
      readonly secrets: readonly {
        readonly name: string;
        readonly bytes: number;
        readonly variantBytes: number;
      }[];
    };

/**
 * Whether a task masking the secret values `stored` can mask `offered` too,
 * within the secret budget: `MASK_SECRET_MAX_VALUES` values,
 * `MASK_SECRET_MAX_TEXT_BYTES` of value text and
 * `MASK_SECRET_MAX_VARIANT_BYTES` of variant text, over every secret the
 * task has had (masks only append, so a re-offer's values add to it). A
 * value the task has already, or shorter than `MASK_MIN_LENGTH` UTF-16
 * units (never masked), adds nothing; every other value counts in full,
 * whatever variants it has.
 */
export function checkSecretMasks(
  stored: readonly string[],
  offered: readonly SecretMaskOffer[],
): SecretMaskCheck {
  const known = new Set(stored);
  let values = stored.length;
  let bytes = 0;
  let variantBytes = 0;
  for (const value of stored) {
    bytes += utf8Length(value);
    variantBytes += maskVariantBytes(value);
  }
  const added: string[] = [];
  const sizes: { name: string; bytes: number; variantBytes: number }[] = [];
  for (const { name, value } of offered) {
    if (value.length < MASK_MIN_LENGTH || known.has(value)) continue;
    const size = { name, bytes: utf8Length(value), variantBytes: maskVariantBytes(value) };
    known.add(value);
    added.push(value);
    sizes.push(size);
    values++;
    bytes += size.bytes;
    variantBytes += size.variantBytes;
  }
  const limit =
    values > MASK_SECRET_MAX_VALUES
      ? "values"
      : bytes > MASK_SECRET_MAX_TEXT_BYTES
        ? "bytes"
        : variantBytes > MASK_SECRET_MAX_VARIANT_BYTES
          ? "variants"
          : undefined;
  return limit === undefined ? { ok: true, added } : { ok: false, limit, secrets: sizes };
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
  /** The task's matchers kept from earlier calls, reused and extended by this one. */
  readonly cache?: MaskMatcherCache | undefined;
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

interface Tier {
  readonly masks: number[];
  readonly long: Matcher;
  readonly short: Matcher;
  state: number;
  local: number;
}

interface Entry {
  readonly variants: readonly MaskVariant[];
  readonly fromIndex: number;
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
 * Linear in the rows' length (Aho–Corasick over UTF-16 code units) times the
 * matchers stepped: the masks in effect for the whole call (the base, kept in
 * `options.cache` between calls) and at most log2 n + 1 tiers over the masks
 * a row registers or activates.
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
  const pending = new Map<number, number[]>();
  const known = new Map<string, number>();
  let bytes = 0;
  let reservedValues = 0;
  let reservedBytes = 0;
  let secretValues = 0;
  const cache = options.cache ?? new MaskMatcherCache();
  const variants = cache.prepare(masks);
  for (const [k, mask] of masks.entries()) {
    // From row 0, a mask of row 0 counts from the stream's start: the same as one already in effect.
    const now = mask.fromIndex < start || (start === 0 && mask.fromIndex === 0);
    const entry: Entry = {
      variants: variants[k] as MaskVariant[],
      fromIndex: mask.fromIndex,
      from: now ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    };
    entries.push(entry);
    if (!now) {
      const list = pending.get(mask.fromIndex);
      if (list === undefined) pending.set(mask.fromIndex, [k]);
      else list.push(k);
    }
    known.set(
      mask.value,
      Math.min(known.get(mask.value) ?? Number.POSITIVE_INFINITY, mask.fromIndex),
    );
    if (mask.secret === true) secretValues++;
    else if (mask.reserved === true) {
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
  const inBase: boolean[] = entries.map((entry) => entry.from === Number.NEGATIVE_INFINITY);
  const base = cache.base(entries, inBase);
  base.long.work = work;
  base.short.work = work;
  const prefixOf = (c: LogMaskCarry | null): string =>
    c === null ? "" : (entries[c.mask]?.variants[c.variant]?.text.slice(0, c.length) ?? "");
  // Masks not in the base, in tiers: a new tier takes in the one before it while that one is
  // at most twice its size. So each tier is more than twice the next, a row steps at most
  // log2 n + 1 of them, and each mask is inserted O(log n) times however many rows add masks.
  const tiers: Tier[] = [];
  const addTier = (masks: number[], prefix: string): void => {
    let merged = masks;
    while (tiers.length > 0 && (tiers.at(-1) as Tier).masks.length <= 2 * merged.length)
      merged = [...(tiers.pop() as Tier).masks, ...merged];
    merged.sort((a, b) => a - b);
    const long = new Matcher(entries, true, merged);
    const short = new Matcher(entries, false, merged);
    long.work = work;
    short.work = work;
    tiers.push({ masks: merged, long, short, state: long.run(prefix), local: 0 });
  };

  let state = base.long.run(prefixOf(resumed));
  const initial = entries.flatMap((entry, mask) =>
    inBase[mask] !== true && entry.from !== Number.POSITIVE_INFINITY ? [mask] : [],
  );
  if (initial.length > 0) addTier(initial, prefixOf(resumed));
  // The deepest partial that would count; at equal depth the lowest `from`, then the first mask.
  const carryAt = (end: number): LogMaskCarry | null => {
    let best = base.long.carry(state, end);
    // From row 0 the base's masks count from offset 0, where masks of empty leading rows tie.
    let bestFrom = start === 0 ? 0 : Number.NEGATIVE_INFINITY;
    for (const tier of tiers) {
      const found = tier.long.carryFrom(tier.state, end);
      if (found === null) continue;
      const [carry, from] = found;
      if (
        best === null ||
        carry.length > best.length ||
        (carry.length === best.length &&
          (from < bestFrom || (from === bestFrom && carry.mask < best.mask)))
      ) {
        best = carry;
        bestFrom = from;
      }
    }
    return best;
  };
  const carries: (LogMaskCarry | null)[] = [boundary(carryAt(0), 0)];
  const added: { value: string; index: number }[] = [];
  const dropped: { index: number; reason: "values" | "bytes" }[] = [];
  const ranges = new Ranges();
  const rowStarts: number[] = [];
  const gaps = [gapRemaining];
  let pos = 0;
  let lastCut = 0;

  try {
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
      const fresh: number[] = [];
      for (const mask of pending.get(index) ?? []) {
        (entries[mask] as Entry).from = pos;
        fresh.push(mask);
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
          const values =
            entries.length -
            secretValues -
            reservedValues +
            Math.max(reserved.values, reservedValues);
          if (values >= MASK_MAX_VALUES) dropped.push({ index, reason: "values" });
          else if (bytes + Math.max(reserved.bytes, reservedBytes) + size > MASK_MAX_TEXT_BYTES)
            dropped.push({ index, reason: "bytes" });
          else {
            fresh.push(entries.length);
            entries.push({ variants: variantsOf(value), fromIndex: index, from: pos });
            known.set(value, index);
            bytes += size;
            added.push({ value, index });
          }
        }
      }
      if (fresh.length > 0) {
        activations.push({ index, offset: pos });
        // Partial matches in progress here are of earlier values only. Matchers left as they
        // are keep their state: what they hold past this partial can never count.
        addTier(fresh, prefixOf(carryAt(pos)));
      }
      let local = 0;
      for (const tier of tiers) tier.local = 0;
      for (let i = 0; i < row.length; i++) {
        const unit = row.charCodeAt(i);
        state = base.long.step(state, unit);
        local = base.short.step(local, unit);
        pos++;
        let length = Math.max(
          base.long.longestMatch(state, pos),
          base.short.longestMatch(local, pos),
        );
        for (const tier of tiers) {
          tier.state = tier.long.step(tier.state, unit);
          tier.local = tier.short.step(tier.local, unit);
          length = Math.max(
            length,
            tier.long.longestMatch(tier.state, pos),
            tier.short.longestMatch(tier.local, pos),
          );
        }
        if (length > 0) ranges.add(Math.max(pos - length, lastCut), pos);
        if (pos === commandEnd) ranges.add(commandEnd - (data as string).length, commandEnd);
      }
      const carried = boundary(carryAt(pos), pos);
      carries.push(carried);
      if (carried !== null && carried.length < MASK_HOLD_MIN_LENGTH) lastCut = pos;
    });
  } finally {
    // A kept matcher never counts into a later caller's work.
    base.long.work = undefined;
    base.short.work = undefined;
  }

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
  readonly #edges = new Map<number, number>();
  readonly #firstChild: number[] = [-1];
  readonly #nextSibling: number[] = [-1];
  readonly #unit: number[] = [0];
  readonly #fail: number[] = [0];
  readonly #depth: number[] = [0];
  readonly #term: number[] = [Number.POSITIVE_INFINITY];
  readonly #dict: number[] = [-1];
  readonly #proper: number[] = [Number.POSITIVE_INFINITY];
  readonly #properRef: number[] = [-1];
  readonly #partialNode: number[] = [0];
  readonly #refs: { readonly mask: number; readonly variant: number }[] = [];

  readonly #crosses: boolean;

  work: { lookups: number } | undefined;

  /** The crossing (or row-local) variants of masks `masks`, ascending positions, that are in effect. */
  constructor(entries: readonly Entry[], crosses: boolean, masks: readonly number[]) {
    this.#crosses = crosses;
    this.#add(entries, masks);
  }

  get patterns(): number {
    return this.#refs.length;
  }

  get nodes(): number {
    return this.#unit.length;
  }

  /**
   * Inserts the variants of masks `masks` (each after every mask inserted so far) and links
   * the whole trie again: an existing node's failure link may now end at a new node.
   */
  extend(entries: readonly Entry[], masks: readonly number[]): void {
    this.#add(entries, masks);
  }

  #add(entries: readonly Entry[], masks: readonly number[]): void {
    const work = this.work;
    this.work = undefined;
    for (const mask of masks) {
      const entry = entries[mask] as Entry;
      if (entry.from === Number.POSITIVE_INFINITY) continue;
      entry.variants.forEach((variant, index) => {
        if (variant.crosses !== this.#crosses) return;
        const ref = this.#refs.length;
        this.#refs.push({ mask, variant: index });
        this.#insert(variant.text, entry.from, ref);
      });
    }
    this.#link();
    this.work = work;
  }

  #child(node: number, unit: number): number {
    if (this.work !== undefined) this.work.lookups++;
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

  step(node: number, unit: number): number {
    let at = node;
    for (;;) {
      const next = this.#child(at, unit);
      if (next !== 0 || at === 0) return next;
      at = this.#fail[at] as number;
    }
  }

  run(text: string): number {
    let node = 0;
    for (let i = 0; i < text.length; i++) node = this.step(node, text.charCodeAt(i));
    return node;
  }

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

  carryFrom(node: number, end: number): [LogMaskCarry, number] | null {
    let at = this.#partialNode[node] as number;
    while (at !== 0) {
      const depth = this.#depth[at] as number;
      const from = this.#proper[at] as number;
      if (from <= end - depth) {
        const ref = this.#refs[this.#properRef[at] as number] as { mask: number; variant: number };
        return [{ mask: ref.mask, variant: ref.variant, length: depth }, from];
      }
      at = this.#partialNode[this.#fail[at] as number] as number;
    }
    return null;
  }

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

/** What a call did with a task's kept matchers. */
export type MaskMatcherOutcome = "hit" | "extended" | "built";

/**
 * A task's masks as of its last call, their variants, and the matchers over
 * the masks in effect for that whole call (the base). A call whose masks
 * start with these, unchanged, reuses the base, or extends it with masks that
 * follow; any other call builds it again. Masks only append, so the usual
 * call reuses it. Holds mask values and their variants in memory: keep it
 * only as long as the masks themselves exist.
 */
export class MaskMatcherCache {
  #masks: LogMask[] = [];
  #variants: MaskVariant[][] = [];
  #inBase: number[] = [];
  #long: Matcher | undefined;
  #short: Matcher | undefined;
  #units = 0;
  #variantCount = 0;
  #patterns = 0;

  /** What the last call did with the base. */
  outcome: MaskMatcherOutcome | undefined;
  /** Patterns the last call inserted into the base: none on a hit. */
  inserted = 0;
  /** Trie nodes the last call linked in the base: none on a hit. */
  linked = 0;

  /** An estimate of the heap this holds, in bytes, at or above what workerd retains for it. */
  get bytes(): number {
    const nodes = (this.#long?.nodes ?? 0) + (this.#short?.nodes ?? 0);
    return (
      CACHE_FIXED_BYTES +
      nodes * CACHE_NODE_BYTES +
      this.#patterns * CACHE_PATTERN_BYTES +
      this.#variantCount * CACHE_VARIANT_BYTES +
      this.#masks.length * CACHE_MASK_BYTES +
      this.#units * CACHE_UNIT_BYTES
    );
  }

  /** @internal The variants of each of `masks`, kept for those unchanged since the last call. */
  prepare(masks: readonly LogMask[]): readonly MaskVariant[][] {
    const kept = this.#masks;
    if (kept.length > masks.length || kept.some((mask, k) => !sameMask(mask, masks[k] as LogMask)))
      this.#clear();
    for (let k = this.#masks.length; k < masks.length; k++) {
      const mask = masks[k] as LogMask;
      const variants = variantsOf(mask.value);
      this.#masks.push({
        value: mask.value,
        fromIndex: mask.fromIndex,
        reserved: mask.reserved === true,
        secret: mask.secret === true,
      });
      this.#variants.push(variants);
      this.#units += mask.value.length;
      this.#variantCount += variants.length;
      for (const variant of variants) this.#units += variant.text.length;
    }
    return this.#variants;
  }

  /** @internal The base matchers over the masks `inBase` marks, each in effect for the whole call. */
  base(entries: readonly Entry[], inBase: readonly boolean[]): { long: Matcher; short: Matcher } {
    const wanted: number[] = [];
    inBase.forEach((yes, mask) => {
      if (yes) wanted.push(mask);
    });
    const kept = this.#inBase;
    const prefix = kept.length <= wanted.length && kept.every((mask, k) => wanted[k] === mask);
    let long = this.#long;
    let short = this.#short;
    if (long !== undefined && short !== undefined && prefix && kept.length === wanted.length) {
      this.outcome = "hit";
      this.inserted = 0;
      this.linked = 0;
    } else {
      const before = long !== undefined && short !== undefined && prefix ? this.#patterns : 0;
      if (long !== undefined && short !== undefined && prefix) {
        // Every new member follows every kept one, so insertion order stays ascending.
        const added = wanted.slice(kept.length);
        long.extend(entries, added);
        short.extend(entries, added);
        this.outcome = "extended";
      } else {
        long = new Matcher(entries, true, wanted);
        short = new Matcher(entries, false, wanted);
        this.outcome = "built";
      }
      this.#patterns = long.patterns + short.patterns;
      this.inserted = this.#patterns - before;
      this.linked = long.nodes + short.nodes - 2;
    }
    this.#long = long;
    this.#short = short;
    this.#inBase = wanted;
    return { long, short };
  }

  #clear(): void {
    this.#masks = [];
    this.#variants = [];
    this.#inBase = [];
    this.#long = undefined;
    this.#short = undefined;
    this.#units = 0;
    this.#variantCount = 0;
    this.#patterns = 0;
  }
}

// The estimate's constants. Measured in workerd 1.20261101.1 (`tools/bench/mask/run.ts`): a kept
// cache retains 82 to 96 bytes per trie node, everything included, at the caps (few long
// secrets, 200 short ones, 255 values sharing a prefix, both allowances); about 200 bytes per
// short mask of a later row than the call's (variants kept, nothing in the tries); and 1 to 4
// KiB with one short mask or none. The estimate is 1.4 to 5 times every shape's: room for a
// hash table's next doubling.
const CACHE_FIXED_BYTES = 4096;
const CACHE_NODE_BYTES = 128;
const CACHE_PATTERN_BYTES = 64;
const CACHE_VARIANT_BYTES = 96;
const CACHE_MASK_BYTES = 192;
const CACHE_UNIT_BYTES = 2;

function sameMask(a: LogMask, b: LogMask): boolean {
  return (
    a.value === b.value &&
    a.fromIndex === b.fromIndex &&
    (a.reserved === true) === (b.reserved === true) &&
    (a.secret === true) === (b.secret === true)
  );
}
