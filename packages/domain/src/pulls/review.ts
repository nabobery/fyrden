import { atLeast, type RepoRole } from "../authz/roles.js";
import type { ReviewState } from "./approvals.js";
import type { PullState } from "./pull.js";

/** What a submitted review says, as GitHub's API takes it. */
export const REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/** The longest review body, in characters (GitHub's). */
export const MAX_REVIEW_BODY_LENGTH = 65_536;
/** The longest dismissal message, in characters. Proposed. */
export const MAX_DISMISSAL_MESSAGE_LENGTH = 1_024;
/** Reviewers a pull request may have requested at once, a team counting as one. Proposed. */
export const MAX_REQUESTED_REVIEWERS = 15;
/** Members a team asked to review may have (each is asked). Proposed. */
export const MAX_TEAM_REVIEWERS = 2_000;
/** Members a pull request's requested teams may have in all, counted per team. Proposed. */
export const MAX_PULL_TEAM_REVIEWERS = 10_000;

export function reviewStateOf(event: ReviewEvent): ReviewState {
  return event === "APPROVE"
    ? "APPROVED"
    : event === "REQUEST_CHANGES"
      ? "CHANGES_REQUESTED"
      : "COMMENTED";
}

export type ReviewRefusal =
  | "forbidden"
  | "wrong_state"
  | "own_pull_request"
  | "body_required"
  /** The conversation is locked: only write access and above review. */
  | "locked";

/**
 * Whether a caller may submit a review. Anyone who reads the repository
 * may review an open pull request (whether the review counts toward a
 * merge is decided when merging); its author, compared by root identity,
 * may only comment. A request for changes and a comment need a body.
 * While the conversation is locked, only write access and above review.
 */
export function decideReview(input: {
  readonly event: ReviewEvent;
  readonly body: string | null;
  readonly pullState: PullState;
  readonly isAuthor: boolean;
  readonly role: RepoRole | null;
  readonly locked?: boolean;
}): { ok: true } | { ok: false; refusal: ReviewRefusal } {
  if (!atLeast(input.role, "read")) return { ok: false, refusal: "forbidden" };
  if (input.pullState !== "open") return { ok: false, refusal: "wrong_state" };
  if (input.locked && !atLeast(input.role, "write")) return { ok: false, refusal: "locked" };
  if (input.isAuthor && input.event !== "COMMENT")
    return { ok: false, refusal: "own_pull_request" };
  if (input.event !== "APPROVE" && !input.body?.trim())
    return { ok: false, refusal: "body_required" };
  return { ok: true };
}

/**
 * Whether a caller may dismiss a review: write access, on an open pull
 * request, a standing approval or request for changes (a comment never
 * counted; a dismissed one is already gone).
 */
export function decideDismissal(input: {
  readonly reviewState: ReviewState;
  readonly dismissed: boolean;
  readonly pullState: PullState;
  readonly role: RepoRole | null;
}): { ok: true } | { ok: false; refusal: "forbidden" | "wrong_state" } {
  if (!atLeast(input.role, "write")) return { ok: false, refusal: "forbidden" };
  if (input.pullState !== "open" || input.dismissed || input.reviewState === "COMMENTED")
    return { ok: false, refusal: "wrong_state" };
  return { ok: true };
}

/** Whether a caller may request or withdraw reviews: the author, or triage and above, on an open pull request. */
export function decideReviewRequest(input: {
  readonly pullState: PullState;
  readonly isAuthor: boolean;
  readonly role: RepoRole | null;
}): { ok: true } | { ok: false; refusal: "forbidden" | "wrong_state" } {
  if (!atLeast(input.role, "read")) return { ok: false, refusal: "forbidden" };
  if (!input.isAuthor && !atLeast(input.role, "triage")) return { ok: false, refusal: "forbidden" };
  if (input.pullState !== "open") return { ok: false, refusal: "wrong_state" };
  return { ok: true };
}
