import { FEED_HORIZON_MS, type FeedEntry, type FeedKind, type FeedPriority } from "@fyrden/domain";

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
 * older entry arriving later cannot open it.
 *
 * The feed is made of streams: a repository's issue threads, or its pull
 * requests' (the thread key's `subject`). Every change of a shown item
 * gives it the feed's next sequence number, so a reader that follows the
 * sequence sees each change, late arrivals included (one made while it
 * pages comes after where it is), and an `order_at`, its retention clock
 * (now, never before its stream's last change, so a stream's expired items
 * are a prefix of it). A reader's position is kept per stream: the number
 * of the last item of it given.
 * Items and tombstones older than the retention, and a stream's oldest
 * past its caps, are deleted; the stream's low watermark records how far,
 * and a position in it below that has missed changes. So what happens in
 * one stream never evicts, expires or moves another's (a reader that may
 * not read a repository is never affected by it). An item or tombstone
 * a cap deleted leaves a fence at its version (so many a stream at most),
 * so an entry up to it arriving later is dropped rather than bringing it
 * back. A reader's positions are kept as a snapshot (`feed_cursors`) its
 * cursor names. When the owner loses read access to repositories, their
 * items up to then are purged, and a mark drops entries up to then that
 * arrive later; so are they when a read finds the owner cannot read them,
 * up to when that was decided, whichever comes first.
 */

/** Proposed values. */
export const FEED_POLICY = {
  /** Items whose last change is older are deleted; older entries are dropped on arrival. */
  retentionMs: FEED_HORIZON_MS,
  /** Shown items a stream keeps at most; the ones changed longest ago go first. */
  streamItems: 500,
  /** Tombstones a stream keeps at most; the ones written longest ago go first. */
  streamTombstones: 500,
  /**
   * Fences of what a stream's caps evicted it keeps at most, the ones of
   * the oldest events going first: an item evicted longer ago can come
   * back with a very late delivery (an obsolete item shown; nothing new
   * lost).
   */
  streamFences: 100,
  /** Ids an activity item keeps at most (the greatest). */
  maxMembers: 100,
  /** Items a sync returns at most. */
  syncItems: 500,
  /**
   * Rows one step of retention or retirement deletes at most: items (with
   * their eviction fences), then purge marks and eviction fences, each up to
   * this many (Proposed). More left: the step is due again at once.
   */
  sliceRows: 500,
  /**
   * How long a cursor's snapshot is kept from when it was made (absolute):
   * an unchanged answer keeps a new one once it is half that old, so a
   * cursor read on lives on, an idle poller's renewal costing a write
   * twice a day.
   */
  cursorTtlMs: 24 * 60 * 60_000,
  /** Snapshots a credential keeps at most; the oldest go first. */
  cursorsPerCredential: 50,
  /**
   * Streams a snapshot has positions in at most (its coverage); and live
   * streams a first page looks for where its unread items start in (past
   * them, it reads from the retained start).
   */
  coverage: 1_000,
} as const;

/**
 * Gone threads one `forgetGoneThreads` call forgets at most: each at most
 * one item a kind (seven), so a call deletes under 500 rows (see
 * `FEED_POLICY.sliceRows`).
 */
export const MAX_GONE_THREADS = 70;

/**
 * Repositories one purge call (`purge`, `forgetRepos`) takes at most, each
 * purged in a transaction of its own, so a call's work is bounded; purge
 * effects name at most this many.
 */
export const PURGE_REPOS = 2;

/**
 * The key a feed's restore generation has in the directory's
 * `source_epochs`: a restore of the principal's object allocates the next
 * one there, as for a repository's.
 */
export const feedEpochSource = (principalId: string) => `feed:${principalId}`;

/** A stream: a repository's threads about one subject (`issue`, `pull`). */
export interface StreamKey {
  readonly repoId: string;
  readonly subject: string;
}

/** What a thread key's thread is about: its part before the `/` (none: empty). */
export const subjectOfThread = (threadKey: string) =>
  threadKey.slice(0, Math.max(0, threadKey.indexOf("/")));

/** A stream's position: `[repository, subject, sequence number]`. */
export type StreamPosition = readonly [repoId: string, subject: string, seq: number];

/**
 * A snapshot: per stream, the last sequence number a reader was given
 * (sorted by stream, at most `FEED_POLICY.coverage`), and `base`, where a
 * stream without a position reads from (a cursor of before streams named
 * every stream at one sequence number), else from its retained start.
 */
export interface SnapshotState {
  readonly positions: readonly StreamPosition[];
  readonly base: number | null;
}

/** What a cursor names: a snapshot by id, or (before streams) a sequence number of the feed. */
export type CursorRef =
  | { readonly epoch: string; readonly id: string }
  | { readonly epoch: string; readonly base: number };

export interface StreamRead {
  /** The credential reading: a snapshot is its own. */
  readonly credential: string;
  readonly cursor: CursorRef | null;
  /**
   * After the last item an answer read already, and the retention cutoff
   * its first page read by (kept for the answer, so nothing expires
   * between its pages); null for its first page.
   */
  readonly after: { readonly seq: number; readonly cutoff: number } | null;
}

