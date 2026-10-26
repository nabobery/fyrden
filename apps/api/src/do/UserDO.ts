import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import type { FeedEntry } from "@fyrden/domain";
import { MigratingDO } from "./base/MigratingDO.js";
import { userSchema } from "./schema/user.js";
import {
  Feed,
  type FeedAck,
  type FeedApplied,
  type FeedFilter,
  type FeedItem,
  type FeedItemId,
  type FeedPage,
  type FeedPosition,
  type FeedPurge,
  feedEpochSource,
  type GoneThread,
  MAX_GONE_THREADS,
  type SyncPosition,
  type ThreadVersion,
} from "./user/feed.js";

/** When an alarm that could not reach the directory, or a step that failed, tries again. Proposed. */
const EPOCH_RETRY_MS = 60_000;

/** Steps one alarm runs at most; more due, it is due again at once. Proposed. */
const ALARM_STEPS = 4;

/**
 * Deferred work, by kind, in the order an alarm runs what is due: a
 * retired feed's cleanup, then retention. Each step is bounded (see
 * `FEED_POLICY.sliceRows`) and answers when it is due again.
 */
const KINDS = ["retire", "retain"] as const;
type Kind = (typeof KINDS)[number];

/** Hooks into the feed's directory read. For tests. */
export const feedHooks: { beforeEpochRead?: () => Promise<void> } = {};

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

  /** Applies one batch of the principal's feed entries, in one transaction (see `Feed.apply`). */
  async applyFeed(entries: readonly FeedEntry[]): Promise<FeedApplied> {
    await this.#checkEpoch();
    if (this.#retired()) return NOTHING_APPLIED;
    const feed = this.#feed();
    const applied = this.ctx.storage.transactionSync(() => feed.apply(entries));
    // Even with nothing shown changed: a tombstone may have been written.
    if (entries.length > 0) await this.#scheduleRetention(feed);
    return applied;
  }

  /** Forgets repositories the principal no longer reads (see `Feed.purge`). */
  async purge(purge: FeedPurge): Promise<{ deleted: number }> {
    await this.#checkEpoch();
    if (this.#retired()) return { deleted: 0 };
    const feed = this.#feed();
    const deleted = this.ctx.storage.transactionSync(() => feed.purge(purge));
    await this.#scheduleRetention(feed);
    return { deleted };
  }

  /**
   * Forgets repositories a read found the principal cannot read, each as
   * the purge of what that was decided by (see `Feed.purge`), in one
   * transaction.
   */
  async forgetRepos(losses: readonly FeedPurge[]): Promise<{ deleted: number }> {
    await this.#checkEpoch();
    if (this.#retired()) return { deleted: 0 };
    const feed = this.#feed();
    const deleted = this.ctx.storage.transactionSync(() =>
      losses.reduce((sum, loss) => sum + feed.purge(loss), 0),
    );
    await this.#scheduleRetention(feed);
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

  async listFeed(since: FeedPosition | null, limit: number, filter: FeedFilter): Promise<FeedPage> {
    await this.#checkEpoch();
    // Retired: empty while its cleanup runs, its cursors judged as before.
    const shown = this.#retired() ? { ...filter, subjects: [] } : filter;
    return this.#feed().list(since, limit, shown);
  }

  async syncFeed(
    after: SyncPosition | null,
    limit: number,
    filter: Pick<FeedFilter, "repoIds" | "subjects">,
  ): Promise<{ epoch: string; lowWatermark: number; items: FeedItem[]; more: boolean }> {
    await this.#checkEpoch();
    return this.#feed().sync(after, limit, this.#retired() ? { subjects: [] } : filter);
  }

  async ackFeed(id: FeedItemId, at: ThreadVersion): Promise<FeedAck> {
    await this.#checkEpoch();
    if (this.#retired()) return { status: "missing" };
    const feed = this.#feed();
    return this.ctx.storage.transactionSync(() => feed.ack(id, at));
  }

  /**
   * Runs what is due, in `KINDS` order, at most `ALARM_STEPS` steps, each
   * in its own transaction with its schedule row; then sets the alarm to
   * the earliest row. A step that throws is due again a minute on, the
   * others still run.
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
    let steps = 0;
    for (const kind of KINDS) {
      while (steps < ALARM_STEPS && this.#dueNow(kind)) {
        steps++;
        try {
          this.ctx.storage.transactionSync(() => {
            const more = kind === "retire" ? feed.retireStep() : feed.retainStep();
            const next = more ? Date.now() : kind === "retain" ? feed.nextRetention() : null;
            this.#setDue(kind, next);
          });
        } catch (error) {
          createLogger({ op: "user.alarm", doClass: "UserDO" }).warn("a step failed", {
            kind,
            error,
          });
          this.#setDue(kind, Date.now() + EPOCH_RETRY_MS);
          break;
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
        .prepare(
          `SELECT (SELECT epoch_gen FROM source_epochs WHERE source_id = ?1) AS epoch_gen,
             (SELECT lifecycle FROM principals WHERE id = ?2) AS lifecycle`,
        )
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
