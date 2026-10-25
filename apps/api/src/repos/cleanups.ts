import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { readModelFor } from "../events/read-model.js";
import { clock } from "../services.js";

/*
 * What a deleted repository left outside its own storage, removed by its
 * deletion before that storage goes (the `cleanup` step, after the
 * tombstone is in the read model and before the erase). Each cleanup is
 * idempotent and works a page at a time, always from the start of what is
 * left, so one interrupted anywhere resumes by running again; once it
 * finds nothing left it is recorded as done (`repo_deletion_cleanups`)
 * and not run again. A cleanup may also wait (the deletion goes to the back
 * of the cron's queue and tries again later).
 *
 * Nothing new of the repository gets in meanwhile: once its tombstone is
 * in the read model, the journal takes no effect of it and the webhook
 * sink makes no delivery of it (and removes a body it stored as the
 * tombstone arrived). Effects being delivered when the cleanups start are
 * waited for, so no delivery is still being made when its rows and bodies
 * are removed: first until no invocation that claimed one of its webhook
 * effects can still be running (a claim can outlive its lease), then until
 * no effect of it is claimed.
 */

/** Proposed values. */
export const CLEANUP_POLICY = {
  /**
   * Pages one deletion call works through: each takes up to three internal
   * calls (D1 or R2), plus one to read what is done and one to record each
   * cleanup finished: at most 25 calls a deletion, 250 for the cron's ten,
   * of an invocation's 1,000. One page of each cleanup: a repository with
   * little to clean up is cleaned up in one call.
   */
  pagesPerCall: 6,
  /** Journaled effects deleted a page. */
  effectsPage: 500,
  /** Webhook deliveries (and their attempts) deleted a page. */
  deliveriesPage: 200,
  /** Search projection rows deleted a page, of each table. */
  searchPage: 500,
  /** Webhook bodies deleted a page (one R2 delete takes up to 1,000 keys). */
  bodiesPage: 1_000,
  /**
   * How long after a webhook effect ended (made, failed or ended by the
   * deletion) the invocation that claimed it may still be running: a queue
   * consumer invocation's wall-time limit, 15 minutes
   * (https://developers.cloudflare.com/queues/platform/limits/).
   */
  settleMs: 15 * 60_000,
};

export interface CleanupTarget {
  readonly repoId: string;
  /** The org shard its read model, effects and deliveries are in. */
  readonly shard: string;
  /** The deletion's generation: a cleanup done in an earlier one runs again (see `repo_deletions`). */
  readonly gen: number;
}

/** After a page: nothing is left, more is, or what is left cannot go yet. */
export type PageOutcome = "done" | "more" | "wait";

export interface RepoCleanup {
  /** Recorded once done; never renamed (a deletion under way would run it again). */
  readonly name: string;
  /** Removes one page. */
  page(env: Env, target: CleanupTarget, metrics?: Metrics): Promise<PageOutcome>;
}

const pageOutcome = (removed: number, page: number): PageOutcome =>
  removed < page ? "done" : "more";

/** The repository's effects, through the primary key: `<repo>:` up to, not including, `<repo>;`. */
const OURS = "effect_id >= ?1 || ':' AND effect_id < ?1 || ';'";

/**
 * The repository's webhook effects, settled: none can still be making
 * deliveries or storing bodies. Pending ones are ended (a page at a time),
 * as their next claim would end them, so none is claimed again; one claimed
 * now is waited for until it ends. Whoever claimed one did so before it
 * ended, and is stopped within `settleMs` of its claim, so the wait lasts
 * until `settleMs` after the last of those ever claimed ended. Effects
 * journaled before claims were counted as attempts (no source recorded) are
 * taken as claimed. Most repositories have none claimed lately and do not
 * wait. Reads all the repository's webhook effects a call while it waits.
 */
