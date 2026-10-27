import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  atLeast,
  type EventId,
  eventKey,
  FEED_HORIZON_MS,
  type FeedBlock,
  type FeedKind,
  type FeedRecipient,
  MAX_FEED_AUDIENCE,
  MAX_FEED_EXCERPT,
  MAX_FEED_PAGE_BYTES,
  MAX_FEED_PAGES,
  MAX_FEED_TITLE,
  mentionsIn,
  newMentions,
  type RepoRole,
} from "@fyrden/domain";

/*
 * What the repository's events mean for principals' activity feeds,
 * decided in the transaction of the change (the only place that sees the
 * state before and after it). Each event about an issue or a pull request may name
 * who should hear of it: the people taking part in the thread (its author,
 * reviewers asked or reviewing, commenters, the mentioned) for its
 * activity, and those who have something to act on (a review asked of
 * them, a review or a conflict on their pull request) for that, with when
 * it no longer needs them. No one is told of their own action (compared by
 * root identity: a user and its agents are one); what their action changes
 * of their own items still changes, silently. Every recipient must read the
 * repository (feeds check again when read). Feeds hold no text of the
 * repository's: an item names its comment, review or pull request, whose
 * excerpt is read when the feed is shown (an edit or deletion shows at once).
 */

/** A principal, and the root identity it counts as (the user its agents act for). */
export interface FeedPrincipal {
  readonly id: string;
  readonly root: string;
}

/** Who makes the change being emitted, as the caller worked it out. */
export interface FeedActor {
  /** The root identity: the user its agents act for. */
  readonly root: string | null;
  readonly role: RepoRole | null;
  /** Mentioned handles (lower-cased) resolved before the change. */
  readonly mentioned: ReadonlyMap<string, FeedPrincipal>;
}

/** How long a page of recipients is kept past its event's delivery deadline. Proposed. */
export const FEED_PAGE_GRACE_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

/** A feed effect's request for a page of its event's further recipients. */
export interface FeedPageAsk {
  readonly eventKey: string;
  readonly page: number;
  /** The restore and ownership generations the event was made in. */
  readonly epochGen: number;
  readonly ownerGen: number;
}

/** The page's entries and bytes, or why it is not to be delivered. */
export type FeedPageRead =
  | { readonly recipients: readonly FeedRecipient[]; readonly bytes: number }
  | { readonly missing: "deleted" | "restored" | "transferred" | "absent" };

/** Who reads the repository, as a feed's audience is decided (see `RepoFeedDeps.readers`). */
export interface Readers {
  readonly mayRead: (principal: string) => boolean;
  readonly key: string | null;
}

export interface RepoFeedDeps {
  readonly git: RepoGitStorage;
  /**
   * Who reads the repository now (its visibility, or its ACL as last
   * pulled), from one read of them, and a key that changes when they do
   * (null when there is no ACL to go by).
   */
  readonly readers: () => Readers;
  /** The actor's role, when no caller said (from the ACL as last pulled). */
  readonly roleOf: (principal: string) => RepoRole | null;
  /** Queues the pruning of audience pages for `at` (or keeps it sooner). */
  readonly prunePagesAt: (at: number) => void;
  /** Brings the ACL as `readers` and `roleOf` see it up to date (within its read TTL). */
  readonly refreshAccess: () => Promise<void>;
  /** Handles (lower-cased) to the active users and agents with them. */
  readonly resolveHandles: (handles: readonly string[]) => Promise<Map<string, FeedPrincipal>>;
  /** Before a change, with the texts it writes: what else they need resolved (other repositories). */
  readonly prepareTexts?: (texts: readonly (string | null | undefined)[]) => Promise<void>;
  /**
   * Whether watching adds to audiences (the deployment's switch): watchers,
   * thread subscribers, and authors told of their subjects' state changes.
   * Off: none of them.
   */
  readonly audiences?: () => boolean;
  /** The watchers an event may tell (see `RepoWatching.candidates`). */
  readonly watchers?: () => {
    readonly watchers: readonly FeedPrincipal[];
    readonly overflow: boolean;
  };
  /** The subscribers an event of a thread may tell (see `RepoThreadPreferences.subscribers`). */
  readonly subscribers?: (number: number) => {
    readonly subscribers: readonly FeedPrincipal[];
    readonly overflow: boolean;
  };
  readonly metrics: Metrics;
}

type Row = Record<string, unknown>;
/**
 * A recipient as a plan names it, with the root identity it counts as;
 * `standing`: a request of it stands again (a reopening), told whatever its access now.
 */
