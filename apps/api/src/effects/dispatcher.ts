import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  EFFECT_POLICY,
  type Effect,
  type EffectPolicy,
  type EffectSink,
  effectCalls,
  SINGLE_EFFECT_CALLS,
  SWEEP_ROUND_CALLS,
} from "./journal.js";

/**
 * Delivers journaled effects and records the outcome. A delivery first
 * claims its effect (a lease with a token), so the consumer and the sweeper
 * never deliver the same effect at once, and only the claim's holder
 * records the outcome. A delivered effect is marked done; a failed one
 * backs off and is retried by the sweeper until `maxAttempts`, then marked
 * failed. A crash between the delivery and the mark leaves the claim to
 * expire, and the effect is delivered again with the same id. A sink that
 * delivers in batches gets every effect of it a claim took in one call;
 * the ones it delivered are marked done together, the rest back off.
 */

type Row = {
  effect_id: string;
  sink: string;
  target: string;
  payload: string;
  attempts: number;
};

export interface DispatchDeps {
  readonly db: D1Database;
  readonly env: Env;
  readonly sinks: readonly EffectSink[];
  readonly now: () => number;
  readonly log?: Logger;
  readonly metrics?: Metrics;
  readonly policy?: EffectPolicy;
}

const RETURNING = "RETURNING effect_id, sink, target, payload, attempts";

/**
 * Delivers effects a consumer batch has just journaled (`ids`: only the
 * rows it inserted), unless someone tried them already: a retry keeps the
 * sweeper's backoff.
 */
export async function dispatchEffects(deps: DispatchDeps, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const policy = deps.policy ?? EFFECT_POLICY;
  const now = deps.now();
  const token = crypto.randomUUID();
  deps.metrics?.count("d1.query", { db: "org", op: "effects_claim" });
  const { results } = await deps.db
    .prepare(
      `UPDATE effects SET lease_token = ?1, lease_until = ?2
       WHERE effect_id IN (SELECT value FROM json_each(?3)) AND state = 'pending'
         AND attempts = 0 AND (lease_until IS NULL OR lease_until <= ?4)
       ${RETURNING}`,
    )
    .bind(token, now + policy.leaseMs, JSON.stringify(ids), now)
    .all<Row>();
  return deliverAll(deps, results, token);
}

/**
 * Retries due effects (the consumer could not deliver them, or their claim
 * expired), oldest first, a page at a time while the sweep's calls,
 * effects and payload bytes last, and deletes delivered ones past
 * retention. What a run leaves waits for the next. Returns the effects
 * delivered.
 */
export async function sweepEffects(deps: DispatchDeps): Promise<number> {
  const policy = deps.policy ?? EFFECT_POLICY;
  // Due as of the sweep's start; each page's claim lasts from when it is taken (see `claimDue`).
  const now = deps.now();
  let left = policy.sweepCalls;
  let effects = policy.sweepLimit;
  let bytes = policy.sweepBytes;
  let delivered = 0;
  for (let first = true; ; first = false) {
    left -= SWEEP_ROUND_CALLS;
    const page = Math.min(policy.sweepPage, effects, Math.floor(left / SINGLE_EFFECT_CALLS));
    // The run's first effect goes whatever it costs, so none waits for ever.
    if (page < 1 && !first) break;
    const token = crypto.randomUUID();
    const rows = await claimDue(deps, policy, token, now, Math.max(page, 1), bytes, first);
    // As many as the calls left allow; the others go back.
    let taken = 0;
    for (const row of rows) {
      const cost = effectCalls(
        deps.sinks.find((s) => s.name === row.sink),
        { target: row.target, payload: JSON.parse(row.payload) as Record<string, unknown> },
      );
      if (cost > left && !(first && taken === 0)) break;
      left -= cost;
      effects--;
      bytes -= row.bytes;
      taken++;
    }
    const back = rows.slice(taken);
    if (back.length > 0) await release(deps, back, token);
    delivered += await deliverAll(deps, rows.slice(0, taken), token);
    // Nothing more is due, or the calls, effects or bytes are spent. An effect that failed now
    // backs off past `now` and a delivered one is done, so a later page never meets either again.
    if (rows.length < page || back.length > 0) break;
  }
  deps.metrics?.count("d1.query", { db: "org", op: "effects_prune" });
  // Failed ones too, after the same time (their payloads go with them).
  await deps.db
    .prepare(
      `DELETE FROM effects WHERE (state = 'done' AND done_at <= ?1)
         OR (state = 'failed' AND next_attempt_at <= ?1)`,
    )
    .bind(now - policy.retentionMs)
    .run();
  return delivered;
}

