import { internLines, type Lines, splitLines } from "../diff/text.js";

/*
 * Lines up a parent's file with its child's the way the pinned oracle does,
 * or says it can't. The rules come from black-box experiments and git's user
 * documentation, each step in the order that reproduced them. Several give
 * "shortest edit" answers that a cleaner design would pick differently, and
 * those differences are the point: the search's tie-breaking, the crowded
 * lines it never sees, and the scan that scores slides are not transitive or
 * tidy. Change one and the frozen vectors fail.
 */

/** Rounds of one search before it's refused: past this the oracle's answer isn't known. */
export const MAX_SEARCH_ROUNDS = 256;
/** Work in one alignment: diagonals visited, lines followed, lines scored. */
export const MAX_ALIGN_WORK = 4_000_000;

const TAIL_BLOCK = 1024;
const CROWD_WALK = 100;
const CROWD_NEEDED = 7;
const CROWD_WEIGHT = 3;
const MAX_SLIDE_WINDOW = 100;
const BLANK_RUN = 20;
const MAX_SCORED_INDENT = 200;
const TAB = 8;
const INDENT_WEIGHT = 132;
/**
 * A comparison this near zero isn't trusted: every known miss was within 16 under the
 * figures before these. The figures are a fit, from black-box choices only.
 */
const CLOSE_CALL = 17;

const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const HTAB = 0x09;

export interface AlignLimits {
  readonly maxRounds: number;
  readonly maxWork: number;
}

const DEFAULT_LIMITS: AlignLimits = { maxRounds: MAX_SEARCH_ROUNDS, maxWork: MAX_ALIGN_WORK };

/** New-side lines `[start, end)`, from 0. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export type Alignment =
  | {
      readonly kind: "aligned";
      /** For each new line, the old line it's unchanged from, or -1. Lines in `unsettled` hold the scan's raw pick. */
      readonly oldOfNew: Int32Array;
      /** Lines whose answer wasn't settled: a close call, or an indentation past what's known. */
      readonly unsettled: readonly LineRange[];
      readonly work: number;
    }
  | {
      readonly kind: "refused";
      readonly reason: "diff_budget";
      /** Only what no alignment could change: the tail cut and the sealed common ends. Else -1. */
      readonly oldOfNew: Int32Array;
      readonly work: number;
    };

interface Side {
  readonly lines: Lines;
  readonly ids: Uint32Array;
  /** Lines after the tail cut. */
  readonly count: number;
  readonly changed: Uint8Array;
  /** Each line's indentation, computed when scored: 0 not yet, -1 blank, -2 too wide to read, else the indentation plus 1. */
  indents?: Int16Array;
}

class OverBudget extends Error {}

