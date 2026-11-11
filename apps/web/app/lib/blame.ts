/**
 * The blame page's rules, shared by its loader and the browser. Blame numbers a file's lines
 * as the engine counts them (`countLines`, packages/git-core/src/blame/walk.ts): a line ends
 * at a line feed only, a final one starts no line, and a carriage return is part of its line.
 * The file view's helpers also break at a lone CR, as its renderer does, so they aren't used
 * here: their numbers would leave the API's after the first one.
 */
import type { getBlame, Output } from "@fyrden/api-contract";
import { type Block, type LineRange, MAX_WHOLE_BYTES, MAX_WHOLE_LINES } from "./file-view.js";
import { encodePath } from "./types.js";

export type BlameAnswer = Output<typeof getBlame>;
export type Range = BlameAnswer["ranges"][number];
export type CommitFacts = BlameAnswer["commits"][string];

/** One window of a blamed file as the page draws it: its lines, and the ranges over them. */
export interface BlameView {
  readonly owner: string;
  readonly repo: string;
  /** The ref the page was asked for, and the commit blame resolved it to. */
  readonly ref: string;
  readonly commit: string;
  readonly path: string;
  readonly blame: {
    readonly state: BlameAnswer["state"];
    readonly lines: number;
    readonly resolved: number;
    readonly unresolved: number;
    /** The settled ranges overlapping this window, whole (not clipped). */
    readonly ranges: readonly Range[];
    readonly commits: Readonly<Record<string, CommitFacts>>;
  };
  readonly window: {
    readonly firstLine: number;
    readonly lastLine: number;
    /** Its one line is longer than a window holds, and stops short of its end. */
    readonly cut: boolean;
    readonly previous: number | null;
    readonly next: number | null;
    readonly lines: readonly { number: number; text: string }[];
  };
  /** The whole file is this one window. */
  readonly whole: boolean;
  readonly selected: LineRange | null;
  /** A carriage return not ending a CRLF: the renderer would number lines differently. */
  readonly loneCr: boolean;
}

/** A blame page's path, at `ref` (the commit, once known: a branch may move). */
export function blamePath(owner: string, repo: string, ref: string, path: string): string {
  return `/${owner}/${repo}/blame/${encodeURIComponent(ref)}/${encodePath(path)}`;
}

/** The most lines blame takes (`MAX_BLAME_LINES`): no page asks past it. */
export const BLAME_LIMIT_LINES = 100_000;

/**
 * A file's bytes as blame's text. A byte order mark is kept, as U+FEFF on the first line: the
 * engine counts its bytes, so a file holding only one has a line.
 */
export function decodeBlameBytes(
  bytes: Uint8Array,
): { kind: "text"; text: string } | { kind: "binary" } | { kind: "undecodable" } {
  if (bytes.includes(0)) return { kind: "binary" };
  try {
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } catch {
    return { kind: "undecodable" };
  }
}

const LF = 0x0a;
const CR = 0x0d;

/** Whether `text` has a carriage return not directly followed by a line feed. */
export function hasLoneCr(text: string): boolean {
  for (let at = text.indexOf("\r"); at >= 0; at = text.indexOf("\r", at + 1))
    if (text.charCodeAt(at + 1) !== LF) return true;
  return false;
}

/**
 * The blocks of `text` by the file view's rules, numbered at line feeds: a block ends at
 * `MAX_WHOLE_LINES` or before the line, its ending counted, that would take it past
 * `MAX_WHOLE_BYTES`; a longer line is alone, cut there. `start` and `end` are offsets into
 * `text`, `end` short of the last line's ending.
 */
export function blameBlocks(text: string): { blocks: Block[]; totalLines: number } {
  const blocks: Block[] = [];
  if (text.length === 0) return { blocks, totalLines: 0 };
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
  while (at < text.length) {
    line++;
    let bytes = 0;
    let fits = -1;
    let end = at;
    while (end < text.length) {
      const unit = text.charCodeAt(end);
      if (unit === LF) break;
      // A pair is one 4-byte character, and a cut stays out of it.
      const pair = unit >= 0xd800 && unit <= 0xdbff;
      const size = unit < 0x80 ? 1 : unit < 0x800 ? 2 : pair ? 4 : 3;
      if (bytes + size > MAX_WHOLE_BYTES && fits < 0) fits = end;
      bytes += size;
      end += pair ? 2 : 1;
    }
    const next = end < text.length ? end + 1 : end;
    bytes += next - end;
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
    at = next;
  }
  close();
  return { blocks, totalLines: line };
}

/**
 * A block's lines as the page draws them. A CR ending a line before its line feed isn't drawn;
 * any other CR is drawn as ␍: as itself, HTML parsing would turn it into a line feed, breaking
 * the line and the hydrated text apart.
 */
export function drawnLines(text: string, block: Block): { number: number; text: string }[] {
  const pieces = text.slice(block.start, block.end).split("\n");
  return pieces.map((piece, index) => {
    const number = block.firstLine + index;
    // Every line but a block's last ends at a line feed; its last does if one follows it.
    const ended = index < pieces.length - 1 || text.charCodeAt(block.end) === LF;
    const shown = ended && piece.charCodeAt(piece.length - 1) === CR ? piece.slice(0, -1) : piece;
    return { number, text: shown.replaceAll("\r", "␍") };
  });
}

