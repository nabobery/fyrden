export interface StepRange {
  readonly number: number;
  readonly from: number;
  readonly rows: number;
}

/** A step's rows of the log (`step` its number), or rows outside every step (`step` null). */
export interface Segment {
  readonly step: number | null;
  readonly from: number;
  readonly rows: number;
}

/**
 * The log's `total` rows split by the steps' ranges: ranges clipped to the
 * log, sorted, each cut where the next one starts, and the rows between
 * them as unnamed segments; a step with no rows keeps its own segment.
 */
export function segmentsOf(steps: readonly StepRange[], total: number): Segment[] {
  const sorted = [...steps].sort((a, b) => a.from - b.from || a.number - b.number);
  const clip = (n: number) => Math.min(Math.max(n, 0), total);
  const out: Segment[] = [];
  let at = 0;
  for (let k = 0; k < sorted.length; k++) {
    const step = sorted[k] as StepRange;
    const start = Math.max(clip(step.from), at);
    const next = sorted[k + 1];
    const end = Math.max(
      start,
      Math.min(clip(step.from + step.rows), next ? clip(next.from) : total),
    );
    if (start > at) out.push({ step: null, from: at, rows: start - at });
    out.push({ step: step.number, from: start, rows: end - start });
    at = end;
  }
  if (at < total) out.push({ step: null, from: at, rows: total - at });
  return out;
}

export type FlatItem =
  | { readonly kind: "header"; readonly segment: number; readonly step: number }
  | { readonly kind: "row"; readonly row: number };

export interface FlatLayout {
  readonly count: number;
  at(flat: number): FlatItem | null;
  /** Where `row` is drawn, or null while its step is folded. */
  flatOf(row: number): number | null;
  headerOf(step: number): number | null;
  stepOf(row: number): number | null;
}