class Meter {
  spent = 0;
  readonly #max: number;
  constructor(max: number) {
    this.#max = max;
  }
  add(work: number): void {
    this.spent += work;
    if (this.spent > this.#max) throw new OverBudget();
  }
}

/** The bytes the tail cut removes from both files: a multiple of the block, given back to a line end. */
function tailCut(old: Uint8Array, new_: Uint8Array): number {
  const most = Math.min(old.length, new_.length);
  let common = 0;
  while (common < most && old[old.length - 1 - common] === new_[new_.length - 1 - common]) common++;
  const blocks = common - (common % TAIL_BLOCK);
  if (blocks === 0) return 0;
  // What's cut starts where the given-back bytes end, just past the first line feed after the cut.
  const cutAt = old.length - blocks;
  const lineEnd = old.indexOf(LF, cutAt);
  if (lineEnd < 0) return 0;
  return old.length - (lineEnd + 1);
}

function sideOf(lines: Lines, ids: Uint32Array, count: number): Side {
  return { lines, ids, count, changed: new Uint8Array(count) };
}

function smallestLimit(lineCount: number): number {
  let limit = 4;
  while (limit * limit <= lineCount) limit *= 2;
  return limit;
}

const GONE = 0;
const KEPT = 1;
const CROWDED = 2;

/**
 * Which lines of `x` between the common ends are searched, as line numbers.
 * The rest are marked changed: lines the other side lacks, and crowded lines
 * among those. A crowded line is given up when, walking up to 100 lines each
 * way and stopping at a line that's kept or at the common ends, it finds gone
 * lines on both sides, and enough of them for the crowded lines it passed.
 * Counted once per stretch between kept lines, so one line costs the same as
 * any other, and charged before it's done.
 */
function searchedLines(
  x: Side,
  y: Side,
  prefix: number,
  suffix: number,
  ids: number,
  meter: Meter,
): Int32Array {
  const from = prefix;
  const size = Math.max(0, x.count - suffix - from);
  meter.add(size);
  const counts = new Uint32Array(ids);
  for (let i = 0; i < y.count; i++)
    counts[y.ids[i] as number] = (counts[y.ids[i] as number] as number) + 1;
  const limit = smallestLimit(x.count);
  const classes = new Uint8Array(size);
  let anyCrowded = false;
  for (let i = 0; i < size; i++) {
    const count = counts[x.ids[from + i] as number] as number;
    if (count >= limit) anyCrowded = true;
    classes[i] = count === 0 ? GONE : count >= limit ? CROWDED : KEPT;
  }
  if (anyCrowded) meter.add(size);
  // How many gone lines come before each line of the stretch being looked at.
  const goneBefore = new Int32Array(anyCrowded ? size + 1 : 0);
  const searched = new Int32Array(size);
  let found = 0;
  for (let start = 0; start < size; ) {
    if (classes[start] === KEPT) {
      searched[found++] = from + start;
      start++;
      continue;
    }
    let end = start + 1;
    while (end < size && classes[end] !== KEPT) end++;
    if (anyCrowded) {
      goneBefore[start] = 0;
      for (let i = start; i < end; i++) {
        goneBefore[i + 1] = (goneBefore[i] as number) + (classes[i] === GONE ? 1 : 0);
      }
    }
    for (let i = start; i < end; i++) {
      if (classes[i] === CROWDED) {
        const low = Math.max(i - CROWD_WALK, start);
        const high = Math.min(i + CROWD_WALK + 1, end);
        const goneAbove = (goneBefore[i] as number) - (goneBefore[low] as number);
        const goneBelow = (goneBefore[high] as number) - (goneBefore[i + 1] as number);
        const passed = high - low - 1 - goneAbove - goneBelow;
        const givenUp =
          goneAbove > 0 &&
          goneBelow > 0 &&
          goneAbove + goneBelow >= CROWD_NEEDED + CROWD_WEIGHT * passed;
        if (!givenUp) {
          searched[found++] = from + i;
          continue;
        }
      }
      x.changed[from + i] = 1;
    }
    start = end;
  }
  return searched.subarray(0, found);
}

/**
 * The search over the two lists of searched lines: marks what's changed.
 * Linear-space shortest edit (Myers 1986, §4b). Its choices among equal
 * answers are the part that matters, and each has a witness in the vectors.
 */
function searchLists(
  x: Side,
  y: Side,
  oldList: Int32Array,
  newList: Int32Array,
  limits: AlignLimits,
  meter: Meter,
): void {
  const a = new Uint32Array(oldList.length);
  for (let i = 0; i < a.length; i++) a[i] = x.ids[oldList[i] as number] as number;
  const b = new Uint32Array(newList.length);
  for (let i = 0; i < b.length; i++) b[i] = y.ids[newList[i] as number] as number;
  // Indexed by diagonal from the range's own start, which a round moves by at most one.
  const span = 2 * (limits.maxRounds + 2) + 1;
  const forward = new Int32Array(span);
  const backward = new Int32Array(span);
  const stack: number[] = [0, a.length, 0, b.length];

  while (stack.length > 0) {
    let b1 = stack.pop() as number;
    let b0 = stack.pop() as number;
    let a1 = stack.pop() as number;
    let a0 = stack.pop() as number;
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
      a0++;
      b0++;
    }
    while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) {
      a1--;
      b1--;
    }
    meter.add(1);
    if (a0 === a1 || b0 === b1) {
      for (let i = a0; i < a1; i++) x.changed[oldList[i] as number] = 1;
      for (let i = b0; i < b1; i++) y.changed[newList[i] as number] = 1;
      continue;
    }
    const split = findSplit(a, b, a0, a1, b0, b1, forward, backward, limits, meter);
    stack.push(a0, split.x, b0, split.y, split.x, a1, split.y, b1);
  }
}

/** A search reached its round limit. */
export class RoundsReached extends Error {}

