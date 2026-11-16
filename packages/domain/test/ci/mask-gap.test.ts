import { describe, expect, it } from "vitest";
import { type LogMask, MASK_WHOLE_MAX_BYTES, maskGapLength, maskRows } from "../../src/ci/mask.js";

const masks: readonly LogMask[] = [{ value: "abcdefgh", fromIndex: 0 }];

describe("maskGapLength", () => {
  it("covers the longest crossing encoding, including its padding", () => {
    expect(maskGapLength(masks, 1)).toBe(11);
  });

  it("ignores masks not yet registered at the omitted position", () => {
    const future = [{ value: "abcdefgh", fromIndex: 5 }];
    expect(maskGapLength(future, 4)).toBe(0);
    expect(maskGapLength(future, 5)).toBe(11);
    expect(maskRows(future, null, ["abcdefgh"], { start: 4, gapRemaining: 0 }).lines).toEqual([
      "abcdefgh",
    ]);
  });

  it("uses no gap protection without a crossing variant", () => {
    expect(maskGapLength([], 0)).toBe(0);
    expect(maskGapLength([{ value: "abcdefg", fromIndex: 0 }], 0)).toBe(0);
  });

  it("includes crossing encodings of a row-local plain value", () => {
    expect(maskGapLength([{ value: "&&&", fromIndex: 0 }], 0)).toBe(17);
  });

  it("includes reserved token masks", () => {
    expect(maskGapLength([{ value: "abcdefgh", fromIndex: 0, reserved: true }], 1)).toBe(11);
  });

  it("uses the trimmed-line policy for a value past the whole-value byte cap", () => {
    const value = `${"a".repeat(MASK_WHOLE_MAX_BYTES + 1)}\nbcdefghi`;
    expect(maskGapLength([{ value, fromIndex: 0 }], 1)).toBe(MASK_WHOLE_MAX_BYTES);
  });

  it("applies the whole-value cap in UTF-8 bytes rather than UTF-16 units", () => {
    const value = "😀".repeat(MASK_WHOLE_MAX_BYTES / 4 + 1);
    expect(maskGapLength([{ value, fromIndex: 0 }], 1)).toBe(value.length - 1);
  });
});

