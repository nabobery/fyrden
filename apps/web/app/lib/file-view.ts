/**
 * The file page's rules, shared by its loader and the browser: what a file is, where its
 * lines end, the blocks a large one is paged by, and the links to its lines.
 */

import { bytesOfBase64, type Contents, classifyBytes, encodePath } from "./types.js";

/** A file up to both of these is sent whole; above either, one block at a time. */
export const MAX_WHOLE_BYTES = 64 * 1024;
export const MAX_WHOLE_LINES = 2_000;
/** Above either of these, the renderer draws the file without highlighting it. */
export const MAX_HIGHLIGHTED_BYTES = 256 * 1024;
export const MAX_HIGHLIGHTED_LINES = 10_000;
/** The largest file the API's raw route serves (`CONTENTS_POLICY.maxRawBytes`). */
export const MAX_RAW_BYTES = 24 * 1024 * 1024;

/**
 * What the renderer is given to draw. Over either limit it is told the language is plain text,
 * so it draws its rows and asks no highlighter for anything.
 */
export function rendererFile({
  path,
  contents,
  cacheKey,
  size,
  totalLines,
}: {
  path: string;
  contents: string;
  cacheKey: string;
  size: number;
  totalLines: number;
}): { name: string; contents: string; cacheKey: string; lang?: "text" } {
  const plainText = size > MAX_HIGHLIGHTED_BYTES || totalLines > MAX_HIGHLIGHTED_LINES;
  return { name: path, contents, cacheKey, ...(plainText && { lang: "text" as const }) };
}

/** One run of a file's lines, and where it lies in the text it was scanned from. */
export interface Block {
  readonly firstLine: number;
  readonly lineCount: number;
  readonly start: number;
  readonly end: number;
  /** Its one line is longer than a block holds: `end` stops short of the line's end. */
  readonly cut: boolean;
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** A text file's lines as the page shows them: all of them, or one block. */
export interface TextFile {
  readonly state: "text";
  /** The lines shown, with no final line ending. */
  readonly text: string;
  readonly firstLine: number;
  readonly totalLines: number;
  readonly whole: boolean;
  /** Its line is longer than a block holds, and `text` stops short of the line's end. */
  readonly cut: boolean;
  /** The first lines of the neighbouring blocks. */
  readonly previous: number | null;
  readonly next: number | null;
  readonly selected: LineRange | null;
  /** The commit whose raw bytes hold the whole text, when the API's answer named one. */
  readonly commit: string | null;
  /** The blob's id: its text never changes under this. */
  readonly sha: string;
  readonly size: number;
  /** A Markdown file's source: its links keep `plain=1`. */
  readonly plain: boolean;
}

export type FileState =
  | TextFile
  | { readonly state: "markdown"; readonly source: string }
  | { readonly state: "empty" | "binary" | "undecodable" | "too-large" | "too-large-for-raw" }
  | { readonly state: "submodule"; readonly sha: string }
  | { readonly state: "symlink"; readonly target: string };

/** The kinds of file an API answer can name, a directory (which redirects) apart. */
type FileContents = Exclude<Contents, { type: "dir" }>;

/**
 * `text` split at each `\n`, `\r\n` and lone `\r`, as the renderer numbers its rows
 * (`computeFileOffsets.js` in `@pierre/diffs`): a final line ending starts one more line.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/**
 * `text` with one final line ending off, so that a file's last line is the last it has:
 * the renderer would draw a blank row after it.
 */
export function withoutFinalEnding(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  return text.endsWith("\n") || text.endsWith("\r") ? text.slice(0, -1) : text;
}

const LF = 0x0a;
const CR = 0x0d;

/**
 * The blocks of `text` (with no final line ending), from the top: their boundaries depend on
 * nothing but the text. A block ends at `MAX_WHOLE_LINES` or when the next line, its ending
 * counted, would take it past `MAX_WHOLE_BYTES`. A line longer than that is alone, cut there.
 */
export function scanBlocks(text: string): { blocks: Block[]; totalLines: number } {
  const blocks: Block[] = [];
  let line = 0;
  let at = 0;
  let current: { firstLine: number; lineCount: number; start: number; bytes: number } | null = null;
  let shownTo = 0;
  let cut = false;
  const close = () => {
    if (current)
      blocks.push({
        firstLine: current.firstLine,
        lineCount: current.lineCount,
        start: current.start,
        end: shownTo,
        cut,
      });
  };
  for (;;) {
    line++;
    // One line: its bytes (UTF-8, from the text's UTF-16 units), and where a cut would fall.
    let bytes = 0;
    let fits = -1;
    let end = at;
    while (end < text.length) {
      const unit = text.charCodeAt(end);
      if (unit === LF || unit === CR) break;
      // A pair is one 4-byte character, and a cut stays out of it.
      const pair = unit >= 0xd800 && unit <= 0xdbff;
      const size = unit < 0x80 ? 1 : unit < 0x800 ? 2 : pair ? 4 : 3;
      if (bytes + size > MAX_WHOLE_BYTES && fits < 0) fits = end;
      bytes += size;
      end += pair ? 2 : 1;
    }
    let next = end;
    if (end < text.length) {
      next = text.charCodeAt(end) === CR && text.charCodeAt(end + 1) === LF ? end + 2 : end + 1;
      bytes += next - end;
    }
    if (
      !current ||
      current.lineCount === MAX_WHOLE_LINES ||
      current.bytes + bytes > MAX_WHOLE_BYTES
    ) {
      close();
      current = { firstLine: line, lineCount: 0, start: at, bytes: 0 };
    }
    current.lineCount++;
    current.bytes += bytes;
    cut = fits >= 0;
    shownTo = cut ? fits : end;
    if (end >= text.length) break;
    at = next;
  }
  close();
  return { blocks, totalLines: line };
}

/** The block holding `line`: the last one for a line past the end. */
export function blockHolding(blocks: readonly Block[], line: number): Block {
  let low = 0;
  let high = blocks.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((blocks[middle] as Block).firstLine <= line) low = middle;
    else high = middle - 1;
  }
  return blocks[low] as Block;
}

