import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  type DomainEvent,
  eventKey,
  FEED_HORIZON_MS,
  type FeedBlock,
  FeedBlockSchema,
  type FeedEntry,
} from "@fyrden/domain";
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
 * and the feed queue's consumer deliver only what their invocation's calls allow.
 *
 * An account's `access.revoked` (principals no longer read some of its
 * repositories, at most 100 an event) becomes effects too, of at most 100
 * principals each (a transfer can name thousands): delivering one purges
 * those repositories from each principal's feed, up to when access was
 * lost, as the account had them at its ACL version. The event names every
 * repository (a member's removal names those the account held then), and
 * public repositories are left out of every purge: anyone still reads those.
 *
 * An event settling review requests carries the entries doing so in its
 * data (`resolutions`: blocks of at most 100 recipients, all they deliver
 * in them): an effect each, standing across a transfer of the repository,
 * since one who still reads it must not find a request open that ended.
 */

/** Principals one purge effect names at most (an event names up to 100 recipients too). */
export const PURGE_PRINCIPALS = 100;

/**
 * Calls to feeds (and page reads) under way at once while delivering a
 * batch, the next started as soon as one ends. A call takes 280 ms of wall
 * time at p50, 570 ms at p95, nearly all of it waiting (measured on Free,
 * 2026-10-22); Durable Object calls are not among those Cloudflare's
 * six-connection limit counts. Proposed.
 */
export const FEED_CALLS_IN_FLIGHT = 32;

/**
 * Runs `tasks` with at most `limit` under way at once, the next started as
 * soon as one ends, and answers their outcomes in order, as
 * `Promise.allSettled` does.
 */
export async function settledInPool<T>(
  tasks: readonly (() => PromiseLike<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(`a pool needs at least one task under way, not ${limit}`);
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const run = async () => {
    for (let i = next++; i < tasks.length; i = next++) {
      try {
        results[i] = { status: "fulfilled", value: await (tasks[i] as () => PromiseLike<T>)() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, run));
  return results;
}

/** What an event means for feeds, as its effect carries it. */
interface PlannedFeed {
  readonly repoId: string;
  readonly eventKey: string;
  readonly occurredAt: number;
  readonly actor: string | null;
  readonly epochGen: number;
  readonly feed: FeedBlock;
}

/**
 * A page of an event's further recipients, as its effect carries it: the
 * event (its block without recipients), the page as the manifest names it,
 * the ownership generation it was made under, and its deadline.
 */
interface PlannedPage extends Omit<PlannedFeed, "feed"> {
  readonly ownerGen: number;
  readonly deadline: number;
  readonly page: { readonly n: number; readonly count: number; readonly bytes: number };
  readonly feed: Omit<FeedBlock, "audience" | "pages" | "deadline">;
}

const RevokedSchema = z.object({
  principals: z.array(z.string().min(1)).min(1),
  repos: z.array(z.string().min(1)),
  acl_version: z.number().int().nonnegative(),
});

/** A purge of `repos`, as its effect carries it. */
interface PlannedPurge {
  readonly purge: {
    readonly accountId: string;
    readonly principals: readonly string[];
    readonly repos: readonly string[];
    readonly until: number;
    readonly epochGen: number;
    readonly aclVersion: number;
  };
}

const isPurge = (effect: Effect) => "purge" in effect.payload;
const isPage = (effect: Effect) => "page" in effect.payload;

/** An effect's entries to apply: the event, its block, and the recipients it names. */
interface Entries {
  readonly id: string;
  readonly event: Omit<PlannedFeed, "feed">;
  readonly feed: Omit<FeedBlock, "audience" | "pages" | "deadline">;
  readonly audience: readonly FeedEntry["recipient"][];
}

/** An event's effect's entries (the recipients it carries). */
function entriesOf(effect: Effect): Entries {
  const { feed: block, ...event } = effect.payload as unknown as PlannedFeed;
  const { audience, pages: _pages, deadline: _deadline, ...feed } = block;
  return { id: effect.id, event, feed, audience };
}

/** One call to a feed, and the effects it delivers part of. */
interface FeedCall {
  readonly effects: ReadonlySet<string>;
  readonly call: () => Promise<unknown>;
}

/** Each recipient's entries across the effects: one call each. */
function entryCalls(effects: readonly Entries[], env: Env): FeedCall[] {
  const recipients = new Map<string, { entries: FeedEntry[]; effects: Set<string> }>();
  for (const { id, event, feed, audience } of effects) {
    for (const recipient of audience) {
      const group = recipients.get(recipient.principal) ?? { entries: [], effects: new Set() };
      recipients.set(recipient.principal, group);
      group.entries.push({ ...event, feed, recipient });
      group.effects.add(id);
    }
  }
  return [...recipients].map(([principal, group]) => ({
    effects: group.effects,
    call: () => env.USER.getByName(principal).applyFeed(group.entries),
  }));
}

/**
 * Each purge's call to each principal's feed. One directory query finds
 * the public repositories, which every purge leaves out.
 */
async function purgeCalls(effects: readonly Effect[], env: Env): Promise<FeedCall[]> {
  const purges = effects.map((effect) => ({
    id: effect.id,
    ...(effect.payload as unknown as PlannedPurge).purge,
  }));
  if (purges.length === 0) return [];
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT id FROM repos WHERE id IN (SELECT value FROM json_each(?)) AND visibility = 'public'`,
    )
    .bind(JSON.stringify([...new Set(purges.flatMap((p) => p.repos))]))
    .all<{ id: string }>();
  const open = new Set(results.map((row) => row.id));
  return purges.flatMap((purge) => {
    const repoIds = purge.repos.filter((id) => !open.has(id));
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

/**
 * The id of a page's effect or a settlement's (`effectId`: the event key,
 * the sink, the target `page:<n>` or `res:<n>`): up to 100 calls each.
 */
const PAGE_ID = /:feed:(page|res):\d+$/;

export const feedSink: EffectSink = {
  name: "feed",
  // An entry is never given up on while feeds would keep it: retried until then (see the journal).
  horizonMs: FEED_HORIZON_MS,
  // Delivered in one batch, a call per recipient (100 at most each): within an invocation's calls.
  perMessage: 8,
  // A page of further recipients (up to 100 calls) alone, so an event's pages go side by side.
  alone: (id: string) => PAGE_ID.test(id),
  inline: true,
  // A page goes to the queue: an event carrying one has more recipients than an invocation's share
  // (so do an event's settlements).
  inlineable: (planned: PlannedEffect) =>
    !("page" in planned.payload) && planned.acrossTransfers !== true,

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
              repos: data.repos,
              until: event.at,
              epochGen: event.id.epochGen,
              aclVersion: data.acl_version,
            },
          } satisfies PlannedPurge,
        }),
      );
    }
    // A block's further pages (`pages`) are read and delivered by later versions; this one
    // delivers the recipients the event carries, so it is no version to go back to once
    // events with pages are made.
    const settling = settlementsOf(event);
    if (!event.feed || event.feed.audience.length === 0) return settling;
    const about = {
      repoId: event.id.sourceId,
      eventKey: eventKey(event.id),
      occurredAt: event.at,
      actor: event.actor,
      epochGen: event.id.epochGen,
    };
    const { audience: _audience, pages = [], deadline, ...feed } = event.feed;
    return [
      { target: "feed", payload: { ...about, feed: event.feed } satisfies PlannedFeed },
      // Each further page an effect of its own: its own attempts, its own outcome.
      ...(deadline === undefined
        ? []
        : pages.map((page) => ({
            target: `page:${page.n}`,
            payload: {
              ...about,
              ownerGen: event.ownerGen,
              deadline,
              page,
              feed,
            } satisfies PlannedPage,
          }))),
      ...settling,
    ];
  },

  async deliver(effect: Effect, env: Env): Promise<void> {
    const { error, delivered, ended } = await deliverFeeds([effect], env, Date.now());
    if (delivered.length === 0) throw error ?? new Error(ended?.[0]?.reason ?? "not delivered");
  },

  deliverBatch: (
    effects: readonly Effect[],
    env: Env,
    _db: D1Database,
    metrics?: Metrics,
    now = Date.now(),
  ) => deliverFeeds(effects, env, now, metrics),

  /**
   * One call per recipient of an event, or per principal a purge names; a
   * page's, one more to read it.
   */
  calls(planned: PlannedEffect): number {
    const payload = planned.payload as unknown as PlannedFeed | PlannedPurge | PlannedPage;
    if ("purge" in payload) return payload.purge.principals.length;
    if ("page" in payload) return 1 + payload.page.count;
    return payload.feed.audience.length;
  },
};

/**
 * The effects of an event's settlements (`data.resolutions`), one a block,
 * each standing across a transfer. A block that is not one (a stored
 * event whose data is gone, or any other shape) is no effect.
 */
function settlementsOf(event: DomainEvent): PlannedEffect[] {
  const blocks = event.data?.resolutions;
  if (!Array.isArray(blocks)) return [];
  const about = {
    repoId: event.id.sourceId,
    eventKey: eventKey(event.id),
    occurredAt: event.at,
    actor: event.actor,
    epochGen: event.id.epochGen,
  };
  return blocks.flatMap((block, i) => {
    const parsed = FeedBlockSchema.safeParse(block);
    if (!parsed.success || parsed.data.audience.length === 0) return [];
    return [
      {
        target: `res:${i + 1}`,
        payload: { ...about, feed: parsed.data } satisfies PlannedFeed,
        acrossTransfers: true,
      },
    ];
  });
}

/**
 * The effects' calls to feeds, several under way at once. An effect is delivered when
 * every call it takes part in succeeded.
 */
async function deliverFeeds(
  effects: readonly Effect[],
  env: Env,
  now: number,
  metrics?: Metrics,
): Promise<BatchDelivery> {
  // Each failed effect with the first error that stopped it; those ended, with why.
  const failed = new Map<string, unknown>();
  const ended = new Map<string, string>();
  let error: unknown;
  const pageEffects = effects.filter(isPage);
  let started = Date.now();
  const pages = await readPages(pageEffects, env, now, failed, ended);
  const pagesMs = Date.now() - started;
  if (pageEffects.length > 0) metrics?.count("feed.stage_ms", { stage: "pages" }, pagesMs);
  error = [...failed.values()][0];
  const calls = entryCalls(
    [...effects.filter((effect) => !isPurge(effect) && !isPage(effect)).map(entriesOf), ...pages],
    env,
  );
  const purges = effects.filter(isPurge);
  try {
    calls.push(...(await purgeCalls(purges, env)));
  } catch (cause) {
    error = cause;
    for (const effect of purges) if (!failed.has(effect.id)) failed.set(effect.id, cause);
  }
  started = Date.now();
  const results = await settledInPool(
    calls.map((call) => call.call),
    FEED_CALLS_IN_FLIGHT,
  );
  results.forEach((result, i) => {
    if (result.status === "fulfilled") return;
    error ??= result.reason;
    for (const id of calls[i]?.effects ?? []) if (!failed.has(id)) failed.set(id, result.reason);
  });
  const callsMs = Date.now() - started;
  if (calls.length > 0) metrics?.count("feed.stage_ms", { stage: "calls" }, callsMs);
  createLogger({ op: "feed.deliver" }).info("feeds delivered", {
    effects: effects.length,
    pages: pageEffects.length,
    calls: calls.length,
    pagesMs,
    callsMs,
  });
  return {
    delivered: effects.map((effect) => effect.id).filter((id) => !failed.has(id) && !ended.has(id)),
    ended: [...ended].map(([id, reason]) => ({ ids: [id], reason })),
    failures: [...failed].map(([id, cause]) => ({ ids: [id], error: cause })),
    ...(error !== undefined && { error }),
  };
}

/**
 * The page effects' recipients, read from their repositories several at
 * once. A page past its deadline is ended unread (entries that old are
 * dropped on arrival); one its repository no longer holds as the event's
 * (deleted, restored or transferred since: `invalidated:`; or gone) or
 * that is not what the manifest names, ended; one that could not be read,
 * failed (tried again).
 */
async function readPages(
  effects: readonly Effect[],
  env: Env,
  now: number,
  failed: Map<string, unknown>,
  ended: Map<string, string>,
): Promise<Entries[]> {
  const read: Entries[] = [];
  const due = effects.filter((effect) => {
    const { deadline } = effect.payload as unknown as PlannedPage;
    if (now <= deadline) return true;
    ended.set(effect.id, "expired: past the feed's delivery deadline");
    return false;
  });
  const results = await settledInPool(
    due.map((effect) => async () => {
      const p = effect.payload as unknown as PlannedPage;
      return await env.REPO.getByName(p.repoId).feedAudiencePage({
        eventKey: p.eventKey,
        page: p.page.n,
        epochGen: p.epochGen,
        ownerGen: p.ownerGen,
      });
    }),
    FEED_CALLS_IN_FLIGHT,
  );
  results.forEach((result, i) => {
    const effect = due[i] as Effect;
    const {
      page,
      deadline: _deadline,
      ownerGen: _ownerGen,
      feed,
      ...event
    } = effect.payload as unknown as PlannedPage;
    if (result.status === "rejected") {
      failed.set(effect.id, result.reason);
      return;
    }
    const answer = result.value;
    if ("missing" in answer) {
      ended.set(
        effect.id,
        answer.missing === "absent"
          ? "page missing: absent"
          : `invalidated: page missing: its source was ${answer.missing}`,
      );
      return;
    }
    if (answer.recipients.length !== page.count || answer.bytes !== page.bytes) {
      ended.set(effect.id, "page missing: not the page its manifest names");
      return;
    }
    read.push({ id: effect.id, event, feed, audience: answer.recipients });
  });
  return read;
}