describe("maskRows after an omitted row", () => {
  it("masks a secret suffix whose prefix was inside the omitted row", () => {
    const result = maskRows(masks, null, ["defgh...... SAFE"], {
      start: 2,
      gapRemaining: 11,
    });
    expect(result.lines).toEqual(["*** SAFE"]);
    expect(result.gapRemainingAt(0)).toBe(11);
    expect(result.gapRemainingAt(1)).toBe(0);
  });

  it("protects a suffix split across short and empty rows in successive requests", () => {
    const first = maskRows(masks, null, ["de", ""], { start: 2, gapRemaining: 11 });
    expect(first.lines).toEqual(["***", ""]);
    expect(first.gapRemainingAt(2)).toBe(9);
    const second = maskRows(masks, first.carryAt(2), ["fg", "h......", " SAFE"], {
      start: 4,
      gapRemaining: first.gapRemainingAt(2),
    });
    expect(second.lines).toEqual(["***", "***", " SAFE"]);
    expect([0, 1, 2, 3].map((k) => second.gapRemainingAt(k))).toEqual([9, 7, 0, 0]);
  });

  it("consumes raw characters instead of the replacement marker length", () => {
    const result = maskRows([], null, ["abcd", "e", "fSAFE"], {
      start: 1,
      gapRemaining: 6,
    });
    expect(result.lines).toEqual(["***", "***", "***SAFE"]);
    expect([0, 1, 2, 3].map((k) => result.gapRemainingAt(k))).toEqual([6, 2, 1, 0]);
  });

  it("resets the protected prefix for a second omission", () => {
    const first = maskRows(masks, null, ["0123456789"], {
      start: 2,
      gapRemaining: maskGapLength(masks, 1),
    });
    expect(first.gapRemainingAt(1)).toBe(1);
    const afterSecondGap = maskRows(masks, null, ["0123456789"], {
      start: 4,
      gapRemaining: maskGapLength(masks, 3),
    });
    expect(afterSecondGap.lines).toEqual(["***"]);
    expect(afterSecondGap.gapRemainingAt(1)).toBe(1);
  });

  it.each([{ final: true }, { force: true }])("keeps gap protection with %j", (options) => {
    const result = maskRows([], null, ["abcTAIL"], {
      start: 1,
      gapRemaining: 3,
      ...options,
    });
    expect(result.lines).toEqual(["***TAIL"]);
    expect(result.gapRemainingAt(1)).toBe(0);
  });

  it("does not consume a gap budget on an empty final call", () => {
    const result = maskRows([], null, [], { start: 1, final: true, gapRemaining: 7 });
    expect(result.lines).toEqual([]);
    expect(result.gapRemainingAt(0)).toBe(7);
  });

  it("keeps ordinary pattern carry independent of the conservative prefix", () => {
    const first = maskRows(masks, null, ["abcde"], { start: 0, force: true });
    const result = maskRows(masks, first.carryAt(1), ["fgh SAFE"], {
      start: 1,
      final: true,
      gapRemaining: 1,
    });
    expect(result.lines).toEqual(["*** SAFE"]);
    expect(result.gapRemainingAt(1)).toBe(0);
  });

  it("extends a cutoff to include a complete surrogate pair", () => {
    const result = maskRows([], null, ["A😀B"], { start: 1, gapRemaining: 2 });
    expect(result.lines).toEqual(["***B"]);
    expect(result.gapRemainingAt(1)).toBe(0);
  });

  it("protects the second surrogate across empty rows and a request boundary", () => {
    const first = maskRows([], null, ["A\ud83d", ""], { start: 1, gapRemaining: 2 });
    expect(first.lines).toEqual(["***", ""]);
    expect(first.gapRemainingAt(2)).toBe(1);
    const second = maskRows([], null, ["\ude00B"], {
      start: 3,
      gapRemaining: first.gapRemainingAt(2),
    });
    expect(second.lines).toEqual(["***B"]);
    expect(second.gapRemainingAt(1)).toBe(0);
  });

  it("retains command registration and normal masking after the protected prefix", () => {
    const rows = ["::add-mask::new-secret", "new-secret SAFE"];
    const ordinary = maskRows([], null, rows, { start: 2, final: true });
    const gap = maskRows([], null, rows, { start: 2, final: true, gapRemaining: 3 });
    expect(gap.added).toEqual(ordinary.added);
    expect(gap.dropped).toEqual(ordinary.dropped);
    expect(gap.lines[1]).toBe("*** SAFE");
    expect(gap.gapRemainingAt(2)).toBe(0);
  });

  it("leaves ordinary output and carry unchanged without a gap", () => {
    const rows = ["abc", "defgh SAFE", "abcde"];
    const ordinary = maskRows(masks, null, rows, { start: 0 });
    const gap = maskRows(masks, null, rows, { start: 0, gapRemaining: 0 });
    expect(gap.lines).toEqual(ordinary.lines);
    expect(gap.settled).toBe(ordinary.settled);
    expect(gap.added).toEqual(ordinary.added);
    expect(gap.dropped).toEqual(ordinary.dropped);
    for (let k = 0; k <= rows.length; k++) {
      expect(gap.carryAt(k)).toEqual(ordinary.carryAt(k));
      expect(gap.gapRemainingAt(k)).toBe(0);
    }
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "refuses an invalid persisted gap budget %s",
    (gapRemaining) => {
      expect(() => maskRows([], null, ["secret"], { start: 0, gapRemaining })).toThrow(RangeError);
    },
  );

  it.each([-1, 0.5, Number.NaN, 2])("rejects an invalid row boundary %s", (boundary) => {
    const result = maskRows([], null, ["safe"], { start: 0, gapRemaining: 0 });
    expect(() => result.gapRemainingAt(boundary)).toThrow(RangeError);
  });
});