/** A positive whole number in a query: an out-of-range one is the caller's to clamp. */
function positive(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= 1 ? number : null;
}

function rangeWithin(first: number, last: number, total: number): LineRange {
  const clamp = (line: number) => Math.max(1, Math.min(line, total));
  return { start: clamp(Math.min(first, last)), end: clamp(Math.max(first, last)) };
}

/**
 * `12` or `12-20` as lines of a file of `total`: reversed ones swapped, ones out of range
 * clamped, and anything else null.
 */
export function parseLineRange(value: string | null, total: number): LineRange | null {
  const match = value === null ? null : /^(\d+)(?:-(\d+))?$/.exec(value);
  if (!match) return null;
  const first = Number(match[1]);
  return rangeWithin(first, match[2] === undefined ? first : Number(match[2]), total);
}

/** `#L12` or `#L12-L20`, by the same rule. */
export function parseLineFragment(hash: string, total: number): LineRange | null {
  const match = /^#L(\d+)(?:-L(\d+))?$/.exec(hash);
  if (!match) return null;
  return parseLineRange(
    match[2] === undefined ? (match[1] as string) : `${match[1]}-${match[2]}`,
    total,
  );
}

/**
 * The canonical link to `range`: the query is what the server sees (it picks the block and
 * marks the lines), the fragment what scrolls to the first of them.
 */
export function lineLink(range: LineRange | null, plain: boolean): string {
  const query = plain ? ["plain=1"] : [];
  if (range === null) return query.length > 0 ? `?${query.join("&")}` : "";
  query.push(`line=${range.start === range.end ? range.start : `${range.start}-${range.end}`}`);
  return `?${query.join("&")}#L${range.start}`;
}

/** The link to the block starting at `from`, keeping the lines selected. */
export function blockLink(from: number, selected: string | null, plain: boolean): string {
  const query = plain ? ["plain=1"] : [];
  query.push(`from=${from}`);
  if (selected !== null) query.push(`line=${selected}`);
  return `?${query.join("&")}`;
}

/** The query's form of `range`. */
export function lineParam(range: LineRange | null): string | null {
  if (range === null) return null;
  return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
}

/**
 * A file's raw bytes on the web's own route. The trailing slash is what the route ignores
 * and a name ending in `.data` needs: `dataSuffixRedirect` only fixes navigations, and any
 * other request for such a path would get React Router's loader data.
 */
export function rawBytesUrl(owner: string, repo: string, ref: string, path: string): string {
  return `/${owner}/${repo}/raw/${encodeURIComponent(ref)}/${encodePath(path)}/`;
}

