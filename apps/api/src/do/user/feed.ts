import type { FeedEntry, FeedKind, FeedPriority } from "@fyrden/domain";

/*
 * A principal's activity feed: one item per repository, thread and kind,
 * updated in place by the entries events bring. An entry applies only when
 * it is newer than the item (the thread's feed version), so duplicates and
 * any delivery order leave the same item; an activity item also gathers the
 * ids of what it aggregates (comments, reviews) as a set, and a comment's
 * edit or deletion updates or clears the excerpt taken from it. What only
 * resolves or deletes something the feed never showed is kept as a
 * tombstone (a row without a sequence number, never read), so that an
 * older entry arriving later cannot bring it back. Every change of a shown
 * item gives it the feed's next sequence number, so a reader that follows
 * the sequence sees each change, late arrivals included. Items and
 * tombstones older than the retention, and items past the cap, are
 * deleted; the low watermark records how far, and a cursor below it has
 * missed changes. When the owner loses read access to repositories, their
 * items up to then are purged, and a mark drops entries up to then that
 * arrive later.
 */

/** Proposed values. */
export const FEED_POLICY = {
  /** Items whose last change is older are deleted; older entries are dropped on arrival. */
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  /** Items a feed keeps at most; the ones changed longest ago go first. */
  maxItems: 5_000,
  /** Ids an activity item keeps at most (the greatest). */
  maxMembers: 100,
  /** Deleted member ids an activity item remembers at most (the latest deleted). */
  maxDeleted: 100,
  /** Items a sync returns at most. */
  syncItems: 500,
} as const;

/**
 * The key a feed's restore generation has in the directory's
 * `source_epochs`: a restore of the principal's object allocates the next
 * one there, as for a repository's.
 */
export const feedEpochSource = (principalId: string) => `feed:${principalId}`;

/** A place in a feed: its epoch and a sequence number. */
export interface FeedPosition {
  readonly epoch: string;
  readonly seq: number;
}

export interface FeedItem {
  readonly repoId: string;
  readonly threadKey: string;
  readonly kind: FeedKind;
  readonly number: number;
  readonly title: string;
  readonly version: number;
  readonly state: "open" | "resolved";
  readonly priority: FeedPriority;
  readonly reasons: readonly string[];
  /** The last change was the owner's own action: nothing to notify of. */
  readonly silent: boolean;
  readonly action: string;
  readonly actor: string | null;
  readonly actorTrust: "write" | "read" | "none";
  readonly excerpt: string | null;
  readonly members: readonly string[];
  readonly truncated: boolean;
  readonly eventKey: string;
  readonly eventAt: number;
  readonly ackedVersion: number;
  readonly seq: number;
}

/** What applying entries did: items changed, and of those, changes to notify of (not silent). */
export interface FeedApplied {
  readonly changed: number;
  readonly notified: number;
}

export type FeedPage =
  | { readonly expired: true }
  | {
      readonly expired: false;
      readonly head: FeedPosition;
      readonly items: readonly FeedItem[];
      /** More items follow the page's last one. */
      readonly more: boolean;
    };

export interface FeedFilter {
  readonly priority?: FeedPriority | undefined;
  readonly kind?: FeedKind | undefined;
  /** Only items of these repositories (a token's own list); null for any. */
  readonly repoIds?: readonly string[] | null | undefined;
}

/** Where a sync page ends: whether its last item was an open P0 one, and its sequence number. */
export interface SyncPosition {
  readonly open: boolean;
  readonly seq: number;
}

/** `ahead`: the item has no such version yet. */
export type FeedAck =
  | { readonly status: "missing" }
  | { readonly status: "ahead" }
  | { readonly status: "acked"; readonly item: FeedItem };

/** Repositories the owner no longer reads, as of `until` (ms), at an account's ACL version. */
export interface FeedPurge {
  readonly repoIds: readonly string[];
  readonly until: number;
  readonly aclVersion: number;
}