function findSplit(
  a: Uint32Array,
  b: Uint32Array,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  forward: Int32Array,
  backward: Int32Array,
  limits: AlignLimits,
  meter: Meter,
): { x: number; y: number } {
  const lowest = a0 - b1;
  const highest = a1 - b0;
  const fromStart = a0 - b0;
  const fromEnd = a1 - b1;
  const meetForward = ((fromStart - fromEnd) & 1) !== 0;
  const middle = (forward.length - 1) >> 1;
  const fAt = (k: number) => k - fromStart + middle;
  const bAt = (k: number) => k - fromEnd + middle;
  const NONE_BACK = 0x7fffffff;
  forward[fAt(fromStart)] = a0;
  backward[bAt(fromEnd)] = a1;
  forward[fAt(fromStart - 1)] = -1;
  forward[fAt(fromStart + 1)] = -1;
  backward[bAt(fromEnd - 1)] = NONE_BACK;
  backward[bAt(fromEnd + 1)] = NONE_BACK;
  let fMin = fromStart;
  let fMax = fromStart;
  let bMin = fromEnd;
  let bMax = fromEnd;

  for (let round = 1; ; round++) {
    if (round >= limits.maxRounds) throw new RoundsReached();
    // A frontier grows a diagonal each way until it reaches the range's corner, then shrinks there.
    if (fMin > lowest) {
      fMin--;
      forward[fAt(fMin - 1)] = -1;
    } else fMin++;
    if (fMax < highest) {
      fMax++;
      forward[fAt(fMax + 1)] = -1;
    } else fMax--;
    for (let k = fMax; k >= fMin; k -= 2) {
      const left = forward[fAt(k - 1)] as number;
      const right = forward[fAt(k + 1)] as number;
      let x = left >= right ? left + 1 : right;
      let y = x - k;
      const start = x;
      while (x < a1 && y < b1 && a[x] === b[y]) {
        x++;
        y++;
      }
      meter.add(1 + x - start);
      forward[fAt(k)] = x;
      if (meetForward && k >= bMin && k <= bMax && (backward[bAt(k)] as number) <= x) {
        return { x, y };
      }
    }
    if (bMin > lowest) {
      bMin--;
      backward[bAt(bMin - 1)] = NONE_BACK;
    } else bMin++;
    if (bMax < highest) {
      bMax++;
      backward[bAt(bMax + 1)] = NONE_BACK;
    } else bMax--;
    for (let k = bMax; k >= bMin; k -= 2) {
      const left = backward[bAt(k - 1)] as number;
      const right = backward[bAt(k + 1)] as number;
      let x = left < right ? left : right - 1;
      let y = x - k;
      const start = x;
      while (x > a0 && y > b0 && a[x - 1] === b[y - 1]) {
        x--;
        y--;
      }
      meter.add(1 + start - x);
      backward[bAt(k)] = x;
      if (!meetForward && k >= fMin && k <= fMax && x <= (forward[fAt(k)] as number)) {
        return { x, y };
      }
    }
  }
}

const BLANK = -1;
const WIDE = -2;

/**
 * A line's indentation, BLANK when it holds only spaces, tabs and carriage
 * returns, or WIDE when scoring can't read it: whitespace reaching 200 columns
 * on a blank line, over 200 on any other, or over 201 bytes of it. From there
 * the oracle's answers aren't known, and the rest of the line isn't read.
 */
function indentOf(side: Side, line: number, meter: Meter): number {
  side.indents ??= new Int16Array(side.count);
  const known = side.indents[line] as number;
  if (known !== 0) return known < 0 ? known : known - 1;
  const { bytes, starts } = side.lines;
  const start = starts[line] as number;
  const end = starts[line + 1] as number;
  const last = Math.min(end, start + MAX_SCORED_INDENT + 1);
  let column = 0;
  let at = start;
  let blank = true;
  for (; at < last; at++) {
    const byte = bytes[at];
    if (byte === SPACE) column++;
    else if (byte === HTAB) column += TAB - (column % TAB);
    else if (byte === CR) continue;
    else if (byte === LF) break;
    else {
      blank = false;
      break;
    }
  }
  meter.add(at - start);
  const unread = at === last && last < end;
  const wide = unread || (blank ? column >= MAX_SCORED_INDENT : column > MAX_SCORED_INDENT);
  const indent = wide ? WIDE : blank ? BLANK : column;
  side.indents[line] = indent < 0 ? indent : indent + 1;
  return indent;
}

