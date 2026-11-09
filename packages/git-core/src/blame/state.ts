import { OID_BYTES, type Oid, oidFromBytes, oidToHex } from "../object/oid.js";

/*
 * What a blame holds between commit steps, and its checkpoint encoding. A
 * checkpoint comes back from a bucket as untrusted bytes, so decoding checks
 * everything it can before building anything: a bad object can neither run
 * arbitrary walks nor allocate from a forged count. It can't tell whose state
 * it is, though: the bytes are only trusted inside an envelope bound to the
 * repository, which the caller checks before decoding.
 */

/** Why a line has no answer. Encoded by position, so only ever add to the end. */
export const UNRESOLVED_REASONS = [
  "parent_too_large",
  "too_many_parents",
  "diff_budget",
  "slide_unsettled",
  "object_limit",
  "work_limit",
  "history_unreadable",
  "history_missing",
  "history_limit",
  "state_limit",
  "commit_info_too_large",
  "rename_possible",
] as const;
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

export const MAX_BLAME_LINES = 100_000;
/** The largest checkpoint, its envelope aside. Past it a walk takes one flag instead. */
export const MAX_STATE_BYTES = 2 * 1024 * 1024;

export interface BlameCommitInfo {
  readonly summary: string;
  readonly name: string;
  readonly email: string;
  readonly date: string;
}

/** A commit with lines pending. `pairs` is (current line, final line), from 0, flat. */
export interface PendingCommit {
  readonly oid: Oid;
  readonly generation: number;
  readonly level: number;
  readonly pairs: Int32Array;
}

export interface BlameState {
  readonly commit: Oid;
  readonly path: readonly Uint8Array[];
  readonly lines: number;
  steps: number;
  /** Highest generation first, then level, then object id: a commit comes after all its children. */
  queue: PendingCommit[];
  /**
   * Settled ranges in the order they settled, four numbers each: first final
   * line from 0, line count, then a commit's index in `factOrder` and its
   * first source line from 1, or `-1 - reason` and 0. Grows by doubling.
   */
  ranges: Int32Array;
  rangeCount: number;
  /** What's known of each commit that settled lines, by hex id. */
  facts: Record<string, BlameCommitInfo>;
  factOrder: Oid[];
  /** The state stopped fitting: every line not settled is `state_limit`, with no list of them. */
  stateLimit: boolean;
}

/** A checkpoint's bytes aren't a state: replace the run. */
export class BlameStateError extends Error {
  override name = "BlameStateError";
}

/** A sound state that doesn't fit the room this request has: another moment may have more. */
export class BlameStateTooLarge extends Error {
  override name = "BlameStateTooLarge";
}

const MAGIC = 0x46_59_42_4c; // "FYBL"
const VERSION = 1;
const FLAG_STATE_LIMIT = 1;

// What a decoded state holds, in Node: an entry up to 522 bytes and its pairs 8
// each, a commit's facts 536 with 86 of text, a path segment 208 and its bytes.
// Pairs and ranges are charged double, since they move and grow by doubling.
const PAIR_LIVE = 16;
const QUEUE_LIVE = 640;
const RANGE_LIVE = 32;
const FACT_LIVE = 512;
/** A string takes two bytes a character once one of its characters is wide. */
const TEXT_LIVE = 2;
const SEGMENT_LIVE = 256;
const QUEUE_RECORD = OID_BYTES + 12;
const RANGE_RECORD = 16;
const FACT_FIELDS = 4;

const encoder = new TextEncoder();
// Fatal, so a character can't stand for fewer bytes than were charged for it, and
// keeping a byte order mark, so what's decoded encodes back to the same bytes.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A commit's facts, in bytes of text. */
export const factTextOf = (fact: BlameCommitInfo) =>
  encoder.encode(fact.summary).length +
  encoder.encode(fact.name).length +
  encoder.encode(fact.email).length +
  encoder.encode(fact.date).length;

/** The longest field of a commit's facts a checkpoint holds: its length takes two bytes. */
export const MAX_FACT_FIELD_BYTES = 0xffff;

