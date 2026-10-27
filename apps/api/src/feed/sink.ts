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
import { type FeedApplied, PURGE_REPOS } from "../do/user/feed.js";
import { DISCRETIONARY_WINDOW_MS, type ResourceVector } from "../effects/discretionary.js";
import type { BatchDelivery, Effect, EffectSink, PlannedEffect } from "../effects/journal.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";

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
 * principals and `PURGE_REPOS` repositories each (a transfer can name
 * thousands of principals; an effect planned earlier naming more
 * repositories is delivered as its children instead): delivering one purges
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

/**
 * A watched entry's worst case, priced when its effect is admitted
 * (Proposed; measured locally, 2026-10-27). Per recipient: its feed's call
 * (a new item at its stream's cap: 122 rows read, 15 written; a fresh
 * feed's creation: 33 read, 24 written; the epoch's adoption and the
 * alarm a few more), the item's later deletion, half a second of the
 * object's time, and its cold read of the directory (two rows). Per
 * effect: its journal row's life at its worst (inserted, sent, sent again
 * by the effects cron, claimed and given back, ended, pruned, with their
 * indexes: 53 rows read and 20 written, measured locally; its admission
 * reads up to 26 hours' rows more), and a queue message and one sent
 * again by the effects cron, whether it goes inline or not.
 */
export const WATCH_PRICE = {
  recipient: {
    do_requests: 1,
    do_rows_read: 170,
    do_rows_written: 34,
    do_duration_ms: 500,
    d1_rows_read: 2,
  },
  effect: { d1_rows_read: 100, d1_rows_written: 24, queue_ops: 6 },
} as const;

