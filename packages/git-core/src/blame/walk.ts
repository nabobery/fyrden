import { GitObjectError } from "../object/fsck.js";
import { type Oid, oidToHex } from "../object/oid.js";
import { PackError } from "../pack/errors.js";
import { ReaderWorkSpent } from "../reader/errors.js";
import { type AlignLimits, alignFiles, MAX_ALIGN_WORK, MAX_SEARCH_ROUNDS } from "./align.js";
import { removals, renameCheckBudget } from "./removals.js";
import {
  type BlameCommitInfo,
  type BlameState,
  encodedBytesOf,
  factFitsCheckpoint,
  factTextOf,
  liveBytesOf,
  MAX_BLAME_LINES,
  MAX_STATE_BYTES,
  type PendingCommit,
  pathLiveBytes,
  pendingPairs,
  UNRESOLVED_REASONS,
  type UnresolvedReason,
} from "./state.js";

export type { BlameCommitInfo } from "./state.js";

export const BLAME_ENGINE_VERSION = 1;
export const MAX_BLAME_FILE_BYTES = 1024 * 1024;

/** What the engine reads a history through: the only port it sees. */
export interface BlameSource {
  /** Undefined for a commit the graph doesn't have. `parents` is "too_many" past the limit, with none materialized. */
  commit(oid: Oid): Promise<
    | {
        readonly tree: Oid;
        readonly parents: readonly Oid[] | "too_many";
        readonly generation: number;
        readonly level: number;
      }
    | undefined
  >;
  /** The file of `kind` at a path in a tree, or null: a directory, a submodule, or nothing there. */
  fileAt(
    tree: Oid,
    path: readonly Uint8Array[],
  ): Promise<{ readonly oid: Oid; readonly kind: "file" | "symlink" } | null>;
  /** The bytes, or "too_large" with no body read. */
  blob(oid: Oid, maxBytes: number): Promise<Uint8Array | "too_large">;
  commitInfo(oid: Oid): Promise<BlameCommitInfo>;
  /** A tree's body, or "too_large" with no body read. Throws `BlameObjectUnreadable` if it's missing or not a tree. */
  tree(oid: Oid, maxBytes: number): Promise<Uint8Array | "too_large">;
}

/** A source's calls ran out. With `ReaderWorkSpent`, this is what a slice's budget ending looks like. */
export class BlameReadsSpent extends Error {
  override name = "BlameReadsSpent";
}

/** An object no pack holds, or one that doesn't parse: it will fail the same way every time. */
export class BlameObjectUnreadable extends Error {
  override name = "BlameObjectUnreadable";
}

export interface BlameSliceLimits {
  readonly maxSteps: number;
  /** Engine work, checked between steps, so a slice's first step always finishes. */
  readonly maxWork: number;
  readonly maxBlameSteps: number;
  readonly maxEncodedBytes: number;
  readonly maxLiveStateBytes: number;
  readonly maxFileBytes: number;
  readonly maxFileLines: number;
  readonly align: AlignLimits;
  /**
   * Whether a step beginning now has a whole request's reads and decoding work
   * untouched. Only such a step can be called too large for its budget.
   */
  readonly stepIsFresh: () => boolean;
}

export const DEFAULT_BLAME_SLICE: Omit<BlameSliceLimits, "stepIsFresh"> = {
  maxSteps: 256,
  // Proposed. Deployed rates put a slice doing the worst of everything at about 12 s. The
  // largest slice on four real files took 3.27M, and a heavier one only ends sooner.
  maxWork: 8_000_000,
  maxBlameSteps: 30_000,
  maxEncodedBytes: MAX_STATE_BYTES,
  maxLiveStateBytes: 8 * 1024 * 1024,
  maxFileBytes: MAX_BLAME_FILE_BYTES,
  maxFileLines: MAX_BLAME_LINES,
  align: { maxRounds: MAX_SEARCH_ROUNDS, maxWork: MAX_ALIGN_WORK },
};

/**
 * What a request may spend decoding objects, for the reader's work meter. Weights
 * make a unit about 3.3 ns of the worst primitive tried, deployed in one colo, and a
 * delta program's byte twice its measured cost: deployed, resets followed dense
 * deltas, and not whole-object reads. Two depth-50 chains of a 3.48 MiB tree fit,
 * twice in a row, without one. Resets weren't avoided by a lower limit either: they
 * come and go. Proposed: docs/testing.md has the measurements.
 */
