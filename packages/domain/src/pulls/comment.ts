import { atLeast, type RepoRole } from "../authz/roles.js";

/** The longest comment, in characters (GitHub's). */
export const MAX_COMMENT_BODY_LENGTH = 65_536;

/**
 * Whether a caller may write, edit or delete a conversation comment.
 * Anyone who reads the repository may comment; the author of a comment
 * (by root identity) edits and deletes its own, and write access and
 * above anyone's.
 */
export function decideComment(
  action: "create" | "edit" | "delete",
  input: { readonly isCommentAuthor: boolean; readonly role: RepoRole | null },
): { ok: true } | { ok: false; refusal: "forbidden" } {
  if (!atLeast(input.role, "read")) return { ok: false, refusal: "forbidden" };
  if (action !== "create" && !input.isCommentAuthor && !atLeast(input.role, "write"))
    return { ok: false, refusal: "forbidden" };
  return { ok: true };
}
