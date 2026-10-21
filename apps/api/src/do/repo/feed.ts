import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  atLeast,
  type FeedBlock,
  type FeedKind,
  type FeedRecipient,
  MAX_FEED_AUDIENCE,
  MAX_FEED_EXCERPT,
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
  /** Brings the ACL as `readers` and `roleOf` see it up to date (within its read TTL). */
  readonly refreshAccess: () => Promise<void>;
  /** Handles (lower-cased) to the active users and agents with them. */
  readonly resolveHandles: (handles: readonly string[]) => Promise<Map<string, FeedPrincipal>>;
  /** Before a change, with the texts it writes: what else they need resolved (other repositories). */
  readonly prepareTexts?: (texts: readonly (string | null | undefined)[]) => Promise<void>;
  readonly metrics: Metrics;
}

type Row = Record<string, unknown>;
/** A recipient as a plan names it, with the root identity it counts as. */
type Named = Omit<FeedRecipient, "silent"> & { readonly root: string };

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
  ): FeedBlock | undefined {
    const plan = this.#plan(type, data ?? {}, row);
    if (!plan) return undefined;
    const subject = this.#subject(plan.number);
    if (!subject) return undefined;
    const actorRoot = this.#actor?.root ?? actor;
    const readers = this.deps.readers();
    const audience: FeedRecipient[] = [];
    // One entry per principal and kind (a participant mentioned hears of both).
    const named = new Set<string>();
    const add = (r: Named, exact = false) => {
      const self = exact
        ? r.principal === actor
        : r.principal === actor || r.principal === actorRoot || r.root === actorRoot;
      // No one hears of their own activity; what their action changes of their items, silently.
      if (self && !ACTION_KINDS.has(r.kind)) return;
      const key = `${r.principal}|${r.kind}`;
      if (named.has(key)) return;
      if (!readers.mayRead(r.principal)) return;
      named.add(key);
      const { root: _root, ...recipient } = r;
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
    for (const [who, reason] of plan.joins) this.#join(plan.number, who, reason, readers);
    if (audience.length === 0) return undefined;
    // Things to act on first, when there are more than one event may name.
    audience.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "P0" ? -1 : 1));
    if (audience.length > MAX_FEED_AUDIENCE)
      this.deps.metrics.count("feed.audience_dropped", {}, audience.length - MAX_FEED_AUDIENCE);
    const threadKey = `${subject.kind}/${plan.number}`;
    const [bumped] = this.#exec<{ version: number }>(
      "feed.version",
      `INSERT INTO feed_threads (thread_key, version) VALUES (?, 1)
       ON CONFLICT (thread_key) DO UPDATE SET version = version + 1 RETURNING version`,
      threadKey,
    );
    return {
      threadKey,
      subject: {
        kind: subject.kind,
        number: plan.number,
        title: String(subject.title ?? "").slice(0, MAX_FEED_TITLE),
        version: (bumped as { version: number }).version,
      },
      action: plan.action,
      actorRoot,
      actorTrust: this.#trust(actor),
      member: plan.member,
      // Read live from `member` when a feed is shown (an edit or deletion shows at once).
      excerpt: null,
      audience: audience.slice(0, MAX_FEED_AUDIENCE),
    };
  }

  /** What an event means, before its audience is filtered; undefined for nothing. */
  #plan(type: string, data: Row, row: Row | null): Plan | undefined {
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
          // Nothing on it is still to act on.
          direct: [
            ...this.#requested(row.number as number).map((who) =>
              settledAs(who, "review_requested", "requested_reviewer"),
            ),
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
      case "pull_request.review_requested":
      case "pull_request.review_request_removed": {
        const reviewer = {
          id: String(data.reviewer),
          root: String(data.reviewer_root ?? data.reviewer),
        };
        const open = type === "pull_request.review_requested";
        return {
          ...nothing(data.number as number, open ? "review_requested" : "review_request_removed"),
          direct: [
            {
              ...settledAs(reviewer, "review_requested", "requested_reviewer"),
              state: open ? "open" : "resolved",
            },
          ],
          joins: open ? [[reviewer, "requested_reviewer"]] : [],
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
          // A review given settles the request of it (its reviewer's own action: silently).
          direct: [
            ...(submitted ? [settledAs(reviewer, "review_requested", "requested_reviewer")] : []),
            ...this.#outcomes(number),
          ],
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
