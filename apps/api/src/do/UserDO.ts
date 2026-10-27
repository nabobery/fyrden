import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import type { FeedEntry } from "@fyrden/domain";
import { MigratingDO } from "./base/MigratingDO.js";
import { userSchema } from "./schema/user.js";
import {
  FEED_POLICY,
  Feed,
  type FeedAck,
  type FeedApplied,
  type FeedFilter,
  type FeedItemId,
  type FeedPurge,
  feedEpochSource,
  type GoneThread,
  MAX_GONE_THREADS,
  PURGE_REPOS,
  type SnapshotState,
  type StreamKey,
  type StreamPage,
  type StreamRead,
  type SyncKey,
  type SyncPage,
  type ThreadVersion,
} from "./user/feed.js";
import {
  type Gate,
  type InboxQuery,
  type InboxThread,
  OPEN_GATE,
  type SubjectKind,
} from "./user/inbox.js";

/** When an alarm that could not reach the directory, or a step that failed, tries again. Proposed. */
const EPOCH_RETRY_MS = 60_000;

/** Steps one alarm runs at most; more due, it is due again at once. Proposed. */
const ALARM_STEPS = 4;

/**
 * Deferred work, by kind, in the order an alarm runs what is due: a
 * retired feed's cleanup, retention, then expired cursor snapshots. Each
 * step is bounded (see `FEED_POLICY.sliceRows`) and answers when it is due
 * again.
 */
const KINDS = ["retire", "retain", "cursors"] as const;
type Kind = (typeof KINDS)[number];

/** The feed's restore generation and its principal's lifecycle (bound: the source, the principal). */
export const EPOCH_READ = `SELECT (SELECT epoch_gen FROM source_epochs WHERE source_id = ?1) AS epoch_gen,
  (SELECT lifecycle FROM principals WHERE id = ?2) AS lifecycle`;

/**
 * A principal's acknowledged preferences that keep entries from notifying
 * (bound: the principal, a JSON array of repository ids, a JSON array of
 * [repository id, conversation] pairs): the repositories it ignores, and
 * the conversations it unsubscribed from, each found by its key.
 */
export const PREFERENCE_GATE = `SELECT repo_id, NULL AS conversation FROM watch_preferences
  WHERE principal_id = ?1 AND repo_id IN (SELECT value FROM json_each(?2))
    AND level = 'ignoring'
  UNION ALL
  SELECT t.repo_id, t.conversation FROM json_each(?3) j
    -- The requested conversations drive full-key lookups (not the principal's whole set).
    CROSS JOIN thread_preferences t
  WHERE t.principal_id = ?1 AND t.repo_id = j.value ->> 0 AND t.conversation = j.value ->> 1
    AND t.state = 'unsubscribed'`;

/** Hooks into the feed's directory read. For tests. */
export const feedHooks: {
  beforeEpochRead?: () => Promise<void>;
  beforePreferenceRead?: () => Promise<void>;
} = {};

/** Refuses a purge of more repositories than one call takes (see `PURGE_REPOS`). */
function bounded(repos: number): void {
  if (repos > PURGE_REPOS)
    throw new RangeError(`at most ${PURGE_REPOS} repositories a call, not ${repos}`);
}

/** What a retired feed answers an entry: delivered, nothing changed. */
const NOTHING_APPLIED: FeedApplied = { changed: 0, notified: 0 };

/**
 * One user or agent, by its principal id: its activity feed. Whoever reads
 * a feed (the principal, or agents acting for a user) is authorized by the
 * Worker, which also checks every item's repository at read time.
 *
 * A deleted principal's feed is retired (`retire`): it holds nothing, and
 * takes no entry or purge, answering them as delivered. Every call first
 * learns, once an instance, the restore generation and the principal's
 * lifecycle from the directory, so an object restored from before its
 * retirement retires itself before doing anything.
 */
export class UserDO extends MigratingDO {
  static readonly schema = userSchema;