/** Which lines a URL selects, which it opens at, and what to rewrite it to. */
export interface LineLocation {
  readonly selection: LineRange | null;
  /** The line to bring into view. */
  readonly position: number | null;
  /** The URL's canonical form (a query and fragment), when a fragment overruled its query. */
  readonly canonical: string | null;
}

/**
 * What a URL means with JavaScript. A fragment naming the first line of the query's range is
 * canonical, so the whole range is selected. Any other fragment that parses wins, and the URL
 * is to be rewritten. A valid `from` only moves the view, never the selection.
 */
export function readLineLocation({
  search,
  hash,
  total,
}: {
  search: string;
  hash: string;
  total: number;
}): LineLocation {
  const query = new URLSearchParams(search);
  const asked = parseLineRange(query.get("line"), total);
  const named = parseLineFragment(hash, total);
  const canonicalHash = named !== null && !hash.includes("-") && named.start === asked?.start;
  if (named !== null && !canonicalHash) {
    const plain = query.get("plain") === "1";
    return { selection: named, position: named.start, canonical: lineLink(named, plain) };
  }
  const from = positive(query.get("from"));
  return {
    selection: asked,
    position: from !== null ? Math.min(from, total) : (asked?.start ?? null),
    canonical: null,
  };
}

/**
 * Where a go-to-line request goes: a form can't set a fragment, and the server never sees
 * one. `page` is the page's own URL (`pageUrl`), so the target holds its real path; `total`
 * is the file's last line, null with no numbered lines to go to. Only a positive integer
 * goes to a line, clamped to the last.
 */
export function gotoTarget(page: URL, total: number | null): string {
  const target = new URL(page);
  const line = positive(target.searchParams.get("goto"));
  for (const name of ["goto", "from", "line"]) target.searchParams.delete(name);
  if (line !== null && total !== null) {
    const last = Math.min(line, total);
    target.searchParams.set("line", String(last));
    target.hash = `L${last}`;
  }
  // The page itself, not a redirect to it (a navigation to a path ending so gets one).
  if (target.pathname.endsWith(".data")) target.pathname = `${target.pathname}/`;
  return `${target.pathname}${target.search}${target.hash}`;
}

/** The commit a contents answer's `download_url` is at (always a commit: `rawUrl` in the API). */
function commitOf(downloadUrl: string): string | null {
  try {
    return new URL(downloadUrl).searchParams.get("ref");
  } catch {
    return null;
  }
}

/** Which block a request's query shows: `from`, else the first line it selects, else the first. */
function chosenBlock(blocks: readonly Block[], query: URLSearchParams, selected: LineRange | null) {
  const from = query.get("from");
  const line = from === null ? (selected?.start ?? 1) : (positive(from) ?? 1);
  return blockHolding(blocks, line);
}

/** What the page shows for `contents`, read at the lines `query` asks for. */
export function fileState(
  contents: FileContents,
  query: URLSearchParams,
  { markdown = false }: { markdown?: boolean } = {},
): FileState {
  if (contents.type === "submodule") return { state: "submodule", sha: contents.sha };
  if (contents.type === "symlink") return { state: "symlink", target: contents.target };
  if (contents.encoding === "none")
    return { state: contents.size > MAX_RAW_BYTES ? "too-large-for-raw" : "too-large" };
  if (contents.size === 0) return { state: "empty" };
  const bytes = classifyBytes(bytesOfBase64(contents.content));
  if (bytes.kind !== "text") return { state: bytes.kind };
  const plain = markdown && query.get("plain") === "1";
  if (markdown && !plain) return { state: "markdown", source: bytes.text };
  const text = withoutFinalEnding(bytes.text);
  const { blocks, totalLines } = scanBlocks(text);
  const selected = parseLineRange(query.get("line"), totalLines);
  const whole = contents.size <= MAX_WHOLE_BYTES && totalLines <= MAX_WHOLE_LINES;
  const block = whole ? null : chosenBlock(blocks, query, selected);
  const at = block ? blocks.indexOf(block) : 0;
  return {
    state: "text",
    text: block ? text.slice(block.start, block.end) : text,
    firstLine: block?.firstLine ?? 1,
    totalLines,
    whole,
    cut: block?.cut ?? false,
    previous: block ? (blocks[at - 1]?.firstLine ?? null) : null,
    next: block ? (blocks[at + 1]?.firstLine ?? null) : null,
    selected,
    commit: commitOf(contents.download_url),
    sha: contents.sha,
    size: contents.size,
    plain,
  };
}