const webhookEffects: RepoCleanup = {
  name: "webhook_effects",
  async page(env, { repoId, shard }, metrics) {
    const db = readModelFor(env, shard);
    const now = clock();
    const ours = `${OURS} AND sink = 'webhooks'`;
    const claimed = `${ours} AND (attempts > 0 OR source_id IS NULL)`;
    metrics?.count("d1.query", { db: "org", op: "cleanup_settle_effects" }, 2);
    const [ending, settled] = await db.batch<{ held: number; ended: number | null }>([
      db
        .prepare(
          `UPDATE effects SET state = 'failed', next_attempt_at = ?2, lease_token = NULL,
             lease_until = NULL, last_error = 'invalidated: its source was deleted'
           WHERE effect_id IN (SELECT effect_id FROM effects WHERE ${ours} AND state = 'pending'
             AND (lease_until IS NULL OR lease_until <= ?2) LIMIT ?3)`,
        )
        .bind(repoId, now, CLEANUP_POLICY.effectsPage),
      db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM effects WHERE ${ours} AND state = 'pending') AS held,
             (SELECT max(CASE state WHEN 'done' THEN done_at ELSE next_attempt_at END)
                FROM effects WHERE ${claimed} AND state <> 'pending') AS ended`,
        )
        .bind(repoId),
    ]);
    const invalidated = ending?.meta.changes ?? 0;
    if (invalidated > 0) metrics?.count("effects.invalidated", { sink: "webhooks" }, invalidated);
    if (invalidated === CLEANUP_POLICY.effectsPage) return "more";
    const { held, ended } = settled?.results[0] ?? { held: 0, ended: null };
    if (held === 1) return "wait";
    return ended !== null && ended + CLEANUP_POLICY.settleMs > now ? "wait" : "done";
  },
};

/**
 * The repository's journaled effects, whatever their state (their ids
 * start with its event keys). One a delivery holds (leased) is waited for:
 * the delivery may still be making webhook deliveries and storing bodies.
 */
const journaledEffects: RepoCleanup = {
  name: "effects",
  async page(env, { repoId, shard }, metrics) {
    const db = readModelFor(env, shard);
    const unleased = "(lease_until IS NULL OR lease_until <= ?3)";
    metrics?.count("d1.query", { db: "org", op: "cleanup_effects" }, 2);
    const [deleted, rest] = await db.batch<{ remaining: number }>([
      db
        .prepare(
          `DELETE FROM effects WHERE effect_id IN
             (SELECT effect_id FROM effects WHERE ${OURS} AND ${unleased} LIMIT ?2)`,
        )
        .bind(repoId, CLEANUP_POLICY.effectsPage, clock()),
      // After a page that was not full, any effect left is leased.
      db.prepare(`SELECT EXISTS (SELECT 1 FROM effects WHERE ${OURS}) AS remaining`).bind(repoId),
    ]);
    const outcome = pageOutcome(deleted?.meta.changes ?? 0, CLEANUP_POLICY.effectsPage);
    return outcome === "done" && rest?.results[0]?.remaining === 1 ? "wait" : outcome;
  },
};

/** Its webhook deliveries and their attempts (the bodies go after, by their prefix). */
const webhookDeliveries: RepoCleanup = {
  name: "webhook_deliveries",
  async page(env, { repoId, shard }, metrics) {
    const db = readModelFor(env, shard);
    metrics?.count("d1.query", { db: "org", op: "cleanup_deliveries" });
    const { results } = await db
      .prepare("SELECT delivery_id FROM webhook_deliveries WHERE repo_id = ? LIMIT ?")
      .bind(repoId, CLEANUP_POLICY.deliveriesPage)
      .all<{ delivery_id: string }>();
    if (results.length > 0) {
      const ids = JSON.stringify(results.map((r) => r.delivery_id));
      metrics?.count("d1.query", { db: "org", op: "cleanup_deliveries" }, 2);
      // Attempts first: a row is only deleted with its attempts gone.
      await db.batch([
        db
          .prepare(
            "DELETE FROM webhook_attempts WHERE delivery_id IN (SELECT value FROM json_each(?))",
          )
          .bind(ids),
        db
          .prepare(
            "DELETE FROM webhook_deliveries WHERE delivery_id IN (SELECT value FROM json_each(?))",
          )
          .bind(ids),
      ]);
    }
    return pageOutcome(results.length, CLEANUP_POLICY.deliveriesPage);
  },
};

/** Its webhook payload rows (their bodies go after, by their prefix). */
const webhookPayloads: RepoCleanup = {
  name: "webhook_payloads",
  async page(env, { repoId, shard }, metrics) {
    const db = readModelFor(env, shard);
    metrics?.count("d1.query", { db: "org", op: "cleanup_payloads" });
    const { meta } = await db
      .prepare(
        `DELETE FROM webhook_payloads WHERE event_key IN
           (SELECT event_key FROM webhook_payloads WHERE repo_id = ? LIMIT ?)`,
      )
      .bind(repoId, CLEANUP_POLICY.deliveriesPage)
      .run();
    return pageOutcome(meta.changes, CLEANUP_POLICY.deliveriesPage);
  },
};

/**
 * Its search projections (issues and pull requests, labels, milestones) and
 * its search state (its cutoff, its reconciliation and repairs), a page of
 * each a call. None is written once its
 * tombstone is in the read model (every projection statement checks it).
 */
const searchProjections: RepoCleanup = {
  name: "search",
  async page(env, { repoId, shard }, metrics) {
    const db = readModelFor(env, shard);
    const page = (table: string) =>
      db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE repo_id = ? LIMIT ?)`,
        )
        .bind(repoId, CLEANUP_POLICY.searchPage);
    metrics?.count("d1.query", { db: "org", op: "cleanup_search" }, 6);
    const removed = await db.batch([
      page("search_docs"),
      page("search_labels"),
      page("search_milestones"),
      page("search_sources"),
      page("search_reconciles"),
      page("search_repairs"),
    ]);
    const most = Math.max(...removed.map((r) => r.meta.changes));
    return pageOutcome(most, CLEANUP_POLICY.searchPage);
  },
};

