/**
 * Conflicted files as the conflicts editor works on them: text with git's
 * conflict markers, the head's side first (`<<<<<<<`, `=======`, `>>>>>>>`,
 * each marker line named as the server names it; a `|||||||` section, if
 * any, holds the merge base's lines).
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

/** The text's lines, each with its line break. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** The complete conflicts in `text`, in order (a region missing a marker is not one). */
export function conflictRegions(text: string): ConflictRegion[] {
  const regions: ConflictRegion[] = [];
  let at = 0;
  let open: {
    start: number;
    head: string;
    base: string;
    part: "head" | "ancestor" | "base";
  } | null = null;
  for (const line of linesOf(text)) {
    if (line.startsWith("<<<<<<<")) open = { start: at, head: "", base: "", part: "head" };
    else if (open && line.startsWith("|||||||") && open.part === "head") open.part = "ancestor";
    else if (open && /^=======(\r?\n|$)/.test(line) && open.part !== "base") open.part = "base";
    else if (open && line.startsWith(">>>>>>>") && open.part === "base") {
      regions.push({ start: open.start, end: at + line.length, head: open.head, base: open.base });
      open = null;
    } else if (open?.part === "head") open.head += line;
    else if (open?.part === "base") open.base += line;
    at += line.length;
  }
  return regions;
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
