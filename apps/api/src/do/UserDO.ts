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
  type SyncPosition,
  type ThreadVersion,
} from "./user/feed.js";

/** When an alarm that could not reach the directory tries again. Proposed. */
const EPOCH_RETRY_MS = 60_000;

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
    await this.#checkEpoch();
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
    return this.#feed().list(since, limit, filter);
  }

  async syncFeed(
    after: SyncPosition | null,
    limit: number,
    filter: Pick<FeedFilter, "repoIds" | "subjects">,
  ): Promise<{ epoch: string; lowWatermark: number; items: FeedItem[]; more: boolean }> {
    await this.#checkEpoch();
    return this.#feed().sync(after, limit, filter);
  }

  async ackFeed(id: FeedItemId, at: ThreadVersion): Promise<FeedAck> {
    await this.#checkEpoch();
    const feed = this.#feed();
    return this.ctx.storage.transactionSync(() => feed.ack(id, at));
  }

  override async alarm(): Promise<void> {
    // Retention waits for the directory (the principal may be deleted): unreachable, it is
    // tried again later rather than left to Cloudflare's few retries.
    try {
      await this.#checkEpoch();
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + EPOCH_RETRY_MS);
      return;
    }
    if (this.#retired()) return;
    const feed = this.#feed();
    const next = this.ctx.storage.transactionSync(() => {
      feed.retain();
      return feed.nextRetention();
    });
    if (next !== null) await this.ctx.storage.setAlarm(next);
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
      if (row?.lifecycle === "deleting" || row?.lifecycle === "deleted") this.#retireNow();
    }
    this.#epochChecked = true;
  }

  /**
   * Retires the feed of a principal being deleted: its items, purge marks
   * and evictions go, and from then on it takes nothing. Again, it changes
   * nothing.
   */
  async retire(): Promise<void> {
    await this.#checkEpoch();
    this.#retireNow();
  }

  #retireNow(): void {
    if (this.#retired()) return;
    this.ctx.storage.transactionSync(() => {
      for (const table of ["feed_items", "purge_marks", "feed_evictions"])
        this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      this.ctx.storage.sql.exec("UPDATE feed_meta SET items = 0 WHERE id = 1");
      this.ctx.storage.sql.exec(
        "INSERT INTO feed_retired (id, at) VALUES (1, ?) ON CONFLICT DO NOTHING",
        Date.now(),
      );
    });
    void this.ctx.storage.deleteAlarm();
  }

  /** Whether the feed was retired (read with no await before the write it guards). */
  #retired(): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM feed_retired").toArray().length > 0;
  }

  /** An alarm by the time retention is due; an earlier one is kept. */
  async #scheduleRetention(feed: Feed): Promise<void> {
    const at = feed.nextRetention();
    if (at === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}
