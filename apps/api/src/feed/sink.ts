import { type DomainEvent, eventKey, type FeedBlock, type FeedEntry } from "@fyrden/domain";
import type { BatchDelivery, Effect, EffectSink, PlannedEffect } from "../effects/journal.js";

/*
 * Activity feed entries from events. The repository decides, with the
 * change, what an event means for whose feed (its `feed` block, at most
 * 100 recipients); the sink plans one effect per such event, its payload
 * the block and the event's key, repository, time and actor, and no row
 * per recipient. Delivered together, the effects' entries are grouped by
 * recipient: one call to each principal's feed applies all its entries,
 * however many events name it. A feed applies an entry once however often
 * it comes, so a retried effect changes nothing it already changed. With
 * the dispatcher's batches (two effects inline, four a sweep), one
 * delivery makes at most 400 calls, of the 1,000 an invocation may.
 */

/** Feeds called at once while delivering a batch. Proposed. */
const PARALLEL_FEEDS = 10;

/** What an event means for feeds, as its effect carries it. */
interface PlannedFeed {
  readonly repoId: string;
  readonly eventKey: string;
  readonly occurredAt: number;
  readonly actor: string | null;
  readonly feed: FeedBlock;
}

/** Each recipient's entries across the effects, with the effects that name it. */
function byRecipient(effects: readonly Effect[]) {
  const recipients = new Map<string, { entries: FeedEntry[]; effects: Set<string> }>();
  for (const effect of effects) {
    const { feed: block, ...event } = effect.payload as unknown as PlannedFeed;
    const { audience, ...feed } = block;
    for (const recipient of audience) {
      const group = recipients.get(recipient.principal) ?? { entries: [], effects: new Set() };
      recipients.set(recipient.principal, group);
      group.entries.push({ ...event, feed, recipient });
      group.effects.add(effect.id);
    }
  }
  return recipients;
}

export const feedSink: EffectSink = {
  name: "feed",

  plan(event: DomainEvent): readonly PlannedEffect[] {
    if (!event.feed || event.feed.audience.length === 0) return [];
    return [
      {
        target: "feed",
        payload: {
          repoId: event.id.sourceId,
          eventKey: eventKey(event.id),
          occurredAt: event.at,
          actor: event.actor,
          feed: event.feed,
        } satisfies PlannedFeed,
      },
    ];
  },

  async deliver(effect: Effect, env: Env): Promise<void> {
    const { error, delivered } = await deliverFeeds([effect], env);
    if (delivered.length === 0) throw error;
  },

  deliverBatch: (effects: readonly Effect[], env: Env) => deliverFeeds(effects, env),
};

/**
 * One `applyFeed` call per recipient of the effects. An effect is
 * delivered when every recipient it names applied its entries.
 */
async function deliverFeeds(effects: readonly Effect[], env: Env): Promise<BatchDelivery> {
  const groups = [...byRecipient(effects)];
  const failed = new Set<string>();
  let error: unknown;
  for (let at = 0; at < groups.length; at += PARALLEL_FEEDS) {
    const slice = groups.slice(at, at + PARALLEL_FEEDS);
    const results = await Promise.allSettled(
      slice.map(([principal, group]) => env.USER.getByName(principal).applyFeed(group.entries)),
    );
    results.forEach((result, i) => {
      if (result.status === "fulfilled") return;
      error ??= result.reason;
      for (const id of slice[i]?.[1].effects ?? []) failed.add(id);
    });
  }
  return {
    delivered: effects.map((effect) => effect.id).filter((id) => !failed.has(id)),
    ...(error !== undefined && { error }),
  };
}