const OVER = Number.MAX_SAFE_INTEGER;

interface SplitScore {
  readonly penalty: number;
  /** OVER when it would need an indentation past what's known. */
  readonly indent: number;
  /** All the split's figures are read from: two splits of one shape score alike, whatever the true weights. */
  readonly shape: number;
  /**
   * Its figures can't be trusted: it looked as far as a blank run counts, where they're off
   * by more than a close call, or it read a blank line 200 columns wide or more.
   */
  readonly unsure: boolean;
}

/** What a split looks like, as one number. Each indentation is at most 201, or absent. */
function shapeOf(
  above: number,
  below: number,
  pi: number | undefined,
  cur: number,
  qi: number | undefined,
  atStart: boolean,
  atEnd: boolean,
): number {
  const code = (indent: number | undefined) =>
    indent === undefined || indent < 0 ? 0 : indent + 1;
  const lines = (above * (BLANK_RUN + 1) + below) * 203 ** 3;
  return (
    (lines + code(pi) * 203 ** 2 + code(cur) * 203 + code(qi)) * 4 +
    (atStart ? 1 : 0) +
    (atEnd ? 2 : 0)
  );
}

/** The figures of the split just above line `s`. */
function scoreSplit(side: Side, s: number, meter: Meter): SplitScore {
  let penalty = 0;
  let above = 0;
  let wide = false;
  // A line too wide to read counts as a deep one, as before it was cut short, and makes the split unsure.
  const read = (at: number) => {
    const indent = indentOf(side, at, meter);
    if (indent !== WIDE) return indent;
    wide = true;
    return MAX_SCORED_INDENT + 1;
  };
  let pi: number | undefined;
  let line = s - 1;
  for (; line >= 0 && above < BLANK_RUN; line--) {
    const indent = read(line);
    if (indent >= 0) {
      pi = indent;
      break;
    }
    above++;
  }
  // Past the run's limit, whatever is above counts as indented 0.
  if (above >= BLANK_RUN && pi === undefined) pi = 0;
  penalty -= 61 * above;
  if (s === 0) penalty += 10;
  if (s >= side.count) {
    return {
      penalty,
      indent: -1,
      shape: shapeOf(above, 0, pi, -1, undefined, s === 0, true),
      unsure: above >= BLANK_RUN || wide,
    };
  }

  const cur = read(s);
  let below = 0;
  let qi: number | undefined;
  for (line = s + 1; line < side.count && below < BLANK_RUN; line++) {
    const indent = read(line);
    if (indent >= 0) {
      qi = indent;
      break;
    }
    below++;
  }
  if (below >= BLANK_RUN && qi === undefined) qi = 0;
  meter.add(1);
  // What's below a line that isn't blank plays no part in its figures.
  const shape =
    cur < 0
      ? shapeOf(above, below, pi, cur, qi, s === 0, false)
      : shapeOf(above, 0, pi, cur, undefined, s === 0, false);
  const unsure = above >= BLANK_RUN || below >= BLANK_RUN || wide;

  if (cur < 0) {
    penalty -= 49 * (1 + below);
    if (qi === undefined) return { penalty: penalty + 2, indent: -1, shape, unsure };
    if (qi > MAX_SCORED_INDENT) return { penalty, indent: OVER, shape, unsure };
    if (pi !== undefined) {
      if (pi > MAX_SCORED_INDENT) return { penalty, indent: OVER, shape, unsure };
      if (qi > pi) penalty += 7;
      else if (qi < pi) penalty += 36;
    }
    return { penalty, indent: qi, shape, unsure };
  }
  if (cur > MAX_SCORED_INDENT || (pi !== undefined && pi > MAX_SCORED_INDENT)) {
    return { penalty, indent: OVER, shape, unsure };
  }
  if (pi !== undefined) {
    if (cur > pi) penalty += above > 0 ? 14 : -12;
    else if (cur < pi) penalty += above > 0 ? 33 : 48;
  }
  return { penalty, indent: cur, shape, unsure };
}

interface Refused {
  /** The lines the group could cover, over its slide range. */
  readonly start: number;
  readonly end: number;
  /** Unchanged lines above the group, at its highest and lowest positions. */
  readonly aboveFrom: number;
  readonly aboveTo: number;
}

