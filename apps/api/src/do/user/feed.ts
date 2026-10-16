import type { FeedEntry, FeedKind, FeedPriority } from "@fyrden/domain";

/*
 * A principal's activity feed: one item per repository, thread and kind,
 * updated in place by the entries events bring. An entry applies only when
 * it is newer than the item (the thread's feed version), so duplicates and
 * any delivery order leave the same item; an activity item also gathers the
 * ids of what it aggregates (comments, reviews) as a set, and a comment's
 * edit or deletion updates or clears the excerpt taken from it. Every
 * change of an item gives it the feed's next sequence number, so a reader
 * that follows the sequence sees each change, late arrivals included. Items
 * older than the retention, or past the cap, are deleted; the low
 * watermark records how far, and a cursor below it has missed changes.
 */

/** Proposed values. */
export const FEED_POLICY = {
  /** Items whose last change is older are deleted; older entries are dropped on arrival. */
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  /** Items a feed keeps at most; the ones changed longest ago go first. */
  maxItems: 5_000,
  /** Ids an activity item keeps at most (the greatest). */
  maxMembers: 100,
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
  truncated: number;
  last_event_key: string;
  last_event_at: number;
  acked_version: number;
  feed_seq: number;
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
    seq: row.feed_seq,
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
   * dropped; one for an item the feed does not have creates it, unless it
   * only resolves (there is nothing to resolve). A newer version replaces
   * the item's state; an activity item also adds the entry's member. A
   * duplicate, or an older version that adds nothing, writes nothing. A
   * comment's edit or deletion (see `#redact`) notifies of nothing.
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
   * A comment edited or deleted, for the activity items it is a member of:
   * whatever the thread's version, the excerpt taken from it is replaced
   * (cleared on deletion), and a deletion drops it from the members.
   * Nothing else changes (the item is not reopened), nothing is created,
   * and nothing is sequenced unless something changed.
   */
  #redact(entry: FeedEntry, now: number): boolean {
    const { feed } = entry;
    const id = { repoId: entry.repoId, threadKey: feed.threadKey, kind: "activity" } as const;
    const item = this.#row(id);
    if (!item || feed.member === null) return false;
    const deleted = feed.action === "comment_deleted";
    const members = JSON.parse(item.members) as string[];
    const kept = deleted ? members.filter((m) => m !== feed.member) : members;
    const excerpt =
      item.excerpt_member === feed.member ? (deleted ? null : feed.excerpt) : item.excerpt;
    if (kept.length === members.length && excerpt === item.excerpt) return false;
    this.sql.exec(
      `UPDATE feed_items SET members = ?, excerpt = ?, feed_seq = ?, seq_at = ? WHERE ${WHERE_ITEM}`,
      JSON.stringify(kept),
      excerpt,
      this.#next(false),
      now,
      id.repoId,
      id.threadKey,
      id.kind,
    );
    return true;
  }

  #applyOne(entry: FeedEntry, now: number): boolean {
    const { feed, recipient } = entry;
    const item = this.#row({
      repoId: entry.repoId,
      threadKey: feed.threadKey,
      kind: recipient.kind,
    });
    if (!item && recipient.state === "resolved") return false;
    const newer = !item || feed.subject.version > item.version;
    let members: string[] = item ? (JSON.parse(item.members) as string[]) : [];
    let truncated = item?.truncated === 1;
    if (recipient.kind === "activity" && feed.member !== null && !members.includes(feed.member)) {
      const union = [...members, feed.member].sort(byIdDescending);
      members = union.slice(0, FEED_POLICY.maxMembers);
      truncated ||= union.length > FEED_POLICY.maxMembers;
    }
    const membersJson = JSON.stringify(members);
    const grew =
      item !== undefined && (membersJson !== item.members || truncated !== (item.truncated === 1));
    if (!newer && !grew) return false;
    const seq = this.#next(item === undefined);
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
      return true;
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
         excerpt_member = excluded.excerpt_member, members = excluded.members, truncated = excluded.truncated,
         last_event_key = excluded.last_event_key, last_event_at = excluded.last_event_at,
         feed_seq = excluded.feed_seq, seq_at = excluded.seq_at`,
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
      feed.excerpt,
      feed.member,
      membersJson,
      truncated ? 1 : 0,
      entry.eventKey,
      entry.occurredAt,
      seq,
      now,
    );
    return true;
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
         WHERE (priority = 'P0' AND state = 'open') OR (priority = 'P1' AND last_event_at >= ?1)
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
    if (!item) return { status: "missing" };
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
   * Deletes items past the retention, then the ones changed longest ago
   * past the cap, raising the low watermark to the greatest sequence
   * number deleted (call within a transaction).
   */
  retain(): void {
    const meta = this.#meta();
    const deleted = this.sql
      .exec<{ feed_seq: number }>(
        "DELETE FROM feed_items WHERE seq_at < ? RETURNING feed_seq",
        this.now() - FEED_POLICY.retentionMs,
      )
      .toArray()
      .map((r) => r.feed_seq);
    const excess = meta.items - deleted.length - FEED_POLICY.maxItems;
    if (excess > 0)
      for (const r of this.sql.exec<{ feed_seq: number }>(
        `DELETE FROM feed_items WHERE feed_seq IN
           (SELECT feed_seq FROM feed_items ORDER BY feed_seq LIMIT ?)
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
   * else when the item changed longest ago expires; null for an empty feed.
   */
  nextRetention(): number | null {
    if (this.#meta().items > FEED_POLICY.maxItems) return this.now();
    const oldest = this.sql
      .exec<{ seq_at: number }>("SELECT seq_at FROM feed_items ORDER BY feed_seq LIMIT 1")
      .toArray()[0];
    return oldest ? oldest.seq_at + FEED_POLICY.retentionMs : null;
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
