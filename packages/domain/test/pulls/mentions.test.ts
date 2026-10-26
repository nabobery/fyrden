import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_MENTIONS,
  MENTION_SOURCE_LENGTH,
  mentionsIn,
  newMentions,
} from "../../src/pulls/mentions.js";

describe("mentions", () => {
  it("are handles after @, lower-cased, once each, in order", () => {
    expect(mentionsIn("cc @Alice and @bob-2, again @alice.")).toEqual(["alice", "bob-2"]);
    expect(mentionsIn("@start of text\n(@paren) and @end")).toEqual(["start", "paren", "end"]);
  });

  it("are not addresses, paths, code, or malformed handles", () => {
    expect(mentionsIn("mail a@b.example or x/@y or @-no or @no- or @a--b")).toEqual([]);
    expect(mentionsIn("see `@inline` and\n```\n@fenced\n```\nbut @real")).toEqual(["real"]);
    expect(mentionsIn("~~~js\n@tilde\n~~~\n@after")).toEqual(["after"]);
    expect(mentionsIn("```\n@unclosed fence to the end")).toEqual([]);
  });

  it("are capped", () => {
    const many = Array.from({ length: MAX_MENTIONS + 5 }, (_, i) => `@user${i}`).join(" ");
    expect(mentionsIn(many)).toHaveLength(MAX_MENTIONS);
    expect(mentionsIn(null)).toEqual([]);
  });

  it("new in an edit are those the old text lacked", () => {
    expect(newMentions("hi @a", "hi @a and @B")).toEqual(["b"]);
    expect(newMentions(null, "@a")).toEqual(["a"]);
  });
});

