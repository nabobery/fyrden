import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";

/** Mentions one text names at most; the rest are ignored. */
export const MAX_MENTIONS = 50;

/** A handle after `@`, as handles are made (GitHub's rule: letters, digits, single hyphens). */
const MENTION =
  /(^|[^A-Za-z0-9_`@/.-])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/g;

/** Characters of a text read for mentions: those past it are not (bounds the parse). */
export const MENTION_SOURCE_LENGTH = 16_384;

/** Tokens whose text the page shows as it is. */
const TEXT = new Set([
  "data",
  "characterEscapeValue",
  "htmlTextData",
  "htmlFlowData",
  "autolinkProtocol",
  "autolinkEmail",
]);
/** Tokens whose content the page does not show as text: code, link targets, definitions, images. */
const HIDDEN = new Set([
  "codeText",
  "codeFenced",
  "codeIndented",
  "resource",
  "reference",
  "definition",
  "image",
  // A footnote reference shows as a number; a footnote's text is not read (a mention there
  // tells no one: which of its definitions the page shows depends on rules not worth following).
  "gfmFootnoteCall",
  "gfmFootnoteDefinition",
]);

/**
 * What a text may hold for it to be read for mentions: past these, parsing
 * it costs time that grows faster than the text, so it mentions no one.
 * Each is counted in one pass over the text.
 */
const PARSE_BUDGET = {
  /** Emphasis and strikethrough delimiters. */
  delimiters: 256,
  /** Opening brackets (links, references, footnotes). */
  brackets: 256,
  /** Block quote and list markers opening lines, in all (indentation nests them too). */
  containers: 128,
} as const;
/** A container marker at a line's start: a quote (no space needed after it), or a list item's. */
const CONTAINER = /^[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$))[ \t]*/;

/** Whether `source` stays within the parse budget. */
function withinBudget(source: string): boolean {
  let delimiters = 0;
  let brackets = 0;
  for (const char of source)
    if (char === "*" || char === "_" || char === "~") delimiters++;
    else if (char === "[") brackets++;
  if (delimiters > PARSE_BUDGET.delimiters || brackets > PARSE_BUDGET.brackets) return false;
  let containers = 0;
  for (const line of source.split(/\r\n?|\n/))
    for (let rest = line, marker = CONTAINER.exec(rest); marker; marker = CONTAINER.exec(rest)) {
      if (++containers > PARSE_BUDGET.containers) return false;
      // An empty match cannot happen (a marker is at least one character).
      rest = rest.slice(marker[0].length);
    }
  return true;
}
/** Tokens that end a run of text (a line, a table cell, a block). */
const BREAKS = new Set([
  "lineEnding",
  "tableCellDivider",
  "paragraph",
  "atxHeading",
  "setextHeading",
]);

/**
 * The text a reader sees of `markdown` outside code, as the web app's
 * renderer (GitHub-flavored Markdown, raw HTML shown as text) parses it:
 * its text tokens joined as the page joins them (formatting and links
 * inside a word keep it whole), lines, cells and blocks apart. Read from
 * the parser's tokens, never rendered, so its size is the source's.
 */
export function visibleText(markdown: string): string {
  const source = markdown.slice(0, MENTION_SOURCE_LENGTH);
  if (!withinBudget(source)) return "";
  const events = postprocess(
    parse({ extensions: [gfm()] })
      .document()
      .write(preprocess()(source, undefined, true)),
  );
  const out: string[] = [];
  let hidden = 0;
  let autolink = 0;
  for (const [kind, token, context] of events) {
    const enter = kind === "enter";
    const type = token.type as string;
    if (HIDDEN.has(type)) {
      hidden += enter ? 1 : -1;
      // Code and images stand apart from the text around them; a link's target is just unseen.
      if (enter && type !== "resource" && type !== "reference" && type !== "definition")
        out.push(" ");
      continue;
    }
    if (hidden > 0) continue;
    if (type === "literalAutolink") {
      autolink += enter ? 1 : -1;
      if (enter) out.push(context.sliceSerialize(token));
      continue;
    }
    if (autolink > 0) continue;
    if (BREAKS.has(type)) {
      if (enter || type !== "lineEnding") out.push("\n");
      continue;
    }
    if (enter && type === "characterReference")
      out.push(decodeReference(context.sliceSerialize(token)));
    else if (enter && TEXT.has(type)) out.push(context.sliceSerialize(token));
  }
  return out.join("");
}

/** A character reference (`&#105;`, `&#x69;`, `&nbsp;`) as the character the page shows. */
function decodeReference(reference: string): string {
  const body = reference.slice(1, -1);
  if (body.startsWith("#")) {
    const code = /^#[xX]/.test(body) ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    return Number.isInteger(code) &&
      code > 0 &&
      code <= 0x10ffff &&
      (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : "\ufffd";
  }
  const named = decodeNamedCharacterReference(body);
  return named === false ? reference : named;
}

/** The last texts read, with their mentions (a change reads one text more than once). */
const recent = new Map<string, string[]>();

/** The handles `plain` names (text with no code left in it), at most `MAX_MENTIONS`. */
function handlesIn(plain: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of plain.matchAll(MENTION)) {
    const handle = (match[2] as string).toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    found.push(handle);
    if (found.length >= MAX_MENTIONS) break;
  }
  return found;
}

/**
 * The handles a text mentions (`@handle`, outside code), lower-cased, in
 * order of first appearance, at most `MAX_MENTIONS`. An address
 * (`a@b.c`) or a path (`x/@y`) is not a mention.
 */
export function mentionsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const known = recent.get(text);
  if (known) return [...known];
  const found = handlesIn(visibleText(text));
  if (recent.size >= 8) recent.delete(recent.keys().next().value as string);
  recent.set(text, found);
  return [...found];
}

/** The handles `after` mentions that `before` did not (an edit's new mentions). */
export function newMentions(before: string | null | undefined, after: string | null | undefined) {
  const old = new Set(mentionsIn(before));
  return mentionsIn(after).filter((h) => !old.has(h));
}
