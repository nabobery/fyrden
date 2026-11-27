import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  anchorAt,
  anchoredTop,
  autoOpen,
  flatLayout,
  flatOfKey,
  keyOf,
  MAX_SPACER_PX,
  reconcileOpen,
  rowRanges,
  type Segment,
  scrollGeometry,
  segmentsOf,
  visibleWindow,
} from "../app/lib/log-window.js";

const ROW = 20;

describe("segmentsOf", () => {
  it("covers the log with the steps' ranges and the rows between them", () => {
    const segments = segmentsOf(
      [
        { number: 1, from: 0, rows: 3 },
        { number: 2, from: 5, rows: 2 },
      ],
      10,
    );
    expect(segments.map((s) => [s.step, s.from, s.rows])).toEqual([
      [1, 0, 3],
      [null, 3, 2],
      [2, 5, 2],
      [null, 7, 3],
    ]);
  });

  it("clips a range past the log's end, cuts overlaps, and keeps an empty step's header", () => {
    const segments = segmentsOf(
      [
        { number: 2, from: 4, rows: 10 },
        { number: 1, from: 0, rows: 6 },
        { number: 3, from: 8, rows: 0 },
      ],
      8,
    );
    expect(segments.map((s) => [s.step, s.from, s.rows])).toEqual([
      [1, 0, 4],
      [2, 4, 4],
      [3, 8, 0],
    ]);
  });

  it("is one unnamed segment without steps", () => {
    expect(segmentsOf([], 5)).toEqual([{ step: null, from: 0, rows: 5 }]);
    expect(segmentsOf([], 0)).toEqual([]);
  });

  it("covers every row exactly once, for any steps", () => {
    const steps = fc.array(
      fc.record({ number: fc.nat(300), from: fc.nat(2_000), rows: fc.nat(2_000) }),
      { maxLength: 256 },
    );
    fc.assert(
      fc.property(steps, fc.nat(3_000), (s, total) => {
        const segments = segmentsOf(s, total);
        expect(segments.length).toBeLessThanOrEqual(513);
        let at = 0;
        for (const seg of segments) {
          expect(seg.from).toBe(at);
          at += seg.rows;
        }
        expect(at).toBe(total);
      }),
    );
  });
});

describe("flatLayout", () => {
  const segments: Segment[] = [
    { step: 1, from: 0, rows: 3 },
    { step: null, from: 3, rows: 2 },
    { step: 2, from: 5, rows: 4 },
  ];

  it("puts a header before each step and its rows after when open", () => {
    const layout = flatLayout(segments, new Set([1]));
    expect(layout.count).toBe(1 + 3 + 2 + 1);
    expect([0, 1, 2, 3, 4, 5, 6].map((f) => layout.at(f))).toEqual([
      { kind: "header", segment: 0, step: 1 },
      { kind: "row", row: 0 },
      { kind: "row", row: 1 },
      { kind: "row", row: 2 },
      { kind: "row", row: 3 },
      { kind: "row", row: 4 },
      { kind: "header", segment: 2, step: 2 },
    ]);
    expect(layout.flatOf(4)).toBe(5);
    expect(layout.flatOf(6)).toBeNull();
  });

  it("maps rows and flat positions both ways, for any folding", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.constantFrom(1, 2)), (open) => {
        const layout = flatLayout(segments, new Set(open));
        for (let f = 0; f < layout.count; f++) {
          const item = layout.at(f);
          if (item?.kind === "row") expect(layout.flatOf(item.row)).toBe(f);
        }
        expect(layout.at(layout.count)).toBeNull();
      }),
    );
  });
});

describe("rows, headers and keys", () => {
  const segments: Segment[] = [
    { step: 1, from: 0, rows: 3 },
    { step: null, from: 3, rows: 2 },
    { step: 2, from: 5, rows: 100_000 },
    { step: 3, from: 100_005, rows: 4 },
  ];

  it("finds a step's header and the step a row belongs to", () => {
    const layout = flatLayout(segments, new Set([3]));
    expect(layout.headerOf(1)).toBe(0);
    expect(layout.headerOf(2)).toBe(3);
    expect(layout.headerOf(3)).toBe(4);
    expect(layout.headerOf(9)).toBeNull();
    expect(layout.stepOf(1)).toBe(1);
    expect(layout.stepOf(4)).toBeNull();
    expect(layout.stepOf(50_000)).toBe(2);
    expect(layout.stepOf(100_006)).toBe(3);
  });

  it("gives the visible rows as separate ranges, never the folded rows between them", () => {
    const layout = flatLayout(segments, new Set([1, 3]));
    expect(rowRanges(layout, 0, layout.count)).toEqual([
      [0, 5],
      [100_005, 100_009],
    ]);
    expect(rowRanges(layout, 4, 6)).toEqual([[3, 5]]);
    expect(rowRanges(flatLayout(segments, new Set()), 0, 4)).toEqual([[3, 5]]);
  });

  it("finds an item again by its key after folding, a folded row by its step's header", () => {
    const open = flatLayout(segments, new Set([1, 2]));
    const row = open.at(open.flatOf(40) as number);
    expect(row && keyOf(row)).toBe("r40");
    const header = open.at(open.headerOf(3) as number);
    expect(header && keyOf(header)).toBe("h3");
    const folded = flatLayout(segments, new Set([2]));
    expect(flatOfKey(folded, "r40")).toBe(folded.flatOf(40));
    expect(flatOfKey(folded, "h3")).toBe(folded.headerOf(3));
    const closed = flatLayout(segments, new Set());
    expect(flatOfKey(closed, "r40")).toBe(closed.headerOf(2));
    expect(flatOfKey(closed, "r4")).toBe(2);
  });

  it("keeps the row at the top in place when a step above it folds", () => {
    const before = flatLayout(segments, new Set([1, 2]));
    const top = (before.flatOf(5_000) as number) * ROW + 7;
    const anchor = anchorAt(before, top, ROW);
    expect(anchor).toEqual({ key: "r5000", offset: 7 });
    const after = flatLayout(segments, new Set([2]));
    expect(anchoredTop(after, anchor, ROW)).toBe((after.flatOf(5_000) as number) * ROW + 7);
    expect(anchoredTop(after, null, ROW)).toBeNull();
  });
});