export const BLAME_DECODING_WORK = {
  limit: 512 * 1024 * 1024,
  weights: { "delta-program": 30, "tree-scan": 3 },
} as const;

export type BlameStartFailure = {
  readonly failure: "commit_missing" | "path_not_found" | "file_too_large" | "state_too_large";
};

export interface BlameAdvance {
  readonly steps: number;
  /** "budget": reads or decoding work ran out, and the step was undone. */
  readonly stop: "done" | "slice" | "budget";
  /** Engine work this slice spent. */
  readonly work: number;
}

export type BlameRange =
  | {
      readonly startLine: number;
      readonly lineCount: number;
      readonly commit: Oid;
      readonly sourceStartLine: number;
    }
  | {
      readonly startLine: number;
      readonly lineCount: number;
      readonly unresolved: UnresolvedReason;
    };

function countLines(bytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) count++;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) count++;
  return count;
}

/**
 * The caller's line limit, held to what a checkpoint can record, so every state
 * decodes again. Only a positive whole number is a limit: NaN compares false
 * with every count, so it would let any file through.
 */
function fileLineLimit(asked = MAX_BLAME_LINES): number {
  if (!Number.isInteger(asked) || asked < 1) throw new RangeError(`bad line limit ${asked}`);
  return Math.min(asked, MAX_BLAME_LINES);
}

/**
 * The caller's encoded state limit, held to what a checkpoint can record, so
 * every state decodes again. Only a positive whole number is a limit: NaN
 * compares false with every size, so it would let any state through.
 */
function encodedStateLimit(asked: number): number {
  if (!Number.isInteger(asked) || asked < 1) {
    throw new RangeError(`bad encoded state limit ${asked}`);
  }
  return Math.min(asked, MAX_STATE_BYTES);
}

const sameOid = (a: Oid, b: Oid) => {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
};

/**
 * A state with every line pending at `commit`. Reads the starting file, so what
 * a source throws here is the caller's to answer: there's no line to mark yet.
 */
export async function startBlame(
  source: BlameSource,
  commit: Oid,
  path: readonly Uint8Array[],
  options: {
    readonly maxFileBytes?: number;
    readonly maxFileLines?: number;
    readonly maxLiveStateBytes?: number;
  } = {},
): Promise<BlameState | BlameStartFailure> {
  const lineLimit = fileLineLimit(options.maxFileLines);
  const info = await source.commit(commit);
  if (!info) return { failure: "commit_missing" };
  const file = await source.fileAt(info.tree, path);
  if (!file) return { failure: "path_not_found" };
  const maxBytes = options.maxFileBytes ?? MAX_BLAME_FILE_BYTES;
  const bytes = await source.blob(file.oid, maxBytes);
  if (bytes === "too_large") return { failure: "file_too_large" };
  const lines = countLines(bytes);
  if (lines > lineLimit) return { failure: "file_too_large" };
  const live = liveBytesOf({
    path: pathLiveBytes(path),
    pairs: lines,
    // An empty file has no line to queue.
    queue: lines === 0 ? 0 : 1,
    ranges: 0,
    facts: 0,
    factText: 0,
  });
  if (live > (options.maxLiveStateBytes ?? Number.POSITIVE_INFINITY)) {
    return { failure: "state_too_large" };
  }
  const pairs = new Int32Array(lines * 2);
  for (let line = 0; line < lines; line++) {
    pairs[2 * line] = line;
    pairs[2 * line + 1] = line;
  }
  return {
    commit,
    path,
    lines,
    steps: 0,
    queue:
      lines === 0 ? [] : [{ oid: commit, generation: info.generation, level: info.level, pairs }],
    ranges: new Int32Array(0),
    rangeCount: 0,
    facts: {},
    factOrder: [],
    stateLimit: false,
  };
}

/** What one commit step would do, applied only once all of it is known. */
interface Staged {
  /** Pairs going to each parent, by hex id. */
  readonly passes: Map<string, { oid: Oid; generation: number; level: number; pairs: number[] }>;
  /** Lines this commit settled as its own: pairs. */
  readonly own: number[];
  /** Lines given up on, by reason: final lines. */
  readonly refused: Map<UnresolvedReason, number[]>;
  fact?: BlameCommitInfo;
}

const newStaged = (): Staged => ({ passes: new Map(), own: [], refused: new Map() });

function refuse(staged: Staged, reason: UnresolvedReason, final: number): void {
  const list = staged.refused.get(reason);
  if (list) list.push(final);
  else staged.refused.set(reason, [final]);
}