/**
 * Claims up to `limit` effects due by `due`, oldest first, while their
 * payloads come to at most `bytes` (the first one whatever its size when
 * `first`), so a sweep reads no more than it may deliver. The claim lasts
 * from now, not from `due`: a page taken late in a slow sweep holds its
 * effects as long as the first page did, and an overlapping run cannot
 * take them over at once. The innermost query reads only the first `limit`
 * due effects, in the order of the `effects_due_order` index, and the
 * running payload sum covers just those: a backlog, or a burst due at one
 * time, costs the claim no more than a page.
 */
async function claimDue(
  deps: DispatchDeps,
  policy: EffectPolicy,
  token: string,
  due: number,
  limit: number,
  bytes: number,
  first: boolean,
): Promise<(Row & { bytes: number })[]> {
  deps.metrics?.count("d1.query", { db: "org", op: "effects_claim" });
  const { results } = await deps.db
    .prepare(
      `UPDATE effects SET lease_token = ?1, lease_until = ?2
       WHERE effect_id IN (
         SELECT effect_id FROM (
           SELECT effect_id, row_number() OVER oldest AS n,
             sum(length(CAST(payload AS BLOB))) OVER oldest AS upto
           FROM (
             SELECT effect_id, next_attempt_at, payload FROM effects
             WHERE state = 'pending' AND next_attempt_at <= ?3
               AND (lease_until IS NULL OR lease_until <= ?3)
             ORDER BY next_attempt_at, effect_id LIMIT ?4)
           WINDOW oldest AS (ORDER BY next_attempt_at, effect_id ROWS UNBOUNDED PRECEDING))
         WHERE upto <= ?5 OR (n = 1 AND ?6))
       ${RETURNING}, length(CAST(payload AS BLOB)) AS bytes`,
    )
    .bind(token, deps.now() + policy.leaseMs, due, limit, bytes, first ? 1 : 0)
    .all<Row & { bytes: number }>();
  return results;
}

/** Gives claimed effects back untried, their schedule as it was. */
async function release(deps: DispatchDeps, rows: readonly Row[], token: string): Promise<void> {
  deps.metrics?.count("d1.query", { db: "org", op: "effects_release" });
  await deps.db
    .prepare(
      `UPDATE effects SET lease_token = NULL, lease_until = NULL
       WHERE effect_id IN (SELECT value FROM json_each(?1)) AND lease_token = ?2`,
    )
    .bind(JSON.stringify(rows.map((row) => row.effect_id)), token)
    .run();
}

/** A sink that delivers its effects together. */
type BatchSink = EffectSink & Required<Pick<EffectSink, "deliverBatch">>;

const delivers = (sink: EffectSink | undefined): sink is BatchSink =>
  sink?.deliverBatch !== undefined;

/**
 * Delivers claimed effects: one at a time, except a batch sink's, which go
 * to it together in one call (each still has its own claim and outcome).
 */
