import { applySuggestions, parseSuggestion, type SuggestionEdit } from "@fyrden/domain";
import { type Browsed, fail, type RepoBrowse } from "./browse.js";
import { rawFile } from "./contents.js";
import { FILE_WRITE_POLICY, type FileWriteChange } from "./file-writes.js";
import type { PullRecord } from "./pulls.js";
import type { ReviewCommentRecord } from "./review-comments.js";

/*
 * Applying suggested changes: the suggestions of diff comments anchored to
 * a pull request's current head, as one commit on its head branch made
 * through the file-write path (the branch moves only from that head).
 */

/** Suggestions one commit applies at most. Proposed. */
export const MAX_SUGGESTIONS = 50;

const TOO_LARGE = fail(
  422,
  "too_large",
  `The files the suggestions change come to more than ${FILE_WRITE_POLICY.maxContentBytes} bytes; apply fewer at once.`,
);

/** The largest file a suggestion is applied to (as a diff comment's anchor). */
export const SUGGESTION_MAX_FILE_BYTES = 1024 * 1024;

/**
 * The file changes `comments` suggest for `pull`: each comment must be on
 * it, on the head side, at its current head, and hold one suggestion;
 * suggestions to one file must not overlap.
 */
export async function suggestedChanges(
  browse: RepoBrowse,
  pull: PullRecord,
  comments: readonly (ReviewCommentRecord | undefined)[],
  ids: readonly number[],
): Promise<Browsed<FileWriteChange[]>> {
  const byPath = new Map<string, SuggestionEdit[]>();
  for (const [k, comment] of comments.entries()) {
    const id = ids[k] as number;
    if (comment?.number !== pull.number)
      return fail(404, "comment_not_found", `The pull request has no review comment ${id}.`);
    const { anchor } = comment;
    if (anchor.side !== "RIGHT")
      return fail(
        422,
        "not_applicable",
        `Comment ${id} is on the base side; only the head's lines change.`,
      );
    if (anchor.commitSha !== pull.headSha)
      return fail(
        422,
        "outdated",
        `Comment ${id} is on an earlier head; suggest the change again.`,
      );
    const replacement = parseSuggestion(comment.body);
    if (replacement === undefined)
      return fail(422, "not_a_suggestion", `Comment ${id} does not hold one suggestion.`);
    const edits = byPath.get(anchor.path) ?? [];
    edits.push({ startLine: anchor.startLine ?? anchor.line, line: anchor.line, replacement });
    byPath.set(anchor.path, edits);
  }
  const changes: FileWriteChange[] = [];
  // What one write may carry, counted as it goes: no more is kept past it.
  let bytes = 0;
  for (const [path, edits] of byPath) {
    const file = await rawFile(browse, pull.headSha, path, SUGGESTION_MAX_FILE_BYTES);
    if (!file.ok) return file;
    // A symlink's target is not lines to change (and a write would make it a file).
    if ((file.value.mode & 0o170000) !== 0o100000)
      return fail(422, "not_applicable", `${path} is not a regular file.`);
    const applied = applySuggestions(file.value.bytes, edits);
    if (applied === "overlapping")
      return fail(422, "overlapping", `Suggestions to ${path} overlap; apply them one at a time.`);
    if (applied === "line_out_of_range")
      return fail(422, "line_out_of_range", `A suggestion to ${path} is past its end.`);
    bytes += applied.length;
    if (bytes > FILE_WRITE_POLICY.maxContentBytes) return TOO_LARGE;
    changes.push({ path, content: applied, expectedSha: file.value.sha });
  }
  return { ok: true, value: changes };
}