function terminal(entry: PendingCommit, reason: UnresolvedReason): Staged {
  const staged = newStaged();
  for (let k = 0; k < entry.pairs.length; k += 2)
    refuse(staged, reason, entry.pairs[k + 1] as number);
  return staged;
}

/** Runs one commit step, reading and aligning, and changes nothing. */
async function runStep(
  entry: PendingCommit,
  state: BlameState,
  source: BlameSource,
  limits: BlameSliceLimits,
  spend: (work: number) => void,
): Promise<Staged> {
  const info = await source.commit(entry.oid);
  if (!info) return terminal(entry, "history_missing");
  if (info.parents === "too_many") return terminal(entry, "too_many_parents");
  const file = await source.fileAt(info.tree, state.path);
  if (!file) return terminal(entry, "history_unreadable");

  // Each parent, in order. A file of this kind there that's identical takes every line, and no
  // diff runs: git looks for one across all parents before anything else, renames included.
  const parents: {
    oid: Oid;
    generation: number;
    level: number;
    tree: Oid;
    blob: Oid | undefined;
  }[] = [];
  for (const parent of info.parents) {
    const parentInfo = await source.commit(parent);
    // It might itself have been identical, so nothing can be decided past it.
    if (!parentInfo) return terminal(entry, "history_missing");
    const parentFile = await source.fileAt(parentInfo.tree, state.path);
    const present = parentFile !== null && parentFile.kind === file.kind;
    if (present && sameOid(parentFile.oid, file.oid)) {
      const staged = newStaged();
      staged.passes.set(oidToHex(parent), {
        oid: parent,
        generation: parentInfo.generation,
        level: parentInfo.level,
        pairs: Array.from(entry.pairs),
      });
      spend(entry.pairs.length / 2);
      return staged;
    }
    parents.push({
      oid: parent,
      generation: parentInfo.generation,
      level: parentInfo.level,
      tree: parentInfo.tree,
      blob: present ? parentFile.oid : undefined,
    });
  }

  // Git follows a whole-file rename into a path a parent has no file of this kind at,
  // from a path that parent's change removes. Lines are passed on or settled only where
  // no rename could take them: before the first parent with a removal (the barrier),
  // and only when no parent could hold an identical copy under another name, which
  // would take every line. A check the budget can't finish rules nothing out.
  const budget = renameCheckBudget();
  let barrier = parents.length;
  let presentBefore = false;
  for (let k = 0; k < parents.length; k++) {
    const parent = parents[k] as (typeof parents)[number];
    if (parent.blob) {
      presentBefore = true;
      continue;
    }
    if (!presentBefore) {
      // Nothing before it can keep a line: any removal refuses the step.
      const found = await removals(source, parent.tree, info.tree, undefined, budget, spend);
      if (found !== "none") return terminal(entry, "rename_possible");
      continue;
    }
    const found = await removals(source, parent.tree, info.tree, file.oid, budget, spend);
    if (found === "identical" || found === "unknown") return terminal(entry, "rename_possible");
    if (found === "some" && barrier === parents.length) barrier = k;
  }

  const staged = newStaged();
  let left: number[] = Array.from(entry.pairs);
  spend(left.length / 2);
  // Parents with a file of this kind before the barrier, in order: the only ones diffed.
  const diffed = parents
    .slice(0, barrier)
    .filter((p): p is (typeof parents)[number] & { blob: Oid } => p.blob !== undefined);
  if (diffed.length > 0) {
    const child = await source.blob(file.oid, limits.maxFileBytes);
    if (child === "too_large") return terminal(entry, "parent_too_large");
    const childLines = countLines(child);
    const aligned = new Set<string>();
    for (const parent of diffed) {
      if (left.length === 0) break;
      // A second parent with this blob could take nothing the first left.
      const blobHex = oidToHex(parent.blob);
      if (aligned.has(blobHex)) continue;
      aligned.add(blobHex);
      const before = await source.blob(parent.blob, limits.maxFileBytes);
      const beforeLines = before === "too_large" ? 0 : countLines(before);
      if (before === "too_large" || beforeLines > fileLineLimit(limits.maxFileLines)) {
        for (let k = 0; k < left.length; k += 2)
          refuse(staged, "parent_too_large", left[k + 1] as number);
        left = [];
        break;
      }
      spend(Math.floor((before.length + child.length) / 8) + beforeLines + childLines);
      const alignment = alignFiles(before, child, limits.align);
      spend(alignment.work);
      const pass = passesTo(staged, parent);
      const next: number[] = [];
      if (alignment.kind === "refused") {
        // Only what no alignment could change goes on. The rest stops here, not at a later parent.
        for (let k = 0; k < left.length; k += 2) {
          const line = left[k] as number;
          const final = left[k + 1] as number;
          const old = alignment.oldOfNew[line] as number;
          if (old >= 0) pass.pairs.push(old, final);
          else refuse(staged, alignment.reason, final);
        }
      } else {
        const unsettled = new Uint8Array(childLines);
        for (const { start, end } of alignment.unsettled) unsettled.fill(1, start, end);
        for (let k = 0; k < left.length; k += 2) {
          const line = left[k] as number;
          const final = left[k + 1] as number;
          if (unsettled[line]) {
            refuse(staged, "slide_unsettled", final);
            continue;
          }
          const old = alignment.oldOfNew[line] as number;
          if (old >= 0) pass.pairs.push(old, final);
          else next.push(line, final);
        }
      }
      if (pass.pairs.length === 0) staged.passes.delete(oidToHex(parent.oid));
      left = next;
    }
  }
  if (barrier < parents.length) {
    // What the parents before the barrier didn't take, a rename from it could have.
    for (let k = 0; k < left.length; k += 2)
      refuse(staged, "rename_possible", left[k + 1] as number);
    return staged;
  }
  if (left.length > 0) {
    const fact = await source.commitInfo(entry.oid);
    // Refused whole rather than cut: git shows the whole field, and a cut one would disagree.
    if (!factFitsCheckpoint(fact)) {
      for (let k = 0; k < left.length; k += 2)
        refuse(staged, "commit_info_too_large", left[k + 1] as number);
      return staged;
    }
    for (const value of left) staged.own.push(value);
    staged.fact = fact;
  }
  return staged;
}

