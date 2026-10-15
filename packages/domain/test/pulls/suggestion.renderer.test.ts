// The lines a suggestion applies are the lines a reader is shown: whenever
// parseSuggestion reads one, the web app's renderer (micromark with GFM, as
// apps/web renders comments) shows exactly one suggestion block, with
// exactly those lines. Refusing a body is always allowed.
import fc from "fast-check";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";
import { parseSuggestion } from "../../src/pulls/suggestion.js";

const render = (body: string) =>
  micromark(body, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
  });

const decodeEntities = (html: string) =>
  html
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

/** The suggestion blocks the renderer shows, as their lines. */
function shown(body: string): string[][] {
  const blocks = [
    ...render(body).matchAll(/<pre><code class="language-suggestion">([\s\S]*?)<\/code><\/pre>/g),
  ];
  return blocks.map((m) => {
    const text = decodeEntities(m[1] as string);
    // The renderer keeps the source's line breaks inside code.
    return text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
  });
}

// Lines that make fences, containers and HTML blocks meet.
const FRAGMENTS = [
  "```suggestion",
  "```",
  "````",
  "````md",
  "~~~",
  "```js",
  "  ```",
  "  ```js",
  "   ```suggestion",
  "- item",
  "  inside",
  "> quote",
  "> ```",
  "<div>",
  "<!--",
  "-->",
  "",
  "text",
  "GOOD",
  "\tx",
  "    code",
  "a`b",
  "```suggestion extra",
  "~~~suggestion",
  "```sugges&#116;ion",
  "```suggestion\\",
  "```Suggestion",
  "```js suggestion",
  "````md\u2028x",
  "```suggestion\u00a0",
  "Title",
  "===",
  "| a | b |",
  "| - | - |",
  "* item",
  "1. item",
  "   inside",
  "[ref]: /url",
  "> [ref]: /url",
  "x\ny",
  "<pre>",
  "</pre>",
  "<?x",
  "?>",
  "<!X",
  "<![CDATA[",
  "]]>",
];

/** Bodies that start a different way (a byte order mark, a list marker). */
const STARTS = ["", "\uFEFF", "- ", "> "];

describe("parseSuggestion against the renderer", () => {
  it("never reads lines other than those shown", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STARTS),
        fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 12 }),
        fc.constantFrom("\n", "\r\n"),
        (start, lines, lineBreak) => {
          const body = start + lines.join(lineBreak);
          const read = parseSuggestion(body);
          if (read === undefined) return;
          expect(shown(body)).toEqual([read]);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it.each([
    "[ref]: /url\n```suggestion\n// disabled\nrunDangerousOperation();\n```",
    "[ref]: /url\n\n```suggestion\na\nb\n```",
    "> [ref]: /url\n\n```suggestion\na\nb\n```",
    "- [ref]: /url\n\n```suggestion\na\nb\n```",
    "[multi\nline]: /url\n\n```suggestion\na\nb\n```",
  ])("refuses %j, whose lines the renderer would not show", (body) => {
    expect(parseSuggestion(body)).toBeUndefined();
  });

  it("still reads a suggestion beside inline links", () => {
    const body = "See [the docs](/docs) and [this][ref].\n\n```suggestion\na\nb\n```";
    expect(parseSuggestion(body)).toEqual(["a", "b"]);
    expect(shown(body)).toEqual([["a", "b"]]);
  });

  it("reads the plain form GitHub writes", () => {
    const body = "Better:\n\n```suggestion\nconst x = 1;\n\n  return x;\n```\n\nThanks";
    expect(parseSuggestion(body)).toEqual(["const x = 1;", "", "  return x;"]);
    expect(shown(body)).toEqual([["const x = 1;", "", "  return x;"]]);
  });
});
