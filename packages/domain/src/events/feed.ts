import { z } from "zod";

/*
 * What an event means for principals' activity feeds, decided by the
 * repository in the transaction of the change: the thread it is about,
 * what happened, and who should hear of it (each with why, how urgent,
 * and whether the item is still to act on). A feed holds one item per
 * repository, thread and kind; an event updates the items it names.
 */

/**
 * The kinds of feed item: things to act on, the aggregated activity of a
 * thread, and a digest (a kind's threads in a repository's window, told to
 * watchers past the pushed tier; never in an event's own recipients).
 */
export const FEED_KINDS = [
  "review_requested",
  "changes_requested",
  "approved",
  "merge_conflict",
  "assigned",
  "mention",
  "activity",
  "digest",
] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/** What a feed thread is about. */
export const FEED_SUBJECT_KINDS = ["issue", "pull"] as const;
export type FeedSubjectKind = (typeof FEED_SUBJECT_KINDS)[number];

/**
 * A digest item's thread key: a kind's digest of a repository's window
 * (15-minute windows since the Unix epoch) in its restore generation.
 */
export const digestThreadKey = (subject: FeedSubjectKind, window: number, epoch: number) =>
  `${subject}-digest/${window}.${epoch}`;

/** What a feed thread key names: a conversation, or a kind's digest of a window. */
export type FeedThread =
  | { readonly subject: FeedSubjectKind; readonly number: number }
  | {
      readonly subject: FeedSubjectKind;
      readonly digest: { readonly window: number; readonly epoch: number };
    };

const positive = (text: string) => {
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/**
 * What a thread key names (`issue/7`, `pull/12`, `issue-digest/<window>.<epoch>`);
 * undefined for any other key.
 */
export function parseThreadKey(threadKey: string): FeedThread | undefined {
  const thread = /^(issue|pull)\/([1-9][0-9]*)$/.exec(threadKey);
  if (thread) {
    const number = positive(thread[2] ?? "");
    return number === undefined ? undefined : { subject: thread[1] as FeedSubjectKind, number };
  }
  const digest = /^(issue|pull)-digest\/([1-9][0-9]*)\.([1-9][0-9]*)$/.exec(threadKey);
  const window = positive(digest?.[2] ?? "");
  const epoch = positive(digest?.[3] ?? "");
  return digest && window !== undefined && epoch !== undefined
    ? { subject: digest[1] as FeedSubjectKind, digest: { window, epoch } }
    : undefined;
}

/** P0: act on this; P1: a thread one takes part in; P2: activity in a repository one watches. */
export const FEED_PRIORITIES = ["P0", "P1", "P2"] as const;
export type FeedPriority = (typeof FEED_PRIORITIES)[number];

/** Recipients an event carries itself at most (and each page of the rest). */
export const MAX_FEED_AUDIENCE = 100;
/**
 * Pages of further recipients an event may name, beyond those it carries:
 * the recipients one event can have past the first 100. The most is a
 * close or reopening of a pull request asking teams: its requested teams'
 * members (10,000 at most), a thread's 1,000 participants and 1,000
 * subscribers, the 50 it may mention and those it names directly, under
 * 12,100 in all (watchers are carried apart: `MAX_FEED_WATCHERS`).
 */
export const MAX_FEED_PAGES = 128;
/**
 * A repository's watchers one event tells at most (the pushed tier; the
 * rest are told in digests). They are carried apart from the audience and
 * never paged: their entries are discretionary (P2), admitted against the
 * deployment's daily allowance as one effect.
 */
export const MAX_FEED_WATCHERS = 100;
/** Bytes of one page of recipients, as JSON, at most. */
export const MAX_FEED_PAGE_BYTES = 64 * 1024;
/**
 * How long after its change an event's entries may still reach feeds:
 * feeds keep items this long, and drop older entries on arrival. Proposed.
 */
export const FEED_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
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
  /**
   * The email the event makes for this recipient, on exactly one of its
   * entries (decided by the producer from all of them): its category, and
   * the inbox reason it is for. Absent: none (and on entries made before).
   */
  email: z
    .strictObject({
      category: z.enum(["direct", "participating"]),
      reason: z.string().regex(/^[a-z_]{1,32}$/),
    })
    .optional(),
});
export type FeedRecipient = z.infer<typeof FeedRecipientSchema>;

export const FeedBlockSchema = z
  .strictObject({
    /** The thread within the repository, e.g. `pull/12` or `issue/7`: its subject's kind and number. */
    threadKey: z
      .string()
      .max(64)
      .regex(/^(issue|pull)\/[1-9][0-9]*$/),
    subject: z.strictObject({
      kind: z.enum(FEED_SUBJECT_KINDS),
      number: z.number().int().positive(),
      title: z.string().max(MAX_FEED_TITLE),
      /** The thread's feed version, bumped by every change of it that has a feed block. */
      version: z.number().int().positive(),
      /**
       * The conversation's identity, which a number reused after a restore
       * does not share (absent from blocks made before it was stamped).
       */
      conversation: z.string().min(1).max(128).optional(),
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
    /** Its watchers' entries (P2 only), apart from the audience; absent when none. */
    watchers: z.array(FeedRecipientSchema).min(1).max(MAX_FEED_WATCHERS).optional(),
    /**
     * The further recipients' pages, which the repository keeps (each
     * recipient's entry frozen with the event): their numbers from 1, and
     * how many entries and bytes each holds.
     */
    pages: z
      .array(
        z.strictObject({
          n: z.number().int().min(1).max(MAX_FEED_PAGES),
          count: z.number().int().min(1).max(MAX_FEED_AUDIENCE),
          bytes: z.number().int().min(1).max(MAX_FEED_PAGE_BYTES),
        }),
      )
      .max(MAX_FEED_PAGES)
      .optional(),
    /** When the pages stop being delivered (milliseconds since the epoch); with pages only. */
    deadline: z.number().int().positive().optional(),
  })
  .refine((block) => block.threadKey === `${block.subject.kind}/${block.subject.number}`, {
    message: "the thread key names another subject than the block's",
  })
  .refine((block) => (block.pages ?? []).every((page, i) => page.n === i + 1), {
    message: "the pages are not numbered from 1 in order",
  })
  .refine((block) => (block.pages === undefined) === (block.deadline === undefined), {
    message: "pages come with a deadline, and a deadline with pages",
  })
  .refine(
    (block) =>
      block.audience.every((r) => r.priority !== "P2") &&
      (block.watchers ?? []).every((r) => r.priority === "P2"),
    { message: "watched entries go in watchers, and only they" },
  )
  .refine(
    (block) => [...block.audience, ...(block.watchers ?? [])].every((r) => r.kind !== "digest"),
    { message: "digests are told by digest events, never in an event's recipients" },
  );
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
  /**
   * The repository's restore generation (the event's): the thread's
   * versions count within it, and a newer one's are newer.
   */
  readonly epochGen: number;
  readonly feed: Omit<FeedBlock, "audience" | "watchers">;
  readonly recipient: FeedRecipient;
  /**
   * A watched (P2) entry's admission window's end (milliseconds since the
   * epoch): a feed applying it later drops it, so discretionary work never
   * writes past the window it was granted in.
   */
  readonly until?: number;
}
