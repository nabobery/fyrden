import { atLeast, type RepoRole } from "../authz/roles.js";

/** The longest comment, in characters (GitHub's). */
export const MAX_COMMENT_BODY_LENGTH = 65_536;

/**
 * Whether a caller may write, edit or delete a comment on an issue or a
 * pull request (its conversation or its diff). Anyone who reads the
 * repository may comment; the author of a comment (by root identity) edits
 * and deletes its own, and write access and above anyone's. While the
 * conversation is locked, only write and above may do any of it (GitHub's).
 */
export function decideComment(
  action: "create" | "edit" | "delete",
  input: {
    readonly isCommentAuthor: boolean;
    readonly role: RepoRole | null;
    /** The issue's or pull request's conversation is locked. */
    readonly locked?: boolean;
  },
): { ok: true } | { ok: false; refusal: "forbidden" | "locked" } {
  if (!atLeast(input.role, "read")) return { ok: false, refusal: "forbidden" };
  if (action !== "create" && !input.isCommentAuthor && !atLeast(input.role, "write"))
    return { ok: false, refusal: "forbidden" };
  if (input.locked && !atLeast(input.role, "write")) return { ok: false, refusal: "locked" };
  return { ok: true };
}