/** Moves the changed marks of one side, group by group, and says which groups were close calls. */
function slideSide(
  x: Side,
  other: ReadonlySet<number>,
  spoiled: readonly Refused[],
  meter: Meter,
): Refused[] {
  const { ids, changed, count } = x;
  const refused: Refused[] = [];
  // Groups come in order on both sides, so the first refusal still ahead only moves on.
  let nextSpoiled = 0;
  let joined: Set<number> | undefined;
  let at = 0;
  // Unchanged lines above `at`.
  let unchanged = 0;
  while (at < count) {
    if (!changed[at]) {
      at++;
      unchanged++;
      continue;
    }
    let s = at;
    let e = at + 1;
    while (e < count && changed[e]) e++;
    let above = unchanged;
    let topEnd: number;
    let size: number;
    do {
      size = e - s;
      while (s > 0 && ids[s - 1] === ids[e - 1]) {
        changed[--s] = 1;
        changed[--e] = 0;
        above--;
        while (s > 0 && changed[s - 1]) s--;
        meter.add(1);
      }
      topEnd = e;
      while (e < count && ids[e] === ids[s]) {
        changed[s++] = 0;
        changed[e++] = 1;
        above++;
        while (e < count && changed[e]) e++;
        meter.add(1);
      }
    } while (e - s !== size);

    size = e - s;
    const bottomEnd = e;
    const aboveAt = (end: number) => above - (bottomEnd - end);
    const slideRange = { start: topEnd - size, end: bottomEnd };
    let pick = bottomEnd;
    let close = false;
    if (topEnd !== bottomEnd) {
      let opposite = -1;
      for (let end = bottomEnd; end >= topEnd; end--) {
        if (other.has(aboveAt(end))) {
          opposite = end;
          break;
        }
      }
      if (opposite >= 0) pick = opposite;
      else {
        const scored = scanCandidates(x, size, topEnd, bottomEnd, meter);
        pick = scored.pick;
        close = scored.close;
      }
    }
    const fromAbove = aboveAt(topEnd);
    const toAbove = aboveAt(bottomEnd);
    while (nextSpoiled < spoiled.length && (spoiled[nextSpoiled] as Refused).aboveTo < fromAbove) {
      nextSpoiled++;
    }
    const reached = spoiled[nextSpoiled];
    const here = { ...slideRange, aboveFrom: fromAbove, aboveTo: toAbove };
    // A pick that isn't settled decides how far the next group slides, and whether they join.
    // Apart, a part of it could slide over any line that's the same as a line of either.
    const previous = refused[refused.length - 1];
    if (previous !== undefined && slideRange.start <= previous.end) {
      const start = Math.min(previous.start, here.start);
      let end = Math.max(previous.end, here.end);
      meter.add(end - start);
      if (joined === undefined) {
        joined = new Set();
        for (let line = start; line < end; line++) joined.add(ids[line] as number);
      } else {
        for (let line = here.start; line < here.end; line++) joined.add(ids[line] as number);
      }
      const reachedEnd = end;
      while (end < count && joined.has(ids[end] as number)) end++;
      meter.add(end - reachedEnd);
      refused[refused.length - 1] = {
        start,
        end,
        aboveFrom: Math.min(previous.aboveFrom, here.aboveFrom),
        aboveTo: Math.max(previous.aboveTo, here.aboveTo) + (end - reachedEnd),
      };
    } else if (close || (reached !== undefined && reached.aboveFrom <= toAbove)) {
      refused.push(here);
      joined = undefined;
    }
    // Back up from the bottom to the pick.
    while (e > pick) {
      changed[--s] = 1;
      changed[--e] = 0;
      above--;
    }
    unchanged = above;
    at = e;
  }
  return refused;
}

/**
 * Picks a position by scanning from the highest allowed to the lowest, keeping
 * a best. The comparison isn't transitive, so the order is part of the rule.
 * The penalties are fitted, so a comparison near zero isn't trusted, nor an
 * exact tie, unless the two positions look alike and can't but tie.
 */
