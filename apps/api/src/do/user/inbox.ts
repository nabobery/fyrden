import type { FeedEntry, FeedKind } from "@fyrden/domain";

/*
 * The principal's thread inbox: one row a repository and conversation
 * that notified it, as GitHub's notification threads, apart from feed
 * items (what changed) and agents' acknowledgements (`feed.ack`). A row is
 * made, made unread, or reopened (its done mark cleared) only by an entry
 * that notifies: one not silent, which the principal's preferences allow
 * (see `Gate`), of an event after the one that last notified, and not
 * older than what the feed knows of the thread (its newest item or fence,
 * whichever event made it; the feed's retention, caps and purges keep
 * that). One event notifies at most once, however many of its
 * contributions arrive (a settlement and its main block bump the thread's
 * version apart); its others only strengthen the reason, which only moves
 * to a stronger one, as GitHub's does. Entries without a conversation
 * identity (made before it was stamped) change nothing here.
 */

/** Proposed values. */
export const INBOX_POLICY = {
  /** Threads a repository and kind keeps at most; the least recently updated go first. */
  streamThreads: 250,
  /** Fences of evicted threads a stream keeps at most, the oldest going first. */
  streamFences: 100,
};

/** GitHub's notification reasons Fyrden gives, strongest first: a thread's reason only moves up this list. */
export const INBOX_REASONS = [
  "review_requested",
  "mention",
  "team_mention",
  "assign",
  "author",
  "manual",
  "comment",
  "subscribed",
  "state_change",
] as const;
export type InboxReason = (typeof INBOX_REASONS)[number];

/** Reasons a thread unsubscribed by the principal still notifies for: what it is asked or named for. */
const DIRECT: ReadonlySet<InboxReason> = new Set([
  "review_requested",
  "mention",
  "team_mention",
  "assign",
]);

const strength = (reason: string) => {
  const at = INBOX_REASONS.indexOf(reason as InboxReason);
  return at < 0 ? INBOX_REASONS.length : at;
};
const stronger = (a: string, b: string) => (strength(b) < strength(a) ? b : a);

/** The stronger of two reasons. */
export const strongestReason = (a: InboxReason, b: InboxReason): InboxReason =>
  stronger(a, b) as InboxReason;

/** Whether a thread unsubscribed by the principal still notifies for `reason`. */
export const notifiesThroughUnsubscribe = (reason: InboxReason) => DIRECT.has(reason);

/** The GitHub reason an entry notifies for, from its kind and why its recipient hears of it. */
export function reasonOf(kind: FeedKind, reasons: readonly string[]): InboxReason {
  switch (kind) {
    case "review_requested":
      return "review_requested";
    case "mention":
      return "mention";
    case "assigned":
      return "assign";
    case "approved":
    case "changes_requested":
    case "merge_conflict":
      return "author";
    default: {
      const why = reasons[0];
      if (why === "author") return "author";
      if (why === "subscribed") return "manual";
      if (why === "watching") return "subscribed";
      return "comment";
    }
  }
}

/**
 * The principal's acknowledged preferences, as the directory's copy holds
 * them, for the repositories and conversations a call's entries name:
 * repositories it ignores, and conversations it unsubscribed from.
 */
export interface Gate {
  readonly ignored: ReadonlySet<string>;
  /** `<repository id>\n<conversation>` of unsubscribed conversations. */
  readonly unsubscribed: ReadonlySet<string>;
}

export const OPEN_GATE: Gate = { ignored: new Set(), unsubscribed: new Set() };

/** Whether `gate` lets an entry of `repoId`'s `conversation` notify for `reason`. */
export function allows(gate: Gate, repoId: string, conversation: string, reason: InboxReason) {
  if (gate.ignored.has(repoId)) return false;
  return DIRECT.has(reason) || !gate.unsubscribed.has(`${repoId}\n${conversation}`);
}

