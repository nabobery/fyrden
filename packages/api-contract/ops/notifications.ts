import { HANDLE_SHAPE, MAX_HANDLE_LENGTH } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation, NoContent } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

/*
 * The caller's notification threads, as GitHub's notifications API: one a
 * repository and conversation that notified it. Lists answer Fyrden's
 * list shape (`notifications` and `next_cursor`), not a bare array with a
 * `Link` header.
 */

const Owner = z
  .string()
  .min(1)
  .max(MAX_HANDLE_LENGTH)
  .regex(HANDLE_SHAPE)
  .describe("The repository's owner handle.");
const RepoName = z.string().regex(REPO_NAME_PATTERN).describe("The repository's name.");
const ThreadId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,400}$/)
  .describe("The thread's id, as a notification gives it.");

const Flag = z
  .enum(["1", "true", "0", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");
const Time = z.string().datetime({ offset: true }).describe("ISO 8601.");

const Delivery = z
  .enum(["complete", "degraded"])
  .describe(
    "`degraded`: activity in watched repositories may be missing. The deployment's daily allowance for it ran out within the last 7 days. The same for every caller.",
  );

const Thread = z.object({
  id: z.string().describe("The thread's id: its repository and conversation."),
  repository: z.object({
    id: z.string(),
    name: z.string(),
    full_name: z.string(),
    private: z.boolean(),
    owner: z.object({ login: z.string() }),
  }),
  subject: z.object({
    title: z.string(),
    url: z.string(),
    latest_comment_url: z.null(),
    type: z.enum(["Issue", "PullRequest"]),
  }),
  reason: z
    .string()
    .describe(
      "Why: `review_requested`, `mention`, `team_mention`, `assign`, `author`, `manual` (subscribed to the thread), `comment`, `subscribed` (watching the repository) or `state_change`. It only moves to a stronger one.",
    ),
  unread: z.boolean(),
  updated_at: z.string().describe("When it last notified, ISO 8601."),
  last_read_at: z.string().nullable(),
  url: z.string(),
  subscription_url: z.string(),
});

const ListInput = {
  all: Flag.describe("`true`: read threads too (default: unread only)."),
  participating: Flag.describe(
    "`true`: only threads that name the caller (requested, mentioned, assigned, its own, commented on).",
  ),
  since: Time.optional().describe("Only threads updated after this time."),
  before: Time.optional().describe("Only threads updated before this time."),
  per_page: z.coerce.number().int().min(1).max(50).default(50).describe("Page size, 1-50."),
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(1)
    .optional()
    .describe("GitHub's page number: only 1 (follow `next_cursor` instead)."),
  cursor: z.string().max(400).optional().describe("A previous answer's `next_cursor`."),
};

const ListOutput = z.object({
  notifications: z.array(Thread),
  next_cursor: z
    .string()
    .nullable()
    .describe(
      "Pass as `cursor` for the next page; null when the answer passed nothing it may show.",
    ),
  delivery: Delivery,
});

const LIST =
  "Newest first. A page checks at most 100 repositories and reads at most 1,000 threads, so it can hold fewer than `per_page`; follow `next_cursor` until it is null. Threads of repositories the caller cannot read now are left out (and forgotten once the read finds the principal itself cannot read them).";

export const listNotifications = defineOperation({
  id: "notifications.list",
  method: "GET",
  path: "/notifications",
  summary: "List notifications for the authenticated user",
  description: `The caller's notification threads, as GitHub's. ${LIST} Delegated tokens are refused (403 \`delegated_listing\`): list with the user's own credentials.`,
  input: z.object(ListInput),
  output: ListOutput,
  permission: "notifications:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_notifications",
    title: "List notifications",
    description:
      "List your notification threads (unread unless `all`), newest first; follow `next_cursor`.",
    readOnly: true,
  },
});

export const listRepoNotifications = defineOperation({
  id: "notifications.repo_list",
  method: "GET",
  path: "/repos/{owner}/{repo}/notifications",
  summary: "List repository notifications for the authenticated user",
  description: `The caller's notification threads of one repository it can read, as GitHub's. ${LIST} Delegated tokens are refused (403 \`delegated_listing\`).`,
  input: z.object({ owner: Owner, repo: RepoName, ...ListInput }),
  output: ListOutput,
  permission: "notifications:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const getNotificationThread = defineOperation({
  id: "notifications.thread_get",
  method: "GET",
  path: "/notifications/threads/{thread_id}",
  summary: "Get a thread",
  description:
    "One of the caller's notification threads; 404 when there is none, or the caller cannot read its repository or its kind now, or its number names another conversation now.",
  input: z.object({ thread_id: ThreadId }),
  output: Thread,
  permission: "notifications:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const markNotificationThreadRead = defineOperation({
  id: "notifications.thread_read",
  method: "PATCH",
  path: "/notifications/threads/{thread_id}",
  summary: "Mark a thread as read",
  description:
    "Marks the thread read where it stands: a later event makes it unread again. 205, as GitHub's.",
  input: z.object({ thread_id: ThreadId }),
  output: NoContent,
  successStatus: 205,
  permission: "notifications:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "mark_notification_read",
    title: "Mark a notification read",
    description: "Mark one of your notification threads read (a later event makes it unread).",
    readOnly: false,
    idempotent: true,
  },
});