function passesTo(
  staged: Staged,
  parent: { oid: Oid; generation: number; level: number },
): { pairs: number[] } {
  const hex = oidToHex(parent.oid);
  let pass = staged.passes.get(hex);
  if (!pass) {
    pass = { oid: parent.oid, generation: parent.generation, level: parent.level, pairs: [] };
    staged.passes.set(hex, pass);
  }
  return pass;
}

/** What a failed read means for the step, or undefined when it isn't the walk's to handle. */
function classify(error: unknown): "budget" | UnresolvedReason | undefined {
  if (error instanceof BlameReadsSpent || error instanceof ReaderWorkSpent) return "budget";
  // A tree the rename check can't parse: the engine reads those itself.
  if (error instanceof BlameObjectUnreadable || error instanceof GitObjectError)
    return "history_unreadable";
  if (error instanceof PackError) {
    if (error.code === "object-too-large") return "object_limit";
    if (error.code === "delta-too-deep") return "work_limit";
    return "history_unreadable";
  }
  return undefined;
}

const reasonCode = (reason: UnresolvedReason) => -1 - UNRESOLVED_REASONS.indexOf(reason);

function compareQueue(
  a: PendingCommit,
  b: { oid: Oid; generation: number; level: number },
): number {
  const order = b.generation - a.generation || b.level - a.level;
  if (order !== 0) return order;
  for (let k = 0; k < a.oid.length; k++) {
    const difference = (a.oid[k] as number) - (b.oid[k] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Ranges of one step, in final-line order: runs of consecutive lines with consecutive sources. */
function ownRanges(pairs: readonly number[], commit: number): number[] {
  const order: number[] = [];
  for (let k = 0; k < pairs.length; k += 2) order.push(k);
  order.sort((a, b) => (pairs[a + 1] as number) - (pairs[b + 1] as number));
  const out: number[] = [];
  let k = 0;
  while (k < order.length) {
    const at = order[k] as number;
    const final = pairs[at + 1] as number;
    const current = pairs[at] as number;
    let count = 1;
    while (
      k + count < order.length &&
      pairs[(order[k + count] as number) + 1] === final + count &&
      pairs[order[k + count] as number] === current + count
    )
      count++;
    out.push(final, count, commit, current + 1);
    k += count;
  }
  return out;
}

function refusedRanges(finals: readonly number[], reason: UnresolvedReason): number[] {
  const sorted = [...finals].sort((a, b) => a - b);
  const out: number[] = [];
  let k = 0;
  while (k < sorted.length) {
    const final = sorted[k] as number;
    let count = 1;
    while (sorted[k + count] === final + count) count++;
    out.push(final, count, reasonCode(reason), 0);
    k += count;
  }
  return out;
}

function appendRanges(state: BlameState, records: readonly number[]): void {
  const needed = state.rangeCount * 4 + records.length;
  if (needed > state.ranges.length) {
    const grown = new Int32Array(Math.max(needed, state.ranges.length * 2, 64));
    grown.set(state.ranges.subarray(0, state.rangeCount * 4));
    state.ranges = grown;
  }
  state.ranges.set(records, state.rangeCount * 4);
  state.rangeCount += records.length / 4;
}

/** Running totals, so a long walk's steps don't each recount the state. */
interface Totals {
  pairs: number;
  factText: number;
}
const totals = new WeakMap<BlameState, Totals>();

function totalsOf(state: BlameState): Totals {
  let known = totals.get(state);
  if (!known) {
    let factText = 0;
    for (const fact of Object.values(state.facts)) factText += factTextOf(fact);
    known = { pairs: pendingPairs(state), factText };
    totals.set(state, known);
  }
  return known;
}

/** Where a commit is in the queue, or where it would go. */
function queueSearch(
  queue: readonly PendingCommit[],
  commit: { oid: Oid; generation: number; level: number },
): { at: number; found: boolean } {
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const order = compareQueue(queue[mid] as PendingCommit, commit);
    if (order === 0) return { at: mid, found: true };
    if (order < 0) lo = mid + 1;
    else hi = mid;
  }
  return { at: lo, found: false };
}

/**
 * Applies a step in one synchronous update, unless the result wouldn't fit:
 * then the state takes its one flag, which needs no room.
 */
function apply(
  state: BlameState,
  entry: PendingCommit,
  staged: Staged,
  limits: BlameSliceLimits,
): void {
  const hex = oidToHex(entry.oid);
  const known = hex in state.facts;
  const factIndex = known
    ? state.factOrder.findIndex((oid) => oidToHex(oid) === hex)
    : state.factOrder.length;
  const records = staged.own.length > 0 ? ownRanges(staged.own, factIndex) : [];
  for (const [reason, finals] of staged.refused) {
    for (const value of refusedRanges(finals, reason)) records.push(value);
  }

  let passed = 0;
  let newEntries = 0;
  for (const pass of staged.passes.values()) {
    passed += pass.pairs.length / 2;
    if (!queueSearch(state.queue, pass).found) newEntries++;
  }
  const addFact = staged.fact !== undefined && !known;
  const running = totalsOf(state);
  const counts = {
    path: pathLiveBytes(state.path),
    pairs: running.pairs - entry.pairs.length / 2 + passed,
    queue: state.queue.length - 1 + newEntries,
    ranges: state.rangeCount + records.length / 4,
    facts: state.factOrder.length + (addFact ? 1 : 0),
    factText: running.factText + (addFact ? factTextOf(staged.fact as BlameCommitInfo) : 0),
  };
  if (
    liveBytesOf(counts) > limits.maxLiveStateBytes ||
    encodedBytesOf(state, counts) > encodedStateLimit(limits.maxEncodedBytes)
  ) {
    state.stateLimit = true;
    state.queue = [];
    running.pairs = 0;
    return;
  }

  state.queue.shift();
  for (const pass of staged.passes.values()) mergePass(state, pass);
  running.pairs = counts.pairs;
  running.factText = counts.factText;
  if (addFact) {
    state.facts[hex] = staged.fact as BlameCommitInfo;
    state.factOrder.push(entry.oid);
  }
  appendRanges(state, records);
}

function mergePass(
  state: BlameState,
  pass: { oid: Oid; generation: number; level: number; pairs: number[] },
): void {
  const { at, found } = queueSearch(state.queue, pass);
  if (found) {
    const queued = state.queue[at] as PendingCommit;
    const pairs = new Int32Array(queued.pairs.length + pass.pairs.length);
    pairs.set(queued.pairs);
    pairs.set(pass.pairs, queued.pairs.length);
    state.queue[at] = { ...queued, pairs };
    return;
  }
  state.queue.splice(at, 0, {
    oid: pass.oid,
    generation: pass.generation,
    level: pass.level,
    pairs: Int32Array.from(pass.pairs),
  });
}

/** What's pending, given up on all at once: the whole blame's step limit. */
function refuseEverything(
  state: BlameState,
  reason: UnresolvedReason,
  limits: BlameSliceLimits,
): void {
  const staged = newStaged();
  for (const entry of state.queue) {
    for (let k = 0; k < entry.pairs.length; k += 2)
      refuse(staged, reason, entry.pairs[k + 1] as number);
  }
  const records = refusedRanges(staged.refused.get(reason) ?? [], reason);
  const counts = {
    path: pathLiveBytes(state.path),
    pairs: 0,
    queue: 0,
    ranges: state.rangeCount + records.length / 4,
    facts: state.factOrder.length,
    factText: totalsOf(state).factText,
  };
  totalsOf(state).pairs = 0;
  if (
    liveBytesOf(counts) > limits.maxLiveStateBytes ||
    encodedBytesOf(state, counts) > encodedStateLimit(limits.maxEncodedBytes)
  ) {
    state.stateLimit = true;
    state.queue = [];
    return;
  }
  state.queue = [];
  appendRanges(state, records);
}

/**
 * Walks whole commit steps until the slice's limits or the end of history. A
 * step's reads can stop it partway, and then the state is as it was. A failure
 * that isn't a limit or lasting corruption throws, state unchanged. A state is
 * advanced by one call at a time; a second while one runs is refused.
 */
export async function advanceBlame(
  state: BlameState,
  source: BlameSource,
  limits: BlameSliceLimits,
): Promise<BlameAdvance> {
  fileLineLimit(limits.maxFileLines);
  encodedStateLimit(limits.maxEncodedBytes);
  // Two at once would both apply the step at the head of the queue.
  if (advancing.has(state)) throw new Error("a blame state is already being advanced");
  advancing.add(state);
  try {
    return await advance(state, source, limits);
  } finally {
    advancing.delete(state);
  }
}

/** States an `advanceBlame` call is walking now. */
const advancing = new WeakSet<BlameState>();

async function advance(
  state: BlameState,
  source: BlameSource,
  limits: BlameSliceLimits,
): Promise<BlameAdvance> {
  let steps = 0;
  let work = 0;
  const spend = (units: number) => {
    work += units;
  };
  for (;;) {
    const entry = state.queue[0];
    if (!entry) return { steps, stop: "done", work };
    if (state.steps >= limits.maxBlameSteps) {
      refuseEverything(state, "history_limit", limits);
      return { steps, stop: "done", work };
    }
    if (steps >= limits.maxSteps || (steps > 0 && work >= limits.maxWork)) {
      return { steps, stop: "slice", work };
    }
    const fresh = limits.stepIsFresh();
    let staged: Staged;
    try {
      staged = await runStep(entry, state, source, limits, spend);
    } catch (error) {
      const outcome = classify(error);
      if (outcome === undefined) throw error;
      if (outcome === "budget") {
        if (!fresh) return { steps, stop: "budget", work };
        staged = terminal(entry, "work_limit");
      } else {
        staged = terminal(entry, outcome);
      }
    }
    apply(state, entry, staged, limits);
    state.steps++;
    steps++;
  }
}

/**
 * Settled ranges from `offset`, oldest first, then, for a state that took its
 * flag, the lines nothing settled.
 */
export function blameRanges(state: BlameState, offset: number, limit: number): BlameRange[] {
  const out: BlameRange[] = [];
  let k = offset;
  for (; k < state.rangeCount && out.length < limit; k++) {
    const start = state.ranges[4 * k] as number;
    const count = state.ranges[4 * k + 1] as number;
    const reference = state.ranges[4 * k + 2] as number;
    if (reference >= 0) {
      out.push({
        startLine: start + 1,
        lineCount: count,
        commit: state.factOrder[reference] as Oid,
        sourceStartLine: state.ranges[4 * k + 3] as number,
      });
    } else {
      out.push({
        startLine: start + 1,
        lineCount: count,
        unresolved: UNRESOLVED_REASONS[-1 - reference] as UnresolvedReason,
      });
    }
  }
  if (!state.stateLimit || out.length >= limit) return out;
  const settled = new Uint8Array(state.lines);
  for (let r = 0; r < state.rangeCount; r++) {
    const start = state.ranges[4 * r] as number;
    settled.fill(1, start, start + (state.ranges[4 * r + 1] as number));
  }
  let derived = state.rangeCount;
  for (let line = 0; line < state.lines && out.length < limit; line++) {
    if (settled[line]) continue;
    const start = line;
    while (line < state.lines && !settled[line]) line++;
    if (derived++ >= offset) {
      out.push({ startLine: start + 1, lineCount: line - start, unresolved: "state_limit" });
    }
  }
  return out;
}