/** A positive whole number written in `value`, capped at blame's limit; null for anything else. */
function lineNumber(value: string | undefined | null): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const digits = value.replace(/^0+/, "");
  if (digits.length === 0) return null;
  // Compared as digits first, so no number is ever read past the safe range.
  if (digits.length > String(BLAME_LIMIT_LINES).length) return BLAME_LIMIT_LINES;
  return Math.min(Number(digits), BLAME_LIMIT_LINES);
}

/**
 * The line a page opens at: `from`, else the smaller end of `line`, else 1, read as the file
 * view reads them (an invalid `from` opens at 1), capped at blame's line limit. Known before
 * the file's length, so the loader can ask for the window that holds it.
 */
export function blameTarget(query: URLSearchParams): number {
  const from = query.get("from");
  if (from !== null) return lineNumber(from) ?? 1;
  const match = /^(\d+)(?:-(\d+))?$/.exec(query.get("line") ?? "");
  if (!match) return 1;
  const ends = [lineNumber(match[1]), lineNumber(match[2] ?? match[1])].map((n) => n ?? 1);
  return Math.min(...ends);
}

/**
 * The window to ask blame for so the block holding `target` is inside it: a block holds at
 * most `MAX_WHOLE_LINES`, so it lies within that many lines either side (3,999, under the
 * API's 5,000).
 */
export function blameWindow(target: number): { start: number; end: number } {
  return { start: Math.max(1, target - (MAX_WHOLE_LINES - 1)), end: target + MAX_WHOLE_LINES - 1 };
}

/** One annotation row: what a run of lines is attributed to, or why it isn't yet. */
export type Group =
  | { kind: "commit"; commit: string; startLine: number; lineCount: number }
  | { kind: "unresolved"; reason: string; startLine: number; lineCount: number }
  | { kind: "pending"; startLine: number; lineCount: number };

/**
 * Lines `first` to `last` as drawn groups: adjacent ranges of one commit merged whatever their
 * source lines, adjacent unresolved lines of one reason merged, and each stretch no range
 * covers pending. Ranges come in any order and may overlap the edges; they don't overlap each
 * other (each line is settled once).
 */
export function displayGroups(ranges: readonly Range[], first: number, last: number): Group[] {
  const groups: Group[] = [];
  const sorted = [...ranges].sort((a, b) => a.start_line - b.start_line);
  let line = first;
  const push = (group: Group) => {
    const previous = groups.at(-1);
    if (
      previous &&
      previous.startLine + previous.lineCount === group.startLine &&
      previous.kind === group.kind &&
      (group.kind !== "commit" || (previous as { commit: string }).commit === group.commit) &&
      (group.kind !== "unresolved" || (previous as { reason: string }).reason === group.reason)
    )
      previous.lineCount += group.lineCount;
    else groups.push(group);
  };
  for (const range of sorted) {
    const start = Math.max(range.start_line, first);
    const end = Math.min(range.start_line + range.line_count - 1, last);
    if (start > end) continue;
    if (start > line) push({ kind: "pending", startLine: line, lineCount: start - line });
    const lineCount = end - start + 1;
    push(
      "unresolved" in range
        ? { kind: "unresolved", reason: range.unresolved, startLine: start, lineCount }
        : { kind: "commit", commit: range.commit, startLine: start, lineCount },
    );
    line = Math.max(line, end + 1);
  }
  if (line <= last) push({ kind: "pending", startLine: line, lineCount: last - line + 1 });
  return groups;
}

type Reason = Extract<Range, { unresolved: unknown }>["unresolved"];

/** Why lines aren't attributed, in words, one sentence a reason (none offers to continue). */
const UNRESOLVED: Record<Reason, string> = {
  parent_too_large:
    "Not attributed: an earlier version of this file is over blame's 1 MiB or 100,000-line limit, so it couldn't be compared.",
  too_many_parents: "Not attributed: a merge here has more parents than blame reads.",
  diff_budget: "Not attributed: this diff was too expensive to settle exactly.",
  slide_unsettled: "Not attributed: where these lines moved is too close a call to settle exactly.",
  object_limit:
    "Some lines could not be attributed because reading their history requires an object larger than Fyrden's 4 MiB blame limit. The current file may be smaller. Resolved lines remain shown.",
  work_limit:
    "Some lines could not be attributed because reading their history takes more reads or decoding than one request allows. Asking again won't change this. Resolved lines remain shown.",
  history_unreadable:
    "Not attributed: part of this file's history can't be read. Asking again won't change this.",
  history_missing:
    "Not attributed: a commit in this file's history is missing from the repository.",
  history_limit: "Not attributed: this file's history has more steps than blame follows.",
  state_limit: "Not attributed: this file's blame grew larger than Fyrden keeps for one file.",
  commit_info_too_large:
    "Not attributed: the commit that changed these lines is too large to read.",
  rename_possible:
    "Not attributed: these lines may have come from another file, and blame doesn't follow renames.",
  step_lost:
    "Not attributed: blame failed at this point in the history and won't try it again until this blame expires.",
};

export function unresolvedSentence(reason: string): string {
  return Object.hasOwn(UNRESOLVED, reason)
    ? UNRESOLVED[reason as Reason]
    : `Not attributed (${reason}).`;
}

/** An author time as git prints it (`1700000000 +0100`): its date where the author was. */
export function authorDate(date: string): string {
  const match = /^(-?\d+) ([+-])(\d{2})(\d{2})$/.exec(date);
  if (!match) return date;
  const offset = (match[2] === "-" ? -1 : 1) * (Number(match[3]) * 60 + Number(match[4]));
  const at = new Date((Number(match[1]) + offset * 60) * 1000);
  return Number.isNaN(at.getTime()) ? date : at.toISOString().slice(0, 10);
}