function scanCandidates(
  x: Side,
  size: number,
  topEnd: number,
  bottomEnd: number,
  meter: Meter,
): { pick: number; close: boolean } {
  const reach = Math.min(size + 1, MAX_SLIDE_WINDOW);
  const first = Math.max(topEnd, bottomEnd - reach);
  let best = bottomEnd;
  let bestPenalty = 0;
  let bestIndent = 0;
  let bestTop = 0;
  let bestBottom = 0;
  let has = false;
  let close = false;
  for (let end = first; end <= bottomEnd; end++) {
    const top = scoreSplit(x, end - size, meter);
    const bottom = scoreSplit(x, end, meter);
    if (top.indent === OVER || bottom.indent === OVER) close = true;
    if (top.unsure || bottom.unsure) close = true;
    const penalty = top.penalty + bottom.penalty;
    const indent =
      (top.indent === OVER ? 0 : top.indent) + (bottom.indent === OVER ? 0 : bottom.indent);
    let replaces = !has;
    if (has) {
      const difference = penalty - bestPenalty + INDENT_WEIGHT * Math.sign(indent - bestIndent);
      const alike = top.shape === bestTop && bottom.shape === bestBottom;
      if (Math.abs(difference) < CLOSE_CALL && !alike) close = true;
      replaces = difference <= 0;
    }
    has = true;
    if (replaces) {
      best = end;
      bestPenalty = penalty;
      bestIndent = indent;
      bestTop = top.shape;
      bestBottom = bottom.shape;
    }
  }
  return { pick: best, close };
}

/** Unchanged lines above each group of a side. */
function groupsAbove(side: Side): Set<number> {
  const out = new Set<number>();
  let unchanged = 0;
  for (let i = 0; i < side.count; i++) {
    if (!side.changed[i]) {
      unchanged++;
      continue;
    }
    if (i === 0 || !side.changed[i - 1]) out.add(unchanged);
  }
  return out;
}

interface Prepared {
  readonly old: Side;
  readonly new: Side;
  readonly oldLines: Lines;
  readonly newLines: Lines;
  readonly prefix: number;
  readonly suffix: number;
  readonly ids: number;
  readonly tailLines: number;
}

function prepare(oldBytes: Uint8Array, newBytes: Uint8Array): Prepared {
  const cut = tailCut(oldBytes, newBytes);
  const oldLines = splitLines(oldBytes, Number.MAX_SAFE_INTEGER) as Lines;
  const newLines = splitLines(newBytes, Number.MAX_SAFE_INTEGER) as Lines;
  const { a, b } = internLines(oldLines, newLines);
  let tailLines = 0;
  if (cut > 0) {
    const from = oldBytes.length - cut;
    for (let i = from; i < oldBytes.length; i++) if (oldBytes[i] === LF) tailLines++;
    if (oldBytes[oldBytes.length - 1] !== LF) tailLines++;
  }
  const old = sideOf(oldLines, a, oldLines.count - tailLines);
  const new_ = sideOf(newLines, b, newLines.count - tailLines);
  let prefix = 0;
  const most = Math.min(old.count, new_.count);
  while (prefix < most && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < most - prefix && a[old.count - 1 - suffix] === b[new_.count - 1 - suffix])
    suffix++;
  let ids = 0;
  for (let i = 0; i < a.length; i++) ids = Math.max(ids, (a[i] as number) + 1);
  for (let i = 0; i < b.length; i++) ids = Math.max(ids, (b[i] as number) + 1);
  return { old, new: new_, oldLines, newLines, prefix, suffix, ids, tailLines };
}

function pairedLines(p: Prepared): Int32Array {
  const out = new Int32Array(p.newLines.count).fill(-1);
  let oldLine = 0;
  for (let line = 0; line < p.new.count; line++) {
    if (p.new.changed[line]) continue;
    while (oldLine < p.old.count && p.old.changed[oldLine]) oldLine++;
    out[line] = oldLine++;
  }
  const shift = p.old.count - p.new.count;
  for (let line = p.new.count; line < p.newLines.count; line++) out[line] = line + shift;
  return out;
}

