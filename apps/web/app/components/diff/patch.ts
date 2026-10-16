import type { DiffSide } from "../../lib/pulls.js";

/*
 * A pull request file's hunks as the diff renderer reads them. The API gives
 * a file's hunks alone (from the first `@@` line, no file header), so the
 * renderer's parser is handed a fixed header and the file's own name and
 * kind are set after: a path is never parsed out of patch text, whatever
 * characters it holds.
 */

/** Line ranges a file's hunks show, per side: `[first, last]`, inclusive. */
export type ShownLines = Record<DiffSide, [number, number][]>;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The lines each side of `patch` shows (its hunks' ranges; context lines count for both). */
export function shownLines(patch: string): ShownLines {
  const shown: ShownLines = { LEFT: [], RIGHT: [] };
  for (const line of patch.split("\n")) {
    const m = HUNK_HEADER.exec(line);
    if (!m) continue;
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (oldCount > 0) shown.LEFT.push([oldStart, oldStart + oldCount - 1]);
    if (newCount > 0) shown.RIGHT.push([newStart, newStart + newCount - 1]);
  }
  return shown;
}

/** Whether `line` on `side` is one the hunks show. */
export function isShown(shown: ShownLines, side: DiffSide, line: number): boolean {
  return shown[side].some(([first, last]) => line >= first && line <= last);
}

/** The renderer's side for the API's. */
export const rendererSide = (side: DiffSide): "deletions" | "additions" =>
  side === "LEFT" ? "deletions" : "additions";

/** The API's side for the renderer's. */
export const apiSide = (side: "deletions" | "additions" | undefined): DiffSide =>
  side === "deletions" ? "LEFT" : "RIGHT";

/** The text the renderer parses for a file: a fixed header, then the API's hunks. */
export function rendererPatch(hunks: string): string {
  return `--- a/file\n+++ b/file\n${hunks}`;
}

/** The renderer's kind of change for the API's file status. */
export function changeType(
  status: string,
  hasChanges: boolean,
): "new" | "deleted" | "rename-pure" | "rename-changed" | "change" {
  if (status === "added") return "new";
  if (status === "removed") return "deleted";
  if (status === "renamed") return hasChanges ? "rename-changed" : "rename-pure";
  return "change";
}
