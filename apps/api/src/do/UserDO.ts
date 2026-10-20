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
  type SyncPosition,
  type ThreadVersion,
} from "./user/feed.js";

/**
 * One user or agent, by its principal id: its activity feed. Whoever reads
 * a feed (the principal, or agents acting for a user) is authorized by the
 * Worker, which also checks every item's repository at read time.
 */
export class UserDO extends MigratingDO {
  static readonly schema = userSchema;

  #feed(): Feed {
    return new Feed(this.ctx.storage.sql, () => Date.now());
  }

  /** Applies one batch of the principal's feed entries, in one transaction (see `Feed.apply`). */
  async applyFeed(entries: readonly FeedEntry[]): Promise<FeedApplied> {
    const feed = this.#feed();
    const applied = this.ctx.storage.transactionSync(() => feed.apply(entries));
    // Even with nothing shown changed: a tombstone may have been written.
    if (entries.length > 0) await this.#scheduleRetention(feed);
    return applied;
  }

  /** Forgets repositories the principal no longer reads (see `Feed.purge`). */
  async purge(purge: FeedPurge): Promise<{ deleted: number }> {
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
    const feed = this.#feed();
    const deleted = this.ctx.storage.transactionSync(() =>
      losses.reduce((sum, loss) => sum + feed.purge(loss), 0),
    );
    await this.#scheduleRetention(feed);
    return { deleted };
  }

  /** Forgets threads a read found gone for good (see `Feed.forgetThreads`), in one transaction. */
  forgetThreads(threads: readonly { readonly repoId: string; readonly threadKey: string }[]): {
    deleted: number;
  } {
    const feed = this.#feed();
    return { deleted: this.ctx.storage.transactionSync(() => feed.forgetThreads(threads)) };
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

  ackFeed(id: FeedItemId, at: ThreadVersion): FeedAck {
    const feed = this.#feed();
    return this.ctx.storage.transactionSync(() => feed.ack(id, at));
  }

  override async alarm(): Promise<void> {
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
      const row = await this.env.DIRECTORY.withSession("first-primary")
        .prepare("SELECT epoch_gen FROM source_epochs WHERE source_id = ?")
        .bind(feedEpochSource(principalId))
        .first<{ epoch_gen: number }>();
      if (row) this.#feed().takeEpoch(row.epoch_gen);
    }
    this.#epochChecked = true;
  }

  /** An alarm by the time retention is due; an earlier one is kept. */
  async #scheduleRetention(feed: Feed): Promise<void> {
    const at = feed.nextRetention();
    if (at === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}
