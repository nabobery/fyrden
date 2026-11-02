import {
  countedD1,
  createLogger,
  createMetrics,
  currentInvocation,
  measureInvocation,
  SubrequestTally,
} from "@fyrden/adapters-cloudflare/obs";
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
import { AuthorizationInvalidated, LIVE_AUTHORIZATION_RESULT_MS } from "../live/authorization.js";
import type { LiveEnvelope } from "../live/budget.js";
import {
  isLiveVector,
  livePlanError,
  makeLiveGrant,
  reserveLive,
  validateLiveCoverage,
} from "../live/budget.js";
import { liveCredential } from "../live/credential.js";
import { confirm, extendLease, LIVE_ADMISSION, release } from "../live/directory.js";
import { beginLiveDuration, finishLiveDuration } from "../live/duration.js";
import {
  expectationOf,
  type LiveFunding,
  ownedRun,
  planFor,
  validateFunding,
} from "../live/funding.js";
import {
  LIVE_LOW_WATER,
  LIVE_PRICES,
  LIVE_TURN_RENEWALS,
  LIVE_TURN_STEP_MOST,
  type LIVE_TURN_STEPS,
  type LiveManifestEntry,
  type LiveManifestUnit,
  liveBlockUnit,
  liveKindOf,
} from "../live/manifest.js";
import { quarantineLiveOwners } from "../live/owners.js";
import {
  LIVE_RECOVERY_DURATION,
  type LiveRecoveryReply,
  type LiveRecoveryRequest,
} from "../live/recovery.js";
import { allowedWithRole, findReposById } from "../repos/directory.js";
import { MigratingDO } from "./base/MigratingDO.js";
import { userSchema } from "./schema/user.js";
import { ALARM_LIMITS, AlarmBudget, type InvocationCost } from "./user/alarm-budget.js";
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
  LIVE_TICKET_PRUNE,
  Live,
  type Candidate as LiveCandidate,
  type LiveSignal,
  type LiveSocket,
} from "./user/live.js";
import { LiveBudget } from "./user/live-budget.js";
import { eligibleLiveDeadline, LIVE_BLOCKED, type LiveReadiness } from "./user/live-schedule.js";
import { TurnMeter, type TurnRows, times } from "./user/turn-meter.js";

/** The header the Worker hands an admitted live socket's upgrade over in (internal). */
export const LIVE_BUDGET = "X-Fyrden-Live-Budget-V1";

/** On an admitted socket's 101: the feed holds no turn to run, so the Worker grants one (internal). */
export const LIVE_TURN_WANTED = "X-Fyrden-Live-Turn-Wanted";

/** What the Worker hands a live upgrade: an admitted socket with its funding, or a refusal with its transport's. */
export type LiveBudgetV1 =
  | {
      readonly admitted: LiveAdmitted;
      readonly admission: unknown;
      /** Its end's provisions, on each day it may live on. */
      readonly terminal: unknown;
      /** The feed's blocks of controls and marks, when it held none (installed while its pools have room). */
      readonly controls?: unknown;
      readonly marks?: unknown;
      /** The feed's next turn, when it held none (prepared, not dispatched). */
      readonly turn?: unknown;
    }
  | { readonly refusal: 4412 | 4413; readonly transport: unknown };

/** What one control message, one mark and one socket's end are spent at. */
const unitPrice = (unit: LiveManifestUnit) => (LIVE_PRICES[unit] as LiveManifestEntry).resources;

/** A ticket as the Worker hands it to its feed: its hash, credential, expiry and transport's reference. */
export interface LiveTicketV1 {
  readonly hash: string;
  readonly credentialId: string;
  readonly expiresAt: number;
  readonly transport: { readonly operationId: string };
}

/** The stamp of the grant `envelope` (what recovery retires the rows it paid for by). */
const stampOf = (envelope: LiveEnvelope) => ({
  epoch: envelope.plan.epoch,
  incarnation: envelope.plan.incarnation,
  seq: envelope.seq,
  validUntil: envelope.plan.validUntil,
});

const liveTicketShaped = (t: unknown): t is LiveTicketV1 => {
  if (typeof t !== "object" || t === null) return false;
  const { hash, credentialId, expiresAt, transport } = t as Partial<LiveTicketV1>;
  return (
    typeof hash === "string" &&
    /^[0-9a-f]{64}$/.test(hash) &&
    typeof credentialId === "string" &&
    credentialId.length > 0 &&
    Number.isSafeInteger(expiresAt) &&
    typeof transport === "object" &&
    transport !== null &&
    typeof transport.operationId === "string" &&
    transport.operationId.length > 0
  );
};

/** What the Worker admitted: the socket, its credential and its dependencies. */
export interface LiveAdmitted {
  readonly socketId: string;
  readonly credentialId: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly repoIds: readonly string[] | null;
  readonly dependencies: readonly string[];
}

/** Credentials a pump unit serves (the rest wait for the next turns). */
const PUMP_CREDENTIALS = 1;

/** How long an admission may take to be confirmed before its local state is forgotten. */
const LIVE_CONFIRM_MS = 60_000;

/** How long sockets whose run could not be done (an answer missing) wait to try again. */
const LIVE_RETRY_MS = 60_000;

/** A socket's id, from its attachment. */
/** Whether `kind`'s refill is queued and due (one whose grant's answer was lost waits a minute). */
/**
 * What a turn's grant paid for, in rows, on `day` (the ledger's day it runs
 * on); with the day not known (right at a midnight), the least of its days.
 */
function turnBudget(envelope: LiveEnvelope, day: number | null): TurnRows {
  const charges = envelope.plan.charges.filter((c) => day === null || c.day === day);
  const least = (r: keyof TurnRows) =>
    charges.length === 0 ? 0 : Math.min(...charges.map((c) => c.resources[r]));
  return {
    do_rows_read: least("do_rows_read"),
    do_rows_written: least("do_rows_written"),
    d1_rows_read: least("d1_rows_read"),
    d1_rows_written: least("d1_rows_written"),
  };
}

function refillDue(
  budget: LiveBudget,
  kind: "control_refill" | "mark_refill",
  now: number,
): boolean {
  const pending = budget.pending(kind);
  return pending?.phase === "queued" && pending.intendedAt <= now;
}

function socketIdOf(ws: WebSocket): string | undefined {
  const attached = ws.deserializeAttachment() as { v?: number; id?: unknown } | null;
  return attached?.v === 1 && typeof attached.id === "string" ? attached.id : undefined;
}

/**
 * Whether a socket's prepaid end has passed (its attachment says when, on
 * this object's clock): nothing of it may be done then, no SQL read, its
 * recovery retires it.
 */
