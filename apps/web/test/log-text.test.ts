import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ESCAPE_MARK, logTokens, plainLogText } from "../app/lib/log-text.js";

describe("plainLogText", () => {
  it("drops colour and keeps the text", () => {
    expect(plainLogText("\u001b[1;31merror\u001b[0m: it broke")).toBe("error: it broke");
    expect(plainLogText("\u001b[38;5;208mwarn\u001b[m")).toBe("warn");
  });

  it("shows every other escape as a mark rather than joining around it", () => {
    expect(plainLogText("hun\u001b]8;;https://x.test\u0007ter22")).toBe(`hun${ESCAPE_MARK}ter22`);
    expect(plainLogText("a\u001b[2Kb")).toBe(`a${ESCAPE_MARK}b`);
    expect(plainLogText("a\u001bPq#0\u001b\\b")).toBe(`a${ESCAPE_MARK}b`);
  });

  it("shows control characters as their symbols, and keeps tabs", () => {
    expect(plainLogText("a\u0000b\u0008c\td")).toBe("a␀b␈c\td");
    expect(plainLogText("a\rb")).toBe("a␍b");
    expect(plainLogText("a\u009bb")).toBe(`a${ESCAPE_MARK}b`);
  });

  it("never yields a control character, and keeps text without escapes as it is", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        const out = plainLogText(text);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the property is about control characters.
        expect(out).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the property is about control characters.
        if (!/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(text)) expect(out).toBe(text);
      }),
    );
  });

  it("scans a row a bounded number of times its length, unterminated strings included", () => {
    for (const row of [
      "\u001bP".repeat(8_000),
      "\u001b]".repeat(8_000),
      `${"\u001b]x".repeat(4_000)}\u0007`,
      `\u001b[${"1;".repeat(20_000)}`,
    ]) {
      const work = { steps: 0 };
      for (const _ of logTokens(row, 0, work));
      expect(work.steps, row.slice(0, 4)).toBeLessThanOrEqual(4 * row.length);
    }
  });
});