async function deliverAll(
  deps: DispatchDeps,
  rows: readonly Row[],
  token: string,
): Promise<number> {
  let delivered = 0;
  const batches = new Map<BatchSink, Row[]>();
  for (const row of rows) {
    const sink = deps.sinks.find((s) => s.name === row.sink);
    if (delivers(sink)) batches.set(sink, [...(batches.get(sink) ?? []), row]);
    else if (await deliverOne(deps, sink, row, token)) delivered++;
  }
  for (const [sink, batch] of batches) delivered += await deliverBatch(deps, sink, batch, token);
  return delivered;
}

function effectOf(row: Row): Effect {
  return {
    id: row.effect_id,
    sink: row.sink,
    target: row.target,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    attempts: row.attempts,
  };
}

async function deliverOne(
  deps: DispatchDeps,
  sink: EffectSink | undefined,
  row: Row,
  token: string,
): Promise<boolean> {
  try {
    if (!sink) throw new Error(`no sink named ${row.sink}`);
    await sink.deliver(effectOf(row), deps.env, deps.db);
  } catch (error) {
    await markFailed(deps, [row], token, error, !sink);
    return false;
  }
  await markDone(deps, [row.effect_id], token);
  return true;
}

/** A batch sink's effects in one call; those it did not deliver are retried. */
async function deliverBatch(
  deps: DispatchDeps,
  sink: BatchSink,
  rows: readonly Row[],
  token: string,
): Promise<number> {
  let outcome: Awaited<ReturnType<BatchSink["deliverBatch"]>>;
  try {
    outcome = await sink.deliverBatch(rows.map(effectOf), deps.env, deps.db);
  } catch (error) {
    outcome = { delivered: [], error };
  }
  const delivered = new Set(outcome.delivered);
  const done = rows.filter((row) => delivered.has(row.effect_id)).map((row) => row.effect_id);
  const rest = rows.filter((row) => !delivered.has(row.effect_id));
  if (rest.length > 0)
    await markFailed(deps, rest, token, outcome.error ?? new Error("not delivered"), false);
  if (done.length > 0) await markDone(deps, done, token);
  return done.length;
}

/**
 * Backs failed effects off (from each one's own attempts) in one query, or
 * marks them failed after the last attempt or when `final`. Only this
 * claim's holder writes.
 */
async function markFailed(
  deps: DispatchDeps,
  rows: readonly Row[],
  token: string,
  error: unknown,
  final: boolean,
): Promise<void> {
  const policy = deps.policy ?? EFFECT_POLICY;
  for (const row of rows)
    deps.log?.warn("delivering an effect failed", {
      effectId: row.effect_id,
      attempts: row.attempts + 1,
      error,
    });
  deps.metrics?.count("d1.query", { db: "org", op: "effects_retry" });
  await deps.db
    .prepare(
      `UPDATE effects SET attempts = attempts + 1,
         next_attempt_at = ?1 + min(?2 << attempts, ?3),
         last_error = ?4, lease_token = NULL, lease_until = NULL,
         state = CASE WHEN ?5 OR attempts + 1 >= ?6 THEN 'failed' ELSE 'pending' END
       WHERE effect_id IN (SELECT value FROM json_each(?7)) AND lease_token = ?8`,
    )
    .bind(
      deps.now(),
      policy.backoffMs,
      policy.maxBackoffMs,
      (error instanceof Error ? error.message : String(error)).slice(0, 500),
      final ? 1 : 0,
      policy.maxAttempts,
      JSON.stringify(rows.map((row) => row.effect_id)),
      token,
    )
    .run();
}

/** Marks delivered effects done, in one query; only this claim's holder writes. */
async function markDone(deps: DispatchDeps, ids: readonly string[], token: string): Promise<void> {
  deps.metrics?.count("d1.query", { db: "org", op: "effects_done" });
  await deps.db
    .prepare(
      `UPDATE effects SET state = 'done', done_at = ?, lease_token = NULL, lease_until = NULL
       WHERE effect_id IN (SELECT value FROM json_each(?)) AND lease_token = ?`,
    )
    .bind(deps.now(), JSON.stringify(ids), token)
    .run();
}