/** Its webhook bodies, all under `webhooks/<repo>/` (whether or not a row still names them). */
const webhookBodies: RepoCleanup = {
  name: "webhook_bodies",
  async page(env, { repoId }, metrics) {
    metrics?.count("r2.class_a", { bucket: "fyrden-assets", op: "cleanup_list_bodies" });
    const listed = await env.ASSETS.list({
      prefix: `webhooks/${repoId}/`,
      limit: CLEANUP_POLICY.bodiesPage,
    });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) {
      metrics?.count("r2.class_a", { bucket: "fyrden-assets", op: "cleanup_delete_bodies" });
      await env.ASSETS.delete(keys);
    }
    return listed.truncated ? "more" : "done";
  },
};

/** In order: effects first, so none makes a delivery while its deliveries are removed. */
export const REPO_CLEANUPS: readonly RepoCleanup[] = [
  webhookEffects,
  journaledEffects,
  webhookDeliveries,
  webhookPayloads,
  searchProjections,
  webhookBodies,
];

/**
 * Runs the repository's cleanups not done yet, in order, up to `pages`
 * pages, stopping at one that waits; true once every one is done.
 */
export async function runCleanups(
  env: Env,
  target: CleanupTarget,
  options: { pages?: number; metrics?: Metrics } = {},
): Promise<boolean> {
  const { metrics } = options;
  metrics?.count("d1.query", { db: "directory", op: "cleanups_done" });
  const { results } = await env.DIRECTORY.prepare(
    "SELECT cleanup FROM repo_deletion_cleanups WHERE repo_id = ? AND gen = ?",
  )
    .bind(target.repoId, target.gen)
    .all<{ cleanup: string }>();
  const done = new Set(results.map((r) => r.cleanup));
  let pages = options.pages ?? CLEANUP_POLICY.pagesPerCall;
  for (const cleanup of REPO_CLEANUPS) {
    if (done.has(cleanup.name)) continue;
    for (;;) {
      if (pages-- <= 0) return false;
      const outcome = await cleanup.page(env, target, metrics);
      if (outcome === "wait") return false;
      if (outcome === "done") break;
    }
    metrics?.count("d1.query", { db: "directory", op: "cleanup_done" });
    await env.DIRECTORY.prepare(
      `INSERT INTO repo_deletion_cleanups (repo_id, cleanup, done_at, gen) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (repo_id, cleanup) DO UPDATE SET done_at = excluded.done_at, gen = excluded.gen
         WHERE excluded.gen > repo_deletion_cleanups.gen`,
    )
      .bind(target.repoId, cleanup.name, clock(), target.gen)
      .run();
  }
  return true;
}
