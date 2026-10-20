import { z } from "zod";

/** Where an issue stands. */
export const ISSUE_STATES = ["open", "closed"] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

/**
 * Why an issue is in its state (GitHub's): `completed`, `not_planned` and
 * `duplicate` for a closed one, `reopened` for an open one reopened; null
 * for one never closed.
 */
export const ISSUE_STATE_REASONS = ["completed", "not_planned", "duplicate", "reopened"] as const;
export type IssueStateReason = (typeof ISSUE_STATE_REASONS)[number];

/** Why a conversation was locked (GitHub's). */
export const LOCK_REASONS = ["off-topic", "too heated", "resolved", "spam"] as const;
export type LockReason = (typeof LOCK_REASONS)[number];

/** The longest title, in characters (GitHub's). */
export const MAX_ISSUE_TITLE_LENGTH = 256;
/** The longest body, in characters (GitHub's). */
export const MAX_ISSUE_BODY_LENGTH = 65_536;

/** The entity type issue snapshots travel as in events. */
export const ISSUE_ENTITY = "issue";

/** An issue as events carry it. */
export const IssueRowSchema = z.strictObject({
  number: z.number().int().positive(),
  title: z.string().min(1).max(MAX_ISSUE_TITLE_LENGTH),
  body: z.string().max(MAX_ISSUE_BODY_LENGTH).nullable(),
  state: z.enum(ISSUE_STATES),
  stateReason: z.enum(ISSUE_STATE_REASONS).nullable(),
  /** The issue or pull request of the same repository this one duplicates, while closed as one. */
  duplicateOf: z.number().int().positive().nullable(),
  locked: z.boolean(),
  lockReason: z.enum(LOCK_REASONS).nullable(),
  /** Who opened it, and the root identity it counts as (the user its agents act for). */
  authorId: z.string(),
  authorRoot: z.string(),
  closedAt: z.number().int().min(0).nullable(),
  closedBy: z.string().nullable(),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});
export type IssueRow = z.infer<typeof IssueRowSchema>;
