import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DISPLAY_CUT_UNITS, LogStore } from "../app/lib/log-store.js";

const whole = (i: number, c = `row ${i}`) => ({ i, t: 1, c });

describe("LogStore", () => {
  it("keeps whole rows and omissions, and grows with what it receives", () => {
    const store = new LogStore();
    store.applyPage({
      rows: [whole(0), { i: 1, omitted: "row_too_large", bytes: 9 }],
      state: "streaming",
      end: 5,
      next: "c",
    });
    expect(store.row(0)).toEqual({ kind: "whole", t: 1, c: "row 0", cut: false });
    expect(store.row(1)).toEqual({ kind: "omitted", bytes: 9 });
    expect(store.length).toBe(5);
    store.applyLive([whole(7)]);
    expect(store.length).toBe(8);
    expect(store.missing(0, 8)).toBe(2);
  });

  it("joins a row's pieces in order, and refuses a piece out of order", () => {
    const store = new LogStore();
    store.applyLive([{ i: 0, t: 5, c: "ab", o: 0, end: false }]);
    expect(store.row(0)).toMatchObject({ kind: "prefix", c: "ab" });
    store.applyLive([{ i: 0, t: null, c: "zz", o: 7, end: true }]);
    expect(store.row(0)).toMatchObject({ kind: "prefix", c: "ab" });
    store.applyLive([{ i: 0, t: null, c: "cd", o: 2, end: true }]);
    expect(store.row(0)).toEqual({ kind: "whole", t: 5, c: "abcd", cut: false });
  });

  it("keeps a tail read's last piece as a suffix", () => {
    const store = new LogStore();
    store.applyPage({
      rows: [{ i: 9, t: null, c: "end", o: 400, end: true }],
      state: "complete",
      end: 10,
      next: null,
    });
    expect(store.row(9)).toEqual({ kind: "suffix", t: null, c: "end", o: 400 });
    expect(store.closed).toBe(true);
  });

  it("stops assembling a row at the display cut", () => {
    const store = new LogStore();
    store.applyLive([{ i: 0, t: 1, c: "x".repeat(DISPLAY_CUT_UNITS - 1), o: 0, end: false }]);
    store.applyLive([{ i: 0, t: 1, c: "yy", o: DISPLAY_CUT_UNITS - 1, end: false }]);
    expect(store.row(0)).toMatchObject({ kind: "prefix", cut: true });
    expect((store.row(0) as { c: string }).c.length).toBe(DISPLAY_CUT_UNITS);
    expect(store.wantsMoreOf(0)).toBe(false);
  });

  it("never lowers its extents, and a terminal end wins over a later page", () => {
    const store = new LogStore();
    store.applyLive(Array.from({ length: 55 }, (_, i) => whole(i)));
    store.applyTerminal(50, "complete");
    store.applyPage({ rows: [], state: "streaming", end: 40, next: "c" });
    expect(store.durable).toBe(50);
    expect(store.state).toBe("complete");
    expect(store.closed).toBe(true);
    expect(store.length).toBe(55);
    expect(store.notStored(52)).toBe(true);
    expect(store.notStored(49)).toBe(false);
  });

  it("treats a log as open while a page gives a cursor, even when incomplete", () => {
    const store = new LogStore();
    store.applyPage({ rows: [], state: "incomplete", end: 3, next: "c" });
    expect(store.closed).toBe(false);
    store.applyPage({ rows: [], state: "incomplete", end: 3, next: null });
    expect(store.closed).toBe(true);
  });

  it("drops unfinished pieces at and after a reconnect's start", () => {
    const store = new LogStore();
    store.applyLive([whole(0), { i: 1, t: 1, c: "half", o: 0, end: false }]);
    store.dropUnfinishedFrom(1);
    expect(store.row(1)).toBeUndefined();
    expect(store.row(0)).toBeDefined();
  });

  it("keeps its text within its bound, evicting rows far from the window", () => {
    const store = new LogStore({ maxUnits: 10_000, maxRows: 1_000_000 });
    store.focus([[0, 10]]);
    for (let k = 0; k < 50; k++) store.applyLive([whole(k * 1_024, "z".repeat(1_000))]);
    expect(store.units).toBeLessThanOrEqual(10_000);
    expect(store.row(0)).toBeDefined();
    expect(store.row(49 * 1_024)).toBeUndefined();
  });

  it("forgets a row discarded unfinished, so a terminal end leaves the log at its durable rows", () => {
    const store = new LogStore();
    store.applyLive(Array.from({ length: 5 }, (_, i) => whole(i)));
    store.applyLive([{ i: 5, t: 1, c: "half", o: 0, end: false }]);
    expect(store.length).toBe(6);
    store.dropUnfinishedFrom(5);
    store.applyTerminal(5, "complete");
    expect(store.row(5)).toBeUndefined();
    expect(store.length).toBe(5);
    expect(store.notStored(4)).toBe(false);
  });

  it("keeps the rows received when a reconnect drops nothing", () => {
    const store = new LogStore();
    store.applyLive(Array.from({ length: 5 }, (_, i) => whole(i)));
    store.dropUnfinishedFrom(3);
    expect(store.length).toBe(5);
  });

  it("draws every kind of row up to the display cut, a suffix by its end", () => {
    const store = new LogStore();
    const long = "a".repeat(DISPLAY_CUT_UNITS) + "b".repeat(5);
    store.applyLive([whole(0, long)]);
    expect(store.row(0)).toEqual({
      kind: "whole",
      t: 1,
      c: long.slice(0, DISPLAY_CUT_UNITS),
      cut: true,
    });
    store.applyPage({
      rows: [{ i: 1, t: null, c: long, o: 400, end: true }],
      state: "complete",
      end: 2,
      next: null,
    });
    expect(store.row(1)).toEqual({ kind: "suffix", t: null, c: long.slice(5), o: 405 });
    expect(store.units).toBe(2 * DISPLAY_CUT_UNITS);
    expect(store.wantsMoreOf(0)).toBe(false);
  });

  it("keeps a whole row that ends past the cut when a reconnect drops unfinished rows", () => {
    const store = new LogStore();
    store.applyLive([{ i: 0, t: 1, c: "x".repeat(DISPLAY_CUT_UNITS + 1), o: 0, end: true }]);
    store.dropUnfinishedFrom(0);
    expect(store.row(0)).toMatchObject({ kind: "whole", cut: true });
  });

  it("holds its bound even when the rows in view and their block are dense", () => {
    const store = new LogStore({ maxUnits: 100_000, maxRows: 1_000_000 });
    store.focus([
      [0, 10],
      [500, 510],
    ]);
    store.applyLive(Array.from({ length: 1_024 }, (_, i) => whole(i, "d".repeat(1_000))));
    expect(store.units).toBeLessThanOrEqual(100_000);
    for (const i of [0, 9, 500, 509]) expect(store.row(i)).toBeDefined();
    expect(store.row(1_023)).toBeUndefined();
  });

  it("holds its row bound when the followed tail alone is over it", () => {
    const store = new LogStore({ maxUnits: 1_000_000, maxRows: 100 });
    store.focus([[0, 10]]);
    store.follow(true);
    store.applyLive(Array.from({ length: 1_000 }, (_, i) => whole(i)));
    expect(store.row(5)).toBeDefined();
    expect(store.row(999)).toBeDefined();
    expect(store.row(700)).toBeUndefined();
    let held = 0;
    for (let i = 0; i < 1_000; i++) if (store.row(i)) held += 1;
    expect(held).toBeLessThanOrEqual(100);
  });

  it("protects only the rows in view, not the folded rows between them", () => {
    const store = new LogStore({ maxUnits: 1_000_000, maxRows: 40 });
    store.focus([
      [0, 10],
      [5_000, 5_010],
    ]);
    store.applyLive(Array.from({ length: 5_010 }, (_, i) => whole(i)));
    expect(store.row(0)).toBeDefined();
    expect(store.row(5_009)).toBeDefined();
    expect(store.row(2_500)).toBeUndefined();
  });

  it("keeps a followed log's tail", () => {
    const store = new LogStore({ maxUnits: 5_000, maxRows: 1_000_000 });
    store.focus([[0, 10]]);
    store.follow(true);
    for (let k = 0; k < 20; k++) store.applyLive([whole(k * 1_024, "z".repeat(1_000))]);
    expect(store.row(19 * 1_024)).toBeDefined();
  });

  it("finds the first missing row of any range", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.nat(300)), fc.nat(300), fc.nat(300), (have, a, b) => {
        const store = new LogStore();
        store.applyLive(have.map((i) => whole(i)));
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const expected = Array.from({ length: hi - lo }, (_, k) => lo + k).find(
          (i) => !have.includes(i),
        );
        expect(store.missing(lo, hi)).toBe(expected ?? null);
      }),
    );
  });

  it("keeps a jump's target row when the store is full", () => {
    const store = new LogStore({ maxRows: 1_000 });
    store.focus([[0, 90]]);
    store.applyLive(Array.from({ length: 1_000 }, (_, i) => whole(i)));
    store.focus([...store.focused(), [999_999, 1_000_000]]);
    store.applyPage({ rows: [whole(999_999)], state: "complete", end: 1_000_000, next: null });
    expect(store.row(999_999)).toBeDefined();
    expect(store.row(5)).toBeDefined();
  });

  it("never splits a surrogate pair at the display cut", () => {
    const store = new LogStore();
    const emoji = "\u{1F600}";
    store.applyLive([{ i: 0, t: 1, c: `${"a".repeat(DISPLAY_CUT_UNITS - 1)}${emoji}tail` }]);
    const head = store.row(0) as { c: string };
    expect(head.c.length).toBe(DISPLAY_CUT_UNITS - 1);
    expect(head.c.endsWith("a")).toBe(true);
    const long = `x${emoji}${"b".repeat(DISPLAY_CUT_UNITS - 1)}`;
    store.applyPage({
      rows: [{ i: 1, t: null, c: long, o: 50, end: true }],
      state: "complete",
      end: 2,
      next: null,
    });
    const tail = store.row(1) as { c: string; o: number };
    expect(tail.c).toBe("b".repeat(DISPLAY_CUT_UNITS - 1));
    expect(tail.o).toBe(50 + 3);
  });

  it("keeps a longer prefix when an older, shorter piece replays from the start", () => {
    const store = new LogStore();
    store.applyLive([{ i: 0, t: 1, c: "ab", o: 0, end: false }]);
    store.applyLive([{ i: 0, t: null, c: "cd", o: 2, end: false }]);
    store.applyPage({
      rows: [{ i: 0, t: 1, c: "ab", o: 0, end: false }],
      state: "streaming",
      end: 1,
      next: "c",
    });
    expect(store.row(0)).toMatchObject({ kind: "prefix", c: "abcd" });
    store.applyLive([{ i: 0, t: null, c: "ef", o: 4, end: true }]);
    expect(store.row(0)).toEqual({ kind: "whole", t: 1, c: "abcdef", cut: false });
  });

  it("records a cut row's last piece, so a reconnect keeps it", () => {
    const store = new LogStore();
    store.applyLive([{ i: 0, t: 1, c: "x".repeat(DISPLAY_CUT_UNITS), o: 0, end: false }]);
    store.applyLive([{ i: 0, t: null, c: "tail", o: DISPLAY_CUT_UNITS, end: true }]);
    expect(store.row(0)).toEqual({
      kind: "whole",
      t: 1,
      c: "x".repeat(DISPLAY_CUT_UNITS),
      cut: true,
    });
    store.dropUnfinishedFrom(0);
    expect(store.row(0)).toBeDefined();
  });

  it("completes a cut row whose page and live pieces overlap", () => {
    const store = new LogStore();
    const piece = (o: number, length: number, end: boolean) => ({
      i: 0,
      t: o === 0 ? 1 : null,
      c: "z".repeat(length),
      o,
      end,
    });
    store.applyLive([piece(0, 12_000, false)]);
    store.applyPage({ rows: [piece(0, 25_000, false)], state: "streaming", end: 1, next: "c" });
    store.applyLive([piece(12_000, 12_000, false)]);
    store.applyLive([piece(24_000, 12_000, false)]);
    store.applyLive([piece(36_000, 4_000, true)]);
    expect(store.row(0)).toMatchObject({ kind: "whole", cut: true });
    store.dropUnfinishedFrom(0);
    expect(store.row(0)).toBeDefined();
  });
});