/** Item key fields, as the item's primary key orders them. */
export interface FeedItemId {
  readonly repoId: string;
  readonly threadKey: string;
  readonly kind: FeedKind;
}

type Meta = { epoch: string; head_seq: number; low_watermark: number; items: number };

type Row = {
  repo_id: string;
  thread_key: string;
  kind: FeedKind;
  number: number;
  title: string;
  version: number;
  state: "open" | "resolved";
  priority: FeedPriority;
  reasons: string;
  silent: number;
  action: string;
  actor: string | null;
  actor_trust: "write" | "read" | "none";
  excerpt: string | null;
  display_member: string | null;
  display_version: number;
  members: string;
  deleted: string;
  truncated: number;
  last_event_key: string;
  last_event_at: number;
  acked_version: number;
  /** Null for a tombstone. */
  feed_seq: number | null;
  seq_at: number;
};

/** Member ids in a stable total order, greatest first: longer first, so numeric ids compare as numbers. */
function byIdDescending(a: string, b: string): number {
  if (a.length !== b.length) return b.length - a.length;
  return a < b ? 1 : a > b ? -1 : 0;
}

function itemOf(row: Row): FeedItem {
  return {
    repoId: row.repo_id,
    threadKey: row.thread_key,
    kind: row.kind,
    number: row.number,
    title: row.title,
    version: row.version,
    state: row.state,
    priority: row.priority,
    reasons: JSON.parse(row.reasons) as string[],
    silent: row.silent === 1,
    action: row.action,
    actor: row.actor,
    actorTrust: row.actor_trust,
    excerpt: row.excerpt,
    members: JSON.parse(row.members) as string[],
    truncated: row.truncated === 1,
    eventKey: row.last_event_key,
    eventAt: row.last_event_at,
    ackedVersion: row.acked_version,
    seq: row.feed_seq as number,
  };
}

const WHERE_ITEM = "repo_id = ? AND thread_key = ? AND kind = ?";

/** What a comment's edit or deletion does to the activity items it is a member of. */
const REDACTIONS = new Set(["comment_edited", "comment_deleted"]);

const isRedaction = (entry: FeedEntry) =>
  entry.recipient.kind === "activity" && REDACTIONS.has(entry.feed.action);

/** An item's fields that entries change: its row less its key, sequence and acknowledgement. */
type State = Omit<Row, "repo_id" | "thread_key" | "kind" | "acked_version" | "feed_seq" | "seq_at">;

function stateOf(row: Row): State {
  const {
    repo_id: _,
    thread_key: __,
    kind: ___,
    acked_version: ____,
    feed_seq,
    seq_at,
    ...state
  } = row;
  return state;
}

const sameState = (a: State, b: State) => JSON.stringify(a) === JSON.stringify(b);

/** A state before any entry: every entry is newer, and nothing is shown or displayed. */
function blank(entry: FeedEntry): State {
  return {
    ...thread(entry),
    version: 0,
    state: "resolved",
    display_member: null,
    display_version: 0,
    excerpt: null,
    actor: null,
    actor_trust: entry.feed.actorTrust,
    members: "[]",
    deleted: "[]",
    truncated: 0,
  };
}

/** The thread's state as an entry tells it (the newest version's wins). */
function thread(entry: FeedEntry) {
  const { feed, recipient } = entry;
  return {
    number: feed.subject.number,
    title: feed.subject.title,
    version: feed.subject.version,
    state: recipient.state,
    priority: recipient.priority,
    reasons: JSON.stringify(recipient.reasons),
    silent: recipient.silent ? 1 : 0,
    action: feed.action,
    last_event_key: entry.eventKey,
    last_event_at: entry.occurredAt,
  };
}

/**
 * An activity item with a member's creation, edit or deletion applied.
 * The members are the greatest 100 created and not deleted; a deleted id
 * is remembered (the latest 100) and never added again. What the item
 * displays (the excerpt, its author and trust) is the greatest member's
 * ever seen, deleted ones included (their excerpt cleared): its creation
 * sets the author (none until it arrives), and its creation or an edit
 * the excerpt, whichever has the newest thread version. So any order of
 * the same entries displays the same.
 */
