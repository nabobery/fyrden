/*
 * Adding trailers to a commit message where git reads them. Written from
 * the behaviour `git-interpret-trailers(1)` documents and checked against
 * the git binary as a black box (test/object/trailers.git-oracle.test.ts);
 * no git source is used. Git's defaults apply: `:` separates a key from
 * its value, new trailers go at the end of the trailer block, `#` starts a
 * comment. Unlike git, the message's own text is never rewritten.
 *
 * The rules, as documented and observed:
 * - The trailer block is the message's last paragraph, never its first
 *   (the title). It must be all trailers, or hold a trailer git writes
 *   itself (`Signed-off-by: `, `(cherry picked from commit `) with
 *   trailers at least a quarter of its lines.
 * - A trailer is a key of letters, digits and hyphens, then spaces or
 *   tabs, then `:`; a line starting with whitespace (space, tab or CR)
 *   continues the one before it. Comment lines count for nothing.
 * - The message ends before a `---` line (followed by a space, tab, CR or
 *   nothing) and before a scissors line; trailing comments and empty lines
 *   are not part of it, nor (observed) an old merge message's trailing
 *   `Conflicts:` line with the tab-indented paths after it; blank and
 *   comment lines left at its end belong to no paragraph. Whitespace is only space, tab,
 *   CR and LF.
 */

type Kind = "blank" | "comment" | "trailer" | "continuation" | "other";

interface Line {
  /** Where the line starts in the text, and where the next one does. */
  readonly start: number;
  readonly next: number;
  readonly kind: Kind;
  /** A trailer git writes itself. */
  readonly generated: boolean;
  /** Where the message ends: a patch divider or a scissors line. */
  readonly stop: boolean;
  /** Nothing at all on it (a blank line may hold spaces, tabs or a CR). */
  readonly empty: boolean;
  /** An old merge message's `Conflicts:` line, or a path listed under it. */
  readonly conflicts: "heading" | "path" | null;
}

const SCISSORS = "# ------------------------ >8 ------------------------";
const GENERATED = ["Signed-off-by: ", "(cherry picked from commit "];
const KEY_THEN_COLON = /^[A-Za-z0-9-]+[ \t]*:/;
const BLANK = /^[ \t\r]*$/;
const DIVIDER = /^---(?:[ \t\r]|$)/;

function lineOf(text: string, start: number, next: number): Line {
  const body = text.slice(start, text[next - 1] === "\n" ? next - 1 : next);
  const generated = GENERATED.some((prefix) => body.startsWith(prefix));
  const kind: Kind = BLANK.test(body)
    ? "blank"
    : body.startsWith("#")
      ? "comment"
      : generated || KEY_THEN_COLON.test(body)
        ? "trailer"
        : body[0] === " " || body[0] === "\t" || body[0] === "\r"
          ? "continuation"
          : "other";
  return {
    start,
    next,
    kind,
    generated,
    stop: DIVIDER.test(body) || body === SCISSORS,
    empty: body === "",
    conflicts:
      body === "Conflicts:" && text[next - 1] === "\n"
        ? "heading"
        : body.startsWith("\t")
          ? "path"
          : null,
  };
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  for (let start = 0; start < text.length; ) {
    const nl = text.indexOf("\n", start);
    const next = nl === -1 ? text.length : nl + 1;
    lines.push(lineOf(text, start, next));
    start = next;
  }
  return lines;
}

/**
 * Where the message really ends: before the run of lines at its end that
 * git does not read, empty lines, comments, and an old `Conflicts:` line
 * with the tab-indented paths under it. Any other line ends a run (one
 * with only spaces too: observed).
 */
function withoutIgnoredEnd(lines: readonly Line[], end: number): number {
  let runStart = -1;
  let listing = false;
  for (let i = 0; i < end; i++) {
    const line = lines[i] as Line;
    const ignored =
      line.empty ||
      line.kind === "comment" ||
      line.conflicts === "heading" ||
      (listing && line.conflicts === "path");
    if (!ignored) {
      runStart = -1;
      listing = false;
      continue;
    }
    if (runStart === -1) runStart = i;
    if (line.conflicts === "heading") listing = true;
  }
  return runStart === -1 ? end : runStart;
}

/**
 * The index after the last trailer (or its continuation) of the trailer
 * block among `lines[0, end)`; -1 when the message has none.
 */
function blockEnd(lines: readonly Line[], end: number): number {
  // The title runs to the first blank line; comments do not end it.
  const titleEnd = lines.findIndex((line, i) => i < end && line.kind === "blank");
  if (titleEnd === -1) return -1;
  // The last paragraph: back from the end to the blank line before it.
  let first = end;
  while (first > titleEnd + 1 && lines[first - 1]?.kind !== "blank") first--;
  let trailers = 0;
  let others = 0;
  let generated = false;
  let folding = false;
  let last = -1;
  for (let i = first; i < end; i++) {
    const line = lines[i] as Line;
    if (line.kind === "comment") {
      folding = false;
    } else if (line.kind === "trailer") {
      trailers++;
      generated ||= line.generated;
      folding = true;
      last = i + 1;
    } else if (line.kind === "continuation" && folding) {
      last = i + 1;
    } else {
      others++;
      folding = false;
    }
  }
  return trailers > 0 && (others === 0 || (generated && trailers * 3 >= others)) ? last : -1;
}

/**
 * `message` with `trailers` (whole lines such as `Co-authored-by: A <a@x>`)
 * added where git reads them with the trailers already there: after the
 * last trailer of the message's trailer block, or as a new paragraph at the
 * end of the message (before a patch, a scissors line, trailing comments
 * and blank lines). A final newline is added when the message has none.
 * Throws RangeError for a message with a NUL, which git stops reading at.
 */
export function appendTrailers(message: string, trailers: readonly string[]): string {
  if (message.includes("\0")) throw new RangeError("a commit message must not contain NUL");
  if (trailers.length === 0) return message;
  const text = message === "" || message.endsWith("\n") ? message : `${message}\n`;
  const lines = linesOf(text);
  let end = lines.findIndex((line) => line.stop);
  if (end === -1) end = lines.length;
  end = withoutIgnoredEnd(lines, end);
  // Blank and comment lines left at the end belong to no paragraph; they stay after what is added.
  while (end > 0 && (lines[end - 1]?.kind === "blank" || lines[end - 1]?.kind === "comment")) end--;
  const added = trailers.map((t) => `${t}\n`).join("");
  const after = blockEnd(lines, end);
  if (after !== -1) {
    const at = (lines[after - 1] as Line).next;
    return `${text.slice(0, at)}${added}${text.slice(at)}`;
  }
  // A new paragraph: a blank line, then the trailers, where the message ends.
  const at = end === 0 ? 0 : (lines[end - 1] as Line).next;
  return `${text.slice(0, at)}\n${added}${text.slice(at)}`;
}
