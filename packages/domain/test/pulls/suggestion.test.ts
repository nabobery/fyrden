import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applySuggestions, parseSuggestion } from "../../src/pulls/suggestion.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (out: Uint8Array | string) =>
  typeof out === "string" ? out : new TextDecoder().decode(out);

describe("parseSuggestion", () => {
  it.each([
    ["```suggestion\nnew line\n```", ["new line"]],
    ["Try this:\r\n```suggestion\r\na\r\nb\r\n```\r\nThanks", ["a", "b"]],
    ["````suggestion\n```js\n````", ["```js"]],
    ["```suggestion  \nx\n`````", ["x"]],
    ["```suggestion\n```", []],
    ["```suggestion\n\n```", [""]],
    ["```js\nx\n```\n```suggestion\ny\n```", ["y"]],
    ["```suggestion\n\tx\n  ```", ["\tx"]],
    ["Text <b>inline</b> is fine\n```suggestion\nx\n```", ["x"]],
  ])("reads %j", (body, lines) => {
    expect(parseSuggestion(body)).toEqual(lines);
  });

  it.each([
    "no block",
    "```suggestion\nnever closed",
    "```js\ncode\n```",
    "```suggestion\na\n```\n```suggestion\nb\n```",
    "````suggestion\nx\n```",
    // Shown as one block of code, with a suggestion fence inside it.
    "````md\n```suggestion\nx\n```\n````",
    // An indented fence closes the block: what follows is not part of it, and a second block
    // after it makes two.
    "```suggestion\nGOOD\n  ```\nExplanation\n```suggestion\nx\n```",
    // Four spaces: an indented code block, not a fence.
    "    ```suggestion\nx\n    ```",
    "~~~suggestion\nx\n~~~",
    // Indented: in a list item, it ends with the item, before the fence that would close it.
    "- item\n\n  ```suggestion\n  GOOD\nOUTSIDE\n```",
    "  ```suggestion\n\tx\n  ```",
    // An HTML block's extent is more of Markdown than is read here.
    "<details>\n\n```suggestion\nx\n```\n\n</details>",
    "<!--\n\n```suggestion\nhidden\n```\n-->",
    // An indented block in a list item ends with the item; read globally, a later fence would
    // seem to close it, and a suggestion inside a quoted example would seem to be one.
    "- item\n\n  ```js\n  inside\n````md\n```\n```suggestion\nBAD\n```\n````",
    // A bare carriage return is a line break to Markdown.
    "```suggestion\nGOOD\r```\rOUTSIDE\n```",
    // NUL is shown replaced.
    "```suggestion\nA\u0000B\n```",
    "\uFEFF````md\n```suggestion\nBAD\n```\n````\n```suggestion\nGOOD\n```",
    "````md\u2028x\n```suggestion\nBAD\n```\n````\n```suggestion\nGOOD\n```",
    "````md\u2029x\n```suggestion\nBAD\n```\n````\n```suggestion\nGOOD\n```",
    "```suggestion extra\nFIRST\n```\n```suggestion\nSECOND\n```",
    "```sugges&#116;ion\nFIRST\n```\n```suggestion\nSECOND\n```",
    "~~~suggestion\nFIRST\n~~~\n```suggestion\nSECOND\n```",
  ])("finds no one suggestion in %j", (body) => {
    expect(parseSuggestion(body)).toBeUndefined();
  });
});

describe("parseSuggestion, as a reader sees the block", () => {
  it("takes exactly the lines between the fences, whatever text is around", () => {
    const line = fc.stringMatching(/^[a-z ]{0,6}$/);
    fc.assert(
      fc.property(
        fc.array(line),
        fc.array(line, { maxLength: 4 }),
        fc.array(line),
        (before, inside, after) => {
          const body = [...before, "```suggestion", ...inside, "```", ...after].join("\n");
          expect(parseSuggestion(body)).toEqual(inside);
        },
      ),
    );
  });

  it("closes at an indented fence, leaving the rest out", () => {
    expect(parseSuggestion("```suggestion\nGOOD\n  ```\nExplanation\n```js\nx\n```")).toEqual([
      "GOOD",
    ]);
  });
});

describe("applySuggestions", () => {
  it("replaces, inserts and removes lines, bottom to top", () => {
    const file = bytes("one\ntwo\nthree\nfour\n");
    expect(
      text(
        applySuggestions(file, [
          { startLine: 4, line: 4, replacement: [] },
          { startLine: 1, line: 2, replacement: ["ONE", "1.5", "TWO"] },
        ]),
      ),
    ).toBe("ONE\n1.5\nTWO\nthree\n");
  });

  it("keeps CRLF, and a last line without a break", () => {
    expect(
      text(
        applySuggestions(bytes("a\r\nb\r\n"), [{ startLine: 1, line: 1, replacement: ["x", "y"] }]),
      ),
    ).toBe("x\r\ny\r\nb\r\n");
    expect(
      text(applySuggestions(bytes("a\nb"), [{ startLine: 2, line: 2, replacement: ["c"] }])),
    ).toBe("a\nc");
  });

  it("refuses overlapping edits and lines past the end", () => {
    const file = bytes("1\n2\n3\n");
    expect(
      applySuggestions(file, [
        { startLine: 1, line: 2, replacement: ["x"] },
        { startLine: 2, line: 3, replacement: ["y"] },
      ]),
    ).toBe("overlapping");
    expect(applySuggestions(file, [{ startLine: 3, line: 4, replacement: [] }])).toBe(
      "line_out_of_range",
    );
  });

  it("agrees with editing an array of lines", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-c]{0,3}$/), { minLength: 1, maxLength: 8 }),
        fc.nat(),
        fc.nat(),
        fc.array(fc.stringMatching(/^[a-c]{0,3}$/), { maxLength: 3 }),
        (lines, a, b, replacement) => {
          const start = (a % lines.length) + 1;
          const end = start + (b % (lines.length - start + 1));
          const expected = [...lines];
          expected.splice(start - 1, end - start + 1, ...replacement);
          const out = applySuggestions(bytes(lines.map((l) => `${l}\n`).join("")), [
            { startLine: start, line: end, replacement },
          ]);
          expect(text(out)).toBe(expected.map((l) => `${l}\n`).join(""));
        },
      ),
    );
  });
});