/** The tail cut's pairs, and the common ends only where a line no slide can pass seals them. */
function certainLines(p: Prepared): Int32Array {
  const out = new Int32Array(p.newLines.count).fill(-1);
  const shift = p.old.count - p.new.count;
  for (let line = p.new.count; line < p.newLines.count; line++) out[line] = line + shift;
  const oldCount = new Uint32Array(p.ids);
  const newCount = new Uint32Array(p.ids);
  for (let i = 0; i < p.old.count; i++)
    oldCount[p.old.ids[i] as number] = (oldCount[p.old.ids[i] as number] as number) + 1;
  for (let i = 0; i < p.new.count; i++)
    newCount[p.new.ids[i] as number] = (newCount[p.new.ids[i] as number] as number) + 1;
  const once = (id: number) => oldCount[id] === 1 && newCount[id] === 1;
  // Sealed up to the line nearest the middle that occurs once in each file.
  for (let line = p.prefix - 1; line >= 0; line--) {
    if (!once(p.new.ids[line] as number)) continue;
    for (let k = 0; k <= line; k++) out[k] = k;
    break;
  }
  for (let back = p.suffix - 1; back >= 0; back--) {
    const line = p.new.count - 1 - back;
    if (!once(p.new.ids[line] as number)) continue;
    for (let k = line; k < p.new.count; k++) out[k] = k + shift;
    break;
  }
  return out;
}

/** Searches and slides, marking both sides. Throws when the search can't finish. */
function run(p: Prepared, limits: AlignLimits, meter: Meter): { old: Refused[]; new: Refused[] } {
  const oldList = searchedLines(p.old, p.new, p.prefix, p.suffix, p.ids, meter);
  const newList = searchedLines(p.new, p.old, p.prefix, p.suffix, p.ids, meter);
  searchLists(p.old, p.new, oldList, newList, limits, meter);
  const oldRefused = slideSide(p.old, groupsAbove(p.new), [], meter);
  const newRefused = slideSide(p.new, groupsAbove(p.old), oldRefused, meter);
  return { old: oldRefused, new: newRefused };
}

/** The new lines a refusal reaches, merged: those it covers on the new side, and those pairing into it on the old. */
function unsettledLines(
  p: Prepared,
  oldOfNew: Int32Array,
  refused: { old: readonly Refused[]; new: readonly Refused[] },
): LineRange[] {
  const marks = new Uint8Array(p.new.count + 1);
  for (const { start, end } of refused.new) marks.fill(1, start, end);
  if (refused.old.length > 0) {
    const inOld = new Uint8Array(p.old.count);
    for (const { start, end } of refused.old) inOld.fill(1, start, end);
    for (let line = 0; line < p.new.count; line++) {
      const old = oldOfNew[line] as number;
      if (old >= 0 && inOld[old]) marks[line] = 1;
    }
  }
  const out: LineRange[] = [];
  for (let line = 0; line < p.new.count; line++) {
    if (!marks[line]) continue;
    const start = line;
    while (marks[line]) line++;
    out.push({ start, end: line });
  }
  return out;
}

/** The oracle's alignment where it can be settled, or a refusal. */
export function alignFiles(
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  limits: AlignLimits = DEFAULT_LIMITS,
): Alignment {
  // A search sizes its vectors by the round limit and stops only at a limit, so a limit
  // that isn't a whole number in range would size them wrong or never stop it.
  const { maxRounds, maxWork } = limits;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_SEARCH_ROUNDS) {
    throw new RangeError(`bad round limit ${maxRounds}`);
  }
  if (!Number.isSafeInteger(maxWork) || maxWork < 0) {
    throw new RangeError(`bad work limit ${maxWork}`);
  }
  const p = prepare(oldBytes, newBytes);
  const meter = new Meter(maxWork);
  try {
    const refused = run(p, limits, meter);
    const oldOfNew = pairedLines(p);
    return {
      kind: "aligned",
      oldOfNew,
      unsettled: unsettledLines(p, oldOfNew, refused),
      work: meter.spent,
    };
  } catch (error) {
    if (error instanceof RoundsReached || error instanceof OverBudget) {
      return {
        kind: "refused",
        reason: "diff_budget",
        oldOfNew: certainLines(p),
        work: meter.spent,
      };
    }
    throw error;
  }
}

/**
 * The pick before any close-call refusal, for checking the scan against the
 * oracle. Throws for a search that reaches its round limit: no pick exists.
 */
export function scanAlignment(
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
): { oldOfNew: Int32Array } {
  const p = prepare(oldBytes, newBytes);
  const limits = { maxRounds: MAX_SEARCH_ROUNDS, maxWork: Number.MAX_SAFE_INTEGER };
  run(p, limits, new Meter(limits.maxWork));
  return { oldOfNew: pairedLines(p) };
}