  #feed(): Feed {
    return new Feed(this.ctx.storage.sql, () => Date.now());
  }

  /**
   * Applies one batch of the principal's feed entries, in one transaction
   * (see `Feed.apply`), its inbox notified as the principal's acknowledged
   * preferences allow (see `#gate`; a failed read fails the call, retried
   * as any failed delivery). A watched entry past its admission window is
   * dropped, decided once the object is ready (its epoch and preferences
   * read), right before the transaction: discretionary work writes only
   * within the window it was admitted in; such entries' events are
   * answered.
   */
  async applyFeed(all: readonly FeedEntry[]): Promise<FeedApplied> {
    await this.#checkEpoch();
    const gate = await this.#gate(all);
    // No await from here to the transaction: a retirement or a window passed meanwhile counts.
    if (this.#retired()) return NOTHING_APPLIED;
    const now = Date.now();
    const late = (e: FeedEntry) => e.until !== undefined && e.until <= now;
    const entries = all.filter((e) => !late(e));
    const expired = [...new Set(all.filter(late).map((e) => e.eventKey))];
    const feed = this.#feed();
    const applied = this.ctx.storage.transactionSync(() => feed.apply(entries, gate));
    // Even with nothing shown changed: a tombstone may have been written.
    if (entries.length > 0) await this.#scheduleRetention(feed);
    return expired.length > 0 ? { ...applied, expired } : applied;
  }

  /** A page of the inbox's threads, within `budget` rows read (see `Inbox.page`); none when retired. */
  async inboxPage(
    query: InboxQuery,
    budget: number,
  ): Promise<{ threads: (InboxThread & { matches: boolean })[]; ended: boolean; read: number }> {
    await this.#checkEpoch();
    if (this.#retired()) return { threads: [], ended: true, read: 0 };
    return this.#feed().inbox.page(query, budget);
  }

  /** One inbox thread; null when there is none (or the feed is retired). */
  async inboxThread(id: string): Promise<InboxThread | null> {
    await this.#checkEpoch();
    if (this.#retired()) return null;
    return this.#feed().inbox.thread(id) ?? null;
  }

  /** Marks an inbox thread read, or done; whether there was one. */
  async markInboxThread(id: string, done: boolean): Promise<boolean> {
    await this.#checkEpoch();
    if (this.#retired()) return false;
    const inbox = this.#feed().inbox;
    return this.ctx.storage.transactionSync(() => (done ? inbox.markDone(id) : inbox.markRead(id)));
  }

  /** Streams holding unread threads up to `cutoff` (see `Inbox.unreadStreams`). */
  async inboxUnreadStreams(
    cutoff: number,
    subjects: readonly SubjectKind[],
    repoIds: readonly string[] | null,
    limit: number,
  ): Promise<{ repoId: string; subject: SubjectKind }[]> {
    await this.#checkEpoch();
    if (this.#retired()) return [];
    return this.#feed().inbox.unreadStreams(cutoff, subjects, repoIds, limit);
  }

  /** Marks read up to `limit` unread threads of `streams` up to `cutoff`; how many. */
  async markInboxReadBefore(
    streams: readonly { repoId: string; subject: SubjectKind }[],
    cutoff: number,
    limit: number,
  ): Promise<number> {
    await this.#checkEpoch();
    if (this.#retired()) return 0;
    const inbox = this.#feed().inbox;
    return this.ctx.storage.transactionSync(() => inbox.markReadBefore(streams, cutoff, limit));
  }

  /** Forgets inbox threads a read found replaced (see `Inbox.forget`); at most 100 a call. */
  async forgetInboxThreads(threads: readonly { id: string; epoch: number }[]): Promise<void> {
    if (threads.length > 100)
      throw new RangeError(`at most 100 threads a call, not ${threads.length}`);
    await this.#checkEpoch();
    if (this.#retired()) return;
    const inbox = this.#feed().inbox;
    this.ctx.storage.transactionSync(() => inbox.forget(threads));
  }

  /**
   * The principal's acknowledged preferences for what `entries` may notify
   * of, from the directory's copy (a command answers success only once its
   * copy is committed there): the repositories it ignores, and the
   * conversations it unsubscribed from. One query, and only when an entry
   * may notify (not silent, of a stamped conversation).
   */
  async #gate(entries: readonly FeedEntry[]): Promise<Gate> {
    const principalId = this.ctx.id.name;
    const candidates = entries.filter(
      (e) => !e.recipient.silent && e.feed.subject.conversation !== undefined,
    );
    if (principalId === undefined || candidates.length === 0) return OPEN_GATE;
    await feedHooks.beforePreferenceRead?.();
    const repos = [...new Set(candidates.map((e) => e.repoId))];
    const threads = [
      ...new Set(candidates.map((e) => JSON.stringify([e.repoId, e.feed.subject.conversation]))),
    ].map((key) => JSON.parse(key) as [string, string]);
    const { results } = await this.env.DIRECTORY.withSession("first-primary")
      .prepare(PREFERENCE_GATE)
      .bind(principalId, JSON.stringify(repos), JSON.stringify(threads))
      .all<{ repo_id: string; conversation: string | null }>();
    const ignored = new Set<string>();
    const unsubscribed = new Set<string>();
    for (const row of results)
      if (row.conversation === null) ignored.add(row.repo_id);
      else unsubscribed.add(`${row.repo_id}\n${row.conversation}`);
    return { ignored, unsubscribed };
  }

  /**
   * Forgets repositories the principal no longer reads (see `Feed.purge`),
   * each in a transaction of its own; at most `PURGE_REPOS` a call (an
   * older caller's larger one is refused, and retried through its
   * effect's children).
   */
  async purge(purge: FeedPurge): Promise<{ deleted: number }> {
    bounded(new Set(purge.repoIds).size);
    await this.#checkEpoch();
    if (this.#retired()) return { deleted: 0 };
    const feed = this.#feed();
    let deleted = 0;
    try {
      for (const repoId of new Set(purge.repoIds))
        deleted += this.ctx.storage.transactionSync(() =>
          feed.purge({ ...purge, repoIds: [repoId] }),
        );
    } finally {
      // Retention for what was committed, a later repository's failure notwithstanding.
      await this.#scheduleRetention(feed);
    }
    return { deleted };
  }

  /**
   * Forgets repositories a read found the principal cannot read, each as
   * the purge of what that was decided by (see `Feed.purge`), each in a
   * transaction of its own; at most `PURGE_REPOS` a call.
   */
  async forgetRepos(losses: readonly FeedPurge[]): Promise<{ deleted: number }> {
    bounded(new Set(losses.flatMap((loss) => loss.repoIds)).size);
    await this.#checkEpoch();
    if (this.#retired()) return { deleted: 0 };
    const feed = this.#feed();
    let deleted = 0;
    try {
      for (const loss of losses)
        for (const repoId of new Set(loss.repoIds))
          deleted += this.ctx.storage.transactionSync(() =>
            feed.purge({ ...loss, repoIds: [repoId] }),
          );
    } finally {
      // Retention for what was committed, a later repository's failure notwithstanding.
      await this.#scheduleRetention(feed);
    }
    return { deleted };
  }

  /**
   * Forgets threads a read found gone for good, each only as far as the
   * restore generation it was found gone in (see `Feed.forgetThreads`), in
   * one transaction.
   */
  async forgetGoneThreads(threads: readonly GoneThread[]): Promise<{ deleted: number }> {
    // Bounded (each thread at most one item a kind): a larger call is refused, never sliced.
    if (threads.length > MAX_GONE_THREADS)
      throw new RangeError(`at most ${MAX_GONE_THREADS} threads a call, not ${threads.length}`);
    await this.#checkEpoch();
    if (this.#retired()) return { deleted: 0 };
    const feed = this.#feed();
    return { deleted: this.ctx.storage.transactionSync(() => feed.forgetThreads(threads)) };
  }

  /**
   * The earlier name, for Workers of the earlier version while a deploy
   * rolls out: their threads carry no generation, so nothing is forgotten.
   */
  async forgetThreads(threads: readonly GoneThread[]): Promise<{ deleted: number }> {
    return this.forgetGoneThreads(threads);
  }

  /**
   * The reads of before streams, refused: a Worker of the earlier version
   * (while a deploy rolls out) would make cursors of one sequence from
   * the streams' numbers. Its feed reads fail until it is replaced.
   */
  async listFeed(): Promise<never> {
    throw new Error("the feed is read by streams: listStreams");
  }

  async syncFeed(): Promise<never> {
    throw new Error("the feed is read by streams: syncStreams");
  }

  /** A page of the feed after a cursor's snapshot (see `Feed.read`). */
  async listStreams(read: StreamRead, limit: number, filter: FeedFilter): Promise<StreamPage> {
    await this.#checkEpoch();
    // Retired: empty while its cleanup runs, its cursors judged as before.
    const shown = this.#retired() ? { ...filter, subjects: [] } : filter;
    return this.#feed().read(read, limit, shown);
  }

  /** A page of what needs the owner now, with the feed's head as of its first (see `Feed.sync`). */
  async syncStreams(
    after: SyncKey | null,
    limit: number,
    filter: Pick<FeedFilter, "repoIds" | "subjects">,
  ): Promise<SyncPage> {
    await this.#checkEpoch();
    return this.#feed().sync(after, limit, this.#retired() ? { subjects: [] } : filter);
  }

  /**
   * Keeps a credential's snapshot and answers its id (see
   * `Feed.saveCursor`); a retired feed keeps none (its cursors expire).
   */
  async saveCursor(credential: string, state: SnapshotState): Promise<{ id: string }> {
    return this.#keep((feed) => feed.saveCursor(credential, state));
  }

  /** Keeps the snapshot a complete sync leaves, and answers its id (see `Feed.syncCursor`). */
  async syncCursor(
    credential: string,
    streams: readonly StreamKey[],
    bound: number,
  ): Promise<{ id: string }> {
    return this.#keep((feed) => feed.syncCursor(credential, streams, bound));
  }

  /** A snapshot kept, its expiry scheduled; a retired feed keeps none (its cursors expire). */
  async #keep(save: (feed: Feed) => { id: string; created: boolean }): Promise<{ id: string }> {
    await this.#checkEpoch();
    const feed = this.#feed();
    if (this.#retired()) return { id: crypto.randomUUID().replaceAll("-", "") };
    const saved = this.ctx.storage.transactionSync(() => {
      const saved = save(feed);
      if (saved.created) this.#schedule("cursors", Date.now() + FEED_POLICY.cursorTtlMs);
      return saved;
    });
    if (saved.created) await this.#arm();
    return { id: saved.id };
  }

  async ackFeed(id: FeedItemId, at: ThreadVersion): Promise<FeedAck> {
    await this.#checkEpoch();
    if (this.#retired()) return { status: "missing" };
    const feed = this.#feed();
    return this.ctx.storage.transactionSync(() => feed.ack(id, at));
  }

  /**
   * Runs what is due, a step of each kind due in `KINDS` order before any
   * kind's second, at most `ALARM_STEPS` steps, each in its own
   * transaction with its schedule row; then sets the alarm to the earliest
   * row. A step that throws is due again a minute on, the others still run.
   */
  override async alarm(): Promise<void> {
    // Work waits for the directory (the principal may be deleted): unreachable, it is tried
    // again later rather than left to Cloudflare's few retries.
    try {
      await this.#checkEpoch();
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + EPOCH_RETRY_MS);
      return;
    }
    const feed = this.#feed();
    const steps = {
      retire: () => (feed.retireStep() ? Date.now() : null),
      retain: () => (feed.retainStep() ? Date.now() : feed.nextRetention()),
      cursors: () => (feed.expireCursorsStep() ? Date.now() : feed.nextCursorExpiry()),
    } satisfies Record<Kind, () => number | null>;
    let ran = 0;
    for (let progress = true; progress && ran < ALARM_STEPS; ) {
      progress = false;
      for (const kind of KINDS) {
        if (ran >= ALARM_STEPS || !this.#dueNow(kind)) continue;
        ran++;
        progress = true;
        try {
          this.ctx.storage.transactionSync(() => this.#setDue(kind, steps[kind]()));
        } catch (error) {
          createLogger({ op: "user.alarm", doClass: "UserDO" }).warn("a step failed", {
            kind,
            error,
          });
          this.#setDue(kind, Date.now() + EPOCH_RETRY_MS);
        }
      }
    }
    // Exactly by the schedule as the steps left it: an alarm set earlier in this run (the epoch
    // check arms one) is moved to what is due now; calls made meanwhile left their rows.
    await this.#arm(true);
  }

  /** Whether `kind`'s row is due now. */
  #dueNow(kind: Kind): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 FROM user_schedule WHERE kind = ? AND due_at <= ?", kind, Date.now())
        .toArray().length > 0
    );
  }

  /** `kind` due at `at` (null: nothing left of it). */
  #setDue(kind: Kind, at: number | null): void {
    if (at === null) this.ctx.storage.sql.exec("DELETE FROM user_schedule WHERE kind = ?", kind);
    else
      this.ctx.storage.sql.exec(
        `INSERT INTO user_schedule (kind, due_at) VALUES (?, ?)
         ON CONFLICT (kind) DO UPDATE SET due_at = excluded.due_at`,
        kind,
        at,
      );
  }

  /** `kind` due by `at`: an earlier time it is due already is kept. */
  #schedule(kind: Kind, at: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO user_schedule (kind, due_at) VALUES (?, ?)
       ON CONFLICT (kind) DO UPDATE SET due_at = min(due_at, excluded.due_at)`,
      kind,
      at,
    );
  }

  /**
   * The alarm by the earliest row (now when that is past): set when there
   * is none (as during the alarm's own run) or it is later, or whatever it
   * is when `exact` (the end of an alarm's run); deleted when nothing is
   * scheduled. Read and set with no other write between, after every
   * change.
   */
  async #arm(exact = false): Promise<void> {
    const earliest = this.ctx.storage.sql
      .exec<{ at: number | null }>("SELECT min(due_at) AS at FROM user_schedule")
      .one().at;
    if (earliest === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const at = Math.max(earliest, Date.now());
    const current = exact ? null : await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  #epochChecked = false;
  #epochCheck: Promise<void> | undefined;

  /**
   * Takes the directory's restore generation for this feed once an
   * instance, before it reads or makes a cursor: a restored object (its
   * storage, epoch included, as it was) gets a newer one from the restore,
   * so cursors made since then expire instead of skipping changes.
   */
  #checkEpoch(): Promise<void> {
    if (this.#epochChecked) return Promise.resolve();
    this.#epochCheck ??= this.#takeEpoch().finally(() => {
      this.#epochCheck = undefined;
    });
    return this.#epochCheck;
  }

  async #takeEpoch(): Promise<void> {
    const principalId = this.ctx.id.name;
    if (principalId !== undefined) {
      await feedHooks.beforeEpochRead?.();
      const row = await this.env.DIRECTORY.withSession("first-primary")
        .prepare(EPOCH_READ)
        .bind(feedEpochSource(principalId), principalId)
        .first<{ epoch_gen: number | null; lifecycle: string | null }>();
      if (row?.epoch_gen) this.#feed().takeEpoch(row.epoch_gen);
      // Being deleted, or deleted: an object restored from before its retirement retires again.
      if (row?.lifecycle === "deleting" || row?.lifecycle === "deleted") await this.#retireNow();
    }
    // Once an instance: the alarm by the schedule (an object migrated with work to do, whose
    // earlier alarm Cloudflare gave up retrying, is woken again).
    await this.#arm();
    this.#epochChecked = true;
  }

  /**
   * Retires the feed of a principal being deleted: from then on it takes
   * nothing and reads as empty, and its items, purge marks and evictions
   * are deleted a step at a time from its alarm (other deferred work
   * dropped). Again, it changes nothing (an unfinished cleanup goes on).
   */
  async retire(): Promise<void> {
    await this.#checkEpoch();
    await this.#retireNow();
  }

  async #retireNow(): Promise<void> {
    if (!this.#retired())
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO feed_retired (id, at) VALUES (1, ?) ON CONFLICT DO NOTHING",
          Date.now(),
        );
        this.ctx.storage.sql.exec("DELETE FROM user_schedule WHERE kind <> 'retire'");
        this.#schedule("retire", Date.now());
      });
    await this.#arm();
  }

  /** Whether the feed was retired (read with no await before the write it guards). */
  #retired(): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM feed_retired").toArray().length > 0;
  }

  /** Retention due by the time it is next needed; an earlier time is kept. */
  async #scheduleRetention(feed: Feed): Promise<void> {
    const at = feed.nextRetention();
    if (at === null) return;
    this.#schedule("retain", at);
    await this.#arm();
  }
}
