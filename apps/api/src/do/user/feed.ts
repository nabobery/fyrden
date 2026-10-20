import type { FeedEntry, FeedKind, FeedPriority } from "@fyrden/domain";

/*
 * A principal's activity feed: one item per repository, thread and kind,
 * updated in place by the entries events bring. An entry applies only when
 * it is newer than the item (the thread's feed version, within the
 * repository's restore generation), so duplicates and any delivery order
 * leave the same item; an activity item also gathers the ids of what it
 * aggregates (comments, reviews) as a set, those of the newest generation
 * only. Items hold ids,
 * not text: what a member says is read from the repository when the item
 * is read. What only resolves something the feed never showed is kept as a
 * tombstone (a row without a sequence number, never read), so that an
 * older entry arriving later cannot open it. Every change of a shown
 * item gives it the feed's next sequence number, so a reader that follows
 * the sequence sees each change, late arrivals included. Items and
 * tombstones older than the retention, and items past the cap, are
 * deleted; the low watermark records how far, and a cursor below it has
 * missed changes. An item the cap deleted leaves a fence at its version
 * (so many at most), so an entry up to it arriving later is dropped
 * rather than bringing the item back. When the owner loses read access to repositories, their
 * items up to then are purged, and a mark drops entries up to then that
 * arrive later; so are they when a read finds the owner cannot read them,
 * up to when that was decided, whichever comes first.
 */

/** Proposed values. */
export const FEED_POLICY = {
  /** Items whose last change is older are deleted; older entries are dropped on arrival. */
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  /** Items a feed keeps at most; the ones changed longest ago go first. */
  maxItems: 5_000,
  /**
   * Fences of items the cap evicted a feed keeps at most, the ones of the
   * oldest events going first: an item evicted longer ago can come back
   * with a very late delivery (an obsolete item shown; nothing new lost).
   */
  maxFences: 1_000,
  /** Ids an activity item keeps at most (the greatest). */
  maxMembers: 100,
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
  /** The repository's restore generation `version` counts in. */
  readonly epoch: number;
  readonly version: number;
  readonly state: "open" | "resolved";
  readonly priority: FeedPriority;
  readonly reasons: readonly string[];
  /** The last change was the owner's own action: nothing to notify of. */
  readonly silent: boolean;
  readonly action: string;
  readonly actor: string | null;
  readonly actorTrust: "write" | "read" | "none";
  /** What the item displays: an activity item's greatest member, else the entry's. */
  readonly member: string | null;
  readonly members: readonly string[];
  readonly truncated: boolean;
  readonly eventKey: string;
  readonly eventAt: number;
  readonly ackedEpoch: number;
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
      /**
       * The greatest sequence number retention deleted: every item still
       * there comes after it (its order is the sequence's), so a cursor
       * may start there.
       */
      readonly lowWatermark: number;
      readonly items: readonly FeedItem[];
      /** More items follow the page's last one. */
      readonly more: boolean;
    };

export interface FeedFilter {
  readonly priority?: FeedPriority | undefined;
  readonly kind?: FeedKind | undefined;
  /** Only items of these repositories (a token's own list); null for any. */
  readonly repoIds?: readonly string[] | null | undefined;
  /**
   * Only threads about these kinds (`issue`, `pull`: what a token's scopes
   * let it read); null for any. Left out before paging (one kind through
   * its index), so items a token may never read neither use up a read's
   * budget nor show in its answers.
   */
  readonly subjects?: readonly string[] | null | undefined;
}

/**
 * The one kind of thread a filter reads, for the index by kind (`subjects`
 * of both kinds, or none given: no filter, null). The empty list is
 * answered before any query.
 */
function oneSubject(subjects: readonly string[] | null | undefined): string | null {
  if (!subjects || subjects.length !== 1) return null;
  return subjects[0] ?? null;
}

