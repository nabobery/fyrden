import { atLeast, type RepoRole } from "../authz/roles.js";

/**
 * Comments on a pull request's diff: each starts a thread anchored to a
 * line (or a range of lines) of one file, on one side of the comparison,
 * at a head the pull request has had; replies join the thread. A thread
 * is resolved or not as a whole.
 */

/** `LEFT`: the base side (the merge base's file); `RIGHT`: the head side. */
export const COMMENT_SIDES = ["LEFT", "RIGHT"] as const;
export type CommentSide = (typeof COMMENT_SIDES)[number];

export interface CommentAnchor {
  readonly side: CommentSide;
  /** The last line commented on, from 1. */
  readonly line: number;
  /** The first, for a range; null for one line. */
  readonly startLine: number | null;
}

export type AnchorRefusal = "line_out_of_range" | "invalid_range";

/**
 * Whether an anchor fits a file of `lineCount` lines: lines from 1 to the
 * last, a range's first line before its last (GitHub's rule for
 * `start_line`). Whether the lines are part of the diff is not checked.
 */
export function checkAnchor(anchor: CommentAnchor, lineCount: number): AnchorRefusal | undefined {
  if (anchor.startLine !== null && anchor.startLine >= anchor.line) return "invalid_range";
  if (anchor.line > lineCount || (anchor.startLine ?? anchor.line) < 1) return "line_out_of_range";
  return undefined;
}

/** Lines of a file as git counts them: a last line without a line break is one. */
export function lineCount(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines++;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? lines + 1 : lines;
}

/**
 * Whether a caller may resolve or unresolve a thread, as GitHub allows:
 * the pull request's author (any role that reads), or write access and above.
 */
export function decideResolution(input: {
  readonly isPullAuthor: boolean;
  readonly role: RepoRole | null;
}): { ok: true } | { ok: false; refusal: "forbidden" } {
  if (!atLeast(input.role, "read")) return { ok: false, refusal: "forbidden" };
  if (!input.isPullAuthor && !atLeast(input.role, "write"))
    return { ok: false, refusal: "forbidden" };
  return { ok: true };
}
