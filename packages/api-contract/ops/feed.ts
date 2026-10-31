import { FEED_KINDS, FEED_PRIORITIES, FEED_SUBJECT_KINDS } from "@fyrden/domain";
import { z } from "zod";
import { AUTHENTICATED, defineOperation } from "../src/op.js";

const Cursor = z.string().max(200);

export const FeedItem = z.object({
  item_key: z.string().describe("The item's key: `<repository id>:<thread>:<kind>`."),
  repo: z.object({ id: z.string(), full_name: z.string().describe("owner/name") }),
  thread_key: z
    .string()
    .describe(
      "The thread within the repository, e.g. `pull/12` or `issue/7`; a digest's: `issue-digest/<window>.<epoch>`.",
    ),
  kind: z.enum(FEED_KINDS),
  subject: z.object({
    kind: z.enum(FEED_SUBJECT_KINDS),
    number: z.number().int().optional().describe("The conversation's number; none for a digest."),
    title: z.string(),
  }),
  digest: z
    .object({
      window: z
        .number()
        .int()
        .describe("The window's number (15-minute windows since the Unix epoch)."),
      starts_at: z.number().int().describe("When the window starts, Unix time in milliseconds."),
      ends_at: z.number().int().describe("When it ends, Unix time in milliseconds."),
      url: z.string().describe("Where its threads are read (`GET /feed/digests/...`)."),
    })
    .optional()
    .describe(
      "For `digest`: the window of a watched repository's activity of the subject's kind it tells of (watchers past the first 100 are told once a window).",
    ),
  epoch: z
    .number()
    .int()
    .describe(
      "The repository's restore generation `version` counts in: a newer generation's versions are newer, whatever their numbers.",
    ),
  version: z
    .number()
    .int()
    .describe("The thread's feed version the item is at; acknowledge with it and `epoch`."),
  state: z.enum(["open", "resolved"]).describe("`resolved`: nothing to act on any more."),
  priority: z
    .enum(FEED_PRIORITIES)
    .describe(
      "P0: act on this; P1: a thread you take part in; P2: activity in a repository you watch. An item keeps the highest any of its changes had.",
    ),
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
  acked_epoch: z.number().int().describe("The epoch of the version last acknowledged; 0 for none."),
  acked_version: z.number().int().describe("The version last acknowledged; 0 for none."),
});

const PollAfter = z
  .number()
  .int()
  .describe(
    "Wait at least this long (milliseconds) before polling `GET /feed` again with `next_cursor` (a sync's `head_cursor`): 0 after a full page, as more may follow; else 30 seconds after an answer that showed something, or a sync, doubling with each answer in a row that showed nothing (the cursor counts them), up to 30 minutes.",
  );

const Coverage = z
  .enum(["full", "partial"])
  .describe(
    "`partial`: the cursor follows 1,000 streams (a repository's issues, or its pull requests) and items of others are left out until a sync starts a new one.",
  );

const Delivery = z
  .enum(["complete", "degraded"])
  .describe(
    "`degraded`: activity in watched repositories may be missing from feeds. The deployment's daily allowance for it ran out within the last 7 days. The same for every caller; things to act on and threads you take part in are never left out.",
  );

export const getFeed = defineOperation({
  id: "feed.list",
  method: "GET",
  path: "/feed",
  summary: "Get the activity feed",
  description:
    "The caller's activity feed: pull requests that need it or that it takes part in, one item per repository, thread and kind, in the order they last changed. Pass a previous answer's `next_cursor` as `since` for what changed after it; a changed item comes again, so keep the latest copy by `item_key`. An agent's own token reads the agent's feed; a delegated token reads the user's, limited to the grant's repositories. Items of repositories the caller cannot read now are left out, so a page can be short; a cursor records, per repository and kind of thread (issues, pull requests), only what the caller was shown, so nothing it cannot read moves or expires it. An answer checks at most 100 repositories and reads at most 1,000 items, so a page can end early, even empty, and items the caller cannot read ahead of its own can delay them; the items of repositories the feed's owner itself cannot read now are then forgotten, so a later answer gets past them. Poll by `poll_after_ms`: while nothing changes the wait grows to 30 minutes, and an answer that shows something brings it back to 30 seconds. A cursor belongs to the credential that got it and lasts a day (reading on with it renews it); one past that, of another credential or epoch, or behind what the feed keeps of a repository the caller can read (7 days, 500 items a repository and kind), is refused with 410 `cursor_expired`: start over from `GET /feed/sync`. The answer carries an ETag; with `If-None-Match` an unchanged one is 304.",
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
    head_cursor: Cursor.describe("The same as `next_cursor`."),
    coverage: Coverage,
    delivery: Delivery,
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
      "List what changed in your activity feed (pull requests that need you, threads you take part in) after a cursor (`since`, from a previous answer's `next_cursor`; it lasts a day, renewed as you read on). On `cursor_expired`, call sync_feed.",
    readOnly: true,
  },
});