function lastAtOrBefore(starts: readonly number[], value: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The drawn list: each step's header, then its rows when it is open; rows outside steps always. */
export function flatLayout(segments: readonly Segment[], open: ReadonlySet<number>): FlatLayout {
  const starts: number[] = [];
  const froms = segments.map((s) => s.from);
  const headers = new Map<number, number>();
  let count = 0;
  for (const segment of segments) {
    starts.push(count);
    if (segment.step !== null) headers.set(segment.step, count);
    count += segment.step === null ? segment.rows : 1 + (open.has(segment.step) ? segment.rows : 0);
  }
  const segmentOf = (row: number): number | null => {
    if (segments.length === 0) return null;
    const k = lastAtOrBefore(froms, row);
    const segment = segments[k] as Segment;
    return row >= segment.from && row < segment.from + segment.rows ? k : null;
  };
  return {
    count,
    at(flat) {
      if (flat < 0 || flat >= count || segments.length === 0) return null;
      const k = lastAtOrBefore(starts, flat);
      const segment = segments[k] as Segment;
      const offset = flat - (starts[k] as number);
      if (segment.step === null) return { kind: "row", row: segment.from + offset };
      return offset === 0
        ? { kind: "header", segment: k, step: segment.step }
        : { kind: "row", row: segment.from + offset - 1 };
    },
    flatOf(row) {
      const k = segmentOf(row);
      if (k === null) return null;
      const segment = segments[k] as Segment;
      const start = starts[k] as number;
      if (segment.step === null) return start + row - segment.from;
      return open.has(segment.step) ? start + 1 + row - segment.from : null;
    },
    headerOf(step) {
      return headers.get(step) ?? null;
    },
    stepOf(row) {
      const k = segmentOf(row);
      return k === null ? null : (segments[k] as Segment).step;
    },
  };
}

/** The rows drawn in flat positions `[first, last)`, as ranges of consecutive rows. */
export function rowRanges(
  layout: FlatLayout,
  first: number,
  last: number,
): (readonly [number, number])[] {
  const ranges: [number, number][] = [];
  for (let f = first; f < last; f++) {
    const item = layout.at(f);
    if (item?.kind !== "row") continue;
    const open = ranges.at(-1);
    if (open && open[1] === item.row) open[1] = item.row + 1;
    else ranges.push([item.row, item.row + 1]);
  }
  return ranges;
}

export type ItemKey = `h${number}` | `r${number}`;

export function keyOf(item: FlatItem): ItemKey {
  return item.kind === "header" ? `h${item.step}` : `r${item.row}`;
}

/** Where the item `key` is drawn in `layout`; a row folded away gives its step's header. */
export function flatOfKey(layout: FlatLayout, key: ItemKey): number | null {
  const n = Number(key.slice(1));
  if (key.startsWith("h")) return layout.headerOf(n);
  const flat = layout.flatOf(n);
  if (flat !== null) return flat;
  const step = layout.stepOf(n);
  return step === null ? null : layout.headerOf(step);
}

export interface Anchor {
  readonly key: ItemKey;
  readonly offset: number;
}

export function anchorAt(layout: FlatLayout, top: number, rowPx: number): Anchor | null {
  const flat = Math.floor(top / rowPx);
  const item = layout.at(flat);
  return item ? { key: keyOf(item), offset: top - flat * rowPx } : null;
}

export function anchoredTop(
  layout: FlatLayout,
  anchor: Anchor | null,
  rowPx: number,
): number | null {
  if (anchor === null) return null;
  const flat = flatOfKey(layout, anchor.key);
  return flat === null ? null : flat * rowPx + anchor.offset;
}

export interface StepState {
  readonly number: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly logged: boolean;
}

/** The steps open by default: failed and current ones, else every step when at most one has rows. */
export function autoOpen(steps: readonly StepState[]): number[] {
  const wanted = steps.filter((s) => s.conclusion === "failure" || s.status === "in_progress");
  if (wanted.length > 0) return wanted.map((s) => s.number);
  return steps.filter((s) => s.logged).length <= 1 ? steps.map((s) => s.number) : [];
}

/** `open` with the steps now open by default added, except those the viewer folded or opened by hand. */
export function reconcileOpen(
  open: ReadonlySet<number>,
  touched: ReadonlySet<number>,
  steps: readonly StepState[],
): ReadonlySet<number> {
  const added = autoOpen(steps).filter((n) => !open.has(n) && !touched.has(n));
  return added.length === 0 ? open : new Set([...open, ...added]);
}

/**
 * The tallest spacer drawn. Proposed. Chrome and Safari lay elements out up to
 * about 33,554,400 px, Firefox only up to 8,947,840 px in Meyer's test
 * (verified: https://meyerweb.com/eric/thoughts/2025/08/07/infinite-pixels/);
 * Firefox has refused far smaller heights than Chrome before (verified:
 * https://bugzilla.mozilla.org/show_bug.cgi?id=1379760). Kept under the
 * lowest of them; drawing it in Firefox is unverified.
 */
export const MAX_SPACER_PX = 8_000_000;

export interface ScrollGeometry {
  readonly spacerPx: number;
  logicalTop(physicalTop: number): number;
  physicalTop(logicalTop: number): number;
}

/**
 * The spacer for `count` rows of `rowPx`, and the maps between the
 * scroller's physical offset and the list's logical one: the identity while
 * the list fits under `MAX_SPACER_PX`, else linear over the scrollable
 * ranges, so the last row is reached when the scroller is at its end.
 */
export function scrollGeometry(count: number, rowPx: number, viewportPx: number): ScrollGeometry {
  const logical = count * rowPx;
  if (logical <= MAX_SPACER_PX || viewportPx >= MAX_SPACER_PX)
    return { spacerPx: logical, logicalTop: (p) => p, physicalTop: (l) => l };
  const physicalRange = MAX_SPACER_PX - viewportPx;
  const logicalRange = logical - viewportPx;
  return {
    spacerPx: MAX_SPACER_PX,
    logicalTop: (p) => (p * logicalRange) / physicalRange,
    physicalTop: (l) => (l * physicalRange) / logicalRange,
  };
}

export interface Window {
  readonly first: number;
  readonly last: number;
}

/** The flat positions `[first, last)` to draw for a logical scroll offset, with `overscan` either side. */
export function visibleWindow(
  logicalTop: number,
  viewportPx: number,
  rowPx: number,
  count: number,
  overscan: number,
): Window {
  if (count === 0) return { first: 0, last: 0 };
  const inView = Math.ceil(viewportPx / rowPx);
  let first = Math.max(0, Math.floor(logicalTop / rowPx) - overscan);
  if (first >= count) first = Math.max(0, count - inView - overscan);
  const last = Math.min(count, Math.ceil((logicalTop + viewportPx) / rowPx) + overscan);
  return { first, last: Math.max(first, last) };
}