/** A thread's id: its repository and conversation, reversible, as a URL path segment. */
export function threadId(repoId: string, conversation: string): string {
  const bytes = new TextEncoder().encode(`${repoId}\n${conversation}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A thread id's repository and conversation, or undefined for no id a thread can have. */
export function parseThreadId(id: string): { repoId: string; conversation: string } | undefined {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(id)) return undefined;
  try {
    const binary = atob(id.replaceAll("-", "+").replaceAll("_", "/"));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    );
    const at = text.indexOf("\n");
    if (at <= 0 || at === text.length - 1) return undefined;
    const parsed = { repoId: text.slice(0, at), conversation: text.slice(at + 1) };
    return threadId(parsed.repoId, parsed.conversation) === id ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Where a thread stands: an entry's (epoch, version) and event. */
interface Frontier {
  readonly epoch: number;
  readonly version: number;
  readonly event: string;
}

/** Whether `a` is of another event than `b`, and newer (no `b`: always). */
const after = (a: Frontier, b: Frontier | null) =>
  b === null ||
  (a.event !== b.event && (a.epoch > b.epoch || (a.epoch === b.epoch && a.version > b.version)));

/** Whether `a` is newer than `b` (another event's or the same's). */
const newer = (a: Frontier, b: Frontier) =>
  a.epoch > b.epoch || (a.epoch === b.epoch && a.version > b.version);

type ThreadRow = {
  id: string;
  reason: string;
  unread: number;
  nt_epoch: number;
  nt_version: number;
  nt_event: string;
  rd_epoch: number | null;
  rd_version: number | null;
  rd_event: string | null;
  dn_epoch: number | null;
  dn_version: number | null;
  dn_event: string | null;
};

const frontier = (
  epoch: number | null,
  version: number | null,
  event: string | null,
): Frontier | null =>
  epoch === null || version === null || event === null ? null : { epoch, version, event };

const SUBJECTS = ["issue", "pull"] as const;

/** Rows a list reads of each repository's stream at a time while merging them. Proposed. */
export const MERGE_CHUNK = 8;
export type SubjectKind = (typeof SUBJECTS)[number];

/** What a list of threads asks for (see `Inbox.page`). */
export interface InboxQuery {
  /** Only unread threads (GitHub's default: `all=false`). */
  readonly unreadOnly: boolean;
  /** The kinds the caller may read. */
  readonly subjects: readonly SubjectKind[];
  /** Only these repositories' (a token's own, or one repository's list); null for any. */
  readonly repoIds: readonly string[] | null;
  /** Updated after (milliseconds since the epoch). */
  readonly since: number | null;
  /** Updated before. */
  readonly before: number | null;
  /** The last thread a previous page gave. */
  readonly after: { readonly updatedAt: number; readonly id: string } | null;
  readonly limit: number;
}

/** A thread as readers get it. */
export interface InboxThread {
  readonly id: string;
  readonly repoId: string;
  readonly conversation: string;
  readonly subject: SubjectKind;
  readonly number: number;
  readonly title: string;
  readonly reason: string;
  readonly unread: boolean;
  readonly updatedAt: number;
  readonly lastReadAt: number | null;
  /** The repository's restore generation it last notified in. */
  readonly epoch: number;
}

type InboxRow = {
  id: string;
  repo_id: string;
  conversation: string;
  subject: SubjectKind;
  number: number;
  title: string;
  reason: string;
  unread: number;
  updated_at: number;
  last_read_at: number | null;
  nt_epoch: number;
};

const threadOf = (row: InboxRow): InboxThread => ({
  id: row.id,
  repoId: row.repo_id,
  conversation: row.conversation,
  subject: row.subject,
  number: row.number,
  title: row.title,
  reason: row.reason,
  unread: row.unread === 1,
  updatedAt: row.updated_at,
  lastReadAt: row.last_read_at,
  epoch: row.nt_epoch,
});

/** Identities of one number a gone thread's forgetting deletes at most (see `forgetNumber`). */
export const GONE_IDENTITIES = 2;

export class Inbox {
  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => number,
  ) {}

  /**
   * Takes an entry the feed took (call within the feed's transaction, right
   * after the feed applied it, in the feed's order: epoch, then version),
   * allowed to notify only as `gate` says. Returns whether it made its
   * thread unread or reopened it.
   */
  take(entry: FeedEntry, gate: Gate): boolean {
    return this.#applyOne(entry, gate);
  }

  #applyOne(entry: FeedEntry, gate: Gate): boolean {
    const conversation = entry.feed.subject.conversation;
    if (conversation === undefined || entry.recipient.silent) return false;
    const { repoId } = entry;
    const reason = reasonOf(entry.recipient.kind, entry.recipient.reasons);
    if (!allows(gate, repoId, conversation, reason)) return false;
    const at: Frontier = {
      epoch: entry.epochGen,
      version: entry.feed.subject.version,
      event: entry.eventKey,
    };
    // Another event's entry older than what the feed knows of the thread tells nothing new; any
    // contribution of the event the feed is at may still notify, once.
    const seen = this.#front(repoId, entry.feed.threadKey);
    if (seen !== null && at.event !== seen.event && !newer(at, seen)) return false;
    const id = threadId(repoId, conversation);
    const row = this.sql
      .exec<ThreadRow>("SELECT * FROM inbox_threads WHERE id = ?", id)
      .toArray()[0];
    if (!row) {
      if (!after(at, this.#fence(repoId, conversation))) return false;
      this.sql.exec(
        `INSERT INTO inbox_threads (id, repo_id, conversation, subject, number, title, reason,
           unread, updated_at, last_read_at, nt_epoch, nt_version, nt_event)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?)`,
        id,
        repoId,
        conversation,
        entry.feed.subject.kind,
        entry.feed.subject.number,
        entry.feed.subject.title,
        reason,
        entry.occurredAt,
        at.epoch,
        at.version,
        at.event,
      );
      this.sql.exec(
        "DELETE FROM inbox_evictions WHERE repo_id = ? AND conversation = ?",
        repoId,
        conversation,
      );
      this.#count([{ repo_id: repoId, subject: entry.feed.subject.kind }], 1);
      this.#cap(repoId, entry.feed.subject.kind);
      return true;
    }
    const notified: Frontier = {
      epoch: row.nt_epoch,
      version: row.nt_version,
      event: row.nt_event,
    };
    if (!after(at, notified)) {
      // Another contribution of the event that notified: its reason merges in.
      const merged = at.event === notified.event ? stronger(row.reason, reason) : row.reason;
      if (merged !== row.reason)
        this.sql.exec("UPDATE inbox_threads SET reason = ? WHERE id = ?", merged, id);
      return false;
    }
    const unread =
      row.unread === 1 || after(at, frontier(row.rd_epoch, row.rd_version, row.rd_event));
    const done = frontier(row.dn_epoch, row.dn_version, row.dn_event);
    const reopened = done !== null && after(at, done);
    this.sql.exec(
      `UPDATE inbox_threads SET reason = ?, unread = ?, updated_at = max(updated_at, ?), title = ?,
         nt_epoch = ?, nt_version = ?, nt_event = ?,
         dn_epoch = CASE WHEN ? THEN NULL ELSE dn_epoch END,
         dn_version = CASE WHEN ? THEN NULL ELSE dn_version END,
         dn_event = CASE WHEN ? THEN NULL ELSE dn_event END
       WHERE id = ?`,
      stronger(row.reason, reason),
      unread ? 1 : 0,
      entry.occurredAt,
      entry.feed.subject.title,
      at.epoch,
      at.version,
      at.event,
      reopened ? 1 : 0,
      reopened ? 1 : 0,
      reopened ? 1 : 0,
      id,
    );
    return unread !== (row.unread === 1) || reopened;
  }

  /**
   * What the feed knows of a thread: its newest item's or fence's
   * (epoch, version) and the event that made it (a fence written before
   * fences kept it: none).
   */
  #front(repoId: string, threadKey: string): Frontier | null {
    const row = this.sql
      .exec<{ epoch: number; version: number; event: string }>(
        `SELECT thread_epoch AS epoch, version, last_event_key AS event FROM feed_items
         WHERE repo_id = ?1 AND thread_key = ?2
         UNION ALL
         SELECT thread_epoch, version, event_key FROM feed_evictions
         WHERE repo_id = ?1 AND thread_key = ?2
         ORDER BY epoch DESC, version DESC LIMIT 1`,
        repoId,
        threadKey,
      )
      .toArray()[0];
    return row ?? null;
  }

  /** The event that last notified an evicted thread, while its fence lasts. */
  #fence(repoId: string, conversation: string): Frontier | null {
    const row = this.sql
      .exec<{ epoch: number; version: number; event: string }>(
        `SELECT nt_epoch AS epoch, nt_version AS version, nt_event AS event FROM inbox_evictions
         WHERE repo_id = ? AND conversation = ?`,
        repoId,
        conversation,
      )
      .toArray()[0];
    return row ?? null;
  }

  /** Adds `by` to the thread counts of the streams of `rows` (one a row); an emptied one goes. */
  #count(rows: readonly { repo_id: string; subject: string }[], by: number): void {
    const streams = new Map<string, number>();
    for (const row of rows) {
      const key = JSON.stringify([row.repo_id, row.subject]);
      streams.set(key, (streams.get(key) ?? 0) + by);
    }
    for (const [key, n] of streams) {
      const [repoId, subject] = JSON.parse(key) as [string, string];
      this.sql.exec(
        `INSERT INTO inbox_streams (repo_id, subject, threads) VALUES (?1, ?2, max(?3, 0))
         ON CONFLICT (repo_id, subject) DO UPDATE SET threads = max(threads + ?3, 0)`,
        repoId,
        subject,
        n,
      );
      if (n < 0)
        this.sql.exec(
          "DELETE FROM inbox_streams WHERE repo_id = ? AND subject = ? AND threads = 0",
          repoId,
          subject,
        );
    }
  }

  /** Deletes threads `where` says (bound `bindings`), uncounting them; how many. */
  #delete(where: string, ...bindings: SqlStorageValue[]): number {
    const gone = this.sql
      .exec<{ repo_id: string; subject: string }>(
        `DELETE FROM inbox_threads WHERE ${where} RETURNING repo_id, subject`,
        ...bindings,
      )
      .toArray();
    if (gone.length > 0) this.#count(gone, -1);
    return gone.length;
  }

  /**
   * Keeps a stream within its cap: its least recently updated threads past
   * it go, each leaving the event that last notified it as its fence; the
   * stream's oldest fences past `streamFences` go.
   */
  #cap(repoId: string, subject: string): void {
    const count =
      this.sql
        .exec<{ threads: number }>(
          "SELECT threads FROM inbox_streams WHERE repo_id = ? AND subject = ?",
          repoId,
          subject,
        )
        .toArray()[0]?.threads ?? 0;
    const over = count - INBOX_POLICY.streamThreads;
    if (over <= 0) return;
    const evicted = this.sql
      .exec<{
        repo_id: string;
        conversation: string;
        subject: string;
        nt_epoch: number;
        nt_version: number;
        nt_event: string;
        updated_at: number;
      }>(
        `DELETE FROM inbox_threads WHERE id IN
           (SELECT id FROM inbox_threads INDEXED BY inbox_threads_stream
            WHERE repo_id = ? AND subject = ? ORDER BY updated_at, id LIMIT ?)
         RETURNING repo_id, conversation, subject, nt_epoch, nt_version, nt_event, updated_at`,
        repoId,
        subject,
        over,
      )
      .toArray();
    this.#count(evicted, -1);
    for (const row of evicted)
      this.sql.exec(
        `INSERT INTO inbox_evictions (repo_id, conversation, subject, nt_epoch, nt_version, nt_event,
           event_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, conversation) DO UPDATE SET nt_epoch = excluded.nt_epoch,
           nt_version = excluded.nt_version, nt_event = excluded.nt_event,
           event_at = excluded.event_at`,
        row.repo_id,
        row.conversation,
        row.subject,
        row.nt_epoch,
        row.nt_version,
        row.nt_event,
        row.updated_at,
      );
    this.sql.exec(
      `DELETE FROM inbox_evictions WHERE (repo_id, conversation) IN
         (SELECT repo_id, conversation FROM inbox_evictions INDEXED BY inbox_evictions_stream
          WHERE repo_id = ? AND subject = ? ORDER BY event_at DESC LIMIT ? OFFSET ?)`,
      repoId,
      subject,
      evicted.length,
      INBOX_POLICY.streamFences,
    );
  }

  /**
   * Marks a thread read where the feed's thread stands (only a later event
   * makes it unread again); whether there was such a thread.
   */
  markRead(id: string): boolean {
    return this.#mark(id, false);
  }

  /**
   * Marks a thread done (and read) where the feed's thread stands: only a
   * later event reopens it; whether there was such a thread.
   */
  markDone(id: string): boolean {
    return this.#mark(id, true);
  }

  #mark(id: string, done: boolean): boolean {
    const row = this.sql
      .exec<{ repo_id: string; subject: string; number: number } & Record<string, SqlStorageValue>>(
        "SELECT repo_id, subject, number, nt_epoch, nt_version, nt_event FROM inbox_threads WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!row) return false;
    // Where the thread stands: the feed's front, or the event that last notified it if newer.
    const notified: Frontier = {
      epoch: Number(row.nt_epoch),
      version: Number(row.nt_version),
      event: String(row.nt_event),
    };
    const seen = this.#front(row.repo_id, `${row.subject}/${row.number}`);
    const at = seen !== null && newer(seen, notified) ? seen : notified;
    this.sql.exec(
      `UPDATE inbox_threads SET unread = 0, last_read_at = ?1,
         rd_epoch = ?2, rd_version = ?3, rd_event = ?4
         ${done ? ", dn_epoch = ?2, dn_version = ?3, dn_event = ?4" : ""}
       WHERE id = ?5`,
      this.now(),
      at.epoch,
      at.version,
      at.event,
      id,
    );
    return true;
  }

  /**
   * Threads not done, newest first (by `updated_at`, then id) after
   * `query.after`, of the kinds and repositories asked: each kind through
   * its own index, or each listed repository's stream, merged by reading
   * each a few rows at a time. Consumes at most `query.limit` and reads
   * about `budget` rows at most, as SQLite counts them (stopping short of
   * either: a read starts only while some is left): each consumed one with
   * whether it matches `query` (a stream's read thread does not, when
   * only unread ones are asked); `ended` when nothing is left.
   */
  page(
    query: InboxQuery,
    budget: number,
  ): { threads: (InboxThread & { matches: boolean })[]; ended: boolean; read: number } {
    const bounds: string[] = [];
    const args: SqlStorageValue[] = [];
    if (query.since !== null) {
      bounds.push("updated_at > ?");
      args.push(query.since);
    }
    if (query.before !== null) {
      bounds.push("updated_at < ?");
      args.push(query.before);
    }
    type Source = {
      index: string;
      scope: string;
      scopeArgs: SqlStorageValue[];
      after: { updatedAt: number; id: string } | null;
      rows: InboxRow[];
      done: boolean;
    };
    const sources: Source[] = query.subjects.flatMap((subject) =>
      query.repoIds === null
        ? [
            {
              // An unread thread is never done (marking done reads it).
              index: query.unreadOnly ? "inbox_threads_unread" : "inbox_threads_open",
              scope: query.unreadOnly
                ? "subject = ? AND unread = 1"
                : "subject = ? AND dn_event IS NULL",
              scopeArgs: [subject],
              after: query.after,
              rows: [],
              done: false,
            },
          ]
        : query.repoIds.map((repoId) => ({
            index: "inbox_threads_open_stream",
            scope: "repo_id = ? AND subject = ? AND dn_event IS NULL",
            scopeArgs: [repoId, subject],
            after: query.after,
            rows: [],
            done: false,
          })),
    );
    // A kind's own index reads a page at once; many streams, a few rows each at a time (fewer
    // when there are so many that their first rows would take half the budget).
    const chunk =
      sources.length <= 2
        ? query.limit
        : Math.max(1, Math.min(MERGE_CHUNK, Math.floor(budget / (2 * sources.length))));
    let read = 0;
    /** Fills a source's next rows within the budget; false when the budget is spent. */
    const fill = (source: Source): boolean => {
      const n = Math.min(chunk, budget - read);
      if (n <= 0) return false;
      const cursor = source.after ? " AND (updated_at, id) < (?, ?)" : "";
      const query_ = this.sql.exec<InboxRow>(
        `SELECT id, repo_id, conversation, subject, number, title, reason, unread,
             updated_at, last_read_at, nt_epoch
           FROM inbox_threads INDEXED BY ${source.index}
           WHERE ${[source.scope, ...bounds].join(" AND ")}${cursor}
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
        ...source.scopeArgs,
        ...args,
        ...(source.after ? [source.after.updatedAt, source.after.id] : []),
        n,
      );
      const rows = query_.toArray();
      // What SQLite read, index entries and empty reads included.
      read += Math.max(query_.rowsRead, rows.length);
      source.rows.push(...rows);
      const last = rows.at(-1);
      if (last) source.after = { updatedAt: last.updated_at, id: last.id };
      if (rows.length < n) source.done = true;
      return true;
    };
    const newer = (a: InboxRow, b: InboxRow) =>
      a.updated_at > b.updated_at || (a.updated_at === b.updated_at && a.id > b.id);
    const consumed: (InboxThread & { matches: boolean })[] = [];
    while (consumed.length < query.limit) {
      let best: Source | undefined;
      for (const source of sources) {
        // A source left unfilled (the budget spent) stops the merge: its rows could come first.
        if (source.rows.length === 0 && !source.done && !fill(source))
          return { threads: consumed, ended: false, read };
        const head = source.rows[0];
        if (head && (!best || newer(head, best.rows[0] as InboxRow))) best = source;
      }
      if (!best) return { threads: consumed, ended: true, read };
      const row = best.rows.shift() as InboxRow;
      consumed.push({ ...threadOf(row), matches: !query.unreadOnly || row.unread === 1 });
    }
    return { threads: consumed, ended: false, read };
  }

  /** One thread, or undefined. */
  thread(id: string): InboxThread | undefined {
    const row = this.sql
      .exec<InboxRow>(
        `SELECT id, repo_id, conversation, subject, number, title, reason, unread, updated_at,
           last_read_at, nt_epoch FROM inbox_threads WHERE id = ?`,
        id,
      )
      .toArray()[0];
    return row ? threadOf(row) : undefined;
  }

  /**
   * The streams (repository and kind) of `subjects` holding unread threads
   * updated at or before `cutoff`, the most recently updated first, at most
   * `limit`: of `repoIds` when given, each read through its own stream's
   * index (a token's repositories never depend on others' threads); else
   * found within the newest `scan` such threads.
   */
  unreadStreams(
    cutoff: number,
    subjects: readonly SubjectKind[],
    repoIds: readonly string[] | null,
    limit: number,
    scan = 5_000,
  ): { repoId: string; subject: SubjectKind }[] {
    const found: { repoId: string; subject: SubjectKind; at: number }[] = [];
    if (repoIds !== null)
      for (const repoId of repoIds)
        for (const subject of subjects) {
          const row = this.sql
            .exec<{ at: number }>(
              `SELECT updated_at AS at FROM inbox_threads INDEXED BY inbox_threads_stream
               WHERE repo_id = ? AND subject = ? AND updated_at <= ? AND unread = 1
               ORDER BY updated_at DESC LIMIT 1`,
              repoId,
              subject,
              cutoff,
            )
            .toArray()[0];
          if (row) found.push({ repoId, subject, at: row.at });
        }
    else
      for (const subject of subjects)
        for (const row of this.sql
          .exec<{ repo_id: string; updated_at: number }>(
            `SELECT repo_id, updated_at FROM inbox_threads INDEXED BY inbox_threads_unread
             WHERE subject = ? AND unread = 1 AND updated_at <= ?
             ORDER BY updated_at DESC LIMIT ?`,
            subject,
            cutoff,
            scan,
          )
          .toArray())
          found.push({ repoId: row.repo_id, subject, at: row.updated_at });
    found.sort((a, b) => b.at - a.at);
    const streams = new Map<string, { repoId: string; subject: SubjectKind }>();
    for (const { repoId, subject } of found) {
      const key = `${repoId}\n${subject}`;
      if (!streams.has(key)) streams.set(key, { repoId, subject });
      if (streams.size >= limit) break;
    }
    return [...streams.values()];
  }

  /**
   * Marks read the unread threads of `streams` updated at or before
   * `cutoff`, at most `limit` (each where the feed's thread stands, as
   * `markRead`); how many.
   */
  markReadBefore(
    streams: readonly { repoId: string; subject: SubjectKind }[],
    cutoff: number,
    limit: number,
  ): number {
    let marked = 0;
    for (const { repoId, subject } of streams) {
      if (marked >= limit) break;
      const ids = this.sql
        .exec<{ id: string }>(
          `SELECT id FROM inbox_threads INDEXED BY inbox_threads_stream
           WHERE repo_id = ? AND subject = ? AND updated_at <= ? AND unread = 1 LIMIT ?`,
          repoId,
          subject,
          cutoff,
          limit - marked,
        )
        .toArray();
      for (const { id } of ids) if (this.#mark(id, false)) marked++;
    }
    return marked;
  }

  /**
   * Deletes threads found replaced (their number names another
   * conversation now), each only when it last notified in the repository's
   * generation it was found so in, or before.
   */
  forget(threads: readonly { id: string; epoch: number }[]): void {
    for (const { id, epoch } of threads) this.#delete("id = ? AND nt_epoch <= ?", id, epoch);
  }

  /**
   * Deletes a repository's threads updated up to `until` (call within the
   * purge's transaction): at most two streams' caps.
   */
  purge(repoId: string, until: number): void {
    this.#delete("repo_id = ? AND updated_at <= ?", repoId, until);
  }

  /**
   * Deletes the threads of a repository's number that last notified in the
   * generation the thread was found gone in, or before (a deleted issue's
   * number is never used again within it): at most `GONE_IDENTITIES` (more,
   * which only restores giving the number to new conversations make, go
   * when found gone themselves, or with retention).
   */
  forgetNumber(repoId: string, subject: string, number: number, epoch: number | null): void {
    this.#delete(
      `id IN (SELECT id FROM inbox_threads
        WHERE repo_id = ? AND subject = ? AND number = ? AND nt_epoch <= ? LIMIT ?)`,
      repoId,
      subject,
      number,
      epoch,
      GONE_IDENTITIES,
    );
  }

  /** One step of a retired feed's cleanup: up to `slice` threads, uncounted; whether any went. */
  retireStep(slice: number): boolean {
    return this.#delete("id IN (SELECT id FROM inbox_threads LIMIT ?)", slice) > 0;
  }

  /**
   * One step of retention (call within a transaction): threads not updated
   * within `retentionMs`, and fences as old, at most `slice` each (what a
   * thread has seen is the feed's, which keeps it by its own retention).
   * Returns whether more is left.
   */
  retainStep(retentionMs: number, slice: number): boolean {
    const expired = this.now() - retentionMs;
    let more = false;
    for (const subject of SUBJECTS)
      for (const unread of [0, 1])
        more ||=
          this.#delete(
            `id IN (SELECT id FROM inbox_threads INDEXED BY inbox_threads_unread
              WHERE subject = ? AND unread = ? AND updated_at < ? ORDER BY updated_at, id LIMIT ?)`,
            subject,
            unread,
            expired,
            slice,
          ) >= slice;
    const fences = this.sql
      .exec(
        `DELETE FROM inbox_evictions WHERE (repo_id, conversation) IN
           (SELECT repo_id, conversation FROM inbox_evictions WHERE event_at < ?
            ORDER BY event_at LIMIT ?)
         RETURNING 1`,
        expired,
        slice,
      )
      .toArray().length;
    return more || fences >= slice;
  }

  /** The oldest time retention will act on: a thread's or a fence's; null when there are none. */
  oldest(): number | null {
    const times = this.sql
      .exec<{ at: number | null }>(
        `SELECT min(updated_at) AS at FROM inbox_threads INDEXED BY inbox_threads_unread
         WHERE subject = 'issue' AND unread = 0
         UNION ALL SELECT min(updated_at) FROM inbox_threads INDEXED BY inbox_threads_unread
         WHERE subject = 'issue' AND unread = 1
         UNION ALL SELECT min(updated_at) FROM inbox_threads INDEXED BY inbox_threads_unread
         WHERE subject = 'pull' AND unread = 0
         UNION ALL SELECT min(updated_at) FROM inbox_threads INDEXED BY inbox_threads_unread
         WHERE subject = 'pull' AND unread = 1
         UNION ALL SELECT min(event_at) FROM inbox_evictions`,
      )
      .toArray()
      .flatMap((row) => (row.at === null ? [] : [row.at]));
    return times.length === 0 ? null : Math.min(...times);
  }
}