export const syncFeed = defineOperation({
  id: "feed.sync",
  method: "GET",
  path: "/feed/sync",
  summary: "Sync the activity feed",
  description:
    "The feed's current state, to start from or start over: open P0 items, then P1 and P2 items of the last 7 days, newest first (500 at most), and the cursor to follow with `GET /feed`. Items of repositories the caller cannot read now are left out. `complete` is false when more were left out, or when not every repository could be checked (at most 100 an answer): `head_cursor` then reads every repository from what the feed keeps of it. A complete sync's `head_cursor` follows on after it in the repositories it showed items of, and reads the others from what the feed keeps of them.",
  input: z.object({}),
  output: z.object({
    items: z.array(FeedItem),
    complete: z.boolean(),
    head_cursor: Cursor.describe("Pass as `since` to `GET /feed` for what changes next."),
    coverage: Coverage,
    delivery: Delivery,
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
    "Records that the feed's owner has seen an item at a version, its `epoch` and `version` (every reader of the feed shares it, and the item comes again in `GET /feed`). Versions order by epoch, then version. A version the item does not have yet is refused (409); an older one than already acknowledged changes nothing. A digest is acknowledged at its own epoch and version only (422 `digest_version_inexact`).",
  input: z.object({
    item_key: z.string().max(300),
    epoch: z.number().int().positive(),
    version: z.number().int().positive(),
  }),
  output: z.object({
    item_key: z.string(),
    epoch: z.number().int().describe("The item's current epoch."),
    version: z.number().int().describe("The item's current version."),
    acked_epoch: z.number().int(),
    acked_version: z.number().int(),
  }),
  permission: AUTHENTICATED,
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "ack_feed_item",
    title: "Acknowledge a feed item",
    description: "Mark a feed item seen at a version (the item's `epoch` and `version`).",
    readOnly: false,
  },
});

const Positive = z.coerce.number().int().positive();

export const getFeedDigest = defineOperation({
  id: "feed.digest",
  method: "GET",
  path: "/feed/digests/{repository_id}/{subject}/{window}/{epoch}",
  summary: "Get what a feed digest holds",
  description:
    "The threads a digest item tells of (a watched repository's activity of one kind in one window, for watchers past the first 100), newest first: at most 50 the caller may see, each a conversation the repository still has, that the caller did not unsubscribe from, and that someone besides the caller (or its agents' owner) took part in. Decided now, as a feed item is: 404 when the caller cannot read the repository or the kind, or the digest no longer shows (its conversations deleted, the repository restored, or older than 16 days). `complete` is false when more threads are eligible, or when the window kept no more threads past 5,000 or was left incomplete by the deployment's daily allowance. A Fyrden extension.",
  input: z.object({
    repository_id: z.string().min(1).max(64),
    subject: z.enum(FEED_SUBJECT_KINDS),
    window: Positive,
    epoch: Positive,
  }),
  output: z.object({
    repo: z.object({ id: z.string(), full_name: z.string().describe("owner/name") }),
    subject: z.enum(FEED_SUBJECT_KINDS),
    window: z.number().int(),
    starts_at: z.number().int().describe("When the window starts, Unix time in milliseconds."),
    ends_at: z.number().int().describe("When it ends, Unix time in milliseconds."),
    threads: z.array(
      z.object({
        number: z.number().int(),
        title: z.string().describe("The conversation's title now."),
        last_activity_at: z
          .number()
          .int()
          .describe("When the window last saw activity on it, Unix time in milliseconds."),
        actors: z
          .array(z.string())
          .describe("Who took part in the window (logins; `ghost` for an account deleted)."),
        more_actors: z.boolean().describe("More took part than `actors` names."),
      }),
    ),
    complete: z.boolean(),
  }),
  permission: AUTHENTICATED,
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_feed_digest",
    title: "Get a feed digest",
    description:
      "Read the threads a digest item of your feed tells of (its repository id, subject kind, window and epoch).",
    readOnly: true,
  },
});