/** Whether every field of a commit's facts fits a checkpoint. */
export const factFitsCheckpoint = (fact: BlameCommitInfo) =>
  [fact.summary, fact.name, fact.email, fact.date].every(
    (text) => encoder.encode(text).length <= MAX_FACT_FIELD_BYTES,
  );

/** What a path is charged for. It doesn't change during a walk. */
export function pathLiveBytes(path: readonly Uint8Array[]): number {
  let total = SEGMENT_LIVE * path.length;
  for (const segment of path) total += segment.length;
  return total;
}

/** What a state with these counts is charged for, before any of it is built. */
export function liveBytesOf(counts: {
  readonly path: number;
  readonly pairs: number;
  readonly queue: number;
  readonly ranges: number;
  readonly facts: number;
  readonly factText: number;
}): number {
  return (
    counts.path +
    PAIR_LIVE * counts.pairs +
    QUEUE_LIVE * counts.queue +
    RANGE_LIVE * counts.ranges +
    FACT_LIVE * counts.facts +
    TEXT_LIVE * counts.factText
  );
}

export function pendingPairs(state: BlameState): number {
  let pairs = 0;
  for (const entry of state.queue) pairs += entry.pairs.length / 2;
  return pairs;
}

function factTextBytes(state: BlameState): number {
  let total = 0;
  for (const fact of Object.values(state.facts)) total += factTextOf(fact);
  return total;
}

export function liveStateBytes(state: BlameState): number {
  return liveBytesOf({
    path: pathLiveBytes(state.path),
    pairs: pendingPairs(state),
    queue: state.queue.length,
    ranges: state.rangeCount,
    facts: state.factOrder.length,
    factText: factTextBytes(state),
  });
}

/** The encoded size of a state with these counts, without encoding it. */
export function encodedBytesOf(
  state: BlameState,
  counts: {
    readonly pairs: number;
    readonly queue: number;
    readonly ranges: number;
    readonly facts: number;
    readonly factText: number;
  },
): number {
  let pathBytes = 0;
  for (const segment of state.path) pathBytes += 2 + segment.length;
  return (
    HEADER_BYTES +
    pathBytes +
    QUEUE_RECORD * counts.queue +
    8 * counts.pairs +
    RANGE_RECORD * counts.ranges +
    (OID_BYTES + 2 * FACT_FIELDS) * counts.facts +
    counts.factText
  );
}

const HEADER_BYTES = 4 + 1 + 1 + OID_BYTES + 4 + 4 + 2 + 4 + 4 + 4;

export function encodeBlameState(state: BlameState): Uint8Array<ArrayBuffer> {
  const texts = state.factOrder.map((oid) => {
    const fact = state.facts[oidToHex(oid)] as BlameCommitInfo;
    return [fact.summary, fact.name, fact.email, fact.date].map((text) => encoder.encode(text));
  });
  const textBytes = texts.flat().reduce((total, text) => total + text.length, 0);
  const size = encodedBytesOf(state, {
    pairs: pendingPairs(state),
    queue: state.queue.length,
    ranges: state.rangeCount,
    facts: state.factOrder.length,
    factText: textBytes,
  });
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (value: number) => {
    if (value > 0xffff) throw new RangeError(`a length of ${value} doesn't fit a checkpoint`);
    view.setUint16(at, value);
    at += 2;
  };
  const u32 = (value: number) => {
    view.setUint32(at, value);
    at += 4;
  };
  const bytes = (value: Uint8Array) => {
    out.set(value, at);
    at += value.length;
  };
  u32(MAGIC);
  out[at++] = VERSION;
  out[at++] = state.stateLimit ? FLAG_STATE_LIMIT : 0;
  bytes(state.commit);
  u32(state.lines);
  u32(state.steps);
  u16(state.path.length);
  for (const segment of state.path) {
    u16(segment.length);
    bytes(segment);
  }
  u32(state.queue.length);
  u32(state.rangeCount);
  u32(state.factOrder.length);
  for (const entry of state.queue) {
    bytes(entry.oid);
    u32(entry.generation);
    u32(entry.level);
    u32(entry.pairs.length / 2);
    for (let k = 0; k < entry.pairs.length; k++) u32(entry.pairs[k] as number);
  }
  for (let k = 0; k < state.rangeCount * 4; k++) {
    view.setInt32(at, state.ranges[k] as number);
    at += 4;
  }
  state.factOrder.forEach((oid, k) => {
    bytes(oid);
    for (const text of texts[k] as Uint8Array[]) {
      u16(text.length);
      bytes(text);
    }
  });
  return out;
}

