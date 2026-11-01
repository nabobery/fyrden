import { atLeast, type RepoRole } from "../authz/roles.js";

/** What a reaction says (GitHub's eight). */
export const REACTION_CONTENTS = [
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
] as const;
export type ReactionContent = (typeof REACTION_CONTENTS)[number];

/** What a reaction is on: an issue or pull request (by number), a conversation comment, a diff comment. */
export const REACTION_TARGETS = ["subject", "comment", "review_comment"] as const;
export type ReactionTarget = (typeof REACTION_TARGETS)[number];

/**
 * Whether a caller with `role` (capped by any agents' owners) may react,
 * or take its reaction back: anyone who reads the repository, while the
 * conversation is open; only write access and above while it is locked
 * (as comments).
 */
export function decideReaction(input: {
  readonly role: RepoRole | null;
  readonly locked: boolean;
}): { ok: true } | { ok: false; refusal: "forbidden" | "locked" } {
  if (!atLeast(input.role, "read")) return { ok: false, refusal: "forbidden" };
  if (input.locked && !atLeast(input.role, "write")) return { ok: false, refusal: "locked" };
  return { ok: true };
}