/**
 * The condition reading one kind (bound as `?6`), in the query's text only
 * when there is one: a condition the planner cannot tell apart from none
 * (`?6 IS NULL OR ...`) would keep it from the index by kind.
 */
function bySubject(subjects: readonly string[] | null | undefined): string {
  return oneSubject(subjects) === null
    ? "AND ?6 IS NULL"
    : "AND substr(thread_key, 1, instr(thread_key, '/') - 1) = ?6";
}

/** Where a sync page ends: whether its last item was an open P0 one, and its sequence number. */
export interface SyncPosition {
  readonly open: boolean;
  readonly seq: number;
}

/**
 * A thread's version, in the repository's restore generation: a newer
 * generation's are newer, whatever their numbers (a restore starts them
 * again).
 */
export interface ThreadVersion {
  readonly epoch: number;
  readonly version: number;
}

const newerThan = (a: ThreadVersion, b: ThreadVersion) =>
  a.epoch > b.epoch || (a.epoch === b.epoch && a.version > b.version);

const versionOf = (entry: FeedEntry): ThreadVersion => ({
  epoch: entry.epochGen,
  version: entry.feed.subject.version,
});

/** `ahead`: the item has no such version yet. */
export type FeedAck =
  | { readonly status: "missing" }
  | { readonly status: "ahead" }
  | { readonly status: "acked"; readonly item: FeedItem };

/**
 * Repositories the owner no longer reads, as of `until` (ms), as the
 * account that said so had them at its `(epochGen, aclVersion)`.
 */
export interface FeedPurge {
  readonly repoIds: readonly string[];
  readonly until: number;
  readonly accountId: string;
  readonly epochGen: number;
  readonly aclVersion: number;
}

/** Item key fields, as the item's primary key orders them. */
export interface FeedItemId {
  readonly repoId: string;
  readonly threadKey: string;
  readonly kind: FeedKind;
}

type Meta = { epoch: string; head_seq: number; low_watermark: number; items: number };

/** A repository's purge mark, as a later purge compares itself with it. */
type Mark = { account_id: string; epoch_gen: number; acl_version: number; until_at: number };

