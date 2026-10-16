/**
 * Conflicted files as the conflicts editor works on them: text with git's
 * conflict markers, the head's side first. The server writes each marker as
 * a whole line: `<<<<<<< <head branch>`, `=======`, `>>>>>>> <base branch>`.
 */

export type ConflictKind =
  | "content"
  | "add_add"
  | "modify_delete"
  | "file_directory"
  | "mode"
  | "symlink"
  | "submodule"
  | "binary"
  | "too_large";

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
  editable: boolean;
  content: string | null;
  conflicts: number;
}

export interface Conflicts {
  base_sha: string;
  head_sha: string;
  conflict_snapshot: string;
  files: ConflictFile[];
}

/** Why a conflict cannot be resolved in the browser, in words. */
export const KIND_TEXT: Record<ConflictKind, string> = {
  content: "Both sides changed the same lines.",
  add_add: "Both sides added this file with different contents.",
  modify_delete: "One side changed this file and the other deleted it.",
  file_directory: "One side has a file here and the other a directory.",
  mode: "The sides changed the file's mode differently.",
  symlink: "A symbolic link conflicts.",
  submodule: "A submodule conflicts.",
  binary: "A binary file conflicts.",
  too_large: "The file is too large to merge here.",
};

/** A conflict's place in a file's text: the marker lines included, and each side's lines. */
export interface ConflictRegion {
  /** Offset of its `<<<<<<<` line. */
  start: number;
  /** Offset just after its `>>>>>>>` line (and that line's line break). */
  end: number;
  head: string;
  base: string;
}

/** The branch names the marker lines carry. */
export interface MarkerLabels {
  head: string;
  base: string;
}

/** A file's conflicts as its markers say. */
export interface ConflictReading {
  /** The complete conflicts, in order. */
  regions: ConflictRegion[];
  /**
   * The markers do not read as whole conflicts (one inside another, one
   * left open, an end with no start): the regions cannot be trusted, and the
   * file is edited by hand.
   */
  ambiguous: boolean;
  /** Offsets of lines that start like a conflict's first marker (to move between). */
  starts: number[];
}

/** The text's lines, each with its line break. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A line without its line break. */
const bare = (line: string) => line.replace(/\r?\n$/, "");

/** Reads `text`'s conflicts from its exact marker lines. */
export function readConflicts(text: string, labels: MarkerLabels): ConflictReading {
  const open = `<<<<<<< ${labels.head}`;
  const close = `>>>>>>> ${labels.base}`;
  const regions: ConflictRegion[] = [];
  const starts: number[] = [];
  let ambiguous = false;
  let at = 0;
  let region: { start: number; head: string; base: string; part: "head" | "base" } | null = null;
  for (const line of linesOf(text)) {
    const marker = bare(line);
    if (line.startsWith("<<<<<<<")) starts.push(at);
    if (marker === open) {
      // A start inside a conflict: nested or literal, it cannot be told.
      if (region) ambiguous = true;
      region = { start: at, head: "", base: "", part: "head" };
    } else if (region && marker === "=======") {
      if (region.part === "base") ambiguous = true;
      region.part = "base";
    } else if (marker === close) {
      if (region?.part === "base")
        regions.push({
          start: region.start,
          end: at + line.length,
          head: region.head,
          base: region.base,
        });
      else ambiguous = true;
      region = null;
    } else if (region?.part === "head") region.head += line;
    else if (region?.part === "base") region.base += line;
    at += line.length;
  }
  if (region) ambiguous = true;
  return { regions, ambiguous, starts };
}

export type Choice = "head" | "base" | "both";

/** `text` with `region` replaced by the chosen side (or both, head first). */
export function resolveRegion(text: string, region: ConflictRegion, choice: Choice): string {
  const kept =
    choice === "head" ? region.head : choice === "base" ? region.base : region.head + region.base;
  return text.slice(0, region.start) + kept + text.slice(region.end);
}

/** A file's line breaks: all CRLF, all LF (or none), or a mix. */
export type LineEnding = "crlf" | "lf" | "mixed";

export function lineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (crlf === 0) return "lf";
  return crlf === lf ? "crlf" : "mixed";
}

/**
 * A textarea's submitted text with the file's own line breaks: browsers send
 * every line break as CRLF, so an LF file is turned back (a mixed one too,
 * which cannot be told apart: it is saved with LF).
 */
export function withLineEndings(submitted: string, ending: LineEnding): string {
  const lf = submitted.replaceAll("\r\n", "\n");
  return ending === "crlf" ? lf.replaceAll("\n", "\r\n") : lf;
}

/** `word` quoted for a POSIX shell: a branch name may hold `$`, `;` or a backquote. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** What the conflicts page shows and allows, from what it holds and what it last heard. */
export interface ConflictsView {
  /** The editors stay on the page (their edits are never dropped by a later read). */
  editors: boolean;
  /** The conflicts edited are no longer the latest: sending them would be refused. */
  moved: boolean;
  canSubmit: boolean;
  /** What "Read the conflicts again" does: take the latest read, or ask for one (it failed). */
  readAgain: "adopt" | "revalidate";
  /** The last refusal is about the conflicts being edited (not ones read over since). */
  showRefusal: boolean;
}

export function conflictsView(state: {
  /** The snapshot of the conflicts being edited; null when none are. */
  adopted: string | null;
  /** The snapshot of the latest read with conflicts; null when it found none or failed. */
  latest: string | null;
  /** Why the latest read failed, if it did. */
  failure: string | null;
  open: boolean;
  answer?:
    | {
        ok?: boolean | undefined;
        stale?: boolean | undefined;
        snapshot?: string | undefined;
        error?: string | undefined;
      }
    | undefined;
}): ConflictsView {
  const resolved = state.answer?.ok === true;
  const editors = state.adopted !== null && !resolved;
  const refusalHere =
    state.answer?.error !== undefined &&
    (state.answer.snapshot === undefined || state.answer.snapshot === state.adopted);
  const moved =
    !resolved &&
    ((refusalHere && state.answer?.stale === true) ||
      (state.open && state.failure === null && state.latest !== state.adopted));
  return {
    editors,
    moved,
    canSubmit: editors && state.open && state.failure === null && !moved,
    readAgain: state.failure !== null ? "revalidate" : "adopt",
    showRefusal: refusalHere,
  };
}