const bad = (detail: string) => new BlameStateError(`checkpoint: ${detail}`);

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let k = 0; k < a.length; k++) {
    const difference = (a[k] as number) - (b[k] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Parses and checks a checkpoint, in two passes: the first reads only counts
 * and fields and builds nothing, so a forged count is found against the length
 * and the room before any array exists. Throws BlameStateError for bytes that
 * aren't a state, and BlameStateTooLarge for one past `maxLiveStateBytes`.
 */
export function decodeBlameState(
  bytes: Uint8Array,
  options: { readonly maxLiveStateBytes?: number } = {},
): BlameState {
  if (bytes.length < HEADER_BYTES || bytes.length > MAX_STATE_BYTES) throw bad("wrong size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== MAGIC) throw bad("not a checkpoint");
  if (bytes[4] !== VERSION) throw bad("unknown version");
  const flags = bytes[5] as number;
  if ((flags & ~FLAG_STATE_LIMIT) !== 0) throw bad("unknown flag");
  const commit = bytes.subarray(6, 6 + OID_BYTES);
  let at = 6 + OID_BYTES;
  const lines = view.getUint32(at);
  const steps = view.getUint32(at + 4);
  if (lines > MAX_BLAME_LINES) throw bad("too many lines");
  const segments = view.getUint16(at + 8);
  at += 10;

  const need = (count: number) => {
    if (count > bytes.length - at) throw bad("runs past the end");
  };
  const pathAt = at;
  let pathLive = SEGMENT_LIVE * segments;
  for (let k = 0; k < segments; k++) {
    need(2);
    const length = view.getUint16(at);
    at += 2;
    need(length);
    pathLive += length;
    at += length;
  }
  need(12);
  const queueCount = view.getUint32(at);
  const rangeCount = view.getUint32(at + 4);
  const factCount = view.getUint32(at + 8);
  at += 12;

  const stateLimit = (flags & FLAG_STATE_LIMIT) !== 0;
  if (stateLimit && queueCount !== 0) throw bad("a flagged state with lines pending");
  const queueAt = at;
  let pairs = 0;
  let previous: { generation: number; level: number; oid: number } | undefined;
  for (let k = 0; k < queueCount; k++) {
    need(QUEUE_RECORD);
    const generation = view.getUint32(at + OID_BYTES);
    const level = view.getUint32(at + OID_BYTES + 4);
    const count = view.getUint32(at + OID_BYTES + 8);
    if (count === 0) throw bad("a commit with no lines pending");
    if (count > MAX_BLAME_LINES) throw bad("too many pairs");
    if (previous) {
      const order =
        previous.generation - generation ||
        previous.level - level ||
        -compareBytes(
          bytes.subarray(previous.oid, previous.oid + OID_BYTES),
          bytes.subarray(at, at + OID_BYTES),
        );
      if (order <= 0) throw bad("queue out of order");
    }
    previous = { generation, level, oid: at };
    at += QUEUE_RECORD;
    need(count * 8);
    at += count * 8;
    pairs += count;
    if (pairs > MAX_BLAME_LINES) throw bad("too many pairs");
  }
  const rangesAt = at;
  if (rangeCount > MAX_BLAME_LINES) throw bad("too many ranges");
  need(rangeCount * RANGE_RECORD);
  at += rangeCount * RANGE_RECORD;
  if (factCount > MAX_BLAME_LINES) throw bad("too many facts");
  const factsAt = at;
  let textBytes = 0;
  for (let k = 0; k < factCount; k++) {
    need(OID_BYTES);
    at += OID_BYTES;
    for (let field = 0; field < FACT_FIELDS; field++) {
      need(2);
      const length = view.getUint16(at);
      at += 2;
      need(length);
      at += length;
      textBytes += length;
    }
  }
  if (at !== bytes.length) throw bad("bytes past the end");

  const live = liveBytesOf({
    path: pathLive,
    pairs,
    queue: queueCount,
    ranges: rangeCount,
    facts: factCount,
    factText: textBytes,
  });
  if (options.maxLiveStateBytes !== undefined && live > options.maxLiveStateBytes) {
    throw new BlameStateTooLarge(
      `a state of ${live} bytes doesn't fit ${options.maxLiveStateBytes}`,
    );
  }

  // Sound so far, and it fits: now it's built, checking that each line is told once.
  const seen = new Uint8Array(lines);
  const once = (line: number) => {
    if (line >= lines) throw bad("a line past the file");
    if (seen[line]) throw bad("a line told twice");
    seen[line] = 1;
  };
  const queue: PendingCommit[] = [];
  const hexes = new Set<string>();
  at = queueAt;
  for (let k = 0; k < queueCount; k++) {
    const oid = oidFromBytes(bytes.subarray(at, at + OID_BYTES));
    const hex = oidToHex(oid);
    if (hexes.has(hex)) throw bad("a commit twice in the queue");
    hexes.add(hex);
    const generation = view.getUint32(at + OID_BYTES);
    const level = view.getUint32(at + OID_BYTES + 4);
    const count = view.getUint32(at + OID_BYTES + 8);
    at += QUEUE_RECORD;
    const list = new Int32Array(count * 2);
    for (let p = 0; p < count; p++) {
      // From 0, and reported from 1: the last line a file can have is the limit less one.
      const current = view.getUint32(at);
      if (current >= MAX_BLAME_LINES) throw bad("a current line past any file");
      const final = view.getUint32(at + 4);
      once(final);
      list[2 * p] = current;
      list[2 * p + 1] = final;
      at += 8;
    }
    queue.push({ oid, generation, level, pairs: list });
  }
  const ranges = new Int32Array(rangeCount * 4);
  at = rangesAt;
  for (let k = 0; k < rangeCount; k++) {
    const start = view.getInt32(at);
    const count = view.getInt32(at + 4);
    const reference = view.getInt32(at + 8);
    const source = view.getInt32(at + 12);
    if (start < 0 || count < 1 || count > lines) throw bad("a range past the file");
    for (let line = start; line < start + count; line++) once(line);
    if (reference >= 0) {
      if (reference >= factCount) throw bad("a range of an unknown commit");
      if (source < 1 || source > MAX_BLAME_LINES - count + 1) throw bad("a range's source line");
    } else {
      if (-1 - reference >= UNRESOLVED_REASONS.length) throw bad("an unknown reason");
      if (source !== 0) throw bad("a refused range with a source line");
    }
    ranges.set([start, count, reference, source], 4 * k);
    at += RANGE_RECORD;
  }
  if (!stateLimit) {
    for (let line = 0; line < lines; line++) if (!seen[line]) throw bad("a line left out");
  }
  const facts: Record<string, BlameCommitInfo> = {};
  const factOrder: Oid[] = [];
  at = factsAt;
  const text = () => {
    const length = view.getUint16(at);
    at += 2;
    const field = bytes.subarray(at, at + length);
    at += length;
    try {
      return decoder.decode(field);
    } catch {
      throw bad("a commit's facts aren't UTF-8");
    }
  };
  for (let k = 0; k < factCount; k++) {
    const oid = oidFromBytes(bytes.subarray(at, at + OID_BYTES));
    const hex = oidToHex(oid);
    if (Object.hasOwn(facts, hex)) throw bad("a commit's facts twice");
    at += OID_BYTES;
    const summary = text();
    const name = text();
    const email = text();
    const date = text();
    facts[hex] = { summary, name, email, date };
    factOrder.push(oid);
  }
  // Each segment is a copy, so a short path never holds on to the checkpoint's bytes.
  const path: Uint8Array[] = [];
  at = pathAt;
  for (let k = 0; k < segments; k++) {
    const length = view.getUint16(at);
    path.push(new Uint8Array(bytes.subarray(at + 2, at + 2 + length)));
    at += 2 + length;
  }
  return {
    commit: oidFromBytes(commit),
    path,
    lines,
    steps,
    queue,
    ranges,
    rangeCount,
    facts,
    factOrder,
    stateLimit,
  };
}
