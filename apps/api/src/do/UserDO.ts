import { createLogger, createMetrics } from "@fyrden/adapters-cloudflare/obs";
import type { FeedEntry } from "@fyrden/domain";
import {
  type Candidate,
  eligibleCategories,
  forgetQueuedConversations,
  forgetQueuedGone,
  logSendFailure,
  NOTIFICATION_POLICY,
  type NotificationCategory,
  nextDue,
  notificationsOn,
  queueCandidates,
  sendCandidate,
  sendsPerAlarm,
  type Turn,
} from "../email/notifications.js";
import { FreshAccess } from "../feed/access.js";
import { isLiveVector, livePlanError, validateLiveCoverage } from "../live/budget.js";
import { liveCredential } from "../live/credential.js";
import { confirm, release } from "../live/directory.js";
import { beginLiveDuration, finishLiveDuration } from "../live/duration.js";
import {
  LIVE_RECOVERY_DURATION,
  type LiveRecoveryReply,
  type LiveRecoveryRequest,
} from "../live/recovery.js";
import { randomSecret } from "../oauth/params.js";
import { allowedWithRole, findReposById } from "../repos/directory.js";
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
  parseThreadId,
  type SubjectKind,
} from "./user/inbox.js";
import {
  CLOSE_EXPIRED,
  CLOSE_RESYNC,
  CLOSE_REVOKED,
  type DirtyStream,
  LIVE_POLICY,
  Live,
  type Candidate as LiveCandidate,
  type LiveSignal,
  type LiveSocket,
  ticketHash,
} from "./user/live.js";
import { LiveBudget } from "./user/live-budget.js";

/** The header the Worker hands an admitted live socket's upgrade over in (internal). */
export const LIVE_ADMITTED = "X-Fyrden-Live-Admitted";

/** What the Worker admitted: the socket, its credential and its dependencies. */
export interface LiveAdmitted {
  readonly socketId: string;
  readonly credentialId: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly repoIds: readonly string[] | null;
  readonly dependencies: readonly string[];
}

/** Credentials a pump run serves at most (the rest wait). */
const PUMP_CREDENTIALS = 4;

/** How long an admission may take to be confirmed before its local state is forgotten. */
const LIVE_CONFIRM_MS = 60_000;

/** How long sockets whose run could not be done (an answer missing) wait to try again. */
const LIVE_RETRY_MS = 60_000;

/** A socket's id, from its attachment. */
function socketIdOf(ws: WebSocket): string | undefined {
  const attached = ws.deserializeAttachment() as { v?: number; id?: unknown } | null;
  return attached?.v === 1 && typeof attached.id === "string" ? attached.id : undefined;
}

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
/**
 * The alarm's kinds: the steps above, notification email (sent after them, see `#sendEmails`)
 * and live sockets' pump (`#pump`).
 */
type Kind = (typeof KINDS)[number] | "email" | "live";

/**
 * The feed's restore generation, its principal's lifecycle and the live
 * ledger's incarnation (bound: the source, the principal).
 */