export type StreamPage =
  | { readonly expired: true }
  | {
      readonly expired: false;
      readonly epoch: string;
      /** The cursor's snapshot (id null: none, or a cursor of before streams) and when it was made. */
      readonly snapshot: SnapshotState & { readonly id: string | null; readonly createdAt: number };
      /** On a first page: the streams the snapshot is behind the low watermark of (see `read`). */
      readonly expiredStreams: readonly StreamKey[];
      /** The retention cutoff the page read by (the answer's first page's). */
      readonly cutoff: number;
      /**
       * The low watermarks of the streams of the page's items as the page
       * read them: one past where the answer read in a stream means what
       * it had not read yet was deleted since (see `read`).
       */
      readonly watermarks: readonly StreamPosition[];
      readonly items: readonly FeedItem[];
      /** More items follow the page's last one. */
      readonly more: boolean;
    };

/** A thread a read found gone for good, in the repository's restore generation it was found in. */
export interface GoneThread {
  readonly repoId: string;
  readonly threadKey: string;
  readonly epoch: number;
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
  /** The item's stream's subject. */
  readonly subject: string;
  readonly seq: number;
}

/** What applying entries did: items changed, and of those, changes to notify of (not silent). */
export interface FeedApplied {
  readonly changed: number;
  readonly notified: number;
}

export interface FeedFilter {
  readonly priority?: FeedPriority | undefined;
  readonly kind?: FeedKind | undefined;
  /** Only items of these repositories (a token's own list); null for any. */
  readonly repoIds?: readonly string[] | null | undefined;
  /**
   * Only threads about these kinds (`issue`, `pull`: what a token's scopes
   * let it read); null for any. Left out before paging (a read of one kind
   * starts at that kind's earliest item not given, its streams'), so items
   * a token may never read neither use up a read's budget nor show in its
   * answers.
   */
  readonly subjects?: readonly string[] | null | undefined;
}

/**
 * The one kind of thread a filter reads (`subjects` of both kinds, or none
 * given: no filter, null). The empty list is answered before any query.
 */
function oneSubject(subjects: readonly string[] | null | undefined): string | null {
  if (!subjects || subjects.length !== 1) return null;
  return subjects[0] ?? null;
}

/**
 * The condition reading one kind (bound as `?<n>`), in the query's text
 * only when there is one: a condition the planner cannot tell apart from
 * none (`? IS NULL OR ...`) would keep it from the streams' key.
 */
function bySubject(subjects: readonly string[] | null | undefined, n: number, of = ""): string {
  return oneSubject(subjects) === null ? `AND ?${n} IS NULL` : `AND ${of}subject = ?${n}`;
}

/** Where a sync page ends: whether its last item was an open P0 one, and its place in the feed. */
export interface SyncKey {
  readonly open: boolean;
  readonly seq: number;
  /** The sync's first page's `bound`. */
  readonly bound: number;
}

export interface SyncPage {
  readonly epoch: string;
  readonly items: FeedItem[];
  readonly more: boolean;
  /**
   * The feed's head when the sync's first page was read (passed on with
   * `after`): a stream's head as of then is its greatest sequence number
   * up to it (see `syncCursor`).
   */
  readonly bound: number;
}

/**
 * Positions as SQL looks them up: a JSON object by `<repository>/<subject>`
 * (bound as `?1`; one parse a statement, each lookup a key's), so a
 * stream's or an item's position costs no read of the others.
 */
const byStream = (positions: readonly StreamPosition[]) =>
  JSON.stringify(Object.fromEntries(positions.map(([r, s, seq]) => [`${r}/${s}`, seq])));

/** A row's position (`of`: its table's alias), from `byStream`'s object bound as `?1`. */
const positionOf = (of: string) => `(?1 ->> (${of}.repo_id || '/' || ${of}.subject))`;

/** The streams of positions (bound as `?<n>`, JSON), one row each, to look streams up by. */
const positioned = (n: number) => `(SELECT value ->> 0 AS repo_id, value ->> 1 AS subject
  FROM json_each(?${n}))`;

/** A 32-bit FNV-1a hash of a snapshot's text, to find an equal one by. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
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

/** The higher of two priorities (P0 the highest). */
const higher = (a: FeedPriority, b: FeedPriority): FeedPriority => (a < b ? a : b);

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

/**
 * The meta row: the epoch, the head (the last sequence number given), and
 * since streams, the low watermark the feed had then, only judging cursors
 * of before.
 */
type Meta = { epoch: string; head_seq: number; low_watermark: number; legacy_head: number };

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
  subject: string;
  /** Null for a tombstone. */
  feed_seq: number | null;
  seq_at: number;
  order_at: number;
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
    subject: row.subject,
    seq: row.feed_seq as number,
  };
}

const WHERE_ITEM = "repo_id = ? AND thread_key = ? AND kind = ?";

