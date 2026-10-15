import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkAnchor, decideResolution, lineCount } from "../../src/pulls/review-comment.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("lineCount", () => {
  it.each([
    ["", 0],
    ["a", 1],
    ["a\n", 1],
    ["a\nb", 2],
    ["\n\n", 2],
  ])("%j has %i lines", (text, lines) => {
    expect(lineCount(bytes(text))).toBe(lines);
  });

  it("agrees with splitting on line breaks", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("a", "\n") }), (text) => {
        const split = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
        expect(lineCount(bytes(text))).toBe(split);
      }),
    );
  });
});

describe("checkAnchor", () => {
  const anchor = (line: number, startLine: number | null = null) =>
    ({ side: "RIGHT", line, startLine }) as const;
  it("takes lines within the file, a range's first line before its last", () => {
    expect(checkAnchor(anchor(1), 1)).toBeUndefined();
    expect(checkAnchor(anchor(3, 1), 3)).toBeUndefined();
    expect(checkAnchor(anchor(4), 3)).toBe("line_out_of_range");
    expect(checkAnchor(anchor(1), 0)).toBe("line_out_of_range");
    expect(checkAnchor(anchor(2, 2), 3)).toBe("invalid_range");
    expect(checkAnchor(anchor(2, 3), 3)).toBe("invalid_range");
  });
});

describe("decideResolution", () => {
  it.each([
    [true, "read", true],
    [false, "read", false],
    [false, "triage", false],
    [false, "write", true],
    [true, null, false],
  ] as const)("author=%s with %s: %s", (isPullAuthor, role, ok) => {
    expect(decideResolution({ isPullAuthor, role }).ok).toBe(ok);
  });
});