type Row = {
  repo_id: string;
  thread_key: string;
  kind: FeedKind;
  number: number;
  title: string;
  thread_epoch: number;
  version: number;
  state: "open" | "resolved";
  priority: FeedPriority;
  reasons: string;
  silent: number;
  action: string;
  actor: string | null;
  actor_trust: "write" | "read" | "none";
  display_member: string | null;
  members: string;
  truncated: number;
  last_event_key: string;
  last_event_at: number;
  acked_epoch: number;
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

/** A member of an activity item: its id, and when and by whom it was made. */
interface Member {
  readonly id: string;
  readonly at: number;
  readonly actor: string | null;
  readonly trust: Row["actor_trust"];
}

/**
 * An activity item's members (the greatest 100, greatest first), and what
 * it displays: the greatest of them, its author and the author's access.
 */
function withMembers(state: State, members: readonly Member[], truncated: boolean): State {
  const greatest = members[0];
  return {
    ...state,
    members: JSON.stringify(members),
    truncated: truncated ? 1 : 0,
    display_member: greatest?.id ?? null,
    actor: greatest?.actor ?? null,
    // No member shown: no author, so no access to show (the same whatever came before).
    actor_trust: greatest?.trust ?? "none",
  };
}

function itemOf(row: Row): FeedItem {
  return {
    repoId: row.repo_id,
    threadKey: row.thread_key,
    kind: row.kind,
    number: row.number,
    title: row.title,
    epoch: row.thread_epoch,
    version: row.version,
    state: row.state,
    priority: row.priority,
    reasons: JSON.parse(row.reasons) as string[],
    silent: row.silent === 1,
    action: row.action,
    actor: row.actor,
    actorTrust: row.actor_trust,
    member: row.display_member,
    members: (JSON.parse(row.members) as Member[]).map((m) => m.id),
    truncated: row.truncated === 1,
    eventKey: row.last_event_key,
    eventAt: row.last_event_at,
    ackedEpoch: row.acked_epoch,
    ackedVersion: row.acked_version,
    seq: row.feed_seq as number,
  };
}

const WHERE_ITEM = "repo_id = ? AND thread_key = ? AND kind = ?";

/** An item's fields that entries change: its row less its key, sequence and acknowledgement. */
type State = Omit<
  Row,
  "repo_id" | "thread_key" | "kind" | "acked_epoch" | "acked_version" | "feed_seq" | "seq_at"
>;

function stateOf(row: Row): State {
  const {
    repo_id: _,
    thread_key: __,
    kind: ___,
    acked_epoch: _____,
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
    thread_epoch: 0,
    version: 0,
    state: "resolved",
    display_member: null,
    actor: null,
    actor_trust: entry.feed.actorTrust,
    members: "[]",
    truncated: 0,
  };
}

/** The thread's state as an entry tells it (the newest version's wins). */
function thread(entry: FeedEntry) {
  const { feed, recipient } = entry;
  return {
    number: feed.subject.number,
    title: feed.subject.title,
    thread_epoch: entry.epochGen,
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
 * An activity item with an entry's member added (with when and by whom it
 * was made, so a purge can take it out again): the members are the
 * greatest 100, and the item displays the greatest, so any order of the
 * same entries displays the same.
 */
function withMember(state: State, entry: FeedEntry): State {
  const { feed } = entry;
  const id = feed.member;
  if (id === null) return state;
  const members = JSON.parse(state.members) as Member[];
  if (members.some((m) => m.id === id)) return state;
  const union = [
    ...members,
    { id, at: entry.occurredAt, actor: entry.actor, trust: feed.actorTrust },
  ].sort((a, b) => byIdDescending(a.id, b.id));
  return withMembers(
    state,
    union.slice(0, FEED_POLICY.maxMembers),
    state.truncated === 1 || union.length > FEED_POLICY.maxMembers,
  );
}

export class Feed {
  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => number,
  ) {}

  /**
   * Applies entries (call within a transaction). Within one call an item's
   * entries apply in version order. An entry older than the retention, of
   * a purged repository up to its purge, or of an item the cap evicted up
   * to the version it was at, is dropped. A newer version
   * replaces the thread's state in the item; an activity item also takes
   * the entry's member (see `withMember`). An item is shown once an entry
   * opens it (see `#applyOne`). A duplicate, or an older version that adds
   * nothing, writes nothing.
   */
  apply(entries: readonly FeedEntry[]): FeedApplied {
    const now = this.now();
    let changed = 0;
    let notified = 0;
    const ordered = [...entries].sort(
      (a, b) => a.epochGen - b.epochGen || a.feed.subject.version - b.feed.subject.version,
    );
    const purged = new Map<string, number | null>();
    const purgedUntil = (repoId: string) => {
      if (!purged.has(repoId)) purged.set(repoId, this.#purgedUntil(repoId));
      return purged.get(repoId) ?? null;
    };
    for (const entry of ordered) {
      if (entry.occurredAt < now - FEED_POLICY.retentionMs) continue;
      const until = purgedUntil(entry.repoId);
      if (until !== null && entry.occurredAt <= until) continue;
      if (this.#evicted(entry)) continue;
      if (!this.#applyOne(entry, now)) continue;
      changed++;
      if (!entry.recipient.silent) notified++;
    }
    return { changed, notified };
  }

  /**
   * One entry. An item the feed has not shown (none, or a tombstone) is
   * shown, with the newest state the feed knows of it, once an entry that
   * opens it arrives, whatever that entry's version; until then, an entry
   * that only resolves keeps that newest state in a tombstone. So the
   * outcome does not depend on the order: an item resolved before its
   * opening arrived is shown resolved, and one that never opened is never
   * shown.
   */
  #applyOne(entry: FeedEntry, now: number): boolean {
    const { feed, recipient } = entry;
    const id = { repoId: entry.repoId, threadKey: feed.threadKey, kind: recipient.kind };
    const item = this.#row(id);
    const before = item ? stateOf(item) : blank(entry);
    const newer = newerThan(versionOf(entry), {
      epoch: before.thread_epoch,
      version: before.version,
    });
    let after: State = newer ? { ...before, ...thread(entry) } : before;
    if (recipient.kind === "activity") {
      // Members count within the repository's restore generation: an older one's add none, and
      // a newer one's start the set again (a restored repository's ids may repeat older ones).
      if (entry.epochGen > before.thread_epoch)
        after = withMember(withMembers(after, [], false), entry);
      else if (entry.epochGen === before.thread_epoch) after = withMember(after, entry);
    } else if (newer)
      after = {
        ...after,
        display_member: feed.member,
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

  /** Whether the cap evicted the entry's item at the entry's version or a newer one. */
  #evicted(entry: FeedEntry): boolean {
    const fence = this.sql
      .exec<{ thread_epoch: number; version: number }>(
        `SELECT thread_epoch, version FROM feed_evictions WHERE ${WHERE_ITEM}`,
        entry.repoId,
        entry.feed.threadKey,
        entry.recipient.kind,
      )
      .toArray()[0];
    return (
      fence !== undefined &&
      !newerThan(versionOf(entry), { epoch: fence.thread_epoch, version: fence.version })
    );
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
    if (filter.subjects?.length === 0)
      return {
        expired: false,
        head: { epoch: meta.epoch, seq: meta.head_seq },
        lowWatermark: meta.low_watermark,
        items: [],
        more: false,
      };
    const rows = this.sql
      .exec<Row>(
        `SELECT * FROM feed_items
         WHERE feed_seq > ?1 AND (?2 IS NULL OR priority = ?2) AND (?3 IS NULL OR kind = ?3)
           AND (?5 IS NULL OR repo_id IN (SELECT value FROM json_each(?5)))
           ${bySubject(filter.subjects)}
         ORDER BY feed_seq LIMIT ?4`,
        since?.seq ?? 0,
        filter.priority ?? null,
        filter.kind ?? null,
        limit + 1,
        filter.repoIds ? JSON.stringify(filter.repoIds) : null,
        oneSubject(filter.subjects),
      )
      .toArray();
    return {
      expired: false,
      head: { epoch: meta.epoch, seq: meta.head_seq },
      lowWatermark: meta.low_watermark,
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
    filter: Pick<FeedFilter, "repoIds" | "subjects">,
  ): { epoch: string; lowWatermark: number; items: FeedItem[]; more: boolean } {
    if (filter.subjects?.length === 0) {
      const meta = this.#meta();
      return { epoch: meta.epoch, lowWatermark: meta.low_watermark, items: [], more: false };
    }
    const rows = this.sql
      .exec<Row>(
        `SELECT * FROM (
           SELECT *, (priority = 'P0' AND state = 'open') AS open FROM feed_items
           WHERE feed_seq IS NOT NULL
             AND ((priority = 'P0' AND state = 'open') OR (priority = 'P1' AND last_event_at >= ?1))
             AND (?5 IS NULL OR repo_id IN (SELECT value FROM json_each(?5)))
             ${bySubject(filter.subjects)})
         WHERE (open, feed_seq) < (?2, ?3)
         ORDER BY open DESC, feed_seq DESC LIMIT ?4`,
        this.now() - FEED_POLICY.retentionMs,
        after === null ? 2 : after.open ? 1 : 0,
        after?.seq ?? 0,
        limit + 1,
        filter.repoIds ? JSON.stringify(filter.repoIds) : null,
        oneSubject(filter.subjects),
      )
      .toArray();
    const meta = this.#meta();
    return {
      epoch: meta.epoch,
      lowWatermark: meta.low_watermark,
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
  ack(id: FeedItemId, at: ThreadVersion): FeedAck {
    const item = this.#row(id);
    if (!item || item.feed_seq === null) return { status: "missing" };
    if (newerThan(at, { epoch: item.thread_epoch, version: item.version }))
      return { status: "ahead" };
    if (!newerThan(at, { epoch: item.acked_epoch, version: item.acked_version }))
      return { status: "acked", item: itemOf(item) };
    const row = this.sql
      .exec<Row>(
        `UPDATE feed_items SET acked_epoch = ?, acked_version = ?, feed_seq = ?, seq_at = ?
         WHERE ${WHERE_ITEM}
         RETURNING *`,
        at.epoch,
        at.version,
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
   * are deleted, the members made up to then leave the activity items that
   * survive (changed since: access given back), and a mark drops entries
   * up to then arriving later. A repository's mark is replaced only by a
   * newer purge: of the same account, a newer `(epochGen, aclVersion)`, or
   * the same one with a later `until` (a read's check counts from when its
   * pull started, the revocation itself from when it was made: either may
   * come first, and access given back takes a newer version); of another
   * (the repository was transferred), or of none (`""`: a read found the
   * repository gone), a later `until`. Returns the shown items deleted.
   */
  purge(purge: FeedPurge): number {
    const now = this.now();
    let deleted = 0;
    for (const repoId of new Set(purge.repoIds)) {
      const mark = this.sql
        .exec<Mark>(
          "SELECT account_id, epoch_gen, acl_version, until_at FROM purge_marks WHERE repo_id = ?",
          repoId,
        )
        .toArray()[0];
      const newer =
        !mark ||
        (mark.account_id === purge.accountId && purge.accountId !== ""
          ? purge.epochGen > mark.epoch_gen ||
            (purge.epochGen === mark.epoch_gen &&
              (purge.aclVersion > mark.acl_version ||
                (purge.aclVersion === mark.acl_version && purge.until > mark.until_at)))
          : purge.until > mark.until_at);
      if (!newer) continue;
      for (const row of this.sql.exec<{ feed_seq: number | null }>(
        "DELETE FROM feed_items WHERE repo_id = ? AND last_event_at <= ? RETURNING feed_seq",
        repoId,
        purge.until,
      ))
        if (row.feed_seq !== null) deleted++;
      for (const row of this.sql
        .exec<Row>("SELECT * FROM feed_items WHERE repo_id = ? AND kind = 'activity'", repoId)
        .toArray()) {
        const members = JSON.parse(row.members) as Member[];
        const kept = members.filter((m) => m.at > purge.until);
        if (kept.length === members.length) continue;
        const shown = row.feed_seq !== null;
        this.#write(
          { repoId, threadKey: row.thread_key, kind: row.kind },
          withMembers(stateOf(row), kept, row.truncated === 1),
          shown ? this.#next(false) : null,
          now,
        );
      }
      this.sql.exec(
        `INSERT INTO purge_marks (repo_id, until_at, account_id, epoch_gen, acl_version)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET until_at = excluded.until_at,
           account_id = excluded.account_id, epoch_gen = excluded.epoch_gen,
           acl_version = excluded.acl_version`,
        repoId,
        purge.until,
        purge.accountId,
        purge.epochGen,
        purge.aclVersion,
      );
    }
    if (deleted > 0) this.sql.exec("UPDATE feed_meta SET items = items - ? WHERE id = 1", deleted);
    return deleted;
  }

  /**
   * Forgets threads a read found gone for good (a deleted issue: its number
   * is never used again, so no later entry of the thread is news); a late
   * entry of one comes back only to be found gone again. Call within a
   * transaction. Returns the shown items deleted.
   */
  forgetThreads(
    threads: readonly { readonly repoId: string; readonly threadKey: string }[],
  ): number {
    let deleted = 0;
    for (const { repoId, threadKey } of threads)
      for (const row of this.sql.exec<{ feed_seq: number | null }>(
        "DELETE FROM feed_items WHERE repo_id = ? AND thread_key = ? RETURNING feed_seq",
        repoId,
        threadKey,
      ))
        if (row.feed_seq !== null) deleted++;
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
   * Deletes items, tombstones, purge marks and eviction fences past the
   * retention, then the items changed longest ago past the cap, each
   * leaving a fence, raising the low watermark to the greatest sequence
   * number deleted (call within a transaction).
   */
  retain(): void {
    const meta = this.#meta();
    const expired = this.now() - FEED_POLICY.retentionMs;
    const deleted = this.sql
      .exec<{ feed_seq: number | null }>(
        "DELETE FROM feed_items WHERE seq_at < ? RETURNING feed_seq",
        expired,
      )
      .toArray()
      .flatMap((r) => (r.feed_seq === null ? [] : [r.feed_seq]));
    // Entries a mark or a fence would drop are dropped for their age by now: the events up to
    // a mark happened by its time, and those up to a fence's version by the item's last one.
    this.sql.exec("DELETE FROM purge_marks WHERE until_at < ?", expired);
    this.sql.exec("DELETE FROM feed_evictions WHERE event_at < ?", expired);
    const excess = meta.items - deleted.length - FEED_POLICY.maxItems;
    if (excess > 0) {
      const oldest = `feed_seq IN
        (SELECT feed_seq FROM feed_items WHERE feed_seq IS NOT NULL ORDER BY feed_seq LIMIT ?)`;
      this.sql.exec(
        `INSERT INTO feed_evictions (repo_id, thread_key, kind, thread_epoch, version, event_at)
         SELECT repo_id, thread_key, kind, thread_epoch, version, last_event_at
         FROM feed_items WHERE ${oldest}
         ON CONFLICT (repo_id, thread_key, kind) DO UPDATE SET thread_epoch = excluded.thread_epoch,
           version = excluded.version, event_at = excluded.event_at`,
        excess,
      );
      for (const r of this.sql.exec<{ feed_seq: number }>(
        `DELETE FROM feed_items WHERE ${oldest} RETURNING feed_seq`,
        excess,
      ))
        deleted.push(r.feed_seq);
      this.sql.exec(
        `DELETE FROM feed_evictions WHERE (repo_id, thread_key, kind) IN
           (SELECT repo_id, thread_key, kind FROM feed_evictions ORDER BY event_at
            LIMIT max(0, (SELECT count(*) FROM feed_evictions) - ?))`,
        FEED_POLICY.maxFences,
      );
    }
    if (deleted.length === 0) return;
    this.sql.exec(
      "UPDATE feed_meta SET low_watermark = max(low_watermark, ?), items = items - ? WHERE id = 1",
      Math.max(...deleted),
      deleted.length,
    );
  }

  /**
   * When retention should next run: now when the feed is past its cap,
   * else when the item, tombstone, purge mark or fence changed longest ago
   * expires; null for an empty feed.
   */
  nextRetention(): number | null {
    if (this.#meta().items > FEED_POLICY.maxItems) return this.now();
    const { item, tombstone, mark, fence } = this.sql
      .exec<{
        item: number | null;
        tombstone: number | null;
        mark: number | null;
        fence: number | null;
      }>(
        `SELECT
           (SELECT seq_at FROM feed_items WHERE feed_seq IS NOT NULL ORDER BY feed_seq LIMIT 1) AS item,
           (SELECT min(seq_at) FROM feed_items WHERE feed_seq IS NULL) AS tombstone,
           (SELECT min(until_at) FROM purge_marks) AS mark,
           (SELECT min(event_at) FROM feed_evictions) AS fence`,
      )
      .one();
    const oldest = [item, tombstone, mark, fence].filter((at) => at !== null);
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
