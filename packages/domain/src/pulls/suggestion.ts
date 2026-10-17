/**
 * Suggested changes in diff comments, as GitHub writes them: a comment
 * whose body holds one fenced code block of backticks whose info string is
 * `suggestion`. Applying one replaces the lines the comment is on with the
 * block's lines (none: the lines are removed). Written from GitHub's
 * documented behaviour and the CommonMark spec.
 *
 * The lines taken must be the lines a reader is shown, so only the plain
 * form is read: every fence outside fenced blocks starts its line (one
 * indented, or after a quote or list marker, may sit in a container that
 * ends before the fence that would close it), so each fenced block is a
 * top-level one, skipped as CommonMark closes it (a fence inside
 * one is its text) and the suggestion's lines are taken as they are. A body
 * with an HTML block (whose extent depends on more of Markdown), a bare
 * carriage return (a line break to Markdown, not to this reading), NUL
 * (shown replaced), a byte order mark (skipped), a link reference
 * definition (see DEFINITION) or another fence whose language may read as
 * a suggestion holds none.
 */

// Whole lines: `.` would stop at U+2028, which is not a line break to Markdown.
const OPENING = /^( {0,3})(`{3,}|~{3,})([\s\S]*)$/;
/** The one form of a suggestion's fence read (no other info, ASCII spaces after). */
const SUGGESTION = /^`{3,}suggestion[ \t]*$/;
/** A line that may start an HTML block (CommonMark's block starts all begin so). */
const HTML_BLOCK = /^ {0,3}</;
/**
 * A line that may start a link reference definition, in a quote or list
 * item too: the web app's renderer (micromark 4.0.2) drops line breaks
 * from code blocks after one, so a suggestion would not show its lines.
 */
const DEFINITION = /^[ \t]*(?:(?:>|[*+-]|\d{1,9}[.)])[ \t]*)*\[/;

/**
 * The suggested lines of `body` (none: remove the lines); undefined unless
 * it holds exactly one suggestion block, closed, in the plain form.
 */
export function parseSuggestion(body: string): string[] | undefined {
  // NUL is shown replaced, a bare CR is a line break, a BOM is skipped: all refused.
  if (/[\0\uFEFF]|\r(?!\n)/.test(body)) return undefined;
  const lines = body.split(/\r?\n/);
  let found: string[] | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (HTML_BLOCK.test(line) || DEFINITION.test(line)) return undefined;
    const open = OPENING.exec(line);
    // A fence anywhere but at the start of a line may open a block in a quote or list item
    // (or end one there): not read.
    if (!open || (open[1] as string).length > 0) {
      if (/`{3,}|~{3,}/.test(line)) return undefined;
      continue;
    }
    const fence = open[2] as string;
    const info = open[3] as string;
    // A backtick fence's info string cannot hold a backtick (CommonMark): not a fence.
    if (fence[0] === "`" && info.includes("`")) continue;
    const suggestion = SUGGESTION.test(line);
    // Any other fence whose language may read as a suggestion (more info, tildes, escapes,
    // entities, other characters) is not read.
    if (!suggestion && mayReadAsSuggestion(info)) return undefined;
    const close = closingLine(lines, i + 1, fence);
    if (suggestion) {
      if (close === undefined || found !== undefined) return undefined;
      found = lines.slice(i + 1, close);
    }
    // Inside a block nothing is a fence; an unclosed one takes the rest.
    if (close === undefined) break;
    i = close;
  }
  return found;
}

/** Whether a fence's info string's language (its first word) may be shown as a suggestion. */
function mayReadAsSuggestion(info: string): boolean {
  const word = info.replace(/^[ \t]+/, "").split(/[ \t]/)[0] ?? "";
  return /suggestion/i.test(word) || /[^\x21-\x7e]|[&\\]/.test(word);
}

/** The line closing a block opened by `fence`, from `from`; undefined when none does. */
function closingLine(lines: readonly string[], from: number, fence: string): number | undefined {
  for (let j = from; j < lines.length; j++) {
    const run = /^ {0,3}(`+|~+)[ \t]*$/.exec(lines[j] as string)?.[1];
    if (run && run[0] === fence[0] && run.length >= fence.length) return j;
  }
  return undefined;
}

/** One suggestion to apply: lines `startLine` to `line` (from 1) become `replacement`. */
export interface SuggestionEdit {
  readonly startLine: number;
  readonly line: number;
  /** The suggested lines; none removes the lines. */
  readonly replacement: readonly string[];
}

export type SuggestionRefusal = "overlapping" | "line_out_of_range";

const encoder = new TextEncoder();
const LF = 0x0a;
const CR = 0x0d;

/**
 * `file` with `edits` applied, or why they cannot be. A replaced line's
 * break is kept for the lines replacing it (CRLF stays CRLF), and a last
 * line without a break stays without one.
 */
export function applySuggestions(
  file: Uint8Array,
  edits: readonly SuggestionEdit[],
): Uint8Array | SuggestionRefusal {
  // Line starts and ends, each end past its break.
  const lines: { start: number; end: number }[] = [];
  for (let start = 0; start < file.length; ) {
    const lf = file.indexOf(LF, start);
    const end = lf < 0 ? file.length : lf + 1;
    lines.push({ start, end });
    start = end;
  }
  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine);
  for (const [k, edit] of sorted.entries()) {
    if (edit.startLine < 1 || edit.line < edit.startLine || edit.line > lines.length)
      return "line_out_of_range";
    const previous = sorted[k - 1];
    if (previous && edit.startLine <= previous.line) return "overlapping";
  }
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const edit of sorted) {
    const first = lines[edit.startLine - 1] as { start: number; end: number };
    const last = lines[edit.line - 1] as { start: number; end: number };
    parts.push(file.subarray(at, first.start));
    if (edit.replacement.length > 0) parts.push(replacementBytes(file, last, edit.replacement));
    at = last.end;
  }
  parts.push(file.subarray(at));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The suggested lines, each ending as the last replaced line ends. */
function replacementBytes(
  file: Uint8Array,
  last: { start: number; end: number },
  replacement: readonly string[],
): Uint8Array {
  const endsWithLf = last.end > last.start && file[last.end - 1] === LF;
  const crlf = endsWithLf && last.end - 2 >= last.start && file[last.end - 2] === CR;
  const lineBreak = crlf ? "\r\n" : "\n";
  const text = replacement.join(lineBreak);
  return encoder.encode(endsWithLf ? `${text}${lineBreak}` : text);
}