export const markNotificationThreadDone = defineOperation({
  id: "notifications.thread_done",
  method: "DELETE",
  path: "/notifications/threads/{thread_id}",
  summary: "Mark a thread as done",
  description:
    "Marks the thread done (and read) where it stands: a later event reopens it. 204, as GitHub's.",
  input: z.object({ thread_id: ThreadId }),
  output: NoContent,
  successStatus: 204,
  permission: "notifications:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "mark_notification_done",
    title: "Mark a notification done",
    description: "Mark one of your notification threads done (a later event reopens it).",
    readOnly: false,
    idempotent: true,
  },
});

const Marked = z.object({ message: z.string() });

const MARK =
  "Marks read up to 500 threads updated at or before `last_read_at` (default now; a later time counts as now), of up to 100 repositories and kinds the caller can read, decided now. It always answers 202 with what to do next: repeat the request (with the same `last_read_at`, and a new Idempotency-Key or none) until a list with `all=false` shows none left. GitHub keeps going itself and may answer 205.";

export const markNotificationsRead = defineOperation({
  id: "notifications.mark",
  method: "PUT",
  path: "/notifications",
  summary: "Mark notifications as read",
  description: `${MARK} Delegated tokens are refused (403 \`delegated_listing\`).`,
  input: z.object({
    last_read_at: Time.optional().describe("Threads updated after this are not marked."),
    read: z.boolean().optional().describe("Only `true` (the default) is supported."),
  }),
  output: Marked,
  successStatus: 202,
  permission: "notifications:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

export const markRepoNotificationsRead = defineOperation({
  id: "notifications.repo_mark",
  method: "PUT",
  path: "/repos/{owner}/{repo}/notifications",
  summary: "Mark repository notifications as read",
  description: `${MARK} One repository's threads. Delegated tokens are refused (403 \`delegated_listing\`).`,
  input: z.object({
    owner: Owner,
    repo: RepoName,
    last_read_at: Time.optional().describe("Threads updated after this are not marked."),
  }),
  output: Marked,
  successStatus: 202,
  permission: "notifications:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

const ThreadSubscription = z.object({
  subscribed: z.boolean(),
  ignored: z.boolean(),
  reason: z.null(),
  created_at: z.string().nullable(),
  url: z.string(),
  thread_url: z.string(),
  repository_url: z.string(),
});

const SUBSCRIPTION =
  "The caller's preference for the thread's conversation (the same as `/repos/{owner}/{repo}/issues/{issue_number}/subscription`): 404 when the thread's number names another conversation now. A repository restored from a backup answers 503 `preferences_recovering` meanwhile.";

export const getNotificationThreadSubscription = defineOperation({
  id: "notifications.subscription_get",
  method: "GET",
  path: "/notifications/threads/{thread_id}/subscription",
  summary: "Get a thread subscription for the authenticated user",
  description: `${SUBSCRIPTION} Without a preference: \`subscribed: false\`, \`ignored: false\`, \`created_at: null\`.`,
  input: z.object({ thread_id: ThreadId }),
  output: ThreadSubscription,
  permission: "notifications:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const setNotificationThreadSubscription = defineOperation({
  id: "notifications.subscription_put",
  method: "PUT",
  path: "/notifications/threads/{thread_id}/subscription",
  summary: "Set a thread subscription",
  description: `${SUBSCRIPTION} \`ignored: true\` unsubscribes (its activity no longer notifies; mentions, requests and assignments still do), else subscribes.`,
  input: z.object({
    thread_id: ThreadId,
    ignored: z.boolean().optional().describe("Unsubscribe from the conversation."),
  }),
  output: ThreadSubscription,
  permission: "notifications:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

export const deleteNotificationThreadSubscription = defineOperation({
  id: "notifications.subscription_delete",
  method: "DELETE",
  path: "/notifications/threads/{thread_id}/subscription",
  summary: "Delete a thread subscription",
  description: `${SUBSCRIPTION} Clears the preference (back to what participating or watching gives).`,
  input: z.object({ thread_id: ThreadId }),
  output: NoContent,
  successStatus: 204,
  permission: "notifications:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

export const issueLiveTicket = defineOperation({
  id: "notifications.live_ticket",
  method: "POST",
  path: "/notifications/live",
  summary: "Get a ticket for live notification hints",
  description:
    'A single-use ticket (30 seconds) to open a WebSocket at `url` that hints which of the caller\'s feed and inbox streams changed (`{"t":"changed","n":…,"streams":[{"repo":…,"kind":"issue"|"pull"}]}`, or `"refresh":true`), only streams the credential may read; reread them through the feed and notifications APIs. Acknowledge each frame (`{"t":"ack","n":…}`, at most 8 unacknowledged) and renew every 10 minutes (`{"t":"renew"}`); a socket lasts at most 24 hours. The upgrade needs the same credential: the session\'s cookie from this origin, or the token in `Authorization`. The caller\'s own credentials only (a delegated token: 403 `delegated_listing`). While the deployment has not turned live hints on: 503 `live_unavailable`. A Fyrden extension.',
  input: z.object({}),
  output: z.object({
    ticket: z.string(),
    expires_in: z.number().int().describe("Seconds the ticket can be redeemed."),
    url: z.string().describe("Where to open the WebSocket (the ticket in its query)."),
  }),
  permission: "notifications:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  secretResponse: true,
  mcp: false,
});
