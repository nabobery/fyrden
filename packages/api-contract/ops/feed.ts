import { FEED_KINDS, FEED_PRIORITIES } from "@fyrden/domain";
import { z } from "zod";
import { AUTHENTICATED, defineOperation } from "../src/op.js";

const Cursor = z.string().max(200);

export const FeedItem = z.object({
  item_key: z.string().describe("The item's key: `<repository id>:<thread>:<kind>`."),
  repo: z.object({ id: z.string(), full_name: z.string().describe("owner/name") }),
  thread_key: z.string().describe("The thread within the repository, e.g. `pull/12`."),
  kind: z.enum(FEED_KINDS),
  subject: z.object({
    kind: z.literal("pull"),
    number: z.number().int(),
    title: z.string(),
  }),
  version: z
    .number()
    .int()
    .describe("The thread's feed version the item is at; acknowledge with it."),
  state: z.enum(["open", "resolved"]).describe("`resolved`: nothing to act on any more."),
  priority: z.enum(FEED_PRIORITIES).describe("P0: act on this; P1: a thread you take part in."),
  reasons: z.array(z.string()).describe("Why it is in the feed: author, reviewer, mentioned, ..."),
  silent: z
    .boolean()
    .describe("The last change was the owner's own action (or its agents'): no notification."),
  action: z.string().describe("What happened last: `comment`, `review_requested`, `merged`, ..."),
  actor: z.string().nullable(),
  actor_trust: z
    .enum(["write", "read", "none"])
    .describe("The actor's access to the repository when it acted."),
  excerpt: z
    .string()
    .nullable()
    .describe(
      "What the member the item displays says now (plain text, at most 280 characters), read from the repository; null when there is none or it is gone.",
    ),
  members: z
    .array(z.string())
    .describe("For `activity`: the ids it gathers (comments, reviews), the greatest 100."),
  members_truncated: z.boolean().describe("Some members were left out."),
  event_at: z.number().int().describe("When the last change happened, Unix time in milliseconds."),
  acked_version: z.number().int().describe("The version last acknowledged; 0 for none."),
});

const PollAfter = z
  .number()
  .int()
  .describe(
    "Wait at least this long (milliseconds) before polling again with `next_cursor`; 0 while more may follow.",
  );

export const getFeed = defineOperation({
  id: "feed.list",
  method: "GET",
  path: "/feed",
  summary: "Get the activity feed",
  description:
    "The caller's activity feed: pull requests that need it or that it takes part in, one item per repository, thread and kind, in the order they last changed. Pass a previous answer's `next_cursor` as `since` for what changed after it; a changed item comes again, so keep the latest copy by `item_key`. An agent's own token reads the agent's feed; a delegated token reads the user's, limited to the grant's repositories. Items of repositories the caller cannot read now are left out, so a page can be short, and cursors name only items the caller was shown. An answer checks at most 100 repositories: a page can end early, with `poll_after_ms` 0 to read on. A cursor older than the retention (7 days, 5,000 items) or of another epoch is refused with 410 `cursor_expired`: start over from `GET /feed/sync`. The answer carries an ETag; with `If-None-Match` an unchanged one is 304.",
  input: z.object({
    since: Cursor.optional().describe("A previous answer's `next_cursor`; from the start without."),
    limit: z.coerce.number().int().min(1).max(100).default(50).describe("Page size, 1-100."),
    priority: z.enum(FEED_PRIORITIES).optional().describe("Only items of this priority."),
    kind: z.enum(FEED_KINDS).optional().describe("Only items of this kind."),
  }),
  output: z.object({
    items: z.array(FeedItem),
    next_cursor: Cursor.describe(
      "Pass as `since` next: after the last item shown (where the answer started when none was).",
    ),
    head_cursor: Cursor.describe(
      "The latest change the answer found that the caller may see; the same as `next_cursor` unless more pages follow.",
    ),
    poll_after_ms: PollAfter,
  }),
  permission: AUTHENTICATED,
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  etag: true,
  mcp: {
    tool: "get_feed",
    title: "Get the activity feed",
    description:
      "List what changed in your activity feed (pull requests that need you, threads you take part in) after a cursor (`since`, from a previous answer's `next_cursor`). On `cursor_expired`, call sync_feed.",
    readOnly: true,
  },
});

export const syncFeed = defineOperation({
  id: "feed.sync",
  method: "GET",
  path: "/feed/sync",
  summary: "Sync the activity feed",
  description:
    "The feed's current state, to start from or start over: open P0 items, then P1 items of the last 7 days, newest first (500 at most), and the cursor to follow with `GET /feed`. Items of repositories the caller cannot read now are left out. `complete` is false when more were left out, or when not every repository could be checked (at most 100 an answer): `head_cursor` is then the feed's start.",
  input: z.object({}),
  output: z.object({
    items: z.array(FeedItem),
    complete: z.boolean(),
    head_cursor: Cursor.describe("Pass as `since` to `GET /feed` for what changes next."),
    poll_after_ms: PollAfter,
  }),
  permission: AUTHENTICATED,
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "sync_feed",
    title: "Sync the activity feed",
    description:
      "Get what needs you now (open P0 items) and recent activity, with the cursor to follow get_feed from.",
    readOnly: true,
  },
});

export const ackFeedItem = defineOperation({
  id: "feed.ack",
  method: "POST",
  path: "/feed/ack",
  summary: "Acknowledge a feed item",
  description:
    "Records that the feed's owner has seen an item at a version (every reader of the feed shares it, and the item comes again in `GET /feed`). A version the item does not have yet is refused (409); an older one than already acknowledged changes nothing.",
  input: z.object({
    item_key: z.string().max(300),
    version: z.number().int().positive(),
  }),
  output: z.object({
    item_key: z.string(),
    version: z.number().int().describe("The item's current version."),
    acked_version: z.number().int(),
  }),
  permission: AUTHENTICATED,
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "ack_feed_item",
    title: "Acknowledge a feed item",
    description: "Mark a feed item seen at a version (from the item's `version`).",
    readOnly: false,
  },
});
