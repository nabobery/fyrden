import { z } from "zod";

/*
 * What an event means for principals' activity feeds, decided by the
 * repository in the transaction of the change: the thread it is about,
 * what happened, and who should hear of it (each with why, how urgent,
 * and whether the item is still to act on). A feed holds one item per
 * repository, thread and kind; an event updates the items it names.
 */

/** The kinds of feed item: things to act on, and the aggregated activity of a thread. */
export const FEED_KINDS = [
  "review_requested",
  "changes_requested",
  "approved",
  "merge_conflict",
  "mention",
  "activity",
] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/** P0: act on this; P1: a thread one takes part in. */
export const FEED_PRIORITIES = ["P0", "P1"] as const;
export type FeedPriority = (typeof FEED_PRIORITIES)[number];

/** Recipients one event names at most (the rest are dropped). */
export const MAX_FEED_AUDIENCE = 100;
/** Characters of an excerpt at most. */
export const MAX_FEED_EXCERPT = 280;
/** Characters of a subject's title kept in a feed item at most. */
export const MAX_FEED_TITLE = 256;

const id = z.string().min(1).max(128);

export const FeedRecipientSchema = z.strictObject({
  principal: id,
  kind: z.enum(FEED_KINDS),
  /** Why this principal hears of it (author, reviewer, commenter, mentioned, requested_reviewer, ...). */
  reasons: z.array(z.string().min(1).max(32)).min(1).max(8),
  priority: z.enum(FEED_PRIORITIES),
  /** `resolved`: nothing to act on any more (a review given, the pull request closed). */
  state: z.enum(["open", "resolved"]),
  /** The recipient's own action changed it: its state changes, without notifying it. */
  silent: z.boolean(),
});
export type FeedRecipient = z.infer<typeof FeedRecipientSchema>;

export const FeedBlockSchema = z.strictObject({
  /** The thread within the repository, e.g. `pull/12`. */
  threadKey: z
    .string()
    .max(64)
    .regex(/^[a-z]+\/[1-9][0-9]*$/),
  subject: z.strictObject({
    kind: z.literal("pull"),
    number: z.number().int().positive(),
    title: z.string().max(MAX_FEED_TITLE),
    /** The thread's feed version, bumped by every change of it that has a feed block. */
    version: z.number().int().positive(),
  }),
  /** What happened, e.g. `comment`, `review_requested`, `merged`. */
  action: z
    .string()
    .max(32)
    .regex(/^[a-z][a-z_]*$/),
  /** The actor's root identity (the user its agents act for), compared to exclude it. */
  actorRoot: id.nullable(),
  /** The actor's access to the repository when it acted. */
  actorTrust: z.enum(["write", "read", "none"]),
  /** The entity an activity item aggregates (a comment's or review's id), stable across deliveries. */
  member: z.string().max(64).nullable(),
  excerpt: z.string().max(MAX_FEED_EXCERPT).nullable(),
  audience: z.array(FeedRecipientSchema).max(MAX_FEED_AUDIENCE),
});
export type FeedBlock = z.infer<typeof FeedBlockSchema>;

/** A feed item's key in a principal's feed. */
export function feedItemKey(repoId: string, threadKey: string, kind: FeedKind): string {
  return `${repoId}:${threadKey}:${kind}`;
}

/** One recipient's part of an event, as its feed applies it. */
export interface FeedEntry {
  /** The event's key (stable across deliveries). */
  readonly eventKey: string;
  readonly repoId: string;
  /** When the change happened (milliseconds since the epoch). */
  readonly occurredAt: number;
  /** The actor, as the event names it. */
  readonly actor: string | null;
  readonly feed: Omit<FeedBlock, "audience">;
  readonly recipient: FeedRecipient;
}