export const EPOCH_READ = `SELECT (SELECT epoch_gen FROM source_epochs WHERE source_id = ?1) AS epoch_gen,
  (SELECT lifecycle FROM principals WHERE id = ?2) AS lifecycle,
  (SELECT incarnation FROM live_budget_state WHERE id = 1) AS live_incarnation`;

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
  /** Whether a live authorization is outstanding (its owner arrives with the budgets' wiring). */
  liveOwnerPending?: () => boolean;
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
    const emailing = await this.#emailing(all);
    // No await from here to the transaction: a retirement or a window passed meanwhile counts.
    if (this.#retired()) return NOTHING_APPLIED;
    const now = Date.now();
    const late = (e: FeedEntry) => e.until !== undefined && e.until <= now;
    const entries = all.filter((e) => !late(e));
    const expired = [...new Set(all.filter(late).map((e) => e.eventKey))];
    const feed = this.#feed();
    const live = this.#live();
    const { applied, queued, signalled } = this.ctx.storage.transactionSync(() => {
      const { signals, ...applied } = feed.apply(entries, gate);
      // Live sockets hear of the streams changed, when the feed has any.
      const signalled = live.counts("").feed > 0 && live.mark(signals);
      // The email an entry carries, whatever the inbox made of it, but not for a purged repository.
      const mailable = entries.filter(
        (e) => e.recipient.email && e.occurredAt > (feed.purgedThrough(e.repoId) ?? -1),
      );
      const queued =
        emailing.size > 0 ? queueCandidates(this.ctx.storage.sql, mailable, emailing, now) : 0;
      return { applied, queued, signalled };
    });
    // Even with nothing shown changed: a tombstone may have been written.
    if (entries.length > 0) await this.#scheduleRetention(feed);
    if (queued > 0) await this.#scheduleEmail();
    if (signalled) await this.#scheduleLive();
    const unapplied = [...new Set([...expired, ...(applied.expired ?? [])])];
    return unapplied.length > 0 ? { ...applied, expired: unapplied } : applied;
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
    const thread = inbox.thread(id);
    const marked = this.ctx.storage.transactionSync(() => {
      const marked = done ? inbox.markDone(id) : inbox.markRead(id);
      if (marked && thread) this.#explicit([{ repoId: thread.repoId, subject: thread.subject }]);
      return marked;
    });
    if (marked) await this.#scheduleLive();
    return marked;
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
    const marked = this.ctx.storage.transactionSync(() => {
      const marked = inbox.markReadBefore(streams, cutoff, limit);
      if (marked > 0) this.#explicit(streams);
      return marked;
    });
    if (marked > 0) await this.#scheduleLive();
    return marked;
  }

  /** Forgets inbox threads a read found replaced (see `Inbox.forget`); at most 100 a call. */
  async forgetInboxThreads(threads: readonly { id: string; epoch: number }[]): Promise<void> {
    if (threads.length > 100)
      throw new RangeError(`at most 100 threads a call, not ${threads.length}`);
    await this.#checkEpoch();
    if (this.#retired()) return;
    const inbox = this.#feed().inbox;
    const conversations = threads.flatMap(({ id, epoch }) => {
      const parsed = parseThreadId(id);
      return parsed ? [{ ...parsed, epoch }] : [];
    });
    this.ctx.storage.transactionSync(() => {
      forgetQueuedConversations(this.ctx.storage.sql, conversations);
      inbox.forget(threads);
    });
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
    return this.#preferences(principalId, repos, threads);
  }

  /** The principal's acknowledged preferences for `repos` and `threads` (one query). */
  async #preferences(
    principalId: string,
    repos: readonly string[],
    threads: readonly (readonly [string, string])[],
  ): Promise<Gate> {
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
   * The email categories the principal gets now, when an entry carries an
   * email and the deployment sends notification email (one directory
   * read); none otherwise.
   */
  async #emailing(entries: readonly FeedEntry[]): Promise<ReadonlySet<NotificationCategory>> {
    const principalId = this.ctx.id.name;
    if (principalId === undefined || !entries.some((e) => e.recipient.email)) return new Set();
    if (!notificationsOn(this.env)) return new Set();
    return eligibleCategories(this.env, principalId);
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
    return {
      deleted: this.ctx.storage.transactionSync(() => {
        forgetQueuedGone(this.ctx.storage.sql, threads);
        return feed.forgetThreads(threads);
      }),
    };
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
    const subject = /^(issue|pull)[/-]/.exec(id.threadKey)?.[1] as SubjectKind | undefined;
    const acked = this.ctx.storage.transactionSync(() => {
      const acked = feed.ack(id, at);
      if (acked.status === "acked" && subject) this.#explicit([{ repoId: id.repoId, subject }]);
      return acked;
    });
    if (acked.status === "acked" && subject) await this.#scheduleLive();
    return acked;
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
      retire: () => (feed.retireStep() || this.#live().clearStep() ? Date.now() : null),
      retain: () => (feed.retainStep() ? Date.now() : feed.nextRetention()),
      cursors: () => (feed.expireCursorsStep() ? Date.now() : feed.nextCursorExpiry()),
    } satisfies Record<(typeof KINDS)[number], () => number | null>;
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
    if (this.#dueNow("email") && !this.#retired()) await this.#sendEmails();
    // A retired feed has no live work: a row left by a run racing the retirement goes.
    if (this.#dueNow("live") && this.#retired()) this.#setDue("live", null);
    if (this.#dueNow("live") && !this.#retired()) {
      let more = false;
      try {
        more = await this.#pump();
      } catch (error) {
        createLogger({ op: "user.alarm", doClass: "UserDO" }).warn("the live pump failed", {
          error,
        });
        // Not again at once: its open sockets try again a minute on.
        this.#retryLater(
          this.#live()
            .sockets()
            .filter((s) => s.phase === "open"),
        );
      }
      // Retired while the run awaited: nothing more is due.
      this.#setDue(
        "live",
        this.#retired()
          ? null
          : more
            ? Date.now()
            : this.#live().nextDue(Date.now(), LIVE_CONFIRM_MS),
      );
    }
    // Exactly by the schedule as the steps left it: an alarm set earlier in this run (the epoch
    // check arms one) is moved to what is due now; calls made meanwhile left their rows.
    await this.#arm(true);
  }

  /**
   * Sends the notification emails due (see `sendCandidate`), a few a run,
   * one at a time; each candidate's row then goes, or is due again. Rows
   * read again after each send's awaits: a purge or retirement meanwhile
   * stands.
   */
  async #sendEmails(): Promise<void> {
    const principalId = this.ctx.id.name;
    if (principalId === undefined) return;
    const sql = this.ctx.storage.sql;
    const due = sql
      .exec<{ event_key: string }>(
        "SELECT event_key FROM email_queue WHERE due_at <= ? ORDER BY due_at, arrival LIMIT ?",
        Date.now(),
        sendsPerAlarm(this.env),
      )
      .toArray();
    const metrics = createMetrics(this.env.METRICS);
    // A row as it is now: a purge, a forgetting or the retirement during an earlier send stands.
    const queued = (key: string) =>
      this.#retired()
        ? undefined
        : (sql.exec("SELECT * FROM email_queue WHERE event_key = ?", key).toArray()[0] as unknown as
            | Candidate
            | undefined);
    for (const { event_key } of due) {
      const candidate = queued(event_key);
      if (!candidate) continue;
      let turn: Turn;
      try {
        turn = await sendCandidate(this.env, principalId, candidate, metrics, () =>
          Boolean(queued(event_key)),
        );
      } catch (error) {
        logSendFailure(error);
        turn = {
          done: false,
          due: Date.now() + NOTIFICATION_POLICY.backoffMs * 2 ** candidate.tries,
          tried: true,
        };
      }
      this.ctx.storage.transactionSync(() => {
        if (turn.done || (turn.tried && candidate.tries + 1 >= NOTIFICATION_POLICY.maxAttempts))
          sql.exec("DELETE FROM email_queue WHERE event_key = ?", candidate.event_key);
        else
          sql.exec(
            "UPDATE email_queue SET due_at = ?, tries = tries + ? WHERE event_key = ?",
            turn.due,
            turn.tried ? 1 : 0,
            candidate.event_key,
          );
      });
    }
    this.#setDue("email", nextDue(sql));
  }

  #live(): Live {
    return new Live(this.ctx.storage.sql);
  }

  /** Marks the principal's own changes to streams (other sockets refresh them). */
  #explicit(streams: readonly { repoId: string; subject: SubjectKind }[]): void {
    const live = this.#live();
    if (live.counts("").feed === 0) return;
    live.mark(
      streams.map((s): LiveSignal => ({ repoId: s.repoId, subject: s.subject, explicit: true })),
    );
  }

  /** The `live` kind due by what the pump has to do next. */
  async #scheduleLive(): Promise<void> {
    const at = this.#live().nextDue(Date.now(), LIVE_CONFIRM_MS);
    if (at === null) return;
    this.#schedule("live", at);
    await this.#arm();
  }

  /**
   * A ticket for one live socket of `credentialId` (single use, for
   * `LIVE_POLICY.ticketMs`); null for a retired feed.
   */
  async liveTicket(credentialId: string): Promise<string | null> {
    await this.#checkEpoch();
    if (this.#retired()) return null;
    const ticket = randomSecret(32);
    const hash = await ticketHash(ticket);
    const now = Date.now();
    const live = this.#live();
    this.ctx.storage.transactionSync(() => {
      live.prune(now);
      live.storeTicket(hash, credentialId, now + LIVE_POLICY.ticketMs);
    });
    return ticket;
  }

  /** Redeems a ticket once, for the credential it was issued to; whether it held. */
  async liveRedeem(ticket: string, credentialId: string): Promise<boolean> {
    await this.#checkEpoch();
    if (this.#retired()) return false;
    const hash = await ticketHash(ticket);
    const live = this.#live();
    return this.ctx.storage.transactionSync(() =>
      live.redeemTicket(hash, credentialId, Date.now()),
    );
  }

  /**
   * An admitted live socket's upgrade, handed over by the Worker (the
   * object is reached only through it): confirmed in the directory before
   * anything is exposed, fenced against retirement and revocation after
   * every await; refused, its lease is released.
   */
  override async fetch(request: Request): Promise<Response> {
    const admitted = JSON.parse(
      request.headers.get(LIVE_ADMITTED) ?? "null",
    ) as LiveAdmitted | null;
    if (request.headers.get("Upgrade") !== "websocket" || !admitted)
      return new Response(null, { status: 400 });
    await this.#checkEpoch();
    const live = this.#live();
    const refuse = async (status: number) => {
      this.ctx.storage.transactionSync(() => live.forget(admitted.socketId));
      await release(this.env.DIRECTORY, [admitted.socketId]);
      return new Response(null, { status });
    };
    if (this.#retired() || live.anyRevoked(admitted.dependencies)) return refuse(410);
    const held = live.counts(admitted.credentialId);
    if (held.feed >= LIVE_POLICY.perFeed || held.credential >= LIVE_POLICY.perCredential)
      return refuse(429);
    this.ctx.storage.transactionSync(() =>
      live.addSocket(
        {
          id: admitted.socketId,
          credentialId: admitted.credentialId,
          expiresAt: admitted.expiresAt,
          scopes: admitted.scopes,
          repoIds: admitted.repoIds,
        },
        admitted.dependencies,
        Date.now(),
      ),
    );
    // Its recovery is due before anything is awaited: an object stopped mid-confirmation forgets it.
    this.#schedule("live", Date.now() + LIVE_CONFIRM_MS);
    await this.#arm();
    const confirmed = await confirm(this.env.DIRECTORY, admitted.socketId, Date.now()).catch(
      () => false,
    );
    // Retired, revoked or forgotten while it was confirmed: nothing is exposed.
    if (
      !confirmed ||
      this.#retired() ||
      live.anyRevoked(admitted.dependencies) ||
      !live.socket(admitted.socketId)
    )
      return refuse(409);
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [admitted.socketId]);
    server.serializeAttachment({ v: 1, id: admitted.socketId });
    this.ctx.storage.transactionSync(() => live.open(admitted.socketId));
    await this.#scheduleLive();
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * A socket's control message: an acknowledgement (`{"t":"ack","n":…}`)
   * or a renewal (`{"t":"renew"}`), at most 1 KiB, 20 a minute and 200 in
   * its life; anything else, or past a bound, closes it.
   */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // A restored object takes its epoch first; unread, nothing is applied.
    if (!(await this.#epochTaken())) return;
    const id = socketIdOf(ws);
    const live = this.#live();
    const socket = id === undefined ? undefined : live.socket(id);
    if (id === undefined || !socket || socket.phase !== "open") {
      ws.close(CLOSE_EXPIRED, "unknown socket");
      return;
    }
    // State from before a restore (or another ledger incarnation): nothing it says is applied.
    if (live.stale(id))
      return this.#closeSocket(id, CLOSE_RESYNC, "restored: reread and reconnect");
    const now = Date.now();
    // Past its deadline or its life: closed, whatever it says.
    if (socket.deadline <= now || socket.expires_at <= now)
      return this.#closeSocket(id, CLOSE_EXPIRED, "expired: reconnect with a new ticket");
    const fresh = now - socket.minute_start >= 60_000;
    const minute = fresh ? 1 : socket.minute_count + 1;
    const used = socket.controls_used + 1;
    const size =
      typeof message === "string" ? new TextEncoder().encode(message).length : message.byteLength;
    if (
      typeof message !== "string" ||
      size > LIVE_POLICY.controlBytes ||
      minute > LIVE_POLICY.controlsPerMinute ||
      used > LIVE_POLICY.controlsLife
    )
      return this.#closeSocket(id, 1008, "control message refused");
    this.ctx.storage.transactionSync(() =>
      live.update(id, {
        controls_used: used,
        minute_count: minute,
        ...(fresh && { minute_start: now }),
      }),
    );
    let control: unknown;
    try {
      control = JSON.parse(message);
    } catch {
      return this.#closeSocket(id, 1008, "control message refused");
    }
    if (typeof control !== "object" || control === null || Array.isArray(control))
      return this.#closeSocket(id, 1008, "control message refused");
    const keys = Object.keys(control);
    const { t, n } = control as { t?: unknown; n?: unknown };
    if (t === "ack" && keys.length === 2 && Number.isSafeInteger(n)) {
      const counter = n as number;
      // Acknowledging what was not sent, or again: nothing.
      if (counter <= socket.acked || counter > socket.sent) return;
      this.ctx.storage.transactionSync(() =>
        live.update(id, {
          acked: counter,
          ...(socket.sent - counter < LIVE_POLICY.window && { blocked_since: null }),
        }),
      );
      await this.#scheduleLive();
      return;
    }
    if (t === "renew" && keys.length === 1) return this.#renew(id, socket, now);
    return this.#closeSocket(id, 1008, "control message refused");
  }

  /** A renewal: its credential checked again, its deadline moved (never past its expiry). */
  async #renew(id: string, socket: LiveSocket, now: number): Promise<void> {
    // Earlier than half its deadline: nothing.
    if (now < socket.deadline - LIVE_POLICY.renewMs / 2) return;
    const live = this.#live();
    let credential: Awaited<ReturnType<typeof liveCredential>> | undefined;
    try {
      credential = await liveCredential(this.env.DIRECTORY, socket.credential_id, now);
    } catch {
      credential = undefined;
    }
    const current = live.socket(id);
    if (!current) return;
    // Restored (or another ledger incarnation) while the credential was checked: not renewed.
    if (live.stale(id))
      return this.#closeSocket(id, CLOSE_RESYNC, "restored: reread and reconnect");
    // Its deadline or life passed while the credential was checked: closed, not renewed.
    if (current.deadline <= Date.now() || current.expires_at <= Date.now())
      return this.#closeSocket(id, CLOSE_EXPIRED, "expired: reconnect with a new ticket");
    // Revoked, expired or disabled: closed; unanswered twice: closed.
    if (
      credential === null ||
      live.anyRevoked(live.depsOf(id)) ||
      (credential !== undefined && !sameDeps(credential.dependencies, live.depsOf(id)))
    )
      return this.#closeSocket(id, CLOSE_EXPIRED, "the credential no longer holds");
    if (credential === undefined) {
      if (current.renew_failures + 1 >= 2)
        return this.#closeSocket(id, CLOSE_EXPIRED, "the credential could not be checked");
      this.ctx.storage.transactionSync(() =>
        live.update(id, { renew_failures: current.renew_failures + 1 }),
      );
      return;
    }
    const deadline = Math.min(now + LIVE_POLICY.renewMs, current.expires_at);
    this.ctx.storage.transactionSync(() => live.update(id, { deadline, renew_failures: 0 }));
    for (const ws of this.ctx.getWebSockets(id))
      ws.send(JSON.stringify({ t: "renewed", until: deadline }));
    await this.#scheduleLive();
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.#socketGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.#socketGone(ws);
  }

  /**
   * A socket closed or failed: forgotten and its lease released, once the
   * object took its epoch. One already forgotten (recovery deleted it
   * before closing it) wakes nothing: no bootstrap, no alarm.
   */
  async #socketGone(ws: WebSocket): Promise<void> {
    const id = socketIdOf(ws);
    if (id === undefined || !this.#live().socket(id)) return;
    if (!(await this.#epochTaken())) return;
    await this.#forgetSocket(id);
  }

  /** Whether the object took its epoch (false when the directory could not be read). */
  #epochTaken(): Promise<boolean> {
    return this.#checkEpoch().then(
      () => true,
      () => false,
    );
  }

  /** Closes a socket, forgets it and releases its lease. */
  async #closeSocket(id: string, code: number, reason: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(id)) ws.close(code, reason);
    await this.#forgetSocket(id);
  }

  /** Forgets a socket and releases its lease; one already forgotten (by recovery) is left to the reaper. */
  async #forgetSocket(id: string): Promise<void> {
    const live = this.#live();
    if (!live.socket(id)) return;
    this.ctx.storage.transactionSync(() => live.forget(id));
    await release(this.env.DIRECTORY, [id]);
  }

  /**
   * Dependencies revoked (told by the directory's sweep): recorded, so no
   * socket resting on one is admitted or renewed, and every open one
   * resting on one closed; in any order, any number of times.
   */
  async revoked(dependencies: readonly string[]): Promise<void> {
    await this.#checkEpoch();
    const live = this.#live();
    const ids = this.ctx.storage.transactionSync(() => live.revoke(dependencies, Date.now()));
    for (const id of ids)
      for (const ws of this.ctx.getWebSockets(id)) ws.close(CLOSE_REVOKED, "revoked");
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) live.forget(id);
    });
    await release(this.env.DIRECTORY, ids);
  }

  /**
   * One pump run: forgets admissions never confirmed and closes expired and
   * slow sockets; then reads a page of the streams changed (`dirtyPage`)
   * and, for each credential (at most `PUMP_CREDENTIALS` a run, the
   * furthest behind first), checks it again on the directory's primary (no
   * longer holding: its sockets close) and decides afresh, through one
   * owning account's bounded check, the page's repositories of that account
   * that its token may name; then sends each of its open sockets with room
   * in its window one frame naming the streams it may read now with a
   * cause its current preferences let through. A stream whose repository's
   * answer is not known is passed over; one past the page, or of another
   * account, waits for the next run (the socket's progress stops before
   * it). Then prunes a page of what every socket heard of; whether more is
   * left.
   */
  async #pump(): Promise<boolean> {
    const principalId = this.ctx.id.name;
    if (principalId === undefined) return false;
    const live = this.#live();
    const now = Date.now();
    for (const s of live.sockets()) {
      if (s.phase === "confirming") {
        // A confirmation that never finished (the object restarted meanwhile).
        if (s.minute_start <= now - LIVE_CONFIRM_MS) await this.#forgetSocket(s.socket_id);
      } else if (s.expires_at <= now || s.deadline <= now)
        await this.#closeSocket(s.socket_id, CLOSE_EXPIRED, "expired: renew in time or reconnect");
      else if (s.blocked_since !== null && now - s.blocked_since >= LIVE_POLICY.slowMs)
        await this.#closeSocket(s.socket_id, CLOSE_RESYNC, "slow consumer: reread everything");
    }
    const upTo = live.seq();
    const open = live.sockets().filter((s) => s.phase === "open");
    // A full window waits for acknowledgements (and starts the slow-consumer clock once).
    for (const s of open)
      if (s.sent - s.acked >= LIVE_POLICY.window && s.blocked_since === null)
        this.ctx.storage.transactionSync(() =>
          live.update(s.socket_id, { blocked_since: now, refresh_pending: 1 }),
        );
    // Sockets that can take a frame now, by credential, the furthest behind first.
    const ready = open.filter((s) => s.sent - s.acked < LIVE_POLICY.window && s.retry_at <= now);
    const byCredential = new Map<string, LiveSocket[]>();
    for (const s of [...ready].sort((a, b) => a.delivered_seq - b.delivered_seq))
      byCredential.set(s.credential_id, [...(byCredential.get(s.credential_id) ?? []), s]);
    const serving = [...byCredential].slice(0, PUMP_CREDENTIALS);
    if (serving.length === 0) return this.ctx.storage.transactionSync(() => live.prune(Date.now()));
    const lowest = Math.min(
      ...serving.flatMap(([, sockets]) => sockets.map((s) => s.delivered_seq)),
    );
    // A page of what changed: every socket's progress stops at its end (the rest is due next).
    const { streams: dirty, reach: pageReach } = live.dirtyAfter(lowest, upTo);
    const candidates = new Map(
      dirty.map((d) => [d.stream, live.candidatesAfter(d.stream, lowest)]),
    );
    // The principal's current preferences for what changed (one read); unanswered, the served
    // sockets try again a minute on.
    const repos = [...new Set(dirty.map((d) => d.repo_id))];
    const threads = [...candidates.values()]
      .flat()
      .map((c) => [c.stream.split("\n")[0] as string, c.conversation] as const);
    let gate: Gate = OPEN_GATE;
    if (dirty.length > 0)
      try {
        gate = await this.#preferences(principalId, repos, threads);
      } catch {
        this.#retryLater(serving.flatMap(([, sockets]) => sockets));
        return false;
      }
    const metrics = createMetrics(this.env.METRICS);
    for (const [credentialId, waiting] of serving) {
      const holding = await liveCredential(this.env.DIRECTORY, credentialId, Date.now()).catch(
        () => undefined,
      );
      // Not answered: its sockets try again a minute on.
      if (holding === undefined) {
        this.#retryLater(waiting);
        continue;
      }
      // No longer holding: every socket of it closes; a socket of another authority (an
      // ended lifecycle generation) closes alone.
      const closing =
        holding === null
          ? live.sockets().filter((s) => s.credential_id === credentialId)
          : waiting.filter((s) => !sameDeps(holding.dependencies, live.depsOf(s.socket_id)));
      for (const s of closing)
        await this.#closeSocket(s.socket_id, CLOSE_EXPIRED, "the credential no longer holds");
      const sockets = waiting.filter((s) => !closing.some((c) => c.socket_id === s.socket_id));
      if (sockets.length === 0) continue;
      // Decided afresh, one owning account a unit (that of the earliest stream its sockets have
      // not heard of): the page's repositories of it that its token may name. A stream of
      // another account's repository stops the sockets' progress; the next run takes it.
      const from = Math.min(...sockets.map((s) => s.delivered_seq));
      const named = [
        ...new Set(
          dirty
            .filter((d) => d.seq > from && mayName(sockets[0] as LiveSocket, d.repo_id))
            .map((d) => d.repo_id),
        ),
      ];
      let entries: Awaited<ReturnType<typeof findReposById>>;
      try {
        entries = await findReposById(this.env, named, metrics);
      } catch {
        // Not known which account holds what: tried again a minute on.
        this.#retryLater(sockets);
        continue;
      }
      const ownerOf = new Map(entries.map((e) => [e.id, e.ownerId]));
      const account = ownerOf.get(
        dirty.find((d) => d.seq > from && ownerOf.has(d.repo_id))?.repo_id ?? "",
      );
      const readable = new Map<string, boolean>();
      if (account !== undefined) {
        const deciding = entries.filter((e) => e.ownerId === account);
        const answers = await new FreshAccess({ env: this.env, metrics }, {
          principalId,
          grantId: null,
        } as never).decide(deciding, { live: true });
        for (const entry of deciding) {
          const answer = answers.get(entry.id);
          // Gone: unreadable. Not known: passed over.
          if (answer === "unknown") continue;
          readable.set(entry.id, answer !== undefined && answer.held && answer.role !== null);
        }
      }
      const stop = dirty.find(
        (d) => d.seq > from && ownerOf.has(d.repo_id) && ownerOf.get(d.repo_id) !== account,
      )?.seq;
      const reach = stop === undefined ? pageReach : Math.min(pageReach, stop - 1);
      for (const s of sockets) {
        const sent = this.#send(live, s, dirty, reach, readable, candidates, gate, Date.now());
        if (sent === "expired")
          await this.#closeSocket(
            s.socket_id,
            CLOSE_EXPIRED,
            "expired: renew in time or reconnect",
          );
      }
    }
    // What a run's bounds left is due at once (the alarm sets it by `Live.nextDue`).
    return this.ctx.storage.transactionSync(() => live.prune(Date.now()));
  }

  /** Sockets whose run could not be done (an answer missing): tried again a minute on. */
  #retryLater(sockets: readonly LiveSocket[]): void {
    const live = this.#live();
    const at = Date.now() + LIVE_RETRY_MS;
    this.ctx.storage.transactionSync(() => {
      for (const s of sockets) live.update(s.socket_id, { retry_at: at });
    });
  }

  /** One socket's frame for a pump run (see `#pump`), its progress moved to `reach`. */
  #send(
    live: Live,
    s: LiveSocket,
    dirty: readonly DirtyStream[],
    reach: number,
    readable: ReadonlyMap<string, boolean>,
    candidates: ReadonlyMap<string, readonly LiveCandidate[]>,
    gate: Gate,
    now: number,
  ): "expired" | undefined {
    const current = live.socket(s.socket_id);
    if (!current || current.phase !== "open") return;
    // Its deadline or life passed while the run was authorizing: nothing more is sent.
    if (current.deadline <= now || current.expires_at <= now) return "expired";
    if (current.sent - current.acked >= LIVE_POLICY.window) return;
    const streams = dirty.filter(
      (d) =>
        d.seq > current.delivered_seq &&
        d.seq <= reach &&
        mayName(current, d.repo_id) &&
        mayRead(current, d.subject) &&
        readable.get(d.repo_id) === true &&
        causes(d, current.delivered_seq, candidates.get(d.stream) ?? [], gate),
    );
    const frame =
      streams.length === 0
        ? null
        : streams.length > LIVE_POLICY.streamsPerFrame
          ? { t: "changed", n: current.sent + 1, refresh: true }
          : {
              t: "changed",
              n: current.sent + 1,
              streams: streams.map((d) => ({ repo: d.repo_id, kind: d.subject })),
            };
    if (frame) for (const ws of this.ctx.getWebSockets(s.socket_id)) ws.send(JSON.stringify(frame));
    this.ctx.storage.transactionSync(() =>
      live.update(s.socket_id, {
        delivered_seq: Math.max(current.delivered_seq, reach),
        ...(frame && { sent: current.sent + 1, refresh_pending: 0 }),
        // The send that fills the window starts the slow-consumer clock.
        ...(frame &&
          current.sent + 1 - current.acked >= LIVE_POLICY.window && { blocked_since: now }),
      }),
    );
  }

  /** The `email` kind due by the queue's earliest. */
  async #scheduleEmail(): Promise<void> {
    const at = nextDue(this.ctx.storage.sql);
    if (at === null) return;
    this.#schedule("email", at);
    await this.#arm();
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
  /** Sets the alarm by the schedule (`liveToo` false: by every kind but live). */
  async #arm(exact = false, liveToo = true): Promise<void> {
    const earliest = this.ctx.storage.sql
      .exec<{ at: number | null }>(
        `SELECT min(due_at) AS at FROM user_schedule${liveToo ? "" : " WHERE kind <> 'live'"}`,
      )
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
        .first<{
          epoch_gen: number | null;
          lifecycle: string | null;
          live_incarnation: string | null;
        }>();
      this.#applyEpoch(row?.epoch_gen ?? null, row?.live_incarnation ?? null);
      // Being deleted, or deleted: an object restored from before its retirement retires again.
      if (row?.lifecycle === "deleting" || row?.lifecycle === "deleted") await this.#retireNow();
    }
    // Once an instance: the alarm by the schedule (an object migrated with work to do, whose
    // earlier alarm Cloudflare gave up retrying, is woken again).
    await this.#arm();
    this.#epochChecked = true;
  }

  /**
   * The directory's epoch and ledger incarnation, applied together: the
   * feed's epoch (only forward) and the live fence it moves, in one
   * transaction, so restored credit is invalid exactly when restored
   * cursors are.
   */
  #applyEpoch(epochGen: number | null, liveIncarnation: string | null): void {
    this.ctx.storage.transactionSync(() => {
      const feed = this.#feed();
      if (epochGen) feed.takeEpoch(epochGen);
      const epoch =
        this.ctx.storage.sql
          .exec<{ epoch_gen: number }>("SELECT epoch_gen FROM feed_meta WHERE id = 1")
          .toArray()[0]?.epoch_gen ?? 0;
      if (liveIncarnation !== null)
        new LiveBudget(this.ctx.storage.sql).takeEpoch(epoch, liveIncarnation);
    });
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
        this.ctx.storage.sql.exec("DELETE FROM email_queue");
        this.#schedule("retire", Date.now());
      });
    // Live sockets go with it: closed, their leases released, their state forgotten (sockets at
    // once, at most a feed's; the rest a page a step of the retirement).
    const live = this.#live();
    const sockets = live.sockets().map((s) => s.socket_id);
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_REVOKED, "retired");
    this.ctx.storage.transactionSync(() => {
      for (const id of sockets) live.forget(id);
    });
    await release(this.env.DIRECTORY, sockets);
    await this.#arm();
  }

  /**
   * Recovers live state granted through `request.throughSeq`, paid for by
   * the cleanup grant it carries (checked before anything else, its
   * duration guarded from before the first await): the epoch fence taken
   * from the directory's answer (not the ordinary bootstrap), one bounded
   * page cleaned, sockets it deleted closed, the alarm left to non-live
   * work. Clean moves the watermark; recovery leaves nothing of its own to
   * recover. Its completion goes back for settlement.
   */
  async recoverLiveV1(request: LiveRecoveryRequest): Promise<LiveRecoveryReply> {
    const feed = this.ctx.id.name;
    const text = (v: unknown) => (typeof v === "string" && v.length <= 300 ? v : "");
    const refuse = (reason: "invalid" | "expired" | "fenced"): LiveRecoveryReply => ({
      protocol: 1,
      nonce: text(request?.nonce),
      feed: text(request?.feed),
      status: "refused",
      reason,
    });
    const coverage = request?.coverage;
    const plan = coverage?.plan;
    if (
      request?.protocol !== 1 ||
      !/^[0-9a-f]{32}$/.test(text(request.nonce)) ||
      feed === undefined ||
      request.feed !== feed ||
      typeof request.incarnation !== "string" ||
      !Number.isSafeInteger(request.throughSeq) ||
      request.throughSeq < 1 ||
      typeof plan !== "object" ||
      plan === null ||
      plan.kind !== "recovery" ||
      plan.class !== "cleanup" ||
      plan.recipientType !== "UserDO" ||
      plan.recipient !== feed ||
      plan.producesLocal !== false ||
      !isLiveVector(plan.localCleanupDebt) ||
      Object.values(plan.localCleanupDebt).some((n) => n !== 0) ||
      plan.incarnation !== request.incarnation ||
      coverage.protocol !== 1 ||
      typeof coverage.operationId !== "string" ||
      coverage.operationId.length > 300 ||
      !Number.isSafeInteger(coverage.seq) ||
      livePlanError(plan) !== null
    )
      return refuse("invalid");
    const guard = beginLiveDuration(
      coverage,
      Date.now(),
      LIVE_RECOVERY_DURATION.pendingMs,
      LIVE_RECOVERY_DURATION.tailMs,
    );
    if (!guard) return refuse("invalid");
    const checked = await validateLiveCoverage(this.env.DIRECTORY, coverage, {
      recipientType: "UserDO",
      recipient: feed,
      kind: "recovery",
    });
    if (checked.status === "refused") return refuse(checked.reason);
    this.#applyEpoch(checked.epoch || null, plan.incarnation);
    const budget = new LiveBudget(this.ctx.storage.sql);
    const page = this.ctx.storage.transactionSync(() =>
      budget.recoverPage(request.throughSeq, Date.now(), feedHooks.liveOwnerPending?.() ?? false),
    );
    for (const id of page.closedSocketIds)
      for (const ws of this.ctx.getWebSockets(id)) ws.close(CLOSE_EXPIRED, "expired: reconnect");
    // The alarm by non-live work alone, exactly (an earlier live one goes).
    await this.#arm(true, false);
    const completion = finishLiveDuration(guard, Date.now());
    if (!completion) return refuse("expired");
    return {
      protocol: 1,
      nonce: request.nonce,
      feed,
      incarnation: request.incarnation,
      throughSeq: request.throughSeq,
      status: page.status,
      completion,
    };
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

/** Whether a socket's token may name a repository at all (its repository list). */
function mayName(socket: LiveSocket, repoId: string): boolean {
  if (socket.repo_ids === null) return true;
  return (JSON.parse(socket.repo_ids) as string[]).includes(repoId);
}

/** Whether a socket's token may read a kind of subject (its scopes; none: all). */
function mayRead(socket: LiveSocket, subject: "issue" | "pull"): boolean {
  return allowedWithRole(
    {
      principalId: "",
      principalType: "user",
      scopes: JSON.parse(socket.scopes) as string[],
      repoIds: null,
    },
    { id: "" },
    subject === "issue" ? "issues:read" : "pull_requests:read",
    "read",
  );
}

/**
 * Whether a dirty stream has a cause, after a socket's progress `p`, that the
 * principal's current preferences let through: its own change; a change of
 * no conversation or past the candidates kept, unless the repository is
 * ignored; a conversation's change that asks something of it, unless the
 * repository is ignored; another, unless the conversation is unsubscribed too.
 */
function causes(
  d: DirtyStream,
  p: number,
  candidates: readonly { conversation: string; direct_seq: number; ordinary_seq: number }[],
  gate: Gate,
): boolean {
  if (d.explicit_seq > p) return true;
  if (gate.ignored.has(d.repo_id)) return false;
  if (d.many_seq > p) return true;
  return candidates.some(
    (c) =>
      c.direct_seq > p ||
      (c.ordinary_seq > p && !gate.unsubscribed.has(`${d.repo_id}\n${c.conversation}`)),
  );
}

/** Whether two dependency lists name the same dependencies. */
function sameDeps(a: readonly string[], b: readonly string[]): boolean {
  return [...new Set(a)].sort().join("\n") === [...new Set(b)].sort().join("\n");
}