type Named = Omit<FeedRecipient, "silent"> & {
  readonly root: string;
  readonly standing?: boolean;
};

/**
 * Participants of a thread kept at most, the first to join kept. A join
 * past it is counted (`feed_participation.overflow`,
 * `feed.participants_overflow`); one named directly (mentioned, assigned,
 * asked to review) is told whatever the cap. Proposed.
 */
export const MAX_PARTICIPANTS = 1_000;

/** Participants read a page at a time, in the order they joined. */
const PARTICIPANTS_PER_PAGE = 200;

/** A page of a thread's participants after a join sequence (through its index). */
export const PARTICIPANTS_PAGE = `SELECT principal, root, reason, joined_seq FROM feed_participants
  WHERE number = ?1 AND joined_seq > ?2 ORDER BY joined_seq LIMIT ?3`;
/** Events that open a thread: its repository's watchers hear of them too. */
const OPENED: ReadonlySet<string> = new Set(["issue.opened", "pull_request.opened"]);

/** Events that change a thread's state: its author hears of them, its own included (silently). */
const STATE_CHANGES: ReadonlySet<string> = new Set([
  "issue.closed",
  "issue.reopened",
  "pull_request.closed",
  "pull_request.reopened",
]);

/** Kinds that are something to act on (the others: what happened). */
const ACTION_KINDS: ReadonlySet<FeedKind> = new Set([
  "review_requested",
  "changes_requested",
  "approved",
  "merge_conflict",
  "assigned",
]);

export class RepoFeed {
  /** The change being made: who makes it (set around the change, which does not await). */
  #actor: FeedActor | undefined;

  constructor(private readonly deps: RepoFeedDeps) {}

