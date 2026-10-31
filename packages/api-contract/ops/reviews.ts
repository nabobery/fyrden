import {
  HANDLE_SHAPE,
  MAX_DISMISSAL_MESSAGE_LENGTH,
  MAX_HANDLE_LENGTH,
  MAX_PULL_TEAM_REVIEWERS,
  MAX_REQUESTED_REVIEWERS,
  MAX_REVIEW_BODY_LENGTH,
  MAX_TEAM_REVIEWERS,
  REVIEW_EVENTS,
} from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { TeamSlug } from "./access.js";
import { AfterId, BoundedPerPage } from "./pages.js";
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
const RequestedTeam = z
  .object({
    id: z.string().describe("The team's id (it keeps it when renamed)."),
    slug: z.string(),
    name: z.string(),
  })
  .describe("A team as it was when asked (Fyrden shows these fields only).");
const Logins = z
  .array(z.string().min(1).max(MAX_HANDLE_LENGTH).regex(HANDLE_SHAPE))
  .max(MAX_REQUESTED_REVIEWERS)
  .optional()
  .describe("Handles of users and agents who can read the repository.");
const TeamSlugs = z
  .array(TeamSlug)
  .max(MAX_REQUESTED_REVIEWERS)
  .optional()
  .describe("Slugs of teams of the repository's organization.");
/** Someone to ask or withdraw: a reviewer or a team (by name, or by id when withdrawn). */
const someone = (input: {
  reviewers?: string[] | undefined;
  team_reviewers?: string[] | undefined;
  reviewer_ids?: string[] | undefined;
  team_ids?: string[] | undefined;
}) =>
  (input.reviewers?.length ?? 0) +
    (input.team_reviewers?.length ?? 0) +
    (input.reviewer_ids?.length ?? 0) +
    (input.team_ids?.length ?? 0) >
  0;
const Ids = (what: string) =>
  z
    .array(z.string().min(1).max(64))
    .max(MAX_REQUESTED_REVIEWERS)
    .optional()
    .describe(`Fyrden: ${what} by id, as the requests name them.`);

export const listReviews = defineOperation({
  id: "pulls.reviews.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
  summary: "List reviews",
  description: "A pull request's reviews, in the order submitted.",
  input: z
    .object({
      ...PullInput,
      per_page: BoundedPerPage,
      cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
      after: AfterId,
    })
    .refine((input) => input.cursor === undefined || input.after === undefined, {
      message: "Pass cursor or after, not both.",
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
  description:
    "Who a review of the pull request is requested of and has not reviewed yet: users and agents, and teams (a team's request ends when one of the members it asked reviews).",
  input: z.object(PullInput),
  output: z.object({ users: z.array(Reviewer), teams: z.array(RequestedTeam) }),
  permission: "pull_requests:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const getPullCodeOwners = defineOperation({
  id: "pulls.code_owners.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/code-owners",
  summary: "Get a pull request's code owners",
  description:
    "Fyrden: who owns what an open pull request changes, under its base branch's CODEOWNERS (`.github/`, the root, `docs/`: the first location holding a regular file), for every path the three-dot diff changes (a rename as its two sides). Worked out in the background for the pull request's current base branch, base tip and head: `pending` until then (a draft's is worked out once asked for). Rules are those that decide at least one path, with how many and the first; an ownerless rule's paths need no owner. `errors` counts the file's invalid lines and `unmatchable_paths` the paths that are not UTF-8: either makes a merge needing code owners refuse. `too_large` is final for the pair, with why; `unreadable` is tried again at `retry_at`. Needs `contents:read` too.",
  input: z.object({
    ...PullInput,
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Rules a page, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    state: z.enum(["pending", "complete", "none", "too_large", "unreadable"]),
    reason: z
      .enum(["file", "tree", "depth", "scan", "work", "merge_base", "stuck", "path"])
      .nullable()
      .describe("Why it is `too_large`; null otherwise."),
    retry_at: z
      .number()
      .int()
      .nullable()
      .describe("When an `unreadable` result is worked out again (Unix time in milliseconds)."),
    file: z
      .object({ path: z.string(), sha: z.string() })
      .nullable()
      .describe("The CODEOWNERS file used; null when there is none."),
    errors: z.number().int().describe("Invalid lines in the file."),
    rules: z.array(
      z.object({
        line: z.number().int(),
        owners: z
          .array(z.string())
          .describe("As written (`@user`, `@org/team`); empty: ownerless."),
        paths: z.number().int().describe("Changed paths this rule decides."),
        example_path: z.string().describe("The first of them (at most 512 bytes)."),
      }),
    ),
    ownerless_paths: z.number().int(),
    unmatched_paths: z.number().int().describe("Changed paths no rule matches (no code owners)."),
    unmatchable_paths: z
      .number()
      .int()
      .describe("Changed paths that are not UTF-8, never matched."),
    unmatchable_example: z
      .string()
      .nullable()
      .describe("The first such path's bytes (at most 512), base64."),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page of rules; null on the last page."),
  }),
  permission: "pull_requests:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_pull_request_code_owners",
    title: "Get a pull request's code owners",
    description:
      "Who owns what an open pull request changes under its base branch's CODEOWNERS: each deciding rule with its owners and how many changed paths it decides, plus unmatched paths, the file's error count, and paths that cannot be matched. `pending` while it is worked out.",
    readOnly: true,
  },
});

export const requestReviewers = defineOperation({
  id: "pulls.requested_reviewers.add",
  method: "POST",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
  summary: "Request reviewers",
  description: `Requests a review of users or agents who can read the repository (not the author), and of teams of the repository's organization. A team asks each member it has now (the author aside), at most ${MAX_TEAM_REVIEWERS}, and keeps those members: one of them reviewing ends its request; someone who joins the team later does not. The author may request reviews; on someone else's pull request it needs triage access. At most ${MAX_REQUESTED_REVIEWERS} at once, a team counting as one, and ${MAX_PULL_TEAM_REVIEWERS} members across a pull request's teams; a request ends when its reviewer submits a review. Past the limit, requests of users or agents being deleted give up their places first, with no event.`,
  input: z
    .object({ ...PullInput, reviewers: Logins, team_reviewers: TeamSlugs })
    .refine(someone, { message: "Name a reviewer or a team." })
    .refine(
      (input) =>
        (input.reviewers?.length ?? 0) + (input.team_reviewers?.length ?? 0) <=
        MAX_REQUESTED_REVIEWERS,
      { message: `At most ${MAX_REQUESTED_REVIEWERS} reviewers and teams together.` },
    ),
  output: PullRequest,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "request_reviewers",
    title: "Request reviewers",
    description: `Ask users or agents who can read the repository, or teams of its organization (by slug: each member the team has now is asked), to review an open pull request (not its author; at most ${MAX_REQUESTED_REVIEWERS} at once, a team counting as one; past that, requests of users or agents being deleted give up their places first, with no event). The author may ask; on someone else's pull request it needs triage access.`,
    readOnly: false,
  },
});