/** The price of a watch effect telling `n` watchers. */
export function watchPrice(n: number): ResourceVector {
  const { recipient: r, effect: e } = WATCH_PRICE;
  return {
    do_requests: r.do_requests * n,
    do_rows_read: r.do_rows_read * n,
    do_rows_written: r.do_rows_written * n,
    do_duration_ms: r.do_duration_ms * n,
    d1_rows_read: e.d1_rows_read + r.d1_rows_read * n,
    d1_rows_written: e.d1_rows_written,
    queue_ops: e.queue_ops,
  };
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

/** `repos` in chunks of `PURGE_REPOS` (one chunk, empty, for none). */
const repoChunks = (repos: readonly string[]): string[][] =>
  repos.length === 0
    ? [[]]
    : Array.from({ length: Math.ceil(repos.length / PURGE_REPOS) }, (_, n) =>
        repos.slice(n * PURGE_REPOS, (n + 1) * PURGE_REPOS),
      );

/**
 * Journals the children of purge effects planned before purges named at
 * most `PURGE_REPOS` repositories: one each of `PURGE_REPOS` repositories,
 * with the ids the planner now gives (`<parent>:r<n>`), copied from the
 * parent's row (its source, generations, journaling time and delivery
 * deadline), overdue for the effects cron to send. A child already there
 * is kept (a retry, or the event delivered again under the new planner).
 */
async function journalChildren(
  db: D1Database,
  parents: readonly Effect[],
  now: number,
  metrics?: Metrics,
): Promise<void> {
  const statements = parents.flatMap((parent) => {
    const { purge } = parent.payload as unknown as PlannedPurge;
    return repoChunks(purge.repos).map((repos, n) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO effects (effect_id, sink, target, payload, next_attempt_at,
             created_at, source_id, epoch_gen, owner_gen, any_owner, recover_at, deliver_until)
           SELECT ?2, sink, ?3, ?4, ?5, created_at, source_id, epoch_gen, owner_gen, any_owner, ?5,
             deliver_until
           FROM effects WHERE effect_id = ?1`,
        )
        .bind(
          parent.id,
          `${parent.id}:r${n}`,
          `${parent.target}:r${n}`,
          JSON.stringify({ purge: { ...purge, repos } } satisfies PlannedPurge),
          now,
        ),
    );
  });
  if (statements.length === 0) return;
  metrics?.count("d1.query", { db: "org", op: "feed_purge_children" }, statements.length);
  await db.batch(statements);
}
const isPage = (effect: Effect) => "page" in effect.payload;

/** An effect's entries to apply: the event, its block, and the recipients it names. */
interface Entries {
  readonly id: string;
  readonly event: Omit<PlannedFeed, "feed">;
  readonly feed: Omit<FeedBlock, "audience" | "pages" | "deadline" | "watchers">;
  readonly audience: readonly FeedEntry["recipient"][];
  /** A watch effect's window's end: its entries are dropped past it. */
  readonly until?: number;
}

/** A watch effect (its watched entries, admitted against the day's allowance). */
const isWatch = (effect: Effect) => effect.target === "watch";

/** An event's effect's entries (the recipients it carries). */
function entriesOf(effect: Effect): Entries {
  const { feed: block, ...event } = effect.payload as unknown as PlannedFeed;
  const { audience, pages: _pages, deadline: _deadline, watchers: _watchers, ...feed } = block;
  return {
    id: effect.id,
    event,
    feed,
    audience,
    ...(isWatch(effect) && effect.deliverUntil !== undefined && { until: effect.deliverUntil }),
  };
}

/**
 * One call to a feed, the effects it delivers part of, and, of those,
 * the watch effects by their event's key (one an event).
 */
interface FeedCall {
  readonly effects: ReadonlySet<string>;
  readonly watches: ReadonlyMap<string, string>;
  readonly call: () => Promise<unknown>;
}

/**
 * Each recipient's entries across the effects: one call each. A call
 * leaves out watched entries whose window passed before it starts, and
 * starts not at all when nothing else is left; it answers those entries'
 * events as expired, as the feed answers its own (see `UserDO.applyFeed`).
 */
function entryCalls(effects: readonly Entries[], env: Env): FeedCall[] {
  type Group = { entries: FeedEntry[]; effects: Set<string>; watches: Map<string, string> };
  const recipients = new Map<string, Group>();
  for (const { id, event, feed, audience, until } of effects) {
    for (const recipient of audience) {
      const group: Group = recipients.get(recipient.principal) ?? {
        entries: [],
        effects: new Set(),
        watches: new Map(),
      };
      recipients.set(recipient.principal, group);
      group.entries.push({ ...event, feed, recipient, ...(until !== undefined && { until }) });
      group.effects.add(id);
      if (until !== undefined) group.watches.set(event.eventKey, id);
    }
  }
  return [...recipients].map(([principal, group]) => ({
    effects: group.effects,
    watches: group.watches,
    call: async (): Promise<FeedApplied> => {
      const now = Date.now();
      const late = (e: FeedEntry) => e.until !== undefined && e.until <= now;
      const expired = [...new Set(group.entries.filter(late).map((e) => e.eventKey))];
      const entries = group.entries.filter((e) => !late(e));
      const applied: FeedApplied =
        entries.length > 0
          ? await env.USER.getByName(principal).applyFeed(entries)
          : { changed: 0, notified: 0 };
      return { ...applied, expired: [...expired, ...(applied.expired ?? [])] };
    },
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
      watches: new Map(),
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
      // A bounded number of feeds and repositories an effect: one delivery never makes more
      // calls than that, nor any call more work.
      return Array.from(
        { length: Math.ceil(data.principals.length / PURGE_PRINCIPALS) },
        (_, part) =>
          repoChunks(data.repos).map((repos, n) => ({
            target: `purge:${part}:r${n}`,
            payload: {
              purge: {
                accountId: event.id.sourceId,
                principals: data.principals.slice(
                  part * PURGE_PRINCIPALS,
                  (part + 1) * PURGE_PRINCIPALS,
                ),
                repos,
                until: event.at,
                epochGen: event.id.epochGen,
                aclVersion: data.acl_version,
              },
            } satisfies PlannedPurge,
          })),
      ).flat();
    }
    // A block's further pages (`pages`) are read and delivered by later versions; this one
    // delivers the recipients the event carries, so it is no version to go back to once
    // events with pages are made.
    const settling = settlementsOf(event);
    if (!event.feed) return settling;
    const about = {
      repoId: event.id.sourceId,
      eventKey: eventKey(event.id),
      occurredAt: event.at,
      actor: event.actor,
      epochGen: event.id.epochGen,
    };
    const { watchers = [], ...block } = event.feed;
    const { audience, pages = [], deadline, ...feed } = block;
    return [
      ...(audience.length === 0
        ? []
        : [{ target: "feed", payload: { ...about, feed: block } satisfies PlannedFeed }]),
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
      // Its watchers' entries, discretionary: journaled only when the day's allowance admits them,
      // delivered once within their window.
      ...(watchers.length === 0
        ? []
        : [
            {
              target: "watch",
              payload: { ...about, feed: { ...feed, audience: watchers } } satisfies PlannedFeed,
              admission: {
                price: watchPrice(watchers.length),
                maxAttempts: 1,
                windowMs: DISCRETIONARY_WINDOW_MS,
                warnMs: FEED_HORIZON_MS,
              },
            },
          ]),
      ...settling,
    ];
  },

  async deliver(effect: Effect, env: Env): Promise<void> {
    const { error, delivered, ended } = await deliverFeeds(
      [effect],
      env,
      readModelFor(env, DEFAULT_ORG_SHARD),
      Date.now(),
    );
    if (delivered.length === 0) throw error ?? new Error(ended?.[0]?.reason ?? "not delivered");
  },

  deliverBatch: (
    effects: readonly Effect[],
    env: Env,
    db: D1Database,
    metrics?: Metrics,
    now = Date.now(),
  ) => deliverFeeds(effects, env, db, now, metrics),

  /**
   * One call per recipient of an event, or per principal a purge names; a
   * page's, one more to read it.
   */
  calls(planned: PlannedEffect): number {
    const payload = planned.payload as unknown as PlannedFeed | PlannedPurge | PlannedPage;
    // An earlier planner's purge of more repositories: its children's journal write only.
    if ("purge" in payload)
      return payload.purge.repos.length > PURGE_REPOS ? 1 : payload.purge.principals.length;
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
  db: D1Database,
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
  // A watch effect any of whose entries came past its window: ended (its one attempt), whatever
  // its other recipients' calls did.
  const expired = new Set<string>();
  // A purge planned before purges named at most `PURGE_REPOS` repositories: delivered as its
  // children, journaled now (each then bounded); the parent is done once they are.
  const legacy = effects.filter(
    (effect) =>
      isPurge(effect) &&
      (effect.payload as unknown as PlannedPurge).purge.repos.length > PURGE_REPOS,
  );
  try {
    await journalChildren(db, legacy, now, metrics);
  } catch (cause) {
    error = cause;
    for (const effect of legacy) failed.set(effect.id, cause);
  }
  const purges = effects.filter((effect) => isPurge(effect) && !legacy.includes(effect));
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
    const call = calls[i];
    if (result.status === "fulfilled") {
      for (const key of (result.value as FeedApplied | undefined)?.expired ?? []) {
        const id = call?.watches.get(key);
        if (id !== undefined) expired.add(id);
      }
      return;
    }
    error ??= result.reason;
    for (const id of call?.effects ?? []) if (!failed.has(id)) failed.set(id, result.reason);
  });
  for (const id of expired)
    if (!failed.has(id)) ended.set(id, "expired: past its admission window");
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
