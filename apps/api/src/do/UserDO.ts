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

  listFeed(since: FeedPosition | null, limit: number, filter: FeedFilter): FeedPage {
    return this.#feed().list(since, limit, filter);
  }

  syncFeed(): { head: FeedPosition; items: FeedItem[]; complete: boolean } {
    return this.#feed().sync();
  }

  ackFeed(id: FeedItemId, version: number): FeedAck {
    const feed = this.#feed();
    return this.ctx.storage.transactionSync(() => feed.ack(id, version));
  }

  override async alarm(): Promise<void> {
    const feed = this.#feed();
    const next = this.ctx.storage.transactionSync(() => {
      feed.retain();
      return feed.nextRetention();
    });
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  /** An alarm by the time retention is due; an earlier one is kept. */
  async #scheduleRetention(feed: Feed): Promise<void> {
    const at = feed.nextRetention();
    if (at === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}