function withMember(state: State, entry: FeedEntry, op: "create" | "edit" | "delete"): State {
  const { feed } = entry;
  const member = feed.member;
  if (member === null) return state;
  const version = feed.subject.version;
  const deleted = JSON.parse(state.deleted) as string[];
  const gone = op === "delete" || deleted.includes(member);
  if (op === "edit" && gone) return state;
  let members = JSON.parse(state.members) as string[];
  let truncated = state.truncated === 1;
  if (op === "delete") members = members.filter((m) => m !== member);
  else if (!gone && !members.includes(member)) {
    const union = [...members, member].sort(byIdDescending);
    members = union.slice(0, FEED_POLICY.maxMembers);
    truncated ||= union.length > FEED_POLICY.maxMembers;
  }
  const next: State = {
    ...state,
    members: JSON.stringify(members),
    truncated: truncated ? 1 : 0,
    deleted:
      op === "delete" && !deleted.includes(member)
        ? JSON.stringify([...deleted, member].slice(-FEED_POLICY.maxDeleted))
        : state.deleted,
  };
  const shown = state.display_member;
  if (shown !== null && byIdDescending(member, shown) > 0) return next;
  const same = shown === member;
  // A member displayed before its creation arrives has no author yet.
  const display = {
    ...next,
    display_member: member,
    ...(!same && { actor: null, actor_trust: feed.actorTrust }),
  };
  // A deleted member displays no excerpt, whatever version it had.
  if (op === "delete") return { ...display, excerpt: null, display_version: 0 };
  const author = op === "create" ? { actor: entry.actor, actor_trust: feed.actorTrust } : undefined;
  if (gone) return { ...display, ...author, excerpt: null, display_version: 0 };
  if (same && version <= state.display_version)
    return op === "create" ? { ...next, ...author } : next;
  return { ...display, ...author, excerpt: feed.excerpt, display_version: version };
}

