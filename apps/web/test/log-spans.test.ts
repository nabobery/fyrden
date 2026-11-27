import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { logSpans, MAX_ROW_SPANS, nearest16, SpanCache } from "../app/lib/log-spans.js";
import { ESCAPE_MARK, plainLogText } from "../app/lib/log-text.js";

const ESC = "\u001b";

describe("logSpans", () => {
  it("colours text by SGR, with classes only", () => {
    expect(logSpans(`${ESC}[1;31merror${ESC}[0m: x`)).toEqual([
      { text: "error", className: "a-f1 a-b" },
      { text: ": x", className: "" },
    ]);
  });

  it("maps bright, 256 and truecolour onto the 16 colours", () => {
    expect(logSpans(`${ESC}[92mok`)[0]?.className).toBe("a-f10");
    expect(logSpans(`${ESC}[38;5;196mred`)[0]?.className).toBe("a-f9");
    expect(logSpans(`${ESC}[38;5;244mgrey`)[0]?.className).toBe("a-f8");
    expect(logSpans(`${ESC}[38;2;0;0;238mblue`)[0]?.className).toBe("a-f4");
    expect(logSpans(`${ESC}[38;2;90;90;250mblue`)[0]?.className).toBe("a-f12");
    expect(logSpans(`${ESC}[48;5;2mbg`)[0]?.className).toBe("a-k2");
  });

  it("swaps colours for inverse, draws dim as its own class, and resets parts", () => {
    expect(logSpans(`${ESC}[31;44;7mx`)[0]?.className).toBe("a-f4 a-k1");
    expect(logSpans(`${ESC}[7mx`)[0]?.className).toBe("a-inv");
    expect(logSpans(`${ESC}[2mx${ESC}[22my`)).toEqual([
      { text: "x", className: "a-d" },
      { text: "y", className: "" },
    ]);
    expect(logSpans(`${ESC}[31mx${ESC}[39my`)[1]?.className).toBe("");
  });

  it("shows other escapes as marks, as the plain text does", () => {
    const spans = logSpans(`hun${ESC}]8;;https://x${ESC}\\ter${ESC}[2K22`);
    expect(spans.map((s) => s.text).join("")).toBe(`hun${ESCAPE_MARK}ter${ESCAPE_MARK}22`);
  });

  it("draws the rest of a row plain past its span bound", () => {
    const row = Array.from({ length: MAX_ROW_SPANS + 50 }, (_, i) => `${ESC}[3${i % 8}m${i}`).join(
      "",
    );
    const spans = logSpans(row);
    expect(spans.length).toBeLessThanOrEqual(MAX_ROW_SPANS + 1);
    expect(spans.map((s) => s.text).join("")).toBe(plainLogText(row));
  });

  it("keeps the plain text's characters, whatever the input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        expect(
          logSpans(text)
            .map((s) => s.text)
            .join(""),
        ).toBe(plainLogText(text));
      }),
    );
  });

  it("finds the nearest of the 16", () => {
    expect(nearest16(0, 0, 0)).toBe(0);
    expect(nearest16(255, 255, 255)).toBe(15);
    expect(nearest16(205, 0, 0)).toBe(1);
  });
});

describe("SpanCache", () => {
  const coloured = (n: number) =>
    Array.from({ length: n }, (_, k) => `${ESC}[3${k % 8}m${k}`).join("");

  it("keeps at most its spans, dropping the rows drawn longest ago", () => {
    const cache = new SpanCache(300);
    cache.get(0, coloured(200));
    cache.get(1, coloured(50));
    cache.get(0, coloured(200));
    cache.get(2, coloured(100));
    expect(cache.spans).toBeLessThanOrEqual(300);
    expect(cache.parsed).toBe(3);
    cache.get(0, coloured(200));
    expect(cache.parsed).toBe(3);
    cache.get(1, coloured(50));
    expect(cache.parsed).toBe(4);
  });

  it("counts a row without colour as one span", () => {
    const cache = new SpanCache(3);
    for (let i = 0; i < 5; i++) cache.get(i, "plain");
    expect(cache.spans).toBe(3);
  });

  it("parses a row again when its text changed", () => {
    const cache = new SpanCache(100);
    expect(cache.get(0, "ab")).toEqual([{ text: "ab", className: "" }]);
    expect(cache.get(0, "abcd")).toEqual([{ text: "abcd", className: "" }]);
    expect(cache.parsed).toBe(2);
  });

  describe("SpanCache's text bound", () => {
    it("keeps at most its characters, whatever the span count", () => {
      const cache = new SpanCache(20_000, 25_000);
      for (let i = 0; i < 10; i++) cache.get(i, `${i}`.repeat(10_000));
      expect(cache.units).toBeLessThanOrEqual(25_000);
      expect(cache.get(9, "9".repeat(10_000))).toHaveLength(1);
      expect(cache.parsed).toBe(10);
    });
  });
});