describe("mentions as the page shows them", () => {
  it("leave out code however Markdown nests it", () => {
    for (const text of [
      "` code ``` @hidden ` real",
      "```\n@in\n```~\n@still\n```\nout",
      "> ~~~\n> @in\n> ~~~",
      "- ~~~\n  @in\n  ~~~",
      "```\r\n@in\r\n```",
      "-     @in",
      "1. \n\n    @in",
      "- 1. ~~~@in",
      "- > ~~~\n  > @in",
    ])
      expect(mentionsIn(text), JSON.stringify(text)).toEqual([]);
  });

  it("are read where the page shows text", () => {
    expect(mentionsIn("> quoted @a\n\n- listed @b\n\n| t |\n|---|\n| @c |")).toEqual([
      "a",
      "b",
      "c",
    ]);
    // Raw HTML is shown as text, so what it holds is read.
    expect(mentionsIn("<div>\n```\n@d\n</div>")).toContain("d");
    expect(mentionsIn("[see @e](https://example.com/@f)")).toEqual(["e"]);
    // An unclosed run of four backticks is text, the span after it code; a handle right after
    // a backtick is not a mention.
    expect(mentionsIn("````@g``@h`` @i")).toEqual(["i"]);
  });

  it("only ever name handles the text holds, once each, within the cap", () => {
    const token = fc.constantFrom(
      "@ab",
      "@cd",
      "@Ef",
      "`",
      "``",
      "```",
      "~~~",
      "\n",
      "\n\n",
      " ",
      "    ",
      "x",
      "> ",
      "- ",
      "1. ",
      "\r\n",
    );
    fc.assert(
      fc.property(fc.array(token, { maxLength: 30 }), (tokens) => {
        const text = tokens.join("");
        const found = mentionsIn(text);
        expect(new Set(found).size).toBe(found.length);
        expect(found.length).toBeLessThanOrEqual(MAX_MENTIONS);
        for (const handle of found) expect(text.toLowerCase()).toContain(`@${handle}`);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("mentions as the page joins its text", () => {
  it("keep a word whole across formatting and links", () => {
    expect(mentionsIn("@**alice**")).toEqual(["alice"]);
    expect(mentionsIn("@al*ic*e")).toEqual(["alice"]);
    expect(mentionsIn("[@ali](/x)ce")).toEqual(["alice"]);
  });

  it("keep cells, lines and blocks apart, and read only the start of a long text", () => {
    expect(mentionsIn("| @a | b |\n|---|---|\n| c | @d |")).toEqual(["a", "d"]);
    expect(mentionsIn("@a\n@b")).toEqual(["a", "b"]);
    expect(mentionsIn(`${"x ".repeat(MENTION_SOURCE_LENGTH)}@late`)).toEqual([]);
  });

  it("never read a mention the cut of a long text shortened", () => {
    // `@alicebob` straddles the limit: no `@alice` (nor anything else) from it.
    const handle = "alicebob";
    const head = "x".repeat(MENTION_SOURCE_LENGTH - 6);
    expect(mentionsIn(`${head} @${handle} more`)).toEqual([]);
    // A longer text is read up to its last blank line before the limit, whole.
    expect(mentionsIn(`@first\n\n${"y".repeat(MENTION_SOURCE_LENGTH)} @${handle}`)).toEqual([
      "first",
    ]);
    expect(mentionsIn(`@crlf\r\n \r\n${"y ".repeat(MENTION_SOURCE_LENGTH)}`)).toEqual(["crlf"]);
    // One with no blank line before the limit is not read.
    expect(mentionsIn(`@kept ${head} @${handle}`)).toEqual([]);
  });

  it("never read as text what a long text's cut leaves of inline code", () => {
    // Code past the limit is not opened at the cut to show its rest as text.
    const code = `\` @hidden ${"z ".repeat(MENTION_SOURCE_LENGTH / 2)}\``;
    expect(mentionsIn(`intro\n\n${code}`)).toEqual([]);
    expect(mentionsIn(`intro ${code}`)).toEqual([]);
  });

  it("read a wide table without rendering it", () => {
    const columns = 200;
    const table = `${"|h".repeat(columns)}|\n${"|-".repeat(columns)}|\n${"|@z\n".repeat(200)}`;
    expect(mentionsIn(table)).toEqual(["z"]);
  });
});

describe("mentions in what the page shows of references, autolinks and footnotes", () => {
  it("read character references as their characters", () => {
    expect(mentionsIn("@al&#105;ce")).toEqual(["alice"]);
    expect(mentionsIn("@a&nbsp;b")).toEqual(["a"]);
    expect(mentionsIn("&#64;alice")).toEqual(["alice"]);
  });

  it("read autolinks' text, and never footnote labels or unshown notes", () => {
    // The page shows an autolink's text: `<mailto:@m>` reads `mailto:@m`.
    expect(mentionsIn("<mailto:@m> and <https://x.test/@not> @y")).toEqual(["m", "y"]);
    expect(mentionsIn("[^@alice]: hidden @bob")).toEqual([]);
    // A footnote's text is not read: a mention there tells no one.
    expect(mentionsIn("See note[^n].\n\n[^n]: Please ask @alice.")).toEqual([]);
  });

  it("mention no one in a text too costly to parse", () => {
    // Emphasis inside a word keeps it whole.
    expect(mentionsIn("@a*l*ice")).toEqual(["alice"]);
    expect(mentionsIn(`@x ${"*".repeat(257)}`)).toEqual([]);
    expect(mentionsIn(`@x ${"[".repeat(257)}`)).toEqual([]);
    expect(mentionsIn(`${"- ".repeat(129)}@x`)).toEqual([]);
    expect(mentionsIn(`${"- ".repeat(8)}@x`)).toEqual(["x"]);
    // Nesting built by indentation over many lines counts, tabs too.
    const indented = Array.from(
      { length: 86 },
      (_, i) => `${"\t".repeat(4 * i)}${"- ".repeat(8)}x`,
    );
    expect(mentionsIn(`${indented.join("\n")}\n@alice`)).toEqual([]);
    expect(mentionsIn(`${"- \t".repeat(129)}@x`)).toEqual([]);
    expect(mentionsIn(`${"- ".repeat(8191)}@z`)).toEqual([]);
    expect(mentionsIn(`>> ${"- ".repeat(2048)}@alice`)).toEqual([]);
    expect(mentionsIn(`x\r${"- ".repeat(4096)}@alice`)).toEqual([]);
    // No longer turned into other text: what the page shows stays the rule.
    expect(mentionsIn(`*     @hidden\n\n${"*".repeat(200)}`)).toEqual([]);
    expect(mentionsIn("@alice_bob")).toEqual([]);
  });
});
