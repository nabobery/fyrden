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
 * missed changes.
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
}

/** `ahead`: the item has no such version yet. */
export type FeedAck =
  | { readonly status: "missing" }
  | { readonly status: "ahead" }
  | { readonly status: "acked"; readonly item: FeedItem };

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
  excerpt_member: string | null;
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

export class Feed {
  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => number,
  ) {}

  /**
   * Applies entries (call within a transaction). Within one call an item's
   * entries apply in version order. An entry older than the retention is
   * dropped. A newer version replaces the item's state; an activity item
   * also adds the entry's member, unless that was deleted. An item is
   * shown once an entry opens it (see `#applyOne`). A duplicate, or an
   * older version that adds nothing, writes nothing. A comment's edit or
   * deletion (see `#redact`) notifies of nothing.
   */
  apply(entries: readonly FeedEntry[]): FeedApplied {
    const now = this.now();
    let changed = 0;
    let notified = 0;
    const ordered = [...entries].sort((a, b) => a.feed.subject.version - b.feed.subject.version);
    for (const entry of ordered) {
      if (entry.occurredAt < now - FEED_POLICY.retentionMs) continue;
      const redaction = isRedaction(entry);
      if (!(redaction ? this.#redact(entry, now) : this.#applyOne(entry, now))) continue;
      changed++;
      if (!redaction && !entry.recipient.silent) notified++;
    }
    return { changed, notified };
  }

  /**
   * A comment edited or deleted, for the activity item it is a member of:
   * whatever the thread's version, the excerpt taken from it is replaced
   * (cleared on deletion). A deletion also drops it from the members and
   * is remembered (in a tombstone when the feed has no item yet), so the
   * comment is never added again, whatever arrives later. Nothing else
   * changes (the item is not reopened), and a shown item is sequenced
   * only when what it shows changed.
   */
  #redact(entry: FeedEntry, now: number): boolean {
    const { feed } = entry;
    const member = feed.member;
    if (member === null) return false;
    const id = { repoId: entry.repoId, threadKey: feed.threadKey, kind: "activity" } as const;
    const removing = feed.action === "comment_deleted";
    const item = this.#row(id);
    if (!item) {
      if (removing) this.#deletionTombstone(entry, member, now);
      return false;
    }
    const members = JSON.parse(item.members) as string[];
    const deleted = JSON.parse(item.deleted) as string[];
    if (deleted.includes(member)) return false;
    const kept = removing ? members.filter((m) => m !== member) : members;
    const excerpt =
      item.excerpt_member === member ? (removing ? null : feed.excerpt) : item.excerpt;
    const changed = kept.length !== members.length || excerpt !== item.excerpt;
    if (!changed && !removing) return false;
    const resequence = changed && item.feed_seq !== null;
    this.sql.exec(
      `UPDATE feed_items SET members = ?, excerpt = ?, deleted = ?, feed_seq = ?, seq_at = ?
       WHERE ${WHERE_ITEM}`,
      JSON.stringify(kept),
      excerpt,
      JSON.stringify(removing ? [...deleted, member].slice(-FEED_POLICY.maxDeleted) : deleted),
      resequence ? this.#next(false) : item.feed_seq,
      // A tombstone's retention starts again with each change of what it guards.
      resequence || item.feed_seq === null ? now : item.seq_at,
      id.repoId,
      id.threadKey,
      id.kind,
    );
    return resequence;
  }

  /** An activity item not shown, that only remembers a deleted member (any entry is newer). */
  #deletionTombstone(entry: FeedEntry, member: string, now: number): void {
    const { feed, recipient } = entry;
    this.sql.exec(
      `INSERT INTO feed_items (repo_id, thread_key, kind, number, title, version, state, priority,
         reasons, silent, action, actor, actor_trust, members, deleted, truncated, last_event_key,
         last_event_at, seq_at)
       VALUES (?, ?, 'activity', ?, ?, 0, 'resolved', ?, ?, 1, ?, ?, ?, '[]', ?, 0, ?, ?, ?)`,
      entry.repoId,
      feed.threadKey,
      feed.subject.number,
      feed.subject.title,
      recipient.priority,
      JSON.stringify(recipient.reasons),
      feed.action,
      entry.actor,
      feed.actorTrust,
      JSON.stringify([member]),
      entry.eventKey,
      entry.occurredAt,
      now,
    );
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
    const item = this.#row({
      repoId: entry.repoId,
      threadKey: feed.threadKey,
      kind: recipient.kind,
    });
    const shown = item !== undefined && item.feed_seq !== null;
    const shows = !shown && recipient.state === "open";
    const newer = !item || feed.subject.version > item.version;
    const deleted = item ? (JSON.parse(item.deleted) as string[]) : [];
    const gone = feed.member !== null && deleted.includes(feed.member);
    let members: string[] = item ? (JSON.parse(item.members) as string[]) : [];
    let truncated = item?.truncated === 1;
    if (
      recipient.kind === "activity" &&
      feed.member !== null &&
      !gone &&
      !members.includes(feed.member)
    ) {
      const union = [...members, feed.member].sort(byIdDescending);
      members = union.slice(0, FEED_POLICY.maxMembers);
      truncated ||= union.length > FEED_POLICY.maxMembers;
    }
    const membersJson = JSON.stringify(members);
    const grew =
      item !== undefined && (membersJson !== item.members || truncated !== (item.truncated === 1));
    if (!newer && !grew && !shows) return false;
    const seq = shown || shows ? this.#next(!shown) : null;
    if (!newer) {
      this.sql.exec(
        `UPDATE feed_items SET members = ?, truncated = ?, feed_seq = ?, seq_at = ? WHERE ${WHERE_ITEM}`,
        membersJson,
        truncated ? 1 : 0,
        seq,
        now,
        entry.repoId,
        feed.threadKey,
        recipient.kind,
      );
      return seq !== null;
    }
    this.sql.exec(
      `INSERT INTO feed_items (repo_id, thread_key, kind, number, title, version, state, priority,
         reasons, silent, action, actor, actor_trust, excerpt, excerpt_member, members, truncated,
         last_event_key, last_event_at, feed_seq, seq_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, thread_key, kind) DO UPDATE SET
         number = excluded.number, title = excluded.title, version = excluded.version,
         state = excluded.state, priority = excluded.priority, reasons = excluded.reasons,
         silent = excluded.silent, action = excluded.action, actor = excluded.actor,
         actor_trust = excluded.actor_trust, excerpt = excluded.excerpt,
         excerpt_member = excluded.excerpt_member, members = excluded.members,
         truncated = excluded.truncated, last_event_key = excluded.last_event_key,
         last_event_at = excluded.last_event_at, feed_seq = excluded.feed_seq,
         seq_at = excluded.seq_at`,
      entry.repoId,
      feed.threadKey,
      recipient.kind,
      feed.subject.number,
      feed.subject.title,
      feed.subject.version,
      recipient.state,
      recipient.priority,
      JSON.stringify(recipient.reasons),
      recipient.silent ? 1 : 0,
      feed.action,
      entry.actor,
      feed.actorTrust,
      // A deleted comment's excerpt is not shown again.
      gone ? null : feed.excerpt,
      feed.member,
      membersJson,
      truncated ? 1 : 0,
      entry.eventKey,
      entry.occurredAt,
      seq,
      now,
    );
    return seq !== null;
  }

  /**
   * A page of the items changed after `since` (from the start without one),
   * in sequence order; expired when `since` is of another epoch, below the
   * low watermark (retention deleted changes after it) or past the head.
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
         ORDER BY feed_seq LIMIT ?4`,
        since?.seq ?? 0,
        filter.priority ?? null,
        filter.kind ?? null,
        limit + 1,
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
   * What needs the owner now: open P0 items, then P1 items changed within
   * the retention, newest first, at most `syncItems` (`complete` false when
   * more were left out); and the head at that instant.
   */
  sync(): { head: FeedPosition; items: FeedItem[]; complete: boolean } {
    const meta = this.#meta();
    const rows = this.sql
      .exec<Row>(
        `SELECT * FROM feed_items
         WHERE feed_seq IS NOT NULL
           AND ((priority = 'P0' AND state = 'open') OR (priority = 'P1' AND last_event_at >= ?1))
         ORDER BY (priority = 'P0' AND state = 'open') DESC, feed_seq DESC LIMIT ?2`,
        this.now() - FEED_POLICY.retentionMs,
        FEED_POLICY.syncItems + 1,
      )
      .toArray();
    return {
      head: { epoch: meta.epoch, seq: meta.head_seq },
      items: rows.slice(0, FEED_POLICY.syncItems).map(itemOf),
      complete: rows.length <= FEED_POLICY.syncItems,
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
   * Deletes items and tombstones past the retention, then the items
   * changed longest ago past the cap, raising the low watermark to the
   * greatest sequence number deleted (call within a transaction).
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
   * else when the item or tombstone changed longest ago expires; null for
   * an empty feed.
   */
  nextRetention(): number | null {
    if (this.#meta().items > FEED_POLICY.maxItems) return this.now();
    const { item, tombstone } = this.sql
      .exec<{ item: number | null; tombstone: number | null }>(
        `SELECT
           (SELECT seq_at FROM feed_items WHERE feed_seq IS NOT NULL ORDER BY feed_seq LIMIT 1) AS item,
           (SELECT min(seq_at) FROM feed_items WHERE feed_seq IS NULL) AS tombstone`,
      )
      .one();
    const oldest = [item, tombstone].filter((at) => at !== null);
    return oldest.length === 0 ? null : Math.min(...oldest) + FEED_POLICY.retentionMs;
  }

  #meta(): Meta {
    return this.sql
      .exec<Meta>("SELECT epoch, head_seq, low_watermark, items FROM feed_meta WHERE id = 1")
      .one();
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