function unpaid(ws: WebSocket, now: number): boolean {
  const attached = ws.deserializeAttachment() as { until?: unknown } | null;
  return typeof attached?.until === "number" && now >= attached.until;
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
type Kind = (typeof KINDS)[number] | "email";

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
  /** Funded live work's readiness for a feed, in place of its turn's (tests). */
  liveReadiness?: (feed: string) => LiveReadiness | undefined;
  /** Before the alarm is read or written while it is reconciled. */
  beforeAlarmWrite?: () => Promise<void>;
  /** An alarm run's ceilings (tests: lower than the alarm's own). */
  alarmLimits?: InvocationCost;
  /** Awaited in a feed's turn after its work, before its successor is granted (tests). */
  afterTurnWork?: (feed: UserDO, state: DurableObjectState) => Promise<void>;
  /** Called in a feed's turn once its successor's grant is answered (tests). */
  afterSuccessorGrant?: (state: DurableObjectState) => void;
  /** Called once a turn's step ran: what it used, for `count` items (tests: its measurement). */
  turnStep?: (step: keyof typeof LIVE_TURN_STEPS, used: TurnRows, count: number) => void;
  /** Called once a turn's metered work ended, before its end: what it used, what its grant paid (tests). */
  turnDone?: (used: TurnRows, paid: TurnRows) => void;
  /** Called once a socket's end ran within a turn (on its terminal provision): what it used (tests). */
  turnClose?: (used: TurnRows) => void;
  /** Called once a socket's message, or its close, has been handled, whatever came of it (tests). */
  afterSocketEvent?: (feed: string | undefined, event: "message" | "close") => void;
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

  constructor(ctx: DurableObjectState, env: Env) {
    // Every D1 execution counted against the invocation's tally (an alarm counts by its bindings).
    super(ctx, { ...env, DIRECTORY: countedD1(env.DIRECTORY), ORG_READ: countedD1(env.ORG_READ) });
  }

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
      // Live sockets hear of the streams changed, when the feed has any (as far as its marks are
      // paid for).
      const sockets = live.counts("").feed > 0;
      const signalled = sockets && this.#markPaid(signals, now);
      // The email an entry carries, whatever the inbox made of it, but not for a purged repository.
      const mailable = entries.filter(
        (e) => e.recipient.email && e.occurredAt > (feed.purgedThrough(e.repoId) ?? -1),
      );
      const queued =
        emailing.size > 0 ? queueCandidates(this.ctx.storage.sql, mailable, emailing, now) : 0;
      return { applied, queued, signalled: signalled || sockets };
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
  override alarm(): Promise<void> {
    // One measured invocation, its D1 counted by the bindings: what it may still start is judged
    // by what it made.
    return measureInvocation(
      createMetrics(this.env.METRICS),
      { where: "do", op: "alarm", doClass: "UserDO", d1Counting: "binding" },
      () => this.#alarm(),
    );
  }

  async #alarm(): Promise<void> {
    // What the run may still start, by what it made: the mandatory steps' share kept first, until
    // the alarm is set again.
    const budget = new AlarmBudget(
      currentInvocation()?.tally ?? new SubrequestTally(),
      feedHooks.alarmLimits ?? ALARM_LIMITS,
    );
    const mandatory = budget.reserve("mandatory");
    try {
      await this.#alarmRun(budget);
    } finally {
      mandatory?.physicalComplete();
    }
  }

  async #alarmRun(budget: AlarmBudget): Promise<void> {
    // Work waits for the directory (the principal may be deleted): unreachable, it is tried
    // again later rather than left to Cloudflare's few retries.
    try {
      await this.#checkEpoch();
    } catch {
      // Overdue work waits for a retry (the schedule itself unchanged); funded live work, whose
      // readiness is unknown now, wakes nothing.
      this.#epochRetryAt = Date.now() + EPOCH_RETRY_MS;
      await this.#arm();
      return;
    }
    const feed = this.#feed();
    const steps = {
      retire: () => (feed.retireStep() ? Date.now() : null),
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
    // A live row of an earlier version's schedule: live work is the feed's turn's now.
    this.ctx.storage.sql.exec("DELETE FROM user_schedule WHERE kind = 'live'");
    // Notification email and funded live work take turns when both are due: the one that did
    // not go first last time goes first (what does not fit waits for the next run, due at once).
    const liveBudget = new LiveBudget(this.ctx.storage.sql);
    const order = liveBudget.liveFirst()
      ? (["live", "email"] as const)
      : (["email", "live"] as const);
    for (const kind of order) {
      if (this.#retired()) break;
      if (kind === "email" && this.#dueNow("email")) {
        await this.#sendEmails(budget);
        liveBudget.setLiveFirst(true);
      }
      if (kind === "live" && (await this.#liveTurn(budget))) liveBudget.setLiveFirst(false);
    }
    // By the schedule as the steps left it (calls made meanwhile left their rows).
    await this.#arm();
  }

  /**
   * Sends the notification emails due (see `sendCandidate`), a few a run,
   * one at a time, each only once the run's budget admits all of it (one
   * that does not fit, and those after it, are left as they are for the
   * next run: no attempt, no try, no new due time); each candidate's row
   * then goes, or is due again. Rows read again after each send's awaits:
   * a purge or retirement meanwhile stands.
   */
  async #sendEmails(budget: AlarmBudget): Promise<void> {
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
      // Admitted whole before anything of it starts, held until its row is settled.
      const reservation = budget.reserve("email");
      if (!reservation) break;
      try {
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
      } finally {
        reservation.physicalComplete();
      }
    }
    this.#setDue("email", nextDue(sql));
  }

  #live(): Live {
    return new Live(this.ctx.storage.sql);
  }

  /** Marks the principal's own changes to streams (other sockets refresh them). */
  #explicit(streams: readonly { repoId: string; subject: SubjectKind }[]): void {
    if (this.#live().counts("").feed === 0) return;
    this.#markPaid(
      streams.map((s): LiveSignal => ({ repoId: s.repoId, subject: s.subject, explicit: true })),
      Date.now(),
    );
  }

  /**
   * Marks `signals` (call within a transaction), each paid for first by one
   * mark of today's pool and stamped with the grant that paid: marking
   * stops at the first that cannot be (hints are then left out; the core
   * change stands), and a pool at low water or empty has its refill queued
   * once.
   * Whether any was marked.
   */
  #markPaid(signals: readonly LiveSignal[], local: number): boolean {
    const budget = new LiveBudget(this.ctx.storage.sql);
    const now = budget.ledgerNow(local);
    // Right at a midnight (which day it is cannot be told): no mark, no hint.
    const day = budget.ledgerDay(local);
    if (day === null) return false;
    const live = this.#live();
    const price = liveBlockUnit("mark");
    let marked = false;
    let last = null;
    for (const signal of signals) {
      const paid = budget.spendFrom("mark", day, price, now);
      if (!paid) break;
      live.mark([signal], paid);
      marked = true;
      last = paid;
    }
    // Its refill queued at low water, or once nothing is left (under the pool's newest grant; with
    // every block of it expired and a stream to mark, under the feed's turn, which runs it).
    const stamp =
      last ??
      budget.poolStamp("mark", day, now) ??
      (signals.length > 0 ? budget.turnStamp(now) : null);
    if (stamp && budget.unitsLeft("mark", day, price, now, LIVE_LOW_WATER + 1) <= LIVE_LOW_WATER)
      budget.queueOnce("mark_refill", crypto.randomUUID(), now, stamp, now);
    return marked;
  }

  /**
   * The feed's prepared turn brought due by what live work has to do next
   * (none prepared: nothing is funded to do it, and nothing wakes).
   */
  async #scheduleLive(): Promise<void> {
    const at = this.#liveDueAt(Date.now());
    if (at === null) return;
    if (this.ctx.storage.transactionSync(() => new LiveBudget(this.ctx.storage.sql).bringTurn(at)))
      await this.#arm();
  }

  /**
   * Stores a ticket of one live socket, funded: its `funding` (a `ticket`
   * grant for this feed, with its owner) checked before anything of the
   * feed is read, then its hash, credential, expiry and transport kept
   * (single use, until `ticket.expiresAt`). `retired` for a retired feed,
   * `refused` for a funding or ticket that does not hold.
   */
  async liveTicketV1(
    funding: unknown,
    ticket: LiveTicketV1,
  ): Promise<{ readonly status: "stored" | "retired" | "refused" }> {
    const entry = LIVE_PRICES.ticket as LiveManifestEntry;
    const checked = await validateFunding(
      this.env.DIRECTORY,
      funding,
      expectationOf(entry, {
        recipientType: "UserDO",
        recipient: this.ctx.id.name as string,
        kind: "ticket",
        class: "ordinary",
      }),
    );
    if (checked.status !== "valid" || !liveTicketShaped(ticket)) return { status: "refused" };
    await this.#checkEpoch();
    if (this.#retired()) return { status: "retired" };
    const { envelope } = checked.funding;
    const now = Date.now();
    const live = this.#live();
    return this.ctx.storage.transactionSync(() => {
      // Its grant still current here (no restore or recovery since it was checked), the ticket
      // still to live.
      if (!this.#current(envelope) || ticket.expiresAt <= now)
        return { status: "refused" as const };
      live.prune(now, LIVE_TICKET_PRUNE);
      live.storeTicket(
        ticket.hash,
        ticket.credentialId,
        ticket.expiresAt,
        ticket.transport,
        stampOf(envelope),
      );
      return { status: "stored" as const };
    });
  }

  /**
   * Redeems a ticket once, funded: its `funding` (the ticket's transport,
   * with its owner) checked before anything of the feed is read, then the
   * ticket of `hash` taken for `credentialId`, when it was issued with this
   * very transport and is unexpired: `redeemed`; `refused` for funding
   * that does not pay for it (or is fenced since), `unknown` for a ticket
   * that does not hold (or a retired feed).
   */
  async liveRedeemV1(
    funding: unknown,
    hash: string,
    credentialId: string,
  ): Promise<"redeemed" | "refused" | "unknown"> {
    const checked = await this.#funded(funding, "upgrade_transport");
    if (!checked) return "refused";
    await this.#checkEpoch();
    if (this.#retired()) return "unknown";
    const live = this.#live();
    return this.ctx.storage.transactionSync(() => {
      if (!this.#current(checked.envelope)) return "refused";
      return live.redeemTicket(hash, credentialId, Date.now(), checked.envelope.operationId)
        ? "redeemed"
        : "unknown";
    });
  }

  /** Whether `envelope`'s grant is current under the feed's fence (no restore or recovery past it). */
  #current(envelope: LiveEnvelope): boolean {
    const fence = new LiveBudget(this.ctx.storage.sql).fence();
    return (
      envelope.plan.epoch === fence.epoch &&
      envelope.plan.incarnation === fence.incarnation &&
      envelope.seq > fence.cleanupThrough
    );
  }

  /** `funding` checked as paying for `kind` of this feed (before anything of it is read), or null. */
  async #funded(funding: unknown, kind: LiveManifestUnit): Promise<LiveFunding | null> {
    const checked = await this.#fundingCheck(funding, kind);
    return checked.status === "valid" ? checked.funding : null;
  }

  /** `funding` checked as paying for `kind` of this feed: valid, or why not. */
  async #fundingCheck(
    funding: unknown,
    kind: LiveManifestUnit,
    /** A refusal's upgrade: its transport's grant, its owner named or not (one never admitted). */
    anyOwner = false,
  ): ReturnType<typeof validateFunding> {
    const expected = expectationOf(LIVE_PRICES[kind] as LiveManifestEntry, {
      recipientType: "UserDO",
      recipient: this.ctx.id.name as string,
      kind: liveKindOf(kind),
      class: "ordinary",
    });
    const unowned =
      anyOwner && typeof funding === "object" && funding !== null && "ownerId" in funding
        ? (funding as { ownerId: unknown }).ownerId === null
        : false;
    const sent = Date.now();
    const checked = await validateFunding(
      this.env.DIRECTORY,
      funding,
      unowned ? { ...expected, owned: false } : expected,
    );
    // The ledger's clock as just read: what this object judges its credit's times by.
    if (checked.status === "valid")
      new LiveBudget(this.ctx.storage.sql).noteLedger(checked.ledgerAt, sent, Date.now());
    return checked;
  }

  /**
   * A live socket's upgrade, handed over by the Worker (the object is
   * reached only through it), funded (`LIVE_BUDGET`). An admitted socket
   * comes with its admission's funding, checked before anything else:
   * confirmed in the directory before anything is exposed, fenced against
   * retirement and revocation after every await; refused, its lease is
   * released. A refusal comes with its transport's funding: the socket is
   * accepted only to be closed at once with its code (4412: try again
   * soon; 4413: today's allowance spent), no lease or socket row made.
   */
  override async fetch(request: Request): Promise<Response> {
    const budget = JSON.parse(request.headers.get(LIVE_BUDGET) ?? "null") as LiveBudgetV1 | null;
    if (request.headers.get("Upgrade") !== "websocket" || typeof budget !== "object" || !budget)
      return new Response(null, { status: 400 });
    if ("refusal" in budget) {
      const code = budget.refusal;
      // A transport fenced since (its feed restored) still pays for its refusal: its charge stands
      // in the ledger, and a socket closed at once keeps nothing here.
      const paid =
        code === 4412 || code === 4413
          ? await this.#fundingCheck(budget.transport, "upgrade_transport", true)
          : null;
      if (!paid || (paid.status !== "valid" && paid.reason !== "fenced"))
        return new Response(null, { status: 400 });
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      server.accept();
      server.close(code, code === 4413 ? "live hints spent today's allowance" : "try again soon");
      return new Response(null, { status: 101, webSocket: client });
    }
    const admitted = budget.admitted;
    // Its admission, its end's provisions and the feed's first blocks, each checked as paying for
    // what it is.
    const [admission, terminal, controls, marks, turn] = admitted
      ? await Promise.all([
          this.#funded(budget.admission, "admission"),
          this.#funded(budget.terminal, "terminal"),
          budget.controls === undefined ? null : this.#funded(budget.controls, "control_block"),
          budget.marks === undefined ? null : this.#funded(budget.marks, "mark_block"),
          // Its owner is admitted when it runs: none named yet.
          budget.turn === undefined
            ? null
            : this.#fundingCheck(budget.turn, "pump", true).then((checked) =>
                checked.status === "valid" ? checked.funding : null,
              ),
        ])
      : [null, null, null, null, null];
    if (
      !admitted ||
      !admission ||
      !terminal ||
      (budget.controls !== undefined && !controls) ||
      (budget.marks !== undefined && !marks)
    ) {
      if (admitted) await release(this.env.DIRECTORY, [admitted.socketId]);
      return new Response(null, { status: 409 });
    }
    await this.#checkEpoch();
    const live = this.#live();
    const refuse = async (status: number) => {
      this.ctx.storage.transactionSync(() => {
        live.forget(admitted.socketId);
        new LiveBudget(this.ctx.storage.sql).forgetTerminal(admitted.socketId);
      });
      await release(this.env.DIRECTORY, [admitted.socketId]);
      return new Response(null, { status });
    };
    if (this.#retired() || live.anyRevoked(admitted.dependencies)) return refuse(410);
    const held = live.counts(admitted.credentialId);
    if (held.feed >= LIVE_POLICY.perFeed || held.credential >= LIVE_POLICY.perCredential)
      return refuse(429);
    // Installed only while its grants are current here, stamped with its admission's, its end
    // provided for on each day it may live on, the feed's pools given their first blocks.
    const installed = this.ctx.storage.transactionSync(() => {
      const grants = [admission, terminal, controls, marks].flatMap((f) => (f ? [f.envelope] : []));
      if (!grants.every((g) => this.#current(g))) return false;
      const budget = new LiveBudget(this.ctx.storage.sql);
      const now = budget.ledgerNow(Date.now());
      if (!budget.provideTerminal(admitted.socketId, terminal.envelope, now)) return false;
      if (controls) budget.installBlock("control", controls.envelope, now);
      if (marks) budget.installBlock("mark", marks.envelope, now);
      // A pool left with nothing (blocks the ledger holds but this feed never got: an admission
      // refused after they were granted, say) has its refill queued under this admission's grant.
      const day = budget.ledgerDay(Date.now());
      if (day !== null)
        for (const [kind, refill] of [
          ["control", "control_refill"],
          ["mark", "mark_refill"],
        ] as const)
          if (budget.unitsLeft(kind, day, liveBlockUnit(kind), now, 1) === 0)
            budget.queueOnce(refill, crypto.randomUUID(), now, stampOf(admission.envelope), now);
      // The feed's next turn when it held none: due by the admission's confirmation deadline (an
      // admission never confirmed is forgotten by it).
      if (turn && this.#current(turn.envelope))
        budget.prepareTurn(turn.envelope, Date.now() + LIVE_CONFIRM_MS, now);
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
        stampOf(admission.envelope),
      );
      return true;
    });
    if (!installed) return refuse(409);
    // Its recovery is due before anything is awaited: an object stopped mid-confirmation forgets it
    // in the feed's next turn.
    this.ctx.storage.transactionSync(() =>
      new LiveBudget(this.ctx.storage.sql).bringTurn(Date.now() + LIVE_CONFIRM_MS),
    );
    await this.#arm();
    const confirmed = await confirm(this.env.DIRECTORY, admitted.socketId, Date.now()).catch(
      () => false,
    );
    // Retired, revoked, restored past its grant or forgotten while it was confirmed: nothing is
    // exposed.
    if (
      !confirmed ||
      this.#retired() ||
      !this.#current(admission.envelope) ||
      live.anyRevoked(admitted.dependencies) ||
      !live.socket(admitted.socketId)
    )
      return refuse(409);
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [admitted.socketId]);
    // When its prepaid end passes, on this object's clock (read with no SQL by its callbacks).
    const offset = new LiveBudget(this.ctx.storage.sql).ledgerNow(0);
    server.serializeAttachment({
      v: 1,
      id: admitted.socketId,
      until: terminal.envelope.plan.validUntil - offset,
    });
    this.ctx.storage.transactionSync(() => live.open(admitted.socketId));
    await this.#scheduleLive();
    // No turn to run, and none running to name one (one left stranded dealt with first): the
    // Worker grants one (see `liveTurnV1`).
    await this.#adoptTurn(null).catch(() => {});
    const holding = new LiveBudget(this.ctx.storage.sql);
    const wanted =
      !this.#turnRunning &&
      !holding.runnableTurn(Date.now()) &&
      holding.turn()?.phase !== "dispatched";
    return new Response(null, {
      status: 101,
      webSocket: client,
      ...(wanted && { headers: { [LIVE_TURN_WANTED]: "1" } }),
    });
  }

  /**
   * Prepares the feed's next turn from `funding` (a `pump` grant for this
   * feed, no owner named yet: it is admitted when the turn runs), when the
   * feed holds none it can run; whether it did.
   */
  async liveTurnV1(funding: unknown): Promise<boolean> {
    const checked = await this.#fundingCheck(funding, "pump", true);
    if (checked.status !== "valid") return false;
    await this.#checkEpoch();
    if (this.#retired()) return false;
    const budget = new LiveBudget(this.ctx.storage.sql);
    const prepared = this.ctx.storage.transactionSync(
      () =>
        this.#current(checked.funding.envelope) &&
        budget.prepareTurn(
          checked.funding.envelope,
          Date.now() + LIVE_CONFIRM_MS,
          budget.ledgerNow(Date.now()),
        ),
    );
    if (prepared) await this.#scheduleLive();
    await this.#arm();
    return prepared;
  }

  /**
   * A socket's control message: an acknowledgement (`{"t":"ack","n":…}`)
   * or a renewal (`{"t":"renew"}`), at most 1 KiB, 20 a minute and 200 in
   * its life; anything else, or past a bound, closes it.
   */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      await this.#socketMessage(ws, message);
    } finally {
      feedHooks.afterSocketEvent?.(this.ctx.id.name, "message");
    }
  }

  async #socketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Past its prepaid end: nothing read or spent, only closed (its rows are its recovery's).
    if (unpaid(ws, Date.now())) {
      ws.close(CLOSE_EXPIRED, "expired: reconnect with a new ticket");
      return;
    }
    // A restored object takes its epoch first; unread, nothing is applied.
    if (!(await this.#epochTaken())) return;
    const id = socketIdOf(ws);
    const live = this.#live();
    const socket = id === undefined ? undefined : live.socket(id);
    if (id === undefined || !socket || socket.phase !== "open") {
      ws.close(CLOSE_EXPIRED, "unknown socket");
      return;
    }
    // State from before a restore (or another ledger incarnation): nothing it says is applied,
    // and nothing of it is paid for any more (its credit went with the restore): only told to
    // reread, its rows left to recovery.
    if (live.stale(id)) {
      ws.close(CLOSE_RESYNC, "restored: reread and reconnect");
      return;
    }
    const now = Date.now();
    // Past its deadline or its life: closed, whatever it says.
    if (socket.deadline <= now || socket.expires_at <= now)
      return this.#closeSocket(id, CLOSE_EXPIRED, "expired: reconnect with a new ticket");
    const fresh = now - socket.minute_start >= 60_000;
    const minute = fresh ? 1 : socket.minute_count + 1;
    const used = socket.controls_used + 1;
    const size =
      typeof message === "string" ? new TextEncoder().encode(message).length : message.byteLength;
    // Every message pays for itself first, one control of today's pool, whatever it turns out to
    // be; its counters move with it, and a pool at low water has its refill queued once (and the
    // feed's turn brought due for it).
    let refill = false;
    const counted = this.ctx.storage.transactionSync(() => {
      const budget = new LiveBudget(this.ctx.storage.sql);
      const price = liveBlockUnit("control");
      const at = budget.ledgerNow(now);
      // Right at a midnight (which day it is cannot be told) nothing is spent: unpaid, it closes.
      const day = budget.ledgerDay(now);
      const paid = day === null ? null : budget.spendFrom("control", day, price, at);
      if (!paid) return false;
      live.update(id, {
        controls_used: used,
        minute_count: minute,
        ...(fresh && { minute_start: now }),
      });
      if (
        day !== null &&
        budget.unitsLeft("control", day, price, at, LIVE_LOW_WATER + 1) <= LIVE_LOW_WATER
      )
        refill = budget.queueOnce("control_refill", crypto.randomUUID(), at, paid, at) === "queued";
      return true;
    });
    if (refill) await this.#scheduleLive();
    // Nothing left to pay for it: closed to come back once there is (a new admission brings it).
    if (!counted) return this.#closeSocket(id, 4412, "try again soon");
    if (
      typeof message !== "string" ||
      size > LIVE_POLICY.controlBytes ||
      minute > LIVE_POLICY.controlsPerMinute ||
      used > LIVE_POLICY.controlsLife
    )
      return this.#closeSocket(id, 1008, "control message refused");
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
    // A renewal is queued, its request's time kept, for the feed's next turn to authorize (one
    // early or already queued changes nothing more).
    if (t === "renew" && keys.length === 1) {
      const queued = this.ctx.storage.transactionSync(() =>
        live.queueRenewal(id, crypto.randomUUID(), now),
      );
      if (
        queued === "queued" &&
        this.ctx.storage.transactionSync(() => new LiveBudget(this.ctx.storage.sql).bringTurn(now))
      )
        await this.#arm();
      // A turn running here prepares its successor as it ends (or names none): judged after that.
      while (this.#turnRunning) await this.#turnRunning;
      // No turn to authorize it (one adopted after its run was given up on or its accounting
      // lost, or its successor refused): nothing would answer, so it is closed as an expired one
      // is, to reconnect at once (its admission hands the feed a turn, or is refused).
      if (
        live.socket(id)?.phase === "open" &&
        !new LiveBudget(this.ctx.storage.sql).runnableTurn(Date.now())
      )
        this.#closeSocket(id, CLOSE_EXPIRED, "no live turn: reconnect with a new ticket");
      return;
    }
    return this.#closeSocket(id, 1008, "control message refused");
  }

  /**
   * One queued renewal, in a turn: its credential checked again, then, its
   * request unchanged and the socket still current, its deadline moved from
   * when it was asked (never past its expiry). Unanswered, it counts one
   * failure (two close the socket); revoked, expired or changed, the socket
   * closes. Given up on (the turn outlasted its bound), nothing applies and
   * it stays queued.
   */
  async #renewQueued(socket: LiveSocket, current: () => boolean): Promise<void> {
    const id = socket.socket_id;
    const nonce = socket.renewal_nonce;
    const generation = socket.socket_generation;
    const requestedAt = socket.renewal_intended_at;
    if (nonce === null || requestedAt === null) return;
    const live = this.#live();
    let credential: Awaited<ReturnType<typeof liveCredential>> | undefined;
    try {
      credential = await liveCredential(this.env.DIRECTORY, socket.credential_id, Date.now());
    } catch {
      credential = undefined;
    }
    if (!current()) return;
    const now = Date.now();
    const held = live.socket(id);
    // Asked again, or gone, meanwhile: this answer is not its.
    if (!held || held.renewal_nonce !== nonce || held.socket_generation !== generation) return;
    if (live.stale(id)) {
      for (const ws of this.ctx.getWebSockets(id))
        ws.close(CLOSE_RESYNC, "restored: reread and reconnect");
      return;
    }
    if (held.deadline <= now || held.expires_at <= now)
      return this.#closeSocket(id, CLOSE_EXPIRED, "expired: reconnect with a new ticket");
    if (
      credential === null ||
      live.anyRevoked(live.depsOf(id)) ||
      (credential !== undefined && !sameDeps(credential.dependencies, live.depsOf(id)))
    )
      return this.#closeSocket(id, CLOSE_EXPIRED, "the credential no longer holds");
    if (credential === undefined) {
      if (held.renew_failures + 1 >= 2)
        return this.#closeSocket(id, CLOSE_EXPIRED, "the credential could not be checked");
      this.ctx.storage.transactionSync(() => {
        live.update(id, { renew_failures: held.renew_failures + 1 });
        live.finishRenewal(id, nonce, generation);
      });
      return;
    }
    const deadline = Math.min(requestedAt + LIVE_POLICY.renewMs, held.expires_at);
    // Its lease extended with it (a lease lapses unless renewals extend it); one not extended is
    // unanswered, its deadline left as it was.
    const leased = await extendLease(
      this.env.DIRECTORY,
      id,
      Math.min(held.expires_at, deadline + LIVE_ADMISSION.leaseMarginMs),
    ).catch(() => false);
    if (!current()) return;
    if (!leased) {
      const again = live.socket(id);
      if (!again || again.renewal_nonce !== nonce) return;
      if (again.renew_failures + 1 >= 2)
        return this.#closeSocket(id, CLOSE_EXPIRED, "the credential could not be checked");
      this.ctx.storage.transactionSync(() => {
        live.update(id, { renew_failures: again.renew_failures + 1 });
        live.finishRenewal(id, nonce, generation);
      });
      return;
    }
    this.ctx.storage.transactionSync(() => {
      live.update(id, { deadline, renew_failures: 0 });
      live.finishRenewal(id, nonce, generation);
    });
    for (const ws of this.ctx.getWebSockets(id))
      ws.send(JSON.stringify({ t: "renewed", until: deadline }));
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      await this.#socketGone(ws);
    } finally {
      feedHooks.afterSocketEvent?.(this.ctx.id.name, "close");
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.#socketGone(ws);
  }

  /**
   * A socket closed or failed: forgotten on its terminal provision, once
   * the object took its epoch (its lease is maintenance's to release). One
   * already forgotten (ended here, or deleted by recovery) wakes nothing:
   * no bootstrap, no alarm.
   */
  async #socketGone(ws: WebSocket): Promise<void> {
    if (unpaid(ws, Date.now())) return;
    const id = socketIdOf(ws);
    if (id === undefined || !this.#live().socket(id)) return;
    if (!(await this.#epochTaken())) return;
    this.#endSocket(id);
  }

  /** Whether the object took its epoch (false when the directory could not be read). */
  #epochTaken(): Promise<boolean> {
    return this.#checkEpoch().then(
      () => true,
      () => false,
    );
  }

  /**
   * Ends a socket on today's terminal provision: forgotten, then closed with
   * `code` (its callbacks then find nothing). One with no provision left
   * (its prepaid days passed, or recovery took it) is only closed, its
   * attachment marking it past its end so nothing more of it is read; its
   * rows are its recovery's, except within a turn, which forgets them at its
   * own cost (so the socket keeps no turn going). Its lease is maintenance's
   * to release.
   */
  #closeSocket(id: string, code: number, reason: string): void {
    // Within a turn, a socket's end is its terminal provision's to pay for, not the turn's.
    const meter = this.#meter;
    if (meter) {
      // Exempt only when a terminal provision paid for it: a lookup that found none is the turn's.
      const used = meter.exempt(() => this.#closeNow(id, code, reason));
      if (used) feedHooks.turnClose?.(used);
      // Its end not paid for (its provisions gone): forgotten after the turn's work, at its own cost
      // while it has room (else a later turn's: a pump, as the feed has such sockets), so it neither
      // keeps the feed's turns going nor is closed again by every turn.
      else this.#unpaidEnds.push(id);
      return;
    }
    this.#closeNow(id, code, reason);
  }

  /** Ends and closes a socket (see `#closeSocket`): whether a terminal provision paid for it. */
  #closeNow(id: string, code: number, reason: string): boolean {
    const ended = this.#endSocket(id);
    for (const ws of this.ctx.getWebSockets(id)) {
      // Its end not paid for: past it from now on, so nothing more of it reads anything.
      if (!ended) ws.serializeAttachment({ v: 1, id, until: Date.now() });
      ws.close(code, reason);
    }
    return ended;
  }

  /** Forgets a socket on today's terminal provision, consumed; whether it was. */
  #endSocket(id: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const budget = new LiveBudget(this.ctx.storage.sql);
      const local = Date.now();
      const ended = budget.terminate(
        id,
        budget.ledgerDays(local),
        unitPrice("terminal"),
        budget.ledgerNow(local),
      );
      if (ended) this.#live().forget(id);
      return ended;
    });
  }

  /**
   * Dependencies revoked (told by the directory's sweep): recorded, so no
   * socket resting on one is admitted or renewed, and every open one
   * resting on one closed; in any order, any number of times.
   */
  async revoked(dependencies: readonly string[]): Promise<readonly string[]> {
    await this.#checkEpoch();
    const live = this.#live();
    // Recorded, and every socket resting on one forgotten (its end's provisions with it) before it
    // is closed; their leases are released by whoever told it (the sweep), not from here.
    const ids = this.ctx.storage.transactionSync(() => {
      const closing = live.revoke(dependencies, Date.now());
      const budget = new LiveBudget(this.ctx.storage.sql);
      for (const id of closing) {
        live.forget(id);
        budget.forgetTerminal(id);
      }
      return closing;
    });
    for (const id of ids)
      for (const ws of this.ctx.getWebSockets(id)) ws.close(CLOSE_REVOKED, "revoked");
    return ids;
  }

  /**
   * A turn's housekeeping: expired and slow sockets ended (on their terminal
   * provisions); the admissions whose confirmation never finished, to
   * forget once the turn's work is done (see `#forget`).
   */
  #housekeep(current: () => boolean): string[] {
    const live = this.#live();
    const now = Date.now();
    const unconfirmed: string[] = [];
    for (const s of live.sockets()) {
      if (!current()) return [];
      // A confirmation that never finished (the object restarted meanwhile).
      if (s.phase === "confirming") {
        if (s.minute_start <= now - LIVE_CONFIRM_MS) unconfirmed.push(s.socket_id);
      } else if (s.expires_at <= now || s.deadline <= now)
        this.#closeSocket(s.socket_id, CLOSE_EXPIRED, "expired: renew in time or reconnect");
      else if (s.blocked_since !== null && now - s.blocked_since >= LIVE_POLICY.slowMs)
        this.#closeSocket(s.socket_id, CLOSE_RESYNC, "slow consumer: reread everything");
    }
    return unconfirmed;
  }

  /**
   * Admissions whose confirmation never finished, forgotten after the turn's
   * work (a hint is more urgent): as many as the turn still has room for
   * (the rest the next turn's), forgotten here, then their leases released
   * together (one batch).
   */
  async #forget(unconfirmed: string[], current: () => boolean, meter: TurnMeter): Promise<void> {
    const live = this.#live();
    if (unconfirmed.length === 0 || !current()) return;
    let fitting = 0;
    while (
      fitting < unconfirmed.length &&
      meter.fits(times(LIVE_TURN_STEP_MOST.forget, fitting + 1))
    )
      fitting++;
    const forgetting = unconfirmed.slice(0, fitting);
    if (forgetting.length === 0) return;
    await this.#metered(
      meter,
      "forget",
      async () => {
        this.ctx.storage.transactionSync(() => {
          for (const id of forgetting) live.forget(id);
        });
        await release(this.env.DIRECTORY, forgetting);
      },
      forgetting.length,
    );
  }

  /**
   * One credential's page delivered to its sockets (the turn's `delivery`
   * step): reads a page of the streams changed (`dirtyPage`) and, for each
   * credential (at most `PUMP_CREDENTIALS` a run, the furthest behind
   * first), checks it again on the directory's primary (no longer holding:
   * its sockets close) and decides afresh, through one owning account's
   * bounded check, the page's repositories of that account that its token
   * may name; then sends each of its open sockets with room in its window one
   * frame naming the streams it may read now with a cause its current
   * preferences let through. A stream whose repository's answer is not known
   * is passed over; one past the page, or of another account, waits for the
   * next run (the socket's progress stops before it).
   */
  async #deliver(current: () => boolean): Promise<boolean> {
    const principalId = this.ctx.id.name;
    if (principalId === undefined) return false;
    const live = this.#live();
    const now = Date.now();
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
    if (serving.length === 0) return false;
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
        if (current()) this.#retryLater(serving.flatMap(([, sockets]) => sockets));
        return false;
      }
    if (!current()) return false;
    const metrics = createMetrics(this.env.METRICS);
    for (const [credentialId, waiting] of serving) {
      const holding = await liveCredential(this.env.DIRECTORY, credentialId, Date.now()).catch(
        () => undefined,
      );
      if (!current()) return false;
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
        if (!current()) return false;
      } catch {
        // Not known which account holds what: tried again a minute on.
        if (!current()) return false;
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
        // The account's object's check paid for first, by a grant of its own: refused or not
        // answered, the sockets try again a minute on.
        const paid = await this.#grantConfirmation(account, current).catch(() => false);
        if (!current()) return false;
        if (!paid) {
          this.#retryLater(sockets);
          continue;
        }
        let answers: Awaited<ReturnType<FreshAccess["decide"]>>;
        try {
          answers = await new FreshAccess({ env: this.env, metrics }, {
            principalId,
            grantId: null,
          } as never).decide(deciding, {
            live: true,
            // Each of its awaits checked: nothing more started once the turn can no longer apply.
            checkpoint: () => {
              if (!current()) throw new AuthorizationInvalidated();
            },
          });
        } catch (error) {
          if (error instanceof AuthorizationInvalidated) return false;
          throw error;
        }
        if (!current()) return false;
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
    return true;
  }

  /** Funded live work's readiness: the prepared turn's, while it can run (else blocked). */
  #turnReadiness(local: number): LiveReadiness {
    if (this.#retired()) return LIVE_BLOCKED;
    const turn = new LiveBudget(this.ctx.storage.sql).runnableTurn(local);
    return turn
      ? {
          status: "ready",
          at: turn.intendedAt,
          validUntil: turn.validUntil,
          generation: turn.seq,
        }
      : LIVE_BLOCKED;
  }

  /**
   * Runs the feed's turn when it is due and its whole work and accounting
   * fit the run's budget (else it waits, due, for the next run), the
   * reservation held until its work has physically ended: claimed once by
   * this instance, run as owned work (its owner admitted, recorded
   * dispatched here before any await, observed, settled and released),
   * every step after an await checked against what it was claimed under
   * (the fence, the turn itself, the feed not retired, its bound not
   * outlasted). Then ended naming its successor while the feed has
   * sockets: due at once when work is left, else when live work next is
   * (before the successor lapses). One whose owner was not accounted keeps
   * its reference for recovery. Whether it ran.
   */
  async #liveTurn(alarm: AlarmBudget): Promise<boolean> {
    // One turn's work at a time here, until it has physically ended (whatever became of its row).
    if (this.#turnRunning) return false;
    const budget = new LiveBudget(this.ctx.storage.sql);
    await this.#adoptTurn(alarm);
    const local = Date.now();
    const ready = budget.runnableTurn(local);
    if (!ready || ready.intendedAt > local) return false;
    // Its own coverage needs no check here: it was checked when prepared. Its kind's components (a
    // pump's, or a turn of renewals only).
    const kind = budget.turn()?.envelope.plan.kind === "renewal" ? "renewal" : "pump";
    const units = (LIVE_PRICES[kind] as LiveManifestEntry).components.filter(
      (u) => u !== "coverage",
    );
    const reservation = alarm.reserve(...units);
    if (!reservation) return false;
    let physical: Promise<void> = Promise.resolve();
    let physicalDone = () => {};
    try {
      const envelope = this.ctx.storage.transactionSync(() =>
        budget.claimTurn(budget.ledgerNow(local), this.#instance),
      );
      if (!envelope) return false;
      // Busy from its claim: nothing adopts or replaces it while it may still run here.
      let ended!: () => void;
      this.#turnRunning = new Promise<void>((resolve) => {
        ended = resolve;
      });
      const marker = this.#turnRunning;
      physicalDone = () => {
        ended();
        if (this.#turnRunning === marker) this.#turnRunning = null;
      };
      const claimedUnder = budget.fence();
      let dispatched = false;
      const earliest = budget.ledgerEarliest(local);
      const run = await ownedRun(
        this.env.DIRECTORY,
        envelope,
        "turn",
        async (funding, signal) => {
          dispatched = this.ctx.storage.transactionSync(() =>
            budget.dispatchTurn(envelope.operationId, funding.ownerId as string, this.#instance),
          );
          if (!dispatched) return null;
          // Its result waited for 10 seconds: past them nothing of it applies (its work, which the
          // platform does not cut, still holds the object until it ends).
          const answerBy = Date.now() + LIVE_AUTHORIZATION_RESULT_MS;
          const current = () => {
            const fence = budget.fence();
            const turn = budget.turn();
            return (
              !signal.aborted &&
              Date.now() < answerBy &&
              !this.#retired() &&
              fence.epoch === claimedUnder.epoch &&
              fence.incarnation === claimedUnder.incarnation &&
              fence.authorizationGen === claimedUnder.authorizationGen &&
              fence.cleanupThrough === claimedUnder.cleanupThrough &&
              turn?.operationId === envelope.operationId &&
              turn.phase === "dispatched"
            );
          };
          // Its work metered against its grant: each step only while it still fits.
          const paid = turnBudget(envelope, budget.ledgerDay(Date.now()));
          const meter = new TurnMeter(this.ctx.storage.sql, paid, LIVE_TURN_STEP_MOST.end);
          this.#meter = meter;
          this.#unpaidEnds = [];
          try {
            await this.#turnWork(funding, current, meter);
            await feedHooks.afterTurnWork?.(this, this.ctx);
            // Its work done: what it used, its end (the successor's grant among it) still to come.
            feedHooks.turnDone?.(meter.used(), paid);
            return current() && this.#live().sockets().length > 0
              ? await this.#grantTurn(current).catch(() => null)
              : null;
          } finally {
            if (this.#meter === meter) this.#meter = null;
            meter.stop();
          }
        },
        {
          pendingMs: (LIVE_PRICES[kind] as LiveManifestEntry).pendingMs as number,
          ledger: { now: earliest, at: local, slack: budget.ledgerNow(local) - earliest },
          physical: (ended) => {
            physical = ended;
          },
        },
      );
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        if (run.status === "funded" && dispatched) {
          const successor = run.value;
          const lapse = successor
            ? successor.plan.validUntil - (budget.ledgerNow(now) - now) - 60_000
            : now;
          const next = this.#moreLive(now) ? now : this.#liveDueAt(now);
          budget.finishTurn(envelope.operationId, budget.ledgerNow(now), {
            ownerAccounted: run.accounted === true,
            ...(successor && {
              successor: { envelope: successor, intendedAt: Math.min(next ?? lapse, lapse) },
            }),
          });
        } else if (!dispatched)
          // Its owner not admitted, or recovery took it before it was dispatched: nothing of it
          // ran, so it waits to run again (when it is still there).
          budget.unclaimTurn(envelope.operationId, now + LIVE_RETRY_MS);
        // Dispatched and given up on: its owner's work may still run, so it stays for recovery.
      });
      return true;
    } finally {
      void physical.finally(() => {
        reservation.physicalComplete();
        physicalDone();
      });
    }
  }

  /** The running turn's meter, while its work runs (a socket's end is exempt from it). */
  #meter: TurnMeter | null = null;
  /** Sockets the running turn closed with nothing left to pay for their end: its to forget. */
  #unpaidEnds: string[] = [];

  /** The turn whose work is still physically running in this instance, if any. */
  #turnRunning: Promise<void> | null = null;

  /**
   * A turn left claimed or dispatched with no work of it running here (an
   * instance gone left it, or this one gave up on it, or lost its
   * accounting's answer): one whose owner the directory never admitted
   * runs again; one admitted but never dispatched, or already accounted,
   * is forgotten (the directory releases the first once its window
   * passes); one dispatched is uncertain: its owner is quarantined (its
   * place kept) before it is forgotten, so a new turn may be prepared, and
   * a refill it dispatched is queued again with its request. In
   * an alarm, nothing is done when the run cannot afford it.
   */
  async #adoptTurn(alarm: AlarmBudget | null): Promise<void> {
    const budget = new LiveBudget(this.ctx.storage.sql);
    const turn = budget.turn();
    if (!turn || turn.phase === "prepared" || this.#turnRunning) return;
    const reservation = alarm ? alarm.reserve("quarantine") : { physicalComplete: () => {} };
    if (!reservation) return;
    try {
      const owner = await this.env.DIRECTORY.prepare(
        "SELECT owner_id, status FROM live_duration_owners WHERE operation_id = ?",
      )
        .bind(turn.operationId)
        .first<{ owner_id: string; status: string }>();
      // Dispatched with its end unknown: quarantined (uncertain, its place kept). Observing or
      // accounted, maintenance settles it; reserved, the directory releases it.
      if (owner?.status === "dispatched")
        await quarantineLiveOwners(this.env.DIRECTORY, [owner.owner_id]);
      this.ctx.storage.transactionSync(() => {
        if (budget.turn()?.operationId !== turn.operationId) return;
        if (!owner && turn.phase === "claimed") budget.unclaimTurn(turn.operationId, Date.now());
        else {
          budget.dropTurn(turn.operationId);
          // A refill it dispatched, its answer never heard: asked again by a later turn (the same
          // request, so the same grant if it was made).
          if (turn.ownerId !== null) budget.requeueOwnedPending(turn.ownerId, Date.now());
        }
      });
    } finally {
      reservation.physicalComplete();
    }
  }

  /**
   * A turn's work: its housekeeping, then one kind of work, the most
   * urgent: queued renewals (a few, by deadline), else one queued refill,
   * else one pump unit; then admissions never confirmed forgotten as it
   * still has room.
   */
  async #turnWork(funding: LiveFunding, current: () => boolean, meter: TurnMeter): Promise<void> {
    const unconfirmed = await this.#metered(meter, "housekeep", () => this.#housekeep(current));
    if (!current()) return;
    await this.#mainWork(funding, current, meter);
    await this.#forget(unconfirmed, current, meter);
    // Sockets ended with nothing left to pay for: their rows forgotten as the turn has room.
    for (const id of this.#unpaidEnds.splice(0)) {
      if (!current() || !meter.fits(LIVE_TURN_STEP_MOST.forget)) break;
      await this.#metered(meter, "forget", () =>
        this.ctx.storage.transactionSync(() => this.#live().forget(id)),
      );
    }
  }

  /** A turn's one kind of work, the most urgent (see `#turnWork`). */
  async #mainWork(funding: LiveFunding, current: () => boolean, meter: TurnMeter): Promise<void> {
    const live = this.#live();
    const renewals = live.queuedRenewals().slice(0, LIVE_TURN_RENEWALS);
    if (renewals.length > 0) {
      for (const socket of renewals) {
        if (!current() || !meter.fits(LIVE_TURN_STEP_MOST.renewal)) return;
        await this.#metered(meter, "renewal", () => this.#renewQueued(socket, current));
      }
      return;
    }
    const budget = new LiveBudget(this.ctx.storage.sql);
    const refill = (["control_refill", "mark_refill"] as const).find((kind) =>
      refillDue(budget, kind, Date.now()),
    );
    if (refill) {
      if (meter.fits(LIVE_TURN_STEP_MOST.refill))
        await this.#metered(meter, "refill", () => this.#refill(refill, funding, current));
      return;
    }
    if (meter.fits(LIVE_TURN_STEP_MOST.delivery))
      await this.#metered(meter, "delivery", () => this.#deliver(current));
    if (!current() || !meter.fits(LIVE_TURN_STEP_MOST.prune)) return;
    await this.#metered(meter, "prune", () =>
      this.ctx.storage.transactionSync(() => this.#live().prune(Date.now())),
    );
  }

  /** Runs `fn` as the turn's `step` (for `count` items), told to the tests' hook. */
  async #metered<T>(
    meter: TurnMeter,
    step: keyof typeof LIVE_TURN_STEPS,
    fn: () => Promise<T> | T,
    count = 1,
  ): Promise<T> {
    const { value, used } = await meter.step(fn);
    feedHooks.turnStep?.(step, used, count);
    return value;
  }

  /**
   * When live work is next due: a queued refill when it was asked for (the
   * pool it refills is running low), or what the pump and sockets need
   * next; null for nothing.
   */
  #liveDueAt(now: number): number | null {
    const budget = new LiveBudget(this.ctx.storage.sql);
    const refills = (["control_refill", "mark_refill"] as const)
      .map((kind) => budget.pending(kind))
      .filter((p) => p?.phase === "queued")
      .map((p) => Math.max(now, p?.intendedAt ?? now));
    const due = [...refills, this.#live().nextDue(now, LIVE_CONFIRM_MS)].filter(
      (t): t is number => t !== null,
    );
    return due.length > 0 ? Math.min(...due) : null;
  }

  /** Whether live work is left to do at once (a renewal, a refill, or the pump's). */
  #moreLive(now: number): boolean {
    const live = this.#live();
    const budget = new LiveBudget(this.ctx.storage.sql);
    return (
      live.queuedRenewals().length > 0 ||
      refillDue(budget, "control_refill", now) ||
      refillDue(budget, "mark_refill", now) ||
      (live.nextDue(now, LIVE_CONFIRM_MS) ?? Number.POSITIVE_INFINITY) <= now
    );
  }

  /**
   * One queued refill, in a turn: its exact request made once (a retry
   * sends the same), recorded dispatched with the turn's owner, granted,
   * then installed when it is still this refill's; refused or with no room,
   * it goes (low water queues another).
   */
  async #refill(
    kind: "control_refill" | "mark_refill",
    funding: LiveFunding,
    current: () => boolean,
  ): Promise<void> {
    const feed = this.ctx.id.name;
    const budget = new LiveBudget(this.ctx.storage.sql);
    const item = budget.pending(kind);
    if (!feed || !item || item.phase !== "queued" || !funding.ownerId) return;
    const fence = budget.fence();
    const request =
      item.request ??
      (await makeLiveGrant(
        planFor(
          LIVE_PRICES[
            kind === "control_refill" ? "control_block" : "mark_block"
          ] as LiveManifestEntry,
          {
            incarnation: fence.incarnation,
            epoch: fence.epoch,
            recipientType: "UserDO",
            recipient: feed,
            class: "ordinary",
            kind: kind === "control_refill" ? "control" : "mark",
            producesLocal: true,
          },
          budget.ledgerEarliest(Date.now()),
        ),
      ));
    const plan = funding.envelope.plan;
    const owner = {
      ownerId: funding.ownerId,
      operationId: funding.envelope.operationId,
      objectType: "UserDO" as const,
      objectId: feed,
      incarnation: plan.incarnation,
      epoch: plan.epoch,
    };
    if (!current()) return;
    const dispatched = this.ctx.storage.transactionSync(
      () =>
        budget.preparePending(kind, item.identity, request) &&
        budget.dispatchPending(kind, item.identity, owner, this.#instance),
    );
    if (!dispatched) return;
    const granted = await reserveLive(this.env.DIRECTORY, request).catch(() => null);
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      // A request no longer grantable as a new grant (its first day passed): it goes.
      const firstDay = request.plan.charges[0]?.day ?? 0;
      const lapsed = budget.ledgerEarliest(now) >= (firstDay + 1) * 86_400_000;
      // Its answer lost, or the turn given up on: the same request is sent again a minute on (the
      // same grant, if it was made).
      const uncertain =
        !granted || (granted.status === "refused" && granted.reason === "temporary") || !current();
      if (uncertain && !lapsed) {
        budget.requeuePending(kind, item.identity, now + LIVE_RETRY_MS);
        return;
      }
      // Given up on, past its first day: nothing installed, it goes.
      if (!current()) {
        budget.finishPending(kind, item.identity);
        return;
      }
      const installed =
        granted?.status === "granted"
          ? budget.installPending(
              kind,
              item.identity,
              granted.grant,
              budget.ledgerNow(Date.now()),
              feed,
              this.#instance,
            )
          : "refused";
      // No room on any of its days: kept, its request asked again a minute on (the same grant,
      // charged once) until a block drains or is retired.
      if (installed === "full") budget.requeuePending(kind, item.identity, now + LIVE_RETRY_MS);
      // Refused for good (today's allowance, its grant expired or fenced): it goes (low water
      // queues another).
      else if (installed !== "installed") budget.finishPending(kind, item.identity);
    });
  }

  /**
   * The feed's successor turn, granted from the ledger now (null when
   * refused, or stopped): a pump when it has live work beyond renewals (a
   * change to deliver, a refill, a page to prune), else a turn of renewals
   * only, priced for nothing more (its meter leaves anything marked since to
   * the pump after it).
   */
  async #grantTurn(current: () => boolean): Promise<LiveEnvelope | null> {
    const feed = this.ctx.id.name;
    if (!feed) return null;
    const budget = new LiveBudget(this.ctx.storage.sql);
    const fence = budget.fence();
    const refill = (["control_refill", "mark_refill"] as const).some(
      (kind) => budget.pending(kind)?.phase === "queued",
    );
    const kind = refill || this.#live().hasPumpWork(Date.now()) ? "pump" : "renewal";
    const request = await makeLiveGrant(
      planFor(
        LIVE_PRICES[kind] as LiveManifestEntry,
        {
          incarnation: fence.incarnation,
          epoch: fence.epoch,
          recipientType: "UserDO",
          recipient: feed,
          class: "ordinary",
          kind,
          producesLocal: true,
        },
        budget.ledgerEarliest(Date.now()),
      ),
    );
    if (!current()) return null;
    const granted = await reserveLive(this.env.DIRECTORY, request);
    feedHooks.afterSuccessorGrant?.(this.ctx);
    // Answered once the turn's result no longer applies: named nowhere (its charge stands).
    return granted.status === "granted" && current() ? granted.grant : null;
  }

  /**
   * Grants the pump's call of `account`'s object (`org_confirmation`) from the
   * ledger now: whether it was granted (false when refused, or stopped).
   */
  async #grantConfirmation(account: string, current: () => boolean): Promise<boolean> {
    const budget = new LiveBudget(this.ctx.storage.sql);
    const request = await makeLiveGrant(
      planFor(
        LIVE_PRICES.org_confirmation as LiveManifestEntry,
        {
          incarnation: budget.fence().incarnation,
          epoch: 0,
          recipientType: "OrgDO",
          recipient: account,
          class: "ordinary",
          kind: "org_confirmation",
          producesLocal: false,
        },
        budget.ledgerEarliest(Date.now()),
      ),
    );
    if (!current()) return false;
    return (await reserveLive(this.env.DIRECTORY, request)).status === "granted";
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

  /** This instance's own name, recorded with what it dispatches. */
  readonly #instance = crypto.randomUUID();
  /** While the epoch could not be read: when overdue work is tried again. */
  #epochRetryAt: number | null = null;
  #arming: Promise<void> = Promise.resolve();

  /**
   * When the alarm should ring: the earliest of the schedule's rows (while
   * the epoch could not be read, overdue rows at the retry) and funded live
   * work's eligible deadline (its prepared turn's, while that can run);
   * null for none.
   */
  #desiredAlarm(now: number): number | null {
    const rows = this.ctx.storage.sql
      .exec<{ kind: string; due_at: number }>(
        "SELECT kind, due_at FROM user_schedule WHERE kind <> 'live'",
      )
      .toArray();
    const retry = this.#epochRetryAt;
    const times = rows.map((row) => (retry !== null && row.due_at <= now ? retry : row.due_at));
    const feed = this.ctx.id.name;
    const readiness =
      (feed !== undefined ? feedHooks.liveReadiness?.(feed) : undefined) ??
      this.#turnReadiness(now);
    const live = retry === null ? eligibleLiveDeadline(readiness, now) : null;
    if (live !== null) times.push(live);
    return times.length === 0 ? null : Math.max(Math.min(...times), now);
  }

  /**
   * Sets the alarm to what the schedule wants (earlier or later), deletes
   * it when nothing is due, and leaves it when it already rings then (two
   * times both past are the same). One reconciliation at a time, deciding
   * after its last await, and going again when what is wanted changed while
   * it wrote.
   */
  #arm(): Promise<void> {
    const run = this.#arming.then(() => this.#reconcileAlarm());
    this.#arming = run.catch(() => {});
    return run;
  }

  async #reconcileAlarm(): Promise<void> {
    for (let pass = 0; pass < 4; pass++) {
      await feedHooks.beforeAlarmWrite?.();
      const current = await this.ctx.storage.getAlarm();
      // Decided after the last await: the schedule, readiness and time as they are now.
      const now = Date.now();
      const desired = this.#desiredAlarm(now);
      const same = (at: number | null) =>
        at === null
          ? current === null
          : current !== null && (current === at || (current <= now && at <= now));
      if (same(desired)) return;
      if (desired === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(desired);
      // Still what is wanted once written (nothing changed meanwhile): done.
      const after = this.#desiredAlarm(Date.now());
      if (
        after === desired ||
        (after !== null && desired !== null && after <= Date.now() && desired <= Date.now())
      )
        return;
    }
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
      // Read: overdue work runs at its own time again.
      this.#epochRetryAt = null;
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
    // Live sockets go with it, each on its terminal provision (at most a feed's); what else of
    // live is left, and their leases, are recovery's and maintenance's.
    for (const socket of this.#live().sockets())
      this.#closeSocket(socket.socket_id, CLOSE_REVOKED, "retired");
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
    // The fence this recovery was validated under: one moved while it awaited touches nothing.
    const { epoch, incarnation } = budget.fence();
    // Dispatched work whose end this object cannot show (a restart lost it, or it still runs):
    // its owners quarantined in the directory first, and only those the directory then holds
    // (uncertain, or accounted for) may lose their local rows. Unanswered, or not held, they stay
    // and recovery stays pending.
    const dispatched = budget.dispatchedOwners();
    let quarantined: ReadonlySet<string> = new Set();
    if (dispatched.length > 0)
      try {
        quarantined = new Set(await quarantineLiveOwners(this.env.DIRECTORY, dispatched));
      } catch {
        quarantined = new Set();
      }
    const page = this.ctx.storage.transactionSync(() =>
      budget.recoverPage(request.throughSeq, quarantined, { epoch, incarnation }),
    );
    if (page.status === "fenced") return refuse("fenced");
    for (const id of page.closedSocketIds)
      for (const ws of this.ctx.getWebSockets(id)) ws.close(CLOSE_EXPIRED, "expired: reconnect");
    await this.#arm();
    // Ran past what its grant reserved: no completion (its whole hold stays charged), and its
    // acknowledgement of the local state still stands.
    const completion = finishLiveDuration(guard, Date.now());
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