  get #sql() {
    return this.deps.git.context.storage.sql;
  }

  #exec<T extends Record<string, SqlStorageValue>>(
    op: string,
    query: string,
    ...bindings: unknown[]
  ) {
    const cursor = this.#sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.deps.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op },
        cursor.rowsWritten,
      );
    return rows;
  }

  /**
   * Before a change that may tell feeds: brings access up to date (who may
   * hear of it) and resolves the handles `texts` mention.
   */
  async prepare(
    texts: readonly (string | null | undefined)[] = [],
  ): Promise<Map<string, FeedPrincipal>> {
    await this.deps.refreshAccess();
    await this.deps.prepareTexts?.(texts);
    const handles = [...new Set(texts.flatMap((t) => mentionsIn(t)))];
    return handles.length === 0 ? new Map() : this.deps.resolveHandles(handles);
  }

  /** Runs `change` (synchronously) with `actor` as the one making it. */
  within<R>(actor: FeedActor, change: () => R): R {
    const previous = this.#actor;
    this.#actor = actor;
    try {
      return change();
    } finally {
      this.#actor = previous;
    }
  }

  /**
   * In the change's transaction: what an event of `type` means for feeds,
   * or undefined when it means nothing for any. Bumps the thread's feed
   * version when it does.
   */
  blockFor(
    type: string,
    actor: string | null,
    data: Row | null,
    row: Row | null,
    event: { readonly id: EventId; readonly at: number; readonly ownerGen: number },
  ): FeedBlock | undefined {
    const plan = this.#plan(type, data ?? {}, row, event.ownerGen);
    if (!plan) return undefined;
    const subject = this.#subject(plan.number);
    if (!subject) return undefined;
    const actorRoot = this.#actor?.root ?? actor;
    const readers = this.deps.readers();
    const audience: FeedRecipient[] = [];
    // One entry per principal and kind (a participant mentioned hears of both).
    const named = new Set<string>();
    const add = (r: Named, exact = false, ownState = false) => {
      const self = exact
        ? r.principal === actor
        : r.principal === actor || r.principal === actorRoot || r.root === actorRoot;
      // No one hears of their own activity; what their action changes of their items (an
      // author's own state change included), silently.
      if (self && !ACTION_KINDS.has(r.kind) && !ownState) return;
      const key = `${r.principal}|${r.kind}`;
      if (named.has(key)) return;
      // A request settled, or standing again, reaches everyone it asks, whether they still read
      // the repository or not (feeds check access when read): one who reads it again must find
      // it as it is.
      if (!readers.mayRead(r.principal) && !settlesRequest(r) && !r.standing) return;
      named.add(key);
      const { root: _root, standing: _standing, ...recipient } = r;
      audience.push({ ...recipient, silent: self });
    };
    for (const r of plan.direct) add(r, plan.exact);
    for (const who of plan.mentions) {
      // Those who cannot read the repository are neither told nor kept as participants.
      if (!readers.mayRead(who.id)) continue;
      add({
        principal: who.id,
        root: who.root,
        kind: "mention",
        reasons: ["mentioned"],
        priority: this.#trust(actor) === "write" ? "P0" : "P1",
        state: "open",
      });
      this.#join(plan.number, who, "mentioned", readers);
    }
    const watching = this.deps.audiences?.() ?? false;
    // Its author hears of its state changing, whatever the participants' cap, before them (so a
    // participating author's entry says why).
    if (watching && STATE_CHANGES.has(type) && row)
      for (const who of authorsOf(row))
        add(
          {
            principal: who.id,
            root: who.root,
            kind: "activity",
            reasons: ["author"],
            priority: "P1",
            state: "open",
          },
          false,
          true,
        );
    if (plan.activity)
      for (const p of this.#participants(plan.number))
        add({
          principal: p.principal,
          root: p.root,
          kind: "activity",
          reasons: [p.reason],
          priority: "P1",
          state: "open",
        });
    // Its subscribers, as participants (a participant keeps its reason).
    if (watching && plan.activity) {
      const { subscribers, overflow } = this.deps.subscribers?.(plan.number) ?? {
        subscribers: [],
        overflow: false,
      };
      for (const who of subscribers)
        add({
          principal: who.id,
          root: who.root,
          kind: "activity",
          reasons: ["subscribed"],
          priority: "P1",
          state: "open",
        });
      if (overflow) this.deps.metrics.count("feed.preference_overflow", { kind: "subscribers" });
    }
    // Watchers, after everyone told for another reason (a participant stays P1).
    if (watching && (plan.activity || OPENED.has(type))) {
      const { watchers, overflow } = this.deps.watchers?.() ?? { watchers: [], overflow: false };
      for (const who of watchers)
        add({
          principal: who.id,
          root: who.root,
          kind: "activity",
          reasons: ["watching"],
          priority: "P2",
          state: "open",
        });
      if (overflow) this.deps.metrics.count("feed.preference_overflow", { kind: "watchers" });
    }
    for (const [who, reason] of plan.joins) this.#join(plan.number, who, reason, readers);
    if (audience.length === 0) return undefined;
    // Things to act on first, then threads taken part in, then watched ones, when there are more
    // than one event may name (stable within each).
    audience.sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : 0));
    const pages = this.#keepPages(audience.slice(MAX_FEED_AUDIENCE), event);
    const threadKey = `${subject.kind}/${plan.number}`;
    const version = this.#bump(threadKey);
    return {
      threadKey,
      subject: {
        kind: subject.kind,
        number: plan.number,
        title: String(subject.title ?? "").slice(0, MAX_FEED_TITLE),
        version,
      },
      action: plan.action,
      actorRoot,
      actorTrust: this.#trust(actor),
      member: plan.member,
      // Read live from `member` when a feed is shown (an edit or deletion shows at once).
      excerpt: null,
      audience: audience.slice(0, MAX_FEED_AUDIENCE),
      ...(pages.length > 0 && { pages, deadline: event.at + FEED_HORIZON_MS }),
    };
  }

  /**
   * Keeps `rest` (the recipients past those the event carries) as pages of
   * up to 100 entries and `MAX_FEED_PAGE_BYTES`, frozen with the event, and
   * queues their pruning; their manifest. Past `MAX_FEED_PAGES`, recipients
   * are counted, not kept (the caps keep an event's recipients within it).
   */
  #keepPages(
    rest: readonly FeedRecipient[],
    event: { readonly id: EventId; readonly at: number; readonly ownerGen: number },
  ): { n: number; count: number; bytes: number }[] {
    const pages: { n: number; count: number; bytes: number }[] = [];
    if (rest.length === 0) return pages;
    const key = eventKey(event.id);
    const expiresAt = event.at + FEED_HORIZON_MS + FEED_PAGE_GRACE_MS;
    let page: FeedRecipient[] = [];
    // Bytes of the page as a JSON array: its brackets, and each entry with a comma.
    let bytes = 1;
    let dropped = 0;
    const keep = () => {
      if (page.length === 0) return;
      const json = JSON.stringify(page);
      const n = pages.length + 1;
      const size = encoder.encode(json).length;
      this.#exec(
        "feed.pages",
        `INSERT INTO feed_audience_pages (event_key, page, epoch_gen, owner_gen, recipients, bytes,
           expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        key,
        n,
        event.id.epochGen,
        event.ownerGen,
        json,
        size,
        expiresAt,
      );
      pages.push({ n, count: page.length, bytes: size });
      page = [];
      bytes = 1;
    };
    for (const recipient of rest) {
      const size = encoder.encode(JSON.stringify(recipient)).length + 1;
      if (page.length >= MAX_FEED_AUDIENCE || bytes + size > MAX_FEED_PAGE_BYTES) keep();
      if (pages.length >= MAX_FEED_PAGES) {
        dropped++;
        continue;
      }
      page.push(recipient);
      bytes += size;
    }
    keep();
    if (dropped > 0) this.deps.metrics.count("feed.audience_dropped", {}, dropped);
    if (pages.length > 0) this.deps.prunePagesAt(expiresAt);
    return pages;
  }

  /**
   * A page of an event's further recipients, while the event is still the
   * repository's: made in its current restore generation and under its
   * current owner (`current`); `missing` with why otherwise.
   */
  readPage(
    ask: FeedPageAsk,
    current: { readonly epochGen: number; readonly ownerGen: number },
  ): FeedPageRead {
    if (ask.epochGen !== current.epochGen) return { missing: "restored" };
    if (ask.ownerGen !== current.ownerGen) return { missing: "transferred" };
    const [row] = this.#exec<{ recipients: string; bytes: number }>(
      "feed.read",
      `SELECT recipients, bytes FROM feed_audience_pages
       WHERE event_key = ? AND page = ? AND epoch_gen = ? AND owner_gen = ?`,
      ask.eventKey,
      ask.page,
      ask.epochGen,
      ask.ownerGen,
    );
    if (!row) return { missing: "absent" };
    return { recipients: JSON.parse(row.recipients) as FeedRecipient[], bytes: row.bytes };
  }

  /**
   * Deletes up to `limit` pages whose time is up at `now`; how many, and
   * when the next goes (null for none left).
   */
  prunePages(now: number, limit: number): { pruned: number; nextAt: number | null } {
    const cursor = this.#sql.exec(
      `DELETE FROM feed_audience_pages WHERE (event_key, page) IN (
         SELECT event_key, page FROM feed_audience_pages WHERE expires_at <= ?
         ORDER BY expires_at LIMIT ?)`,
      now,
      limit,
    );
    const pruned = cursor.rowsWritten;
    if (pruned > 0)
      this.deps.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "feed.pages_prune" },
        pruned,
      );
    const [next] = this.#exec<{ at: number | null }>(
      "feed.read",
      "SELECT min(expires_at) AS at FROM feed_audience_pages",
    );
    return { pruned, nextAt: next?.at ?? null };
  }

  /**
   * In a change's transaction: entries settling the review requests of
   * `recipients` on pull request `number` (nothing of them is left to act
   * on), in blocks of at most `MAX_FEED_AUDIENCE` that carry all they
   * deliver, so they travel in the event's data and are delivered
   * whoever owns the repository by then. No reader filter: a feed checks
   * access when read. Bumps the thread's version once; none for no one.
   */
  settlements(
    number: number,
    recipients: readonly FeedPrincipal[],
    actor: string | null,
    action: string,
  ): FeedBlock[] {
    const unique = [...new Map(recipients.map((r) => [r.id, r])).values()];
    const subject = unique.length > 0 ? this.#subject(number) : undefined;
    if (!subject) return [];
    const actorRoot = this.#actor?.root ?? actor;
    const threadKey = `${subject.kind}/${number}`;
    const version = this.#bump(threadKey);
    const blocks: FeedBlock[] = [];
    for (let at = 0; at < unique.length; at += MAX_FEED_AUDIENCE)
      blocks.push({
        threadKey,
        subject: {
          kind: subject.kind,
          number,
          title: String(subject.title ?? "").slice(0, MAX_FEED_TITLE),
          version,
        },
        action,
        actorRoot,
        actorTrust: this.#trust(actor),
        member: null,
        excerpt: null,
        audience: unique.slice(at, at + MAX_FEED_AUDIENCE).map((who) => ({
          principal: who.id,
          kind: "review_requested",
          reasons: ["requested_reviewer"],
          priority: "P0",
          state: "resolved",
          // Their own action: settled without telling them.
          silent: who.id === actor || who.id === actorRoot || who.root === actorRoot,
        })),
      });
    return blocks;
  }

  /** In a change's transaction: the thread's feed version, bumped. */
  #bump(threadKey: string): number {
    const [bumped] = this.#exec<{ version: number }>(
      "feed.version",
      `INSERT INTO feed_threads (thread_key, version) VALUES (?, 1)
       ON CONFLICT (thread_key) DO UPDATE SET version = version + 1 RETURNING version`,
      threadKey,
    );
    return (bumped as { version: number }).version;
  }

  /** What an event means, before its audience is filtered; undefined for nothing. */
  #plan(type: string, data: Row, row: Row | null, ownerGen: number): Plan | undefined {
    const mentioned = (handles: readonly string[]) => {
      const known = this.#actor?.mentioned;
      return known ? handles.flatMap((h) => known.get(h) ?? []) : [];
    };
    const changes = (data.changes ?? {}) as Record<string, { from?: unknown }>;
    const before = typeof changes.body?.from === "string" ? changes.body.from : null;
    switch (type) {
      case "issue.opened": {
        if (!row) return undefined;
        const assignees = this.#assigned(row.number as number);
        return {
          ...nothing(row.number as number, "opened"),
          direct: assignees.map((who) => ({
            ...settledAs(who, "assigned", "assignee"),
            state: "open" as const,
          })),
          member: `issue/${row.number}`,
          mentions: mentioned(mentionsIn(row.body as string | null)),
          joins: [
            ...authorsOf(row).map((who) => [who, "author"] as const),
            ...assignees.map((who) => [who, "assignee"] as const),
          ],
        };
      }
      case "issue.edited":
        if (!row || !("body" in changes)) return undefined;
        return {
          ...nothing(row.number as number, "edited"),
          member: `issue/${row.number}`,
          mentions: mentioned(newMentions(before, row.body as string | null)),
        };
      case "issue.closed":
      case "issue.reopened": {
        if (!row) return undefined;
        const closed = type === "issue.closed";
        return {
          ...nothing(row.number as number, closed ? "closed" : "reopened"),
          // Nothing to act on while closed; the assignments stand again when reopened.
          direct: this.#assigned(row.number as number).map((who) => ({
            ...settledAs(who, "assigned", "assignee"),
            state: closed ? ("resolved" as const) : ("open" as const),
          })),
          activity: true,
        };
      }
      case "issue.assigned":
      case "issue.unassigned":
      case "pull_request.assigned":
      case "pull_request.unassigned": {
        if (!row) return undefined;
        const assignee = {
          id: String(data.assignee),
          root: String(data.assignee_root ?? data.assignee),
        };
        const assigned = type.endsWith(".assigned");
        return {
          ...nothing(row.number as number, assigned ? "assigned" : "unassigned"),
          direct: [
            {
              ...settledAs(assignee, "assigned", "assignee"),
              // An assignment to a closed subject is nothing to act on until it reopens.
              state: assigned && row.state === "open" ? "open" : "resolved",
            },
          ],
          joins: assigned ? [[assignee, "assignee"]] : [],
        };
      }
      case "pull_request.opened": {
        if (!row) return undefined;
        return {
          ...nothing(row.number as number, "opened"),
          member: `pull/${row.number}`,
          mentions: mentioned(mentionsIn(row.body as string | null)),
          joins: authorsOf(row).map((who) => [who, "author"] as const),
        };
      }
      case "pull_request.edited":
        if (!row || !("body" in changes)) return undefined;
        return {
          ...nothing(row.number as number, "edited"),
          member: `pull/${row.number}`,
          mentions: mentioned(newMentions(before, row.body as string | null)),
        };
      case "pull_request.closed":
        if (!row) return undefined;
        return {
          ...nothing(row.number as number, row.state === "merged" ? "merged" : "closed"),
          // Nothing on it is still to act on (a merge settles the teams' members on its own).
          direct: [
            ...this.#requested(row.number as number).map((who) =>
              settledAs(who, "review_requested", "requested_reviewer"),
            ),
            ...(row.state === "merged"
              ? []
              : this.#teamMembers(row.number as number, ownerGen)
            ).map((who) => settledAs(who, "review_requested", "requested_team")),
            ...this.#assigned(row.number as number).map((who) =>
              settledAs(who, "assigned", "assignee"),
            ),
            ...authorsOf(row).flatMap((who) =>
              (["approved", "changes_requested", "merge_conflict"] as const).map((kind) =>
                settledAs(who, kind, "author"),
              ),
            ),
          ],
          activity: true,
        };
      case "pull_request.reopened": {
        if (!row) return undefined;
        const number = row.number as number;
        // What stood when it closed stands again: requests kept, reviews given, a conflict known.
        // The conflict last known (a head moved meanwhile is worked out again, and told if it
        // changed).
        const conflicting = this.#exec<{ state: string }>(
          "feed.read",
          "SELECT state FROM mergeability WHERE pr_number = ?",
          number,
        ).some((m) => conflictingState(m.state));
        return {
          ...nothing(number, "reopened"),
          direct: [
            ...this.#requested(number).map((who) => ({
              ...settledAs(who, "review_requested", "requested_reviewer"),
              state: "open" as const,
              standing: true,
            })),
            ...this.#teamMembers(number, ownerGen).map((who) => ({
              ...settledAs(who, "review_requested", "requested_team"),
              state: "open" as const,
              standing: true,
            })),
            ...this.#assigned(number).map((who) => ({
              ...settledAs(who, "assigned", "assignee"),
              state: "open" as const,
            })),
            ...this.#outcomes(number),
            ...(conflicting
              ? authorsOf(row).map((who) => ({
                  ...settledAs(who, "merge_conflict", "author"),
                  state: "open" as const,
                }))
              : []),
          ],
          activity: true,
        };
      }
      case "pull_request.review_requested": {
        const number = data.number as number;
        // A team's: each member it had when asked (kept with the request), not joining the thread.
        if (typeof data.request_id === "number" && data.team)
          return {
            ...nothing(number, "review_requested"),
            direct: this.#audience(data.request_id).map((id) => ({
              ...settledAs({ id, root: id }, "review_requested", "requested_team"),
              state: "open" as const,
            })),
          };
        const reviewer = {
          id: String(data.reviewer),
          root: String(data.reviewer_root ?? data.reviewer),
        };
        return {
          ...nothing(number, "review_requested"),
          direct: [
            { ...settledAs(reviewer, "review_requested", "requested_reviewer"), state: "open" },
          ],
          joins: [[reviewer, "requested_reviewer"]],
        };
      }
      case "pull_request_review.submitted":
      case "pull_request_review.dismissed": {
        if (!row) return undefined;
        const number = row.number as number;
        const submitted = type === "pull_request_review.submitted";
        const reviewer = { id: String(row.reviewerId), root: String(row.reviewerRoot) };
        return {
          ...nothing(number, submitted ? "review" : "review_dismissed"),
          // A review given settles the requests of it in the event's own entries (`settlements`).
          direct: this.#outcomes(number),
          // Outcomes reach the author even when its own agent reviewed (terminal outcomes).
          exact: true,
          activity: submitted,
          member: `review/${row.id}`,
          mentions: submitted ? mentioned(mentionsIn(row.body as string | null)) : [],
          joins: submitted ? [[reviewer, "reviewer"]] : [],
        };
      }
      case "issue_comment.created":
      case "pull_request_review_comment.created": {
        if (!row) return undefined;
        const prefix = type === "issue_comment.created" ? "comment" : "review_comment";
        return {
          ...nothing(row.number as number, prefix),
          activity: true,
          member: `${prefix}/${row.id}`,
          mentions: mentioned(mentionsIn(row.body as string | null)),
          joins: [[{ id: String(row.authorId), root: String(row.authorRoot) }, "commenter"]],
        };
      }
      // An edit tells only the mentions it adds (feeds read the comment's text when shown).
      case "issue_comment.edited":
      case "pull_request_review_comment.edited": {
        if (!row) return undefined;
        const prefix = type.startsWith("issue_comment") ? "comment" : "review_comment";
        return {
          ...nothing(row.number as number, "comment_edited"),
          member: `${prefix}/${row.id}`,
          mentions: mentioned(newMentions(before, row.body as string | null)),
        };
      }
      case "pull_request.mergeability": {
        const state = data.state;
        const conflicting = conflictingState(state);
        if (!conflicting && state !== "clean") return undefined;
        // From one conflicting state to another is no news.
        if (conflicting && conflictingState(data.previous_state)) return undefined;
        const number = data.number as number;
        const pull = this.#pull(number);
        if (!pull) return undefined;
        return {
          ...nothing(number, conflicting ? "merge_conflict" : "merge_clean"),
          direct: authorsOf(pull).map((who) => ({
            ...settledAs(who, "merge_conflict", "author"),
            state: conflicting ? ("open" as const) : ("resolved" as const),
          })),
        };
      }
      default:
        return undefined;
    }
  }

  /** The reviews' outcome for the pull request's author: requested changes, approvals (latest per reviewer). */
  #outcomes(number: number): Named[] {
    const pull = this.#pull(number);
    if (!pull) return [];
    // Each reviewer's latest review that counts, found once per reviewer.
    const latest = this.#exec<{ state: string }>(
      "feed.read",
      `SELECT r.state FROM reviews r JOIN (
         SELECT max(review_id) AS id FROM reviews
         WHERE pr_number = ? AND dismissed_at IS NULL AND state <> 'COMMENTED'
         GROUP BY reviewer_id) l ON r.review_id = l.id`,
      number,
    ).map((r) => r.state);
    const changes = latest.includes("CHANGES_REQUESTED");
    const approved = latest.includes("APPROVED");
    return authorsOf(pull).flatMap((who) => [
      {
        ...settledAs(who, "changes_requested", "author"),
        state: changes ? ("open" as const) : ("resolved" as const),
      },
      {
        ...settledAs(who, "approved", "author"),
        state: approved && !changes ? ("open" as const) : ("resolved" as const),
      },
    ]);
  }

  /** The actor's access when it acted: write, read, or none (a public repository's reader). */
  #trust(actor: string | null): FeedBlock["actorTrust"] {
    const role =
      this.#actor?.role ?? (actor === null ? null : this.deps.roleOf(this.#actor?.root ?? actor));
    return atLeast(role, "write") ? "write" : atLeast(role, "read") ? "read" : "none";
  }

  /** What thread `number` is about: an issue or a pull request, with its title and author. */
  #subject(number: number): (Row & { kind: "issue" | "pull" }) | undefined {
    return this.#exec<Record<string, SqlStorageValue> & { kind: "issue" | "pull" }>(
      "feed.read",
      `SELECT 'issue' AS kind, number, title, author_id AS authorId, author_root AS authorRoot
       FROM issues WHERE number = ?1
       UNION ALL
       SELECT 'pull', number, title, author_id, author_root FROM pull_requests WHERE number = ?1`,
      number,
    )[0];
  }

  #pull(number: number): Row | undefined {
    return this.#exec<Record<string, SqlStorageValue>>(
      "feed.read",
      `SELECT number, title, author_id AS authorId, author_root AS authorRoot
       FROM pull_requests WHERE number = ?`,
      number,
    )[0];
  }

  /** Who is assigned, with the root identities they were assigned as. */
  #assigned(number: number): FeedPrincipal[] {
    return this.#exec<{ id: string; root: string }>(
      "feed.read",
      "SELECT principal AS id, root FROM subject_assignees WHERE number = ? ORDER BY principal",
      number,
    );
  }

  /** The reviewers asked, with the root identities they joined the thread as. */
  #requested(number: number): FeedPrincipal[] {
    return this.#exec<{ id: string; root: string }>(
      "feed.read",
      `SELECT reviewer_id AS id, coalesce(reviewer_root, reviewer_id) AS root
       FROM review_requests WHERE pr_number = ?`,
      number,
    );
  }

  /**
   * The members the pull request's teams asked under ownership generation
   * `ownerGen` still keep (once each), the root identity each counts as
   * being itself (members are users).
   */
  #teamMembers(number: number, ownerGen: number): FeedPrincipal[] {
    return this.#exec<{ id: string }>(
      "feed.read",
      `SELECT DISTINCT m.value AS id FROM review_team_requests t
       JOIN review_request_audiences a ON a.request_id = t.request_id, json_each(a.members) m
       WHERE t.pr_number = ? AND t.owner_gen = ? AND t.audience = 1`,
      number,
      ownerGen,
    ).map((row) => ({ id: row.id, root: row.id }));
  }

  /** The members a team's request kept, in the order kept. */
  #audience(requestId: number): string[] {
    return this.#exec<{ members: string }>(
      "feed.read",
      "SELECT members FROM review_request_audiences WHERE request_id = ? ORDER BY page",
      requestId,
    ).flatMap((row) => JSON.parse(row.members) as string[]);
  }

  /** The thread's participants in the order they joined, a page at a time. */
  #participants(number: number): { principal: string; root: string; reason: string }[] {
    const all: { principal: string; root: string; reason: string }[] = [];
    for (let after = 0; ; ) {
      const page = this.#exec<{
        principal: string;
        root: string;
        reason: string;
        joined_seq: number;
      }>("feed.read", PARTICIPANTS_PAGE, number, after, PARTICIPANTS_PER_PAGE);
      for (const { joined_seq: _, ...p } of page) all.push(p);
      if (page.length < PARTICIPANTS_PER_PAGE) return all;
      after = page[page.length - 1]?.joined_seq ?? after;
    }
  }

  /**
   * `who` takes part in the thread from now on (the first reason kept),
   * unless the thread has its cap of participants: then the refused join
   * is counted. One already in is not joined again, nor counted. At the
   * cap, participants who no longer read the repository give their places
   * up first (looked for once each time its readers change).
   */
  #join(number: number, who: FeedPrincipal, reason: string, readers: Readers): void {
    // One known by its own id until now gets its real root identity (also past the cap).
    this.#exec(
      "feed.participants",
      `UPDATE feed_participants SET root = ?3
       WHERE number = ?1 AND principal = ?2 AND root = principal AND ?3 <> principal`,
      number,
      who.id,
      who.root,
    );
    const known = this.#exec(
      "feed.read",
      "SELECT 1 FROM feed_participants WHERE number = ? AND principal = ?",
      number,
      who.id,
    );
    if (known.length > 0) return;
    let [count] = this.#exec<{ participants: number; next_seq: number; reclaimed: string | null }>(
      "feed.read",
      "SELECT participants, next_seq, reclaimed FROM feed_participation WHERE number = ?",
      number,
    );
    if (
      count &&
      count.participants >= MAX_PARTICIPANTS &&
      readers.key !== null &&
      count.reclaimed !== readers.key
    ) {
      this.#reclaim(number, readers);
      [count] = this.#exec<{ participants: number; next_seq: number; reclaimed: string | null }>(
        "feed.read",
        "SELECT participants, next_seq, reclaimed FROM feed_participation WHERE number = ?",
        number,
      );
    }
    if ((count?.participants ?? 0) >= MAX_PARTICIPANTS) {
      this.#exec(
        "feed.participants",
        "UPDATE feed_participation SET overflow = overflow + 1 WHERE number = ?",
        number,
      );
      this.deps.metrics.count("feed.participants_overflow", {});
      return;
    }
    const seq = count?.next_seq ?? 1;
    this.#exec(
      "feed.participants",
      `INSERT INTO feed_participants (number, principal, root, reason, joined_seq)
       VALUES (?, ?, ?, ?, ?)`,
      number,
      who.id,
      who.root,
      reason,
      seq,
    );
    this.#exec(
      "feed.participants",
      `INSERT INTO feed_participation (number, participants, next_seq) VALUES (?1, 1, ?2 + 1)
       ON CONFLICT (number) DO UPDATE SET participants = participants + 1, next_seq = ?2 + 1`,
      number,
      seq,
    );
  }

  /**
   * Deletes the thread's participants who no longer read the repository,
   * so their places can be taken, and notes which readers it looked with.
   */
  #reclaim(number: number, readers: Readers): void {
    const gone = this.#participants(number)
      .filter((p) => !readers.mayRead(p.principal))
      .map((p) => p.principal);
    if (gone.length > 0)
      this.#exec(
        "feed.participants",
        `DELETE FROM feed_participants
         WHERE number = ?1 AND principal IN (SELECT value FROM json_each(?2))`,
        number,
        JSON.stringify(gone),
      );
    this.#exec(
      "feed.participants",
      "UPDATE feed_participation SET participants = participants - ?2, reclaimed = ?3 WHERE number = ?1",
      number,
      gone.length,
      readers.key,
    );
  }
}

interface Plan {
  readonly number: number;
  readonly action: string;
  /** Recipients the event names itself (requested reviewers, the author). */
  readonly direct: readonly Named[];
  /** Recipients count as the actor only when they are the actor itself (not its root). */
  readonly exact?: boolean;
  /** The thread's participants hear of it as activity. */
  readonly activity: boolean;
  readonly member: string | null;
  readonly mentions: readonly FeedPrincipal[];
  /** Who takes part in the thread from now on, and why. */
  readonly joins: readonly (readonly [FeedPrincipal, string])[];
}

function nothing(number: number, action: string): Plan {
  return {
    number,
    action,
    direct: [],
    activity: false,
    member: null,
    mentions: [],
    joins: [],
  };
}

function settledAs(who: FeedPrincipal, kind: FeedKind, reason: string): Named {
  return {
    principal: who.id,
    root: who.root,
    kind,
    reasons: [reason],
    priority: "P0",
    state: "resolved",
  };
}

/** Whether a recipient's entry settles a review request (reaching it whatever its access). */
function settlesRequest(r: Named): boolean {
  return r.kind === "review_requested" && r.state === "resolved";
}

/** The issue's or pull request's author, and the user its agent author acts for. */
function authorsOf(pull: Row): FeedPrincipal[] {
  const root = String(pull.authorRoot);
  const author = String(pull.authorId);
  return author === root
    ? [{ id: author, root }]
    : [
        { id: author, root },
        { id: root, root },
      ];
}

/** Whether a mergeability state means a conflict the author must resolve. */
function conflictingState(state: unknown): boolean {
  return state === "conflicts" || state === "manual";
}

/** The start of a text as plain words, at most the excerpt's length. */
export function excerpt(text: string | null | undefined): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_FEED_EXCERPT) return flat;
  return `${flat.slice(0, MAX_FEED_EXCERPT - 1)}…`;
}
