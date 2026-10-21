import {
  HANDLE_SHAPE,
  MAX_DISMISSAL_MESSAGE_LENGTH,
  MAX_HANDLE_LENGTH,
  MAX_REQUESTED_REVIEWERS,
  MAX_REVIEW_BODY_LENGTH,
  REVIEW_EVENTS,
} from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { PullRequest } from "./pulls.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const PullInput = {
  owner: z
    .string()
    .min(1)
    .max(MAX_HANDLE_LENGTH)
    .regex(HANDLE_SHAPE)
    .describe("The owner's handle."),
  repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
  pull_number: z.coerce.number().int().positive().describe("The pull request's number."),
};
const ReviewId = z.coerce.number().int().positive().describe("The review's id.");

export const Review = z.object({
  id: z.number().int(),
  user: z
    .object({ id: z.string() })
    .describe("Who submitted it (the user, when agents acted for one)."),
  performed_via_agents: z
    .array(z.string())
    .describe(
      "Fyrden: the agents that submitted it for `user`, the acting one first; empty if none.",
    ),
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]),
  body: z.string().nullable(),
  commit_id: z.string().describe("The head commit it reviewed: it counts for that commit only."),
  submitted_at: z.number().int().describe("Unix time in milliseconds."),
  dismissal: z
    .object({
      by: z.string(),
      message: z.string(),
      at: z.number().int().describe("Unix time in milliseconds."),
    })
    .nullable()
    .describe("Fyrden: who dismissed it, why and when; null unless `state` is DISMISSED."),
});

const Reviewer = z.object({ id: z.string(), login: z.string() });
const Logins = z
  .array(z.string().min(1).max(MAX_HANDLE_LENGTH).regex(HANDLE_SHAPE))
  .min(1)
  .max(MAX_REQUESTED_REVIEWERS)
  .describe("Handles of users and agents who can read the repository.");
const NoTeams = z
  .array(z.never())
  .max(0)
  .optional()
  .describe("Team reviewers are not supported yet: empty or left out.");

export const listReviews = defineOperation({
  id: "pulls.reviews.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
  summary: "List reviews",
  description: "A pull request's reviews, in the order submitted.",
  input: z.object({
    ...PullInput,
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    reviews: z.array(Review),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "pull_requests:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_reviews",
    title: "List reviews",
    description: "List the reviews of a pull request.",
    readOnly: true,
  },
});

export const getReview = defineOperation({
  id: "pulls.reviews.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
  summary: "Get a review",
  description: "One review of a pull request.",
  input: z.object({ ...PullInput, review_id: ReviewId }),
  output: Review,
  permission: "pull_requests:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const createReview = defineOperation({
  id: "pulls.reviews.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
  summary: "Submit a review",
  description:
    "Approves, requests changes or comments on a pull request at `commit_id`, a head it has had: the review counts for that commit only. Anyone who can read the repository may review an open pull request; whether a review counts toward a merge (write access or above, not the author, people only unless the ruleset allows agents) is decided when merging. The author may only comment. Requesting changes or commenting needs a body.",
  input: z.object({
    ...PullInput,
    commit_id: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .describe("The head commit reviewed: the pull request's `head.sha` when you read it."),
    event: z.enum(REVIEW_EVENTS),
    body: z.string().max(MAX_REVIEW_BODY_LENGTH).optional(),
  }),
  output: Review,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "submit_review",
    title: "Submit a review",
    description:
      "Approve, request changes on, or comment on an open pull request at a head commit it has had (its head.sha). Anyone who can read the repository may review; the author may only comment; requesting changes or commenting needs a body.",
    readOnly: false,
  },
});

export const dismissReview = defineOperation({
  id: "pulls.reviews.dismiss",
  method: "PUT",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals",
  summary: "Dismiss a review",
  description:
    "Dismisses an approval or a request for changes, with a reason: it no longer counts toward or blocks a merge. Needs write access.",
  input: z.object({
    ...PullInput,
    review_id: ReviewId,
    message: z.string().trim().min(1).max(MAX_DISMISSAL_MESSAGE_LENGTH).describe("Why."),
    event: z.literal("DISMISS").optional(),
  }),
  output: Review,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "dismiss_review",
    title: "Dismiss a review",
    description:
      "Dismiss a standing approval or request for changes on an open pull request, giving a reason. Needs write access.",
    readOnly: false,
    // A second dismissal of the same review is refused.
    idempotent: false,
  },
});

export const listRequestedReviewers = defineOperation({
  id: "pulls.requested_reviewers.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
  summary: "List requested reviewers",
  description: "Who a review of the pull request is requested of and has not reviewed yet.",
  input: z.object(PullInput),
  output: z.object({ users: z.array(Reviewer), teams: z.array(z.never()) }),
  permission: "pull_requests:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const requestReviewers = defineOperation({
  id: "pulls.requested_reviewers.add",
  method: "POST",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
  summary: "Request reviewers",
  description: `Requests a review of users or agents who can read the repository (not the author). The author may request reviews; on someone else's pull request it needs triage access. At most ${MAX_REQUESTED_REVIEWERS} at once; a request ends when that reviewer submits a review. Past the limit, requests of users or agents being deleted give up their places first, with no event.`,
  input: z.object({ ...PullInput, reviewers: Logins, team_reviewers: NoTeams }),
  output: PullRequest,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "request_reviewers",
    title: "Request reviewers",
    description: `Ask users or agents who can read the repository to review an open pull request (not its author; at most ${MAX_REQUESTED_REVIEWERS} at once; past that, requests of users or agents being deleted give up their places first, with no event). The author may ask; on someone else's pull request it needs triage access.`,
    readOnly: false,
  },
});

export const removeRequestedReviewers = defineOperation({
  id: "pulls.requested_reviewers.remove",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
  summary: "Remove requested reviewers",
  description: "Withdraws review requests; reviewers not requested are ignored.",
  input: z.object({ ...PullInput, reviewers: Logins, team_reviewers: NoTeams }),
  output: PullRequest,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "remove_requested_reviewers",
    title: "Remove requested reviewers",
    description: "Withdraw review requests from a pull request.",
    readOnly: false,
  },
});
