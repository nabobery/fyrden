import { HANDLE_SHAPE, MAX_HANDLE_LENGTH } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN, Repo } from "./repos.js";

const Owner = z
  .string()
  .min(1)
  .max(MAX_HANDLE_LENGTH)
  .regex(HANDLE_SHAPE)
  .describe("The repository's owner handle.");
const RepoName = z.string().regex(REPO_NAME_PATTERN).describe("The repository's name.");

const Subscription = z.object({
  subscribed: z.boolean().describe("Watching: told of every conversation of the repository."),
  ignored: z
    .boolean()
    .describe(
      "Ignoring: not to be notified of the repository (kept; it takes effect with the inbox).",
    ),
  reason: z.null(),
  created_at: z.string().describe("When the level was set, ISO 8601."),
  url: z.string(),
  repository_url: z.string(),
});

const DORMANT =
  " While the deployment has not turned watch audiences on (`FYRDEN_WATCH_AUDIENCES`), the level is kept and reported but adds nothing to feeds.";

export const getRepoSubscription = defineOperation({
  id: "watching.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/subscription",
  summary: "Get a repository subscription",
  description: `The caller's watch level for a repository it can read, as GitHub's: 404 when it only participates (the default). A repository restored from a backup answers 503 \`preferences_recovering\` while it takes its watchers back.${DORMANT}`,
  input: z.object({ owner: Owner, repo: RepoName }),
  output: Subscription,
  permission: "watching:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const setRepoSubscription = defineOperation({
  id: "watching.put",
  method: "PUT",
  path: "/repos/{owner}/{repo}/subscription",
  summary: "Set a repository subscription",
  description: `Watches a repository the caller can read (\`subscribed: true\`: activity of every conversation comes to its feed, P2), or ignores it (\`ignored: true\`, which wins); neither: back to participating. At most 100 principals watch a repository (409 \`watchers_full\` past it). After a 503, repeat the request (with a new Idempotency-Key, or none): it sets a state.${DORMANT}`,
  input: z.object({
    owner: Owner,
    repo: RepoName,
    subscribed: z.boolean().optional().describe("Watch the repository."),
    ignored: z.boolean().optional().describe("Ignore the repository (wins over `subscribed`)."),
  }),
  output: Subscription,
  permission: "watching:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "watch_repository",
    title: "Watch a repository",
    description:
      "Watch a repository (activity of all its conversations comes to your feed) or ignore it; `subscribed: false, ignored: false` goes back to participating.",
    readOnly: false,
  },
});

export const deleteRepoSubscription = defineOperation({
  id: "watching.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/subscription",
  summary: "Delete a repository subscription",
  description: `Back to participating in a repository the caller can read (told only of the conversations it takes part in).${DORMANT}`,
  input: z.object({ owner: Owner, repo: RepoName }),
  output: z.object({}),
  permission: "watching:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "unwatch_repository",
    title: "Stop watching a repository",
    description: "Go back to participating in a repository (told only of what you take part in).",
    readOnly: false,
  },
});

export const listSubscriptions = defineOperation({
  id: "watching.list",
  method: "GET",
  path: "/user/subscriptions",
  summary: "List watched repositories",
  description:
    "The repositories the caller watches and can read now, by repository id. A page reads at most 100 watched repositories, so it can hold fewer than `per_page`, even none, with a `next_cursor`: keep following it until it is null. A cursor belongs to the credential that got it and lasts an hour. Delegated tokens are refused (403 `delegated_listing`): list with the user's own credentials.",
  input: z.object({
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(400).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    repos: z.array(Repo),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "watching:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

const IssueNumber = z.coerce
  .number()
  .int()
  .positive()
  .describe("The issue's number (or a pull request's: they share one sequence).");

const ThreadSubscription = z.object({
  subscribed: z
    .boolean()
    .describe("Subscribed: told of the conversation's activity as a participant is."),
  ignored: z
    .boolean()
    .describe(
      "Unsubscribed: not to be notified of the conversation (kept; it takes effect with the inbox).",
    ),
  reason: z.null(),
  created_at: z.string().describe("When the preference was set, ISO 8601."),
  url: z.string(),
  issue_url: z.string(),
  repository_url: z.string(),
});

const THREAD =
  " A Fyrden extension at Gitea's route, for the caller itself, on an issue or pull request it may read (`issues:read` or `pull_requests:read` by its kind; any other, or none, answers 404 `issue_not_found`). A repository restored from a backup answers 503 `preferences_recovering` while it takes its preferences back.";

export const getThreadSubscription = defineOperation({
  id: "watching.thread_get",
  method: "GET",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/subscription",
  summary: "Get a thread subscription",
  description: `The caller's preference for one conversation: 404 \`subscription_not_found\` without one.${THREAD}${DORMANT}`,
  input: z.object({ owner: Owner, repo: RepoName, issue_number: IssueNumber }),
  output: ThreadSubscription,
  permission: "watching:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const setThreadSubscription = defineOperation({
  id: "watching.thread_put",
  method: "PUT",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/subscription",
  summary: "Set a thread subscription",
  description: `Subscribes the caller to one conversation (\`subscribed\`, the default: its activity comes to the caller's feed as a participant's, P1), or unsubscribes it (\`ignored: true\`, which wins); \`subscribed: false\` without \`ignored\` deletes the preference. A principal keeps at most 1,000 preferences of each kind (issues, pull requests) a repository (409 \`thread_subscriptions_full\`), and a conversation at most 1,000 subscribed and 1,000 unsubscribed (409 \`thread_subscribers_full\`). After a 503, repeat the request (with a new Idempotency-Key, or none): it sets a state, on the conversation the number names then.${THREAD}${DORMANT}`,
  input: z.object({
    owner: Owner,
    repo: RepoName,
    issue_number: IssueNumber,
    subscribed: z.boolean().optional().describe("Subscribe (the default)."),
    ignored: z.boolean().optional().describe("Unsubscribe (wins over `subscribed`)."),
  }),
  output: ThreadSubscription,
  permission: "watching:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "subscribe_to_thread",
    title: "Subscribe to an issue or pull request",
    description:
      "Subscribe to one issue or pull request (its activity comes to your feed) or unsubscribe from it (`ignored: true`).",
    readOnly: false,
  },
});

export const deleteThreadSubscription = defineOperation({
  id: "watching.thread_delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/subscription",
  summary: "Delete a thread subscription",
  description: `Deletes the caller's preference for one conversation: told of it again only as a participant.${THREAD}${DORMANT}`,
  input: z.object({ owner: Owner, repo: RepoName, issue_number: IssueNumber }),
  output: z.object({}),
  permission: "watching:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "clear_thread_subscription",
    title: "Clear a thread subscription",
    description:
      "Delete your subscription to (or unsubscription from) an issue or pull request: told of it only as a participant.",
    readOnly: false,
  },
});
