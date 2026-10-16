import { z } from "zod";

/** Where a pull request stands. Only a merge makes one `merged`, and nothing undoes it. */
export const PULL_STATES = ["open", "closed", "merged"] as const;
export type PullState = (typeof PULL_STATES)[number];

/** The longest title, in characters (GitHub's). */
export const MAX_PULL_TITLE_LENGTH = 256;
/** The longest body, in characters (GitHub's). */
export const MAX_PULL_BODY_LENGTH = 65_536;

/** The entity type pull request snapshots travel as in events. */
export const PULL_ENTITY = "pull_request";

/** The ref the server keeps at a pull request's head revision; clients may fetch it, not push it. */
export function pullHeadRef(number: number): string {
  return `refs/pull/${number}/head`;
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const branch = z.string().min(1).max(1024);

/** A pull request as events carry it. */
export const PullRequestRowSchema = z.strictObject({
  number: z.number().int().positive(),
  title: z.string().min(1).max(MAX_PULL_TITLE_LENGTH),
  body: z.string().max(MAX_PULL_BODY_LENGTH).nullable(),
  state: z.enum(PULL_STATES),
  draft: z.boolean(),
  /** Who opened it, and the root identity it counts as (the user its agents act for). */
  authorId: z.string(),
  authorRoot: z.string(),
  /** Branch names, without `refs/heads/`. */
  baseRef: branch,
  headRef: branch,
  /** The repository the head branch is in, another member of the fork network; null for this one. */
  headRepoId: z.string().nullable(),
  /** The author lets the base's maintainers write the head branch (in another repository). */
  maintainerCanModify: z.boolean(),
  baseSha: sha,
  headSha: sha,
  /** The head branch was deleted: the pull request stays at its last head revision. */
  headRefDeleted: z.boolean(),
  /** Bumped by each reopen: work started for an earlier opening does not apply. */
  generation: z.number().int().positive(),
  closedAt: z.number().int().min(0).nullable(),
  /** Set once merged: the commit the base branch moved to, who merged, when. */
  mergeCommitSha: sha.nullable(),
  mergedBy: z.string().nullable(),
  mergedAt: z.number().int().min(0).nullable(),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});
export type PullRequestRow = z.infer<typeof PullRequestRowSchema>;
