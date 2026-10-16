import { type DomainEvent, eventKey, type FeedBlock, type FeedEntry } from "@fyrden/domain";
import { z } from "zod";
import type { BatchDelivery, Effect, EffectSink, PlannedEffect } from "../effects/journal.js";

/*
 * Activity feed entries from events. The repository decides, with the
 * change, what an event means for whose feed (its `feed` block, at most
 * 100 recipients); the sink plans one effect per such event, its payload
 * the block and the event's key, repository, time and actor, and no row
 * per recipient. Delivered together, the effects' entries are grouped by
 * recipient: one call to each principal's feed applies all its entries,
 * however many events name it. A feed applies an entry once however often
 * it comes, so a retried effect changes nothing it already changed. The
 * sink says how many calls an effect makes at most, so the events consumer
 * delivers itself only what its invocation's calls allow (the sweeper
 * takes four effects a run, at most 400 calls).
 *
 * An account's `access.revoked` (principals no longer read some of its
 * repositories) becomes effects too, of at most 100 principals each (a
 * transfer can name thousands): delivering one purges those repositories
 * from each principal's feed, up to when access was lost, as the account
 * had them at its ACL version. "All but these" is resolved then, from the
 * directory (the account's repositories but the exceptions), and public
 * repositories are left out of every purge: anyone still reads those.
 */

/** Principals one purge effect names at most (an event names up to 100 recipients too). */
export const PURGE_PRINCIPALS = 100;

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

const RevokedSchema = z.union([
  z.object({
    principals: z.array(z.string().min(1)).min(1),
    repos: z.array(z.string().min(1)),
    acl_version: z.number().int().nonnegative(),
  }),
  z.object({
    principals: z.array(z.string().min(1)).min(1),
    all_except: z.array(z.string().min(1)),
    acl_version: z.number().int().nonnegative(),
  }),
]);

/** A purge, as its effect carries it: of `repos`, or of all the account's but `allExcept`. */
interface PlannedPurge {
  readonly purge: {
    readonly accountId: string;
    readonly principals: readonly string[];
    readonly repos: readonly string[] | null;
    readonly allExcept: readonly string[] | null;
    readonly until: number;
    readonly epochGen: number;
    readonly aclVersion: number;
  };
}

const isPurge = (effect: Effect) => "purge" in effect.payload;

/** One call to a feed, and the effects it delivers part of. */
interface FeedCall {
  readonly effects: ReadonlySet<string>;
  readonly call: () => Promise<unknown>;
}

/** Each recipient's entries across the effects: one call each. */
function entryCalls(effects: readonly Effect[], env: Env): FeedCall[] {
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
  return [...recipients].map(([principal, group]) => ({
    effects: group.effects,
    call: () => env.USER.getByName(principal).applyFeed(group.entries),
  }));
}

/**
 * Each purge's call to each principal's feed. One directory query resolves
 * "all but" and finds the public repositories, which every purge leaves out.
 */
async function purgeCalls(effects: readonly Effect[], env: Env): Promise<FeedCall[]> {
  const purges = effects.map((effect) => ({
    id: effect.id,
    ...(effect.payload as unknown as PlannedPurge).purge,
  }));
  const accounts = [...new Set(purges.filter((p) => p.repos === null).map((p) => p.accountId))];
  const listed = [...new Set(purges.flatMap((p) => p.repos ?? []))];
  const owned = new Map<string, string[]>();
  const open = new Set<string>();
  if (purges.length > 0) {
    const { results } = await env.DIRECTORY.withSession("first-primary")
      .prepare(
        `SELECT id, owner_id, visibility FROM repos
         WHERE owner_id IN (SELECT value FROM json_each(?1))
           OR id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(JSON.stringify(accounts), JSON.stringify(listed))
      .all<{ id: string; owner_id: string; visibility: string }>();
    for (const row of results) {
      if (row.visibility === "public") open.add(row.id);
      else owned.set(row.owner_id, [...(owned.get(row.owner_id) ?? []), row.id]);
    }
  }
  return purges.flatMap((purge) => {
    const repoIds = (
      purge.repos ??
      (owned.get(purge.accountId) ?? []).filter((id) => !purge.allExcept?.includes(id))
    ).filter((id) => !open.has(id));
    if (repoIds.length === 0) return [];
    return purge.principals.map((principal) => ({
      effects: new Set([purge.id]),
      call: () =>
        env.USER.getByName(principal).purge({
          repoIds,
          until: purge.until,
          accountId: purge.accountId,
          epochGen: purge.epochGen,
          aclVersion: purge.aclVersion,
        }),
    }));
  });
}

export const feedSink: EffectSink = {
  name: "feed",

  plan(event: DomainEvent): readonly PlannedEffect[] {
    if (event.type === "access.revoked") {
      // A stored event whose data is gone, or any other shape: nothing to purge by.
      const revoked = RevokedSchema.safeParse(event.data);
      if (!revoked.success) return [];
      const data = revoked.data;
      // A bounded number of feeds an effect: one delivery never makes more calls than that.
      return Array.from(
        { length: Math.ceil(data.principals.length / PURGE_PRINCIPALS) },
        (_, part) => ({
          target: `purge:${part}`,
          payload: {
            purge: {
              accountId: event.id.sourceId,
              principals: data.principals.slice(
                part * PURGE_PRINCIPALS,
                (part + 1) * PURGE_PRINCIPALS,
              ),
              repos: "repos" in data ? data.repos : null,
              allExcept: "all_except" in data ? data.all_except : null,
              until: event.at,
              epochGen: event.id.epochGen,
              aclVersion: data.acl_version,
            },
          } satisfies PlannedPurge,
        }),
      );
    }
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

  /** One call per recipient of an event, or per principal a purge names. */
  calls(planned: PlannedEffect): number {
    const payload = planned.payload as unknown as PlannedFeed | PlannedPurge;
    return "purge" in payload ? payload.purge.principals.length : payload.feed.audience.length;
  },
};

/**
 * The effects' calls to feeds, a few at once. An effect is delivered when
 * every call it takes part in succeeded.
 */
async function deliverFeeds(effects: readonly Effect[], env: Env): Promise<BatchDelivery> {
  const failed = new Set<string>();
  let error: unknown;
  const calls = entryCalls(
    effects.filter((effect) => !isPurge(effect)),
    env,
  );
  const purges = effects.filter(isPurge);
  try {
    calls.push(...(await purgeCalls(purges, env)));
  } catch (cause) {
    error = cause;
    for (const effect of purges) failed.add(effect.id);
  }
  for (let at = 0; at < calls.length; at += PARALLEL_FEEDS) {
    const slice = calls.slice(at, at + PARALLEL_FEEDS);
    const results = await Promise.allSettled(slice.map((call) => call.call()));
    results.forEach((result, i) => {
      if (result.status === "fulfilled") return;
      error ??= result.reason;
      for (const id of slice[i]?.effects ?? []) failed.add(id);
    });
  }
  return {
    delivered: effects.map((effect) => effect.id).filter((id) => !failed.has(id)),
    ...(error !== undefined && { error }),
  };
}