describe("which steps are open", () => {
  const step = (number: number, status: string, conclusion: string | null, logged = true) => ({
    number,
    status,
    conclusion,
    logged,
  });

  it("opens failed and current steps, or a job's only step with rows", () => {
    expect(autoOpen([step(1, "completed", "success"), step(2, "completed", "failure")])).toEqual([
      2,
    ]);
    expect(autoOpen([step(1, "completed", "success"), step(2, "in_progress", null)])).toEqual([2]);
    expect(
      autoOpen([step(1, "completed", "success"), step(2, "completed", "success", false)]),
    ).toEqual([1, 2]);
    expect(autoOpen([step(1, "completed", "success"), step(2, "completed", "success")])).toEqual(
      [],
    );
  });

  it("opens a step that becomes current or fails, unless the viewer folded it", () => {
    const first = new Set(autoOpen([step(1, "in_progress", null), step(2, "queued", null)]));
    expect([...first]).toEqual([1]);
    const later = [step(1, "completed", "success"), step(2, "in_progress", null)];
    expect([...reconcileOpen(first, new Set(), later)].sort()).toEqual([1, 2]);
    expect([...reconcileOpen(new Set(), new Set([2]), later)]).toEqual([]);
    const same = new Set([2]);
    expect(reconcileOpen(same, new Set(), later)).toBe(same);
  });
});

describe("scrollGeometry", () => {
  it("is the identity under the spacer's cap", () => {
    const g = scrollGeometry(100_000, ROW, 600);
    expect(g.spacerPx).toBe(2_000_000);
    expect(g.logicalTop(1234)).toBe(1234);
    expect(g.physicalTop(1234)).toBe(1234);
  });

  it("reaches the last row when the spacer is capped", () => {
    const viewport = 600;
    const g = scrollGeometry(5_000_000, ROW, viewport);
    expect(g.spacerPx).toBe(MAX_SPACER_PX);
    const bottom = g.logicalTop(MAX_SPACER_PX - viewport);
    expect(bottom).toBe(5_000_000 * ROW - viewport);
    const w = visibleWindow(bottom, viewport, ROW, 5_000_000, 0);
    expect(w.last).toBe(5_000_000);
    expect(g.physicalTop(bottom)).toBeCloseTo(MAX_SPACER_PX - viewport, 6);
  });

  it("maps top, middle and bottom back and forth", () => {
    const viewport = 600;
    const g = scrollGeometry(5_000_000, ROW, viewport);
    for (const top of [0, (MAX_SPACER_PX - viewport) / 2, MAX_SPACER_PX - viewport])
      expect(g.physicalTop(g.logicalTop(top))).toBeCloseTo(top, 6);
  });
});

describe("visibleWindow", () => {
  it("is the rows in view and the overscan around them", () => {
    expect(visibleWindow(0, 600, ROW, 100_000, 30)).toEqual({ first: 0, last: 60 });
    expect(visibleWindow(20_000, 600, ROW, 100_000, 30)).toEqual({ first: 970, last: 1060 });
    expect(visibleWindow(1_999_400, 600, ROW, 100_000, 30)).toEqual({
      first: 99_940,
      last: 100_000,
    });
  });

  it("is empty for no rows, and clamped past the end", () => {
    expect(visibleWindow(0, 600, ROW, 0, 30)).toEqual({ first: 0, last: 0 });
    expect(visibleWindow(9e9, 600, ROW, 10, 30)).toEqual({ first: 0, last: 10 });
  });

  it("holds a bounded number of rows whatever the log's size", () => {
    fc.assert(
      fc.property(fc.nat(10_000_000), fc.integer({ min: 1, max: 5_000 }), (rows, top) => {
        const w = visibleWindow(top * ROW, 900, ROW, rows, 30);
        expect(w.last - w.first).toBeLessThanOrEqual(Math.ceil(900 / ROW) + 1 + 60);
        expect(w.first).toBeGreaterThanOrEqual(0);
        expect(w.last).toBeLessThanOrEqual(rows);
      }),
    );
  });
});