export class Feed {
  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => number,
  ) {}

  /**
   * Applies entries (call within a transaction). Within one call an item's
   * entries apply in version order. An entry older than the retention, or
   * of a purged repository up to its purge, is dropped. A newer version
   * replaces the thread's state in the item; an activity item also takes
   * the entry's member (see `withMember`). An item is shown once an entry
   * opens it (see `#applyOne`). A duplicate, or an older version that adds
   * nothing, writes nothing. A comment's edit or deletion notifies of
   * nothing.
   */
  apply(entries: readonly FeedEntry[]): FeedApplied {
    const now = this.now();
    let changed = 0;
    let notified = 0;
    const ordered = [...entries].sort((a, b) => a.feed.subject.version - b.feed.subject.version);
    const purged = new Map<string, number | null>();
    const purgedUntil = (repoId: string) => {
      if (!purged.has(repoId)) purged.set(repoId, this.#purgedUntil(repoId));
      return purged.get(repoId) ?? null;
    };
    for (const entry of ordered) {
      if (entry.occurredAt < now - FEED_POLICY.retentionMs) continue;
      const until = purgedUntil(entry.repoId);
      if (until !== null && entry.occurredAt <= until) continue;
      const redaction = isRedaction(entry);
      if (!(redaction ? this.#redact(entry, now) : this.#applyOne(entry, now))) continue;
      changed++;
      if (!redaction && !entry.recipient.silent) notified++;
    }
    return { changed, notified };
  }

  /**
   * A comment edited or deleted, for the activity item it is a member of
   * (see `withMember`); the thread's state is left as it is, whatever the
   * entry's version (the item is not reopened). For an item the feed does
   * not have yet, a tombstone keeps it, so a creation arriving later
   * displays the same. A shown item is sequenced only when what it shows
   * changed.
   */
  #redact(entry: FeedEntry, now: number): boolean {
    const { feed } = entry;
    const id = { repoId: entry.repoId, threadKey: feed.threadKey, kind: "activity" } as const;
    const item = this.#row(id);
    const before = item ? stateOf(item) : blank(entry);
    const after = withMember(before, entry, feed.action === "comment_deleted" ? "delete" : "edit");
    if (item && sameState(before, after)) return false;
    const shown = item !== undefined && item.feed_seq !== null;
    // What a reader sees changed, not only what the item remembers.
    const visible = shown && !sameState({ ...before, deleted: "" }, { ...after, deleted: "" });
    const seq = visible ? this.#next(false) : (item?.feed_seq ?? null);
    // A tombstone's retention starts again with each change of what it guards.
    this.#write(id, after, seq, visible || !shown ? now : (item?.seq_at ?? now));
    return visible;
  }

  /**
   * One entry, other than a comment's edit or deletion. An item the feed
   * has not shown (none, or a tombstone) is shown, with the newest state
   * the feed knows of it, once an entry that opens it arrives, whatever
   * that entry's version; until then, an entry that only resolves keeps
   * that newest state in a tombstone. So the outcome does not depend on
   * the order: an item resolved before its opening arrived is shown
   * resolved, and one that never opened is never shown.
   */
  #applyOne(entry: FeedEntry, now: number): boolean {
    const { feed, recipient } = entry;
    const id = { repoId: entry.repoId, threadKey: feed.threadKey, kind: recipient.kind };
    const item = this.#row(id);
    const before = item ? stateOf(item) : blank(entry);
    const newer = feed.subject.version > before.version;
    let after: State = newer ? { ...before, ...thread(entry) } : before;
    if (recipient.kind === "activity") after = withMember(after, entry, "create");
    else if (newer)
      after = {
        ...after,
        display_member: feed.member,
        display_version: feed.subject.version,
        excerpt: feed.excerpt,
        actor: entry.actor,
        actor_trust: feed.actorTrust,
      };
    const shown = item !== undefined && item.feed_seq !== null;
    const shows = !shown && recipient.state === "open";
    if (item && sameState(before, after) && !shows) return false;
    const seq = shown || shows ? this.#next(!shown) : null;
    this.#write(id, after, seq, now);
    return seq !== null;
  }

  #write(id: FeedItemId, state: State, seq: number | null, seqAt: number): void {
    const columns = Object.keys(state) as (keyof State)[];
    this.sql.exec(
      `INSERT INTO feed_items (repo_id, thread_key, kind, ${columns.join(", ")}, feed_seq, seq_at)
       VALUES (?, ?, ?, ${columns.map(() => "?").join(", ")}, ?, ?)
       ON CONFLICT (repo_id, thread_key, kind) DO UPDATE SET
         ${[...columns, "feed_seq", "seq_at"].map((c) => `${c} = excluded.${c}`).join(", ")}`,
      id.repoId,
      id.threadKey,
      id.kind,
      ...columns.map((c) => state[c]),
      seq,
      seqAt,
    );
  }

  /**
   * A page of the items changed after `since` (from the start without one),
   * in sequence order; expired when `since` is of another epoch, below the
   * low watermark (retention deleted changes after it) or past the head.
   * The caller reads on with the last item's position.
   */
  list(since: FeedPosition | null, limit: number, filter: FeedFilter = {}): FeedPage {
    const meta = this.#meta();
    if (
      since &&
      (since.epoch !== meta.epoch || since.seq < meta.low_watermark || since.seq > meta.head_seq)
    )
      return { expired: true };
    const rows = this.sql
      .exec<Row>(
        `SELECT * FROM feed_items
         WHERE feed_seq > ?1 AND (?2 IS NULL OR priority = ?2) AND (?3 IS NULL OR kind = ?3)
           AND (?5 IS NULL OR repo_id IN (SELECT value FROM json_each(?5)))
         ORDER BY feed_seq LIMIT ?4`,
        since?.seq ?? 0,
        filter.priority ?? null,
        filter.kind ?? null,
        limit + 1,
        filter.repoIds ? JSON.stringify(filter.repoIds) : null,
      )
      .toArray();
    return {
      expired: false,
      head: { epoch: meta.epoch, seq: meta.head_seq },
      items: rows.slice(0, limit).map(itemOf),
      more: rows.length > limit,
    };
  }

  /**
   * A page of what needs the owner now: open P0 items, then P1 items
   * changed within the retention, newest first, after `after` (from the
   * first without); and the feed's epoch.
   */
  sync(
    after: SyncPosition | null,
    limit: number,
    repoIds: readonly string[] | null,
  ): { epoch: string; items: FeedItem[]; more: boolean } {
    const rows = this.sql
      .exec<Row>(
        `SELECT * FROM (
           SELECT *, (priority = 'P0' AND state = 'open') AS open FROM feed_items
           WHERE feed_seq IS NOT NULL
             AND ((priority = 'P0' AND state = 'open') OR (priority = 'P1' AND last_event_at >= ?1))
             AND (?5 IS NULL OR repo_id IN (SELECT value FROM json_each(?5))))
         WHERE (open, feed_seq) < (?2, ?3)
         ORDER BY open DESC, feed_seq DESC LIMIT ?4`,
        this.now() - FEED_POLICY.retentionMs,
        after === null ? 2 : after.open ? 1 : 0,
        after?.seq ?? 0,
        limit + 1,
        repoIds ? JSON.stringify(repoIds) : null,
      )
      .toArray();
    return {
      epoch: this.#meta().epoch,
      items: rows.slice(0, limit).map(itemOf),
      more: rows.length > limit,
    };
  }

  /**
   * Records that the owner has seen `version` of an item (call within a
   * transaction). Refused for a version the item does not have yet; an
   * older one than already acknowledged changes nothing. A change is
   * sequenced, so every reader of the feed sees it.
   */
  ack(id: FeedItemId, version: number): FeedAck {
    const item = this.#row(id);
    if (!item || item.feed_seq === null) return { status: "missing" };
    if (version > item.version) return { status: "ahead" };
    if (version <= item.acked_version) return { status: "acked", item: itemOf(item) };
    const row = this.sql
      .exec<Row>(
        `UPDATE feed_items SET acked_version = ?, feed_seq = ?, seq_at = ? WHERE ${WHERE_ITEM}
         RETURNING *`,
        version,
        this.#next(false),
        this.now(),
        id.repoId,
        id.threadKey,
        id.kind,
      )
      .one();
    return { status: "acked", item: itemOf(row) };
  }

  /**
   * Forgets repositories the owner no longer reads (call within a
   * transaction): their items and tombstones last changed up to `until`
   * are deleted, and a mark drops entries up to then arriving later. A
   * repository whose mark has this ACL version or a newer one is left as
   * it is (a late or repeated purge). Returns the shown items deleted.
   */
  purge(purge: FeedPurge): number {
    let deleted = 0;
    for (const repoId of new Set(purge.repoIds)) {
      const mark = this.sql
        .exec<{ acl_version: number }>(
          "SELECT acl_version FROM purge_marks WHERE repo_id = ?",
          repoId,
        )
        .toArray()[0];
      if (mark && mark.acl_version >= purge.aclVersion) continue;
      for (const row of this.sql.exec<{ feed_seq: number | null }>(
        "DELETE FROM feed_items WHERE repo_id = ? AND last_event_at <= ? RETURNING feed_seq",
        repoId,
        purge.until,
      ))
        if (row.feed_seq !== null) deleted++;
      this.sql.exec(
        `INSERT INTO purge_marks (repo_id, until_at, acl_version) VALUES (?, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET until_at = excluded.until_at,
           acl_version = excluded.acl_version`,
        repoId,
        purge.until,
        purge.aclVersion,
      );
    }
    if (deleted > 0) this.sql.exec("UPDATE feed_meta SET items = items - ? WHERE id = 1", deleted);
    return deleted;
  }

  #purgedUntil(repoId: string): number | null {
    return (
      this.sql
        .exec<{ until_at: number }>("SELECT until_at FROM purge_marks WHERE repo_id = ?", repoId)
        .toArray()[0]?.until_at ?? null
    );
  }

  /**
   * Deletes items, tombstones and purge marks past the retention, then the
   * items changed longest ago past the cap, raising the low watermark to
   * the greatest sequence number deleted (call within a transaction).
   */
  retain(): void {
    const meta = this.#meta();
    const deleted = this.sql
      .exec<{ feed_seq: number | null }>(
        "DELETE FROM feed_items WHERE seq_at < ? RETURNING feed_seq",
        this.now() - FEED_POLICY.retentionMs,
      )
      .toArray()
      .flatMap((r) => (r.feed_seq === null ? [] : [r.feed_seq]));
    // Entries a mark would drop are dropped for their age by now.
    this.sql.exec(
      "DELETE FROM purge_marks WHERE until_at < ?",
      this.now() - FEED_POLICY.retentionMs,
    );
    const excess = meta.items - deleted.length - FEED_POLICY.maxItems;
    if (excess > 0)
      for (const r of this.sql.exec<{ feed_seq: number }>(
        `DELETE FROM feed_items WHERE feed_seq IN
           (SELECT feed_seq FROM feed_items WHERE feed_seq IS NOT NULL ORDER BY feed_seq LIMIT ?)
         RETURNING feed_seq`,
        excess,
      ))
        deleted.push(r.feed_seq);
    if (deleted.length === 0) return;
    this.sql.exec(
      "UPDATE feed_meta SET low_watermark = max(low_watermark, ?), items = items - ? WHERE id = 1",
      Math.max(...deleted),
      deleted.length,
    );
  }

  /**
   * When retention should next run: now when the feed is past its cap,
   * else when the item, tombstone or purge mark changed longest ago
   * expires; null for an empty feed.
   */
  nextRetention(): number | null {
    if (this.#meta().items > FEED_POLICY.maxItems) return this.now();
    const { item, tombstone, mark } = this.sql
      .exec<{ item: number | null; tombstone: number | null; mark: number | null }>(
        `SELECT
           (SELECT seq_at FROM feed_items WHERE feed_seq IS NOT NULL ORDER BY feed_seq LIMIT 1) AS item,
           (SELECT min(seq_at) FROM feed_items WHERE feed_seq IS NULL) AS tombstone,
           (SELECT min(until_at) FROM purge_marks) AS mark`,
      )
      .one();
    const oldest = [item, tombstone, mark].filter((at) => at !== null);
    return oldest.length === 0 ? null : Math.min(...oldest) + FEED_POLICY.retentionMs;
  }

  /** The meta row; the epoch names the restore generation too, so a restore expires cursors. */
  #meta(): Meta {
    return this.sql
      .exec<Meta>(
        `SELECT epoch_gen || '.' || epoch AS epoch, head_seq, low_watermark, items
         FROM feed_meta WHERE id = 1`,
      )
      .one();
  }

  /** Takes the directory's restore generation for the feed, when newer than the one recorded. */
  takeEpoch(epochGen: number): void {
    this.sql.exec("UPDATE feed_meta SET epoch_gen = ?1 WHERE id = 1 AND epoch_gen < ?1", epochGen);
  }

  #row(id: FeedItemId): Row | undefined {
    return this.sql
      .exec<Row>(`SELECT * FROM feed_items WHERE ${WHERE_ITEM}`, id.repoId, id.threadKey, id.kind)
      .toArray()[0];
  }

  /** The next sequence number, counting a new item when `added`. */
  #next(added: boolean): number {
    return this.sql
      .exec<{ head_seq: number }>(
        "UPDATE feed_meta SET head_seq = head_seq + 1, items = items + ? WHERE id = 1 RETURNING head_seq",
        added ? 1 : 0,
      )
      .one().head_seq;
  }
}