/** An item's fields that entries change: its row less its key, sequence and acknowledgement. */
type State = Omit<
  Row,
  | "repo_id"
  | "thread_key"
  | "kind"
  | "acked_epoch"
  | "acked_version"
  | "subject"
  | "feed_seq"
  | "seq_at"
  | "order_at"
>;

function stateOf(row: Row): State {
  const {
    repo_id: _,
    thread_key: __,
    kind: ___,
    acked_epoch: _____,
    acked_version: ____,
    subject,
    feed_seq,
    seq_at,
    order_at,
    ...state
  } = row;
  return state;
}

/** Rows deleted, as their streams count them. */
type Deleted = Pick<Row, "repo_id" | "subject" | "feed_seq">;

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
    const item = this.#live(id, now);
    const before = item ? stateOf(item) : blank(entry);
    const newer = newerThan(versionOf(entry), {
      epoch: before.thread_epoch,
      version: before.version,
    });
    // An item's priority is the highest any of its entries had, whatever their order (so it never
    // falls: a participant's activity stays P1 whatever a watch entry says, P2).
    let after: State = {
      ...(newer ? { ...before, ...thread(entry) } : before),
      priority: higher(before.priority, entry.recipient.priority),
    };
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
    const stream = { repoId: entry.repoId, subject: subjectOfThread(feed.threadKey) };
    if (!shown && !shows) {
      this.#write(id, after, null, now, now);
      // A new tombstone counts against its stream's cap.
      if (!item) {
        this.#count(stream, 0, 1);
        this.#cap(stream);
      }
      return false;
    }
    const { seq, orderAt } = this.#next(stream, now);
    this.#write(id, after, seq, now, orderAt);
    if (shows) {
      // One more shown, and a tombstone shown now is one fewer.
      this.#count(stream, 1, item ? -1 : 0);
      this.#cap(stream);
    }
    return true;
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

  #write(id: FeedItemId, state: State, seq: number | null, seqAt: number, orderAt: number): void {
    const columns = Object.keys(state) as (keyof State)[];
    const placed = ["feed_seq", "seq_at", "order_at"];
    this.sql.exec(
      `INSERT INTO feed_items (repo_id, thread_key, kind, subject, ${columns.join(", ")},
         ${placed.join(", ")})
       VALUES (?, ?, ?, ?, ${columns.map(() => "?").join(", ")}, ?, ?, ?)
       ON CONFLICT (repo_id, thread_key, kind) DO UPDATE SET
         ${[...columns, ...placed].map((c) => `${c} = excluded.${c}`).join(", ")}`,
      id.repoId,
      id.threadKey,
      id.kind,
      subjectOfThread(id.threadKey),
      ...columns.map((c) => state[c]),
      seq,
      seqAt,
      orderAt,
    );
  }

  /**
   * A page of the items the cursor's snapshot has not given yet, in
   * sequence order, after `read.after` within an answer: per stream, after
   * its position (none:
   * after `base`, else from its retained start). Expired when the cursor
   * is of another epoch, or its snapshot is not the credential's or is
   * past its lifetime (a cursor of before streams: below the feed's low
   * watermark of then, or past its head). A first page also names the
   * streams the snapshot is behind (see `#behind`), and every page the
   * low watermarks of its items' streams: the caller judges whether those
   * may be read, so that what was deleted is never passed silently. A
   * snapshot with positions in `FEED_POLICY.coverage` streams reads those
   * only.
   */
  read(read: StreamRead, limit: number, filter: FeedFilter = {}): StreamPage {
    const meta = this.#meta();
    const now = this.now();
    const snapshot = this.#snapshot(read, meta, now);
    if (!snapshot) return { expired: true };
    const after = read.after;
    // Expired and not deleted yet (retention goes a slice at a time): gone already.
    const cutoff = after?.cutoff ?? now - FEED_POLICY.retentionMs;
    const page = (rows: readonly Row[], more: boolean): StreamPage => ({
      expired: false,
      epoch: meta.epoch,
      snapshot,
      expiredStreams: after === null ? this.#behind(snapshot, cutoff) : [],
      cutoff,
      watermarks: this.#watermarks(rows),
      items: rows.map(itemOf),
      more,
    });
    if (filter.subjects?.length === 0) return page([], false);
    const full = snapshot.positions.length >= FEED_POLICY.coverage;
    // A first page starts at the first item not given yet: what was given is not read again.
    const from = after === null ? this.#floor(snapshot, full, filter) : after.seq;
    if (from === null) return page([], false);
    const rows = this.sql
      .exec<Row>(
        `SELECT i.* FROM feed_items i
         WHERE i.feed_seq > ?4 AND i.order_at >= ?2
           AND i.feed_seq > coalesce(${positionOf("i")}, ?3, 0)
           ${full ? `AND ${positionOf("i")} IS NOT NULL` : ""}
           AND (?5 IS NULL OR i.priority = ?5) AND (?6 IS NULL OR i.kind = ?6)
           AND (?7 IS NULL OR i.repo_id IN (SELECT value FROM json_each(?7)))
           ${bySubject(filter.subjects, 8, "i.")}
         ORDER BY i.feed_seq LIMIT ?9`,
        byStream(snapshot.positions),
        cutoff,
        snapshot.base,
        from,
        filter.priority ?? null,
        filter.kind ?? null,
        filter.repoIds ? JSON.stringify(filter.repoIds) : null,
        oneSubject(filter.subjects),
        limit + 1,
      )
      .toArray();
    return page(rows.slice(0, limit), rows.length > limit);
  }

  /** The cursor's snapshot, undefined when it is expired (see `read`). */
  #snapshot(
    read: StreamRead,
    meta: Meta,
    now: number,
  ): (SnapshotState & { id: string | null; createdAt: number }) | undefined {
    const { cursor } = read;
    if (cursor === null) return { positions: [], base: null, id: null, createdAt: now };
    if (cursor.epoch !== meta.epoch) return undefined;
    // Of before streams: judged by the feed's head and low watermark then (never by its head
    // now, which counts what the caller may not see).
    if ("base" in cursor)
      return cursor.base < meta.low_watermark ||
        cursor.base > meta.legacy_head ||
        this.#manyStreams()
        ? undefined
        : { positions: [], base: cursor.base, id: null, createdAt: now };
    const row = this.sql
      .exec<{ state: string; created_at: number }>(
        "SELECT state, created_at FROM feed_cursors WHERE id = ? AND credential = ?",
        cursor.id,
        read.credential,
      )
      .toArray()[0];
    if (!row || row.created_at <= now - FEED_POLICY.cursorTtlMs) return undefined;
    const state = JSON.parse(row.state) as SnapshotState;
    if (state.base !== null && this.#manyStreams()) return undefined;
    return { ...state, id: cursor.id, createdAt: row.created_at };
  }

  /**
   * Whether the feed has more than `coverage` streams: a snapshot with a
   * base (of before streams) is then expired, as it would be checked
   * against every one.
   */
  #manyStreams(): boolean {
    return (
      this.sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM (SELECT 1 FROM feed_streams LIMIT ?)",
          FEED_POLICY.coverage + 1,
        )
        .one().n > FEED_POLICY.coverage
    );
  }

  /**
   * The streams the snapshot is behind: its position in them (with a
   * base, every stream's without one) below the stream's low watermark, or
   * with an item after it past the retention (the stream's expired items
   * are a prefix of its sequence, so the first after it says), one seek
   * each.
   */
  #behind(snapshot: SnapshotState, cutoff: number): StreamKey[] {
    if (snapshot.positions.length === 0 && snapshot.base === null) return [];
    // A snapshot's streams by their positions; with a base, every stream (of before streams).
    const streams =
      snapshot.base === null
        ? `${positioned(4)} p JOIN feed_streams s ON s.repo_id = p.repo_id AND s.subject = p.subject`
        : "feed_streams s";
    const at = `coalesce(${positionOf("s")}, ?2)`;
    return this.sql
      .exec<{ repo_id: string; subject: string }>(
        `SELECT s.repo_id, s.subject FROM ${streams}
         WHERE ${at} < s.low_watermark OR coalesce((
           SELECT i.order_at < ?3 FROM feed_items i INDEXED BY feed_items_stream
           WHERE i.repo_id = s.repo_id AND i.subject = s.subject AND i.feed_seq IS NOT NULL
             AND i.feed_seq > ${at}
           ORDER BY i.feed_seq LIMIT 1), 0)`,
        byStream(snapshot.positions),
        snapshot.base,
        cutoff,
        ...(snapshot.base === null ? [JSON.stringify(snapshot.positions)] : []),
      )
      .toArray()
      .map((r) => ({ repoId: r.repo_id, subject: r.subject }));
  }

  /** The stored low watermarks of the streams of `rows`. */
  #watermarks(rows: readonly Row[]): StreamPosition[] {
    const streams = new Map(rows.map((r) => [`${r.repo_id}/${r.subject}`, [r.repo_id, r.subject]]));
    if (streams.size === 0) return [];
    return this.sql
      .exec<{ repo_id: string; subject: string; low_watermark: number }>(
        `SELECT s.repo_id, s.subject, s.low_watermark FROM ${positioned(1)} p
         JOIN feed_streams s ON s.repo_id = p.repo_id AND s.subject = p.subject`,
        JSON.stringify([...streams.values()]),
      )
      .toArray()
      .map((r) => [r.repo_id, r.subject, r.low_watermark] as const);
  }

  /**
   * Where the items the snapshot has not given start: the sequence number
   * just before the first of them (null: none), one seek a stream the
   * filter reads (a stream's items not given are a suffix of it). Past
   * `coverage` live streams without full coverage, 0 (the work stays
   * bounded; the read then starts at the retained start).
   */
  #floor(snapshot: SnapshotState, full: boolean, filter: FeedFilter): number | null {
    // Full: its streams only, by their positions; else every stream with items (by the index
    // of those), positioned or not.
    const streams = full
      ? `${positioned(6)} p JOIN feed_streams s ON s.repo_id = p.repo_id AND s.subject = p.subject`
      : "feed_streams s INDEXED BY feed_streams_live";
    const { n, first } = this.sql
      .exec<{ n: number; first: number | null }>(
        `SELECT count(*) AS n, min(f) AS first FROM (
           SELECT (SELECT i.feed_seq FROM feed_items i INDEXED BY feed_items_stream
               WHERE i.repo_id = s.repo_id AND i.subject = s.subject AND i.feed_seq IS NOT NULL
                 AND i.feed_seq > coalesce(${positionOf("s")}, ?2, 0)
               ORDER BY i.feed_seq LIMIT 1) AS f
           FROM ${streams}
           WHERE s.items > 0 AND (?3 IS NULL OR s.repo_id IN (SELECT value FROM json_each(?3)))
             ${bySubject(filter.subjects, 4, "s.")}
           LIMIT ?5)`,
        byStream(snapshot.positions),
        snapshot.base,
        filter.repoIds ? JSON.stringify(filter.repoIds) : null,
        oneSubject(filter.subjects),
        FEED_POLICY.coverage + 1,
        ...(full ? [JSON.stringify(snapshot.positions)] : []),
      )
      .one();
    return n > FEED_POLICY.coverage ? 0 : first === null ? null : first - 1;
  }

  /**
   * A page of what needs the owner now: open P0 items, then P1 items
   * changed within the retention, latest first, after `after` (from the
   * first without); and the feed's head as of the first page.
   */
  sync(
    after: SyncKey | null,
    limit: number,
    filter: Pick<FeedFilter, "repoIds" | "subjects">,
  ): SyncPage {
    const meta = this.#meta();
    const bound = after?.bound ?? meta.head_seq;
    if (filter.subjects?.length === 0) return { epoch: meta.epoch, items: [], more: false, bound };
    const cutoff = this.now() - FEED_POLICY.retentionMs;
    const rows = this.sql
      .exec<Row>(
        `SELECT * FROM (
           SELECT *, (priority = 'P0' AND state = 'open') AS open FROM feed_items
           WHERE feed_seq IS NOT NULL AND order_at >= ?1
             AND ((priority = 'P0' AND state = 'open')
               OR (priority IN ('P1', 'P2') AND last_event_at >= ?1))
             AND (?2 IS NULL OR repo_id IN (SELECT value FROM json_each(?2)))
             ${bySubject(filter.subjects, 3)})
         WHERE (open, feed_seq) < (?4, ?5)
         ORDER BY open DESC, feed_seq DESC LIMIT ?6`,
        cutoff,
        filter.repoIds ? JSON.stringify(filter.repoIds) : null,
        oneSubject(filter.subjects),
        // From the first: any item's `open` is below 2.
        after === null ? 2 : after.open ? 1 : 0,
        after?.seq ?? 0,
        limit + 1,
      )
      .toArray();
    return {
      epoch: meta.epoch,
      items: rows.slice(0, limit).map(itemOf),
      more: rows.length > limit,
      bound,
    };
  }

  /**
   * Keeps the snapshot a complete sync leaves (see `saveCursor`): each of
   * `streams` (those it gave items of, at most `coverage`) at its head as
   * of `bound`: its greatest sequence number up to it (a change since comes
   * after it), one seek each.
   */
  syncCursor(
    credential: string,
    streams: readonly StreamKey[],
    bound: number,
  ): { id: string; created: boolean } {
    if (streams.length > FEED_POLICY.coverage)
      throw new RangeError(`at most ${FEED_POLICY.coverage} streams, not ${streams.length}`);
    const positions = this.sql
      .exec<{ repo_id: string; subject: string; seq: number | null }>(
        `SELECT p.repo_id, p.subject, (SELECT i.feed_seq FROM feed_items i INDEXED BY feed_items_stream
             WHERE i.repo_id = p.repo_id AND i.subject = p.subject AND i.feed_seq IS NOT NULL
               AND i.feed_seq <= ?2
             ORDER BY i.feed_seq DESC LIMIT 1) AS seq
         FROM ${positioned(1)} p`,
        JSON.stringify(streams.map((s) => [s.repoId, s.subject])),
        bound,
      )
      .toArray()
      .flatMap((r) => (r.seq === null ? [] : [[r.repo_id, r.subject, r.seq] as const]));
    return this.saveCursor(credential, { positions, base: null });
  }

  /**
   * Keeps a snapshot for the credential (call within a transaction), and
   * answers its id: that of a live one it has with the same state, made
   * within half the lifetime (so a cursor read on is renewed before it
   * expires), else a new random one, the credential's oldest going first
   * so it keeps at most `cursorsPerCredential` (never the new one).
   * `created`: a row was written.
   */
  saveCursor(credential: string, state: SnapshotState): { id: string; created: boolean } {
    if (state.positions.length > FEED_POLICY.coverage)
      throw new RangeError(
        `at most ${FEED_POLICY.coverage} positions, not ${state.positions.length}`,
      );
    const positions = [...state.positions].sort(([ra, sa], [rb, sb]) =>
      ra < rb ? -1 : ra > rb ? 1 : sa < sb ? -1 : sa > sb ? 1 : 0,
    );
    const text = JSON.stringify({ positions, base: state.base });
    const hash = hashOf(text);
    const now = this.now();
    const same = this.sql
      .exec<{ id: string; state: string }>(
        "SELECT id, state FROM feed_cursors WHERE credential = ? AND hash = ? AND created_at > ?",
        credential,
        hash,
        now - FEED_POLICY.cursorTtlMs / 2,
      )
      .toArray()
      .find((row) => row.state === text);
    if (same) return { id: same.id, created: false };
    this.sql.exec(
      `DELETE FROM feed_cursors WHERE id IN (SELECT id FROM feed_cursors WHERE credential = ?
         ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`,
      credential,
      FEED_POLICY.cursorsPerCredential - 1,
    );
    const id = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    this.sql.exec(
      "INSERT INTO feed_cursors (id, credential, hash, state, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      credential,
      hash,
      text,
      now,
    );
    return { id, created: true };
  }

  /** Deletes up to `sliceRows` snapshots past their lifetime; returns whether more are left. */
  expireCursorsStep(): boolean {
    return (
      this.sql
        .exec(
          `DELETE FROM feed_cursors WHERE id IN (SELECT id FROM feed_cursors WHERE created_at <= ?
             ORDER BY created_at LIMIT ?) RETURNING id`,
          this.now() - FEED_POLICY.cursorTtlMs,
          FEED_POLICY.sliceRows,
        )
        .toArray().length >= FEED_POLICY.sliceRows
    );
  }

  /** When the oldest snapshot expires; null for none. */
  nextCursorExpiry(): number | null {
    const at = this.sql
      .exec<{ at: number | null }>("SELECT min(created_at) AS at FROM feed_cursors")
      .one().at;
    return at === null ? null : at + FEED_POLICY.cursorTtlMs;
  }

  /**
   * Records that the owner has seen `version` of an item (call within a
   * transaction). Refused for a version the item does not have yet; an
   * older one than already acknowledged changes nothing. A change is
   * sequenced in the item's stream, so every reader of the feed sees it.
   */
  ack(id: FeedItemId, at: ThreadVersion): FeedAck {
    const now = this.now();
    const item = this.#live(id, now);
    if (!item || item.feed_seq === null) return { status: "missing" };
    if (newerThan(at, { epoch: item.thread_epoch, version: item.version }))
      return { status: "ahead" };
    if (!newerThan(at, { epoch: item.acked_epoch, version: item.acked_version }))
      return { status: "acked", item: itemOf(item) };
    const { seq, orderAt } = this.#next({ repoId: id.repoId, subject: item.subject }, now);
    const row = this.sql
      .exec<Row>(
        `UPDATE feed_items SET acked_epoch = ?, acked_version = ?, feed_seq = ?, seq_at = ?,
           order_at = ?
         WHERE ${WHERE_ITEM}
         RETURNING *`,
        at.epoch,
        at.version,
        seq,
        now,
        orderAt,
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
      const gone = this.sql
        .exec<Deleted>(
          `DELETE FROM feed_items WHERE repo_id = ? AND last_event_at <= ?
           RETURNING repo_id, subject, feed_seq`,
          repoId,
          purge.until,
        )
        .toArray();
      deleted += this.#forgot(gone, false);
      for (const row of this.sql
        .exec<Row>("SELECT * FROM feed_items WHERE repo_id = ? AND kind = 'activity'", repoId)
        .toArray()) {
        const members = JSON.parse(row.members) as Member[];
        const kept = members.filter((m) => m.at > purge.until);
        if (kept.length === members.length) continue;
        const placed =
          row.feed_seq === null
            ? { seq: null, orderAt: now }
            : this.#next({ repoId, subject: row.subject }, now);
        this.#write(
          { repoId, threadKey: row.thread_key, kind: row.kind },
          withMembers(stateOf(row), kept, row.truncated === 1),
          placed.seq,
          now,
          placed.orderAt,
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
    return deleted;
  }

  /**
   * Forgets threads a read found gone for good (a deleted issue: its number
   * is never used again, so no later entry of the thread is news); a late
   * entry of one comes back only to be found gone again. Call within a
   * transaction. Returns the shown items deleted.
   */
  forgetThreads(threads: readonly GoneThread[]): number {
    let deleted = 0;
    // Only what was told in the generation the thread was found gone in, or before: a restore
    // can give its number to a new conversation, whose items stay. A caller of the earlier shape
    // (no generation, while a deploy rolls out) binds null, which matches nothing.
    for (const { repoId, threadKey, epoch } of threads)
      deleted += this.#forgot(
        this.sql
          .exec<Deleted>(
            `DELETE FROM feed_items WHERE repo_id = ? AND thread_key = ? AND thread_epoch <= ?
             RETURNING repo_id, subject, feed_seq`,
            repoId,
            threadKey,
            epoch ?? null,
          )
          .toArray(),
        false,
      );
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
   * One step of retention (call within a transaction): deletes items and
   * tombstones past the retention, oldest first, at most `sliceRows`,
   * raising their streams' low watermarks to the greatest sequence number
   * deleted; and up to `sliceRows` expired purge marks and eviction fences
   * each. (A stream's caps are kept as it is written.) Returns whether more
   * is left.
   */
  retainStep(): boolean {
    const expired = this.now() - FEED_POLICY.retentionMs;
    const slice = FEED_POLICY.sliceRows;
    const gone = this.sql
      .exec<Deleted>(
        `DELETE FROM feed_items WHERE (repo_id, thread_key, kind) IN
           (SELECT repo_id, thread_key, kind FROM feed_items WHERE order_at < ?
            ORDER BY order_at LIMIT ?)
         RETURNING repo_id, subject, feed_seq`,
        expired,
        slice,
      )
      .toArray();
    this.#forgot(gone, true);
    // Entries a mark or a fence would drop are dropped for their age by now: the events up to
    // a mark happened by its time, and those up to a fence's version by the item's last one.
    const marks = this.sql
      .exec(
        `DELETE FROM purge_marks WHERE repo_id IN
           (SELECT repo_id FROM purge_marks WHERE until_at < ? ORDER BY until_at LIMIT ?)
         RETURNING repo_id`,
        expired,
        slice,
      )
      .toArray().length;
    const fences = this.sql
      .exec(
        `DELETE FROM feed_evictions WHERE (repo_id, thread_key, kind) IN
           (SELECT repo_id, thread_key, kind FROM feed_evictions WHERE event_at < ?
            ORDER BY event_at LIMIT ?)
         RETURNING repo_id`,
        expired,
        slice,
      )
      .toArray().length;
    return gone.length >= slice || marks >= slice || fences >= slice;
  }

  /**
   * One step of a retired feed's cleanup (call within a transaction): up
   * to `sliceRows` items, then purge marks, eviction fences, streams and
   * snapshots. Returns whether more is left.
   */
  retireStep(): boolean {
    const slice = FEED_POLICY.sliceRows;
    for (const [table, key] of [
      ["feed_items", "repo_id, thread_key, kind"],
      ["purge_marks", "repo_id"],
      ["feed_evictions", "repo_id, thread_key, kind"],
      ["feed_streams", "repo_id, subject"],
      ["feed_cursors", "id"],
    ] as const) {
      const n = this.sql
        .exec(
          `DELETE FROM ${table} WHERE (${key}) IN (SELECT ${key} FROM ${table} LIMIT ?)
           RETURNING 1`,
          slice,
        )
        .toArray().length;
      if (n > 0) return true;
    }
    return false;
  }

  /**
   * When retention should next run: when the item, tombstone, purge mark
   * or fence changed longest ago expires; null for an empty feed.
   */
  nextRetention(): number | null {
    const { item, mark, fence } = this.sql
      .exec<{ item: number | null; mark: number | null; fence: number | null }>(
        `SELECT
           (SELECT min(order_at) FROM feed_items) AS item,
           (SELECT min(until_at) FROM purge_marks) AS mark,
           (SELECT min(event_at) FROM feed_evictions) AS fence`,
      )
      .one();
    const oldest = [item, mark, fence].filter((at) => at !== null);
    return oldest.length === 0 ? null : Math.min(...oldest) + FEED_POLICY.retentionMs;
  }

  /** The meta row; the epoch names the restore generation too, so a restore expires cursors. */
  #meta(): Meta {
    return this.sql
      .exec<Meta>(
        `SELECT epoch_gen || '.' || epoch AS epoch, head_seq, low_watermark, legacy_head
         FROM feed_meta WHERE id = 1`,
      )
      .one();
  }

  /** Takes the directory's restore generation for the feed, when newer than the one recorded. */
  takeEpoch(epochGen: number): void {
    this.sql.exec("UPDATE feed_meta SET epoch_gen = ?1 WHERE id = 1 AND epoch_gen < ?1", epochGen);
  }

  /**
   * The item, unless retention has it already: an expired item is deleted
   * here, as its retention step would (its stream's low watermark raised
   * past a shown one), so no write merges into it or brings it back while
   * the steps catch up.
   */
  #live(id: FeedItemId, now: number): Row | undefined {
    const row = this.#row(id);
    if (!row || row.order_at >= now - FEED_POLICY.retentionMs) return row;
    this.sql.exec(`DELETE FROM feed_items WHERE ${WHERE_ITEM}`, id.repoId, id.threadKey, id.kind);
    this.#forgot([row], true);
    return undefined;
  }

  #row(id: FeedItemId): Row | undefined {
    return this.sql
      .exec<Row>(`SELECT * FROM feed_items WHERE ${WHERE_ITEM}`, id.repoId, id.threadKey, id.kind)
      .toArray()[0];
  }

  /**
   * The feed's next sequence number for a change in `stream`, and the
   * `order_at` that goes with it: now, never before the stream's last
   * shown item's (so its expired items are a prefix of its sequence,
   * whatever the clock does, and no other stream moves it).
   */
  #next(stream: StreamKey, now: number): { seq: number; orderAt: number } {
    const last = this.sql
      .exec<{ order_at: number }>(
        `SELECT order_at FROM feed_items INDEXED BY feed_items_stream
         WHERE repo_id = ? AND subject = ? AND feed_seq IS NOT NULL
         ORDER BY feed_seq DESC LIMIT 1`,
        stream.repoId,
        stream.subject,
      )
      .toArray()[0];
    const { head_seq: seq } = this.sql
      .exec<{ head_seq: number }>(
        "UPDATE feed_meta SET head_seq = head_seq + 1 WHERE id = 1 RETURNING head_seq",
      )
      .one();
    return { seq, orderAt: Math.max(now, last?.order_at ?? now) };
  }

  #made(stream: StreamKey): void {
    this.sql.exec(
      `INSERT INTO feed_streams (repo_id, subject, low_watermark, items, tombstones)
       VALUES (?, ?, 0, 0, 0) ON CONFLICT DO NOTHING`,
      stream.repoId,
      stream.subject,
    );
  }

  /** Counts shown items and tombstones into the stream. */
  #count(stream: StreamKey, items: number, tombstones: number): void {
    this.#made(stream);
    this.sql.exec(
      `UPDATE feed_streams SET items = items + ?, tombstones = tombstones + ?
       WHERE repo_id = ? AND subject = ?`,
      items,
      tombstones,
      stream.repoId,
      stream.subject,
    );
  }

  /**
   * Uncounts deleted rows from their streams, raising each one's low
   * watermark to the greatest sequence number deleted when `gone` (they
   * are gone for every reader: retention, a cap); a purge's are not (a
   * reader that may read them again reads what is left). Returns the shown
   * items among them.
   */
  #forgot(rows: readonly Deleted[], gone: boolean): number {
    const streams = new Map<string, { items: number; tombstones: number; seq: number }>();
    for (const row of rows) {
      const key = JSON.stringify([row.repo_id, row.subject]);
      const counted = streams.get(key) ?? { items: 0, tombstones: 0, seq: 0 };
      if (row.feed_seq === null) counted.tombstones++;
      else {
        counted.items++;
        counted.seq = Math.max(counted.seq, row.feed_seq);
      }
      streams.set(key, counted);
    }
    let shown = 0;
    for (const [key, { items, tombstones, seq }] of streams) {
      const [repoId, subject] = JSON.parse(key) as [string, string];
      shown += items;
      this.sql.exec(
        `UPDATE feed_streams SET items = items - ?, tombstones = tombstones - ?,
           low_watermark = max(low_watermark, ?)
         WHERE repo_id = ? AND subject = ?`,
        items,
        tombstones,
        gone ? seq : 0,
        repoId,
        subject,
      );
    }
    return shown;
  }

  /**
   * Keeps the stream within its caps: its shown items changed longest ago,
   * and its tombstones written longest ago, past them are deleted, each
   * leaving its fence (the stream's oldest past `streamFences` going).
   */
  #cap(stream: StreamKey): void {
    const counts = this.sql
      .exec<{ items: number; tombstones: number }>(
        "SELECT items, tombstones FROM feed_streams WHERE repo_id = ? AND subject = ?",
        stream.repoId,
        stream.subject,
      )
      .one();
    const over = [
      [counts.items - FEED_POLICY.streamItems, "feed_seq IS NOT NULL ORDER BY feed_seq"],
      [counts.tombstones - FEED_POLICY.streamTombstones, "feed_seq IS NULL ORDER BY order_at"],
    ] as const;
    const evicted: Row[] = [];
    for (const [n, oldest] of over)
      if (n > 0)
        evicted.push(
          ...this.sql
            .exec<Row>(
              `DELETE FROM feed_items WHERE (repo_id, thread_key, kind) IN
                 (SELECT repo_id, thread_key, kind FROM feed_items
                  WHERE repo_id = ? AND subject = ? AND ${oldest} LIMIT ?)
               RETURNING *`,
              stream.repoId,
              stream.subject,
              n,
            )
            .toArray(),
        );
    if (evicted.length === 0) return;
    for (const row of evicted)
      this.sql.exec(
        `INSERT INTO feed_evictions (repo_id, thread_key, kind, subject, thread_epoch, version, event_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, thread_key, kind) DO UPDATE SET thread_epoch = excluded.thread_epoch,
           version = excluded.version, event_at = excluded.event_at`,
        row.repo_id,
        row.thread_key,
        row.kind,
        row.subject,
        row.thread_epoch,
        row.version,
        row.last_event_at,
      );
    this.sql.exec(
      `DELETE FROM feed_evictions WHERE (repo_id, thread_key, kind) IN
         (SELECT repo_id, thread_key, kind FROM feed_evictions WHERE repo_id = ? AND subject = ?
          ORDER BY event_at DESC LIMIT -1 OFFSET ?)`,
      stream.repoId,
      stream.subject,
      FEED_POLICY.streamFences,
    );
    this.#forgot(evicted, true);
  }
}
