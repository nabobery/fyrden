import { describe, expect, it } from "vitest";
import { storedLogShape } from "../runner/log-accounting.ts";

const final = (index: number, rows: string[], whole = true) => ({
  index,
  rows: rows.map((content) => ({ content })),
  noMore: true,
  whole,
});

describe("the stored shape of a finished log", () => {
  it("after an omission, ended by the newer runner's empty final call: every position below the ack is a line", () => {
    // Row 0 omitted, rows 1 and 2 stored, then an empty final call at 3.
    expect(storedLogShape(final(3, []), 3, 1)).toEqual({ positions: [0, 1, 2], rows: 2 });
    // The omission the last position before the final call.
    expect(storedLogShape(final(1, []), 1, 1)).toEqual({ positions: [0], rows: 0 });
  });

  it("after an omission, ended by the older runner's sentinel: its position is acked, not stored", () => {
    // What the API stores for an omission at 0 and the sentinel at 1 (ack 2, rows 0).
    expect(storedLogShape(final(1, [""]), 2, 1)).toEqual({ positions: [0], rows: 0 });
    expect(storedLogShape(final(3, [""]), 4, 1)).toEqual({ positions: [0, 1, 2], rows: 2 });
  });

  it("ended by a final call with rows: they are lines, an empty one among them too", () => {
    expect(storedLogShape(final(1, ["a", "b"]), 3, 1)).toEqual({ positions: [0, 1, 2], rows: 2 });
    expect(storedLogShape(final(1, ["", ""]), 3, 0)).toEqual({ positions: [0, 1, 2], rows: 3 });
    expect(storedLogShape(final(0, ["x"]), 1, 0)).toEqual({ positions: [0], rows: 1 });
  });

  it("refuses a final ack that does not cover the final call", () => {
    expect(() => storedLogShape(final(3, [""]), 3, 1)).toThrow(/does not cover/);
    expect(() => storedLogShape(final(3, []), 4, 1)).toThrow(/does not cover/);
    expect(() => storedLogShape(final(3, [], false), 3, 1)).toThrow(/not a whole final call/);
    expect(() => storedLogShape(final(1, []), 1, 2)).toThrow(/omissions/);
  });
});