export const requestTeamReviewers = defineOperation({
  id: "pulls.requested_reviewers.add_teams",
  method: "POST",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers/teams",
  summary: "Request reviews of an account's teams",
  description: `Fyrden: as \`pulls.requested_reviewers.add\`, its teams named as \`team_owner\`'s (ignoring case): refused with 409 \`stale\` when the repository belongs to another account now (transferred), rather than ask the new owner's teams of those slugs. Checked with the teams it reads, so neither a cached owner nor a transfer meanwhile asks another account's teams. A path of its own: a deployment that does not know it answers 404 rather than ask the teams unchecked.`,
  input: z
    .object({
      ...PullInput,
      team_owner: z
        .string()
        .min(1)
        .max(MAX_HANDLE_LENGTH)
        .regex(HANDLE_SHAPE)
        .describe("The account whose teams `team_reviewers` names."),
      team_reviewers: z.array(TeamSlug).min(1).max(MAX_REQUESTED_REVIEWERS),
      reviewers: Logins,
    })
    .refine(
      (input) =>
        (input.reviewers?.length ?? 0) + input.team_reviewers.length <= MAX_REQUESTED_REVIEWERS,
      { message: `At most ${MAX_REQUESTED_REVIEWERS} reviewers and teams together.` },
    ),
  output: PullRequest,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: false,
});

export const removeRequestedReviewers = defineOperation({
  id: "pulls.requested_reviewers.remove",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
  summary: "Remove requested reviewers",
  description:
    "Withdraws review requests of users, agents and teams; ones not requested are ignored. Fyrden takes teams alone too (GitHub needs `reviewers`), and `reviewer_ids` and `team_ids` name them by id (a deleted user's handle names no one; two requests can carry one team slug, a team renamed and another named so since).",
  input: z
    .object({
      ...PullInput,
      reviewers: Logins,
      team_reviewers: TeamSlugs,
      reviewer_ids: Ids("users and agents"),
      team_ids: Ids("teams"),
    })
    .refine(someone, { message: "Name a reviewer or a team." }),
  output: PullRequest,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "remove_requested_reviewers",
    title: "Remove requested reviewers",
    description: "Withdraw review requests of users, agents or teams from a pull request.",
    readOnly: false,
  },
});
