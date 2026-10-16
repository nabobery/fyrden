import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import { EFFECT_POLICY, type Effect, type EffectPolicy, type EffectSink } from "./journal.js";

/**
 * Delivers journaled effects and records the outcome. A delivery first
 * claims its effect (a lease with a token), so the consumer and the sweeper
 * never deliver the same effect at once, and only the claim's holder
 * records the outcome. A delivered effect is marked done; a failed one
 * backs off and is retried by the sweeper until `maxAttempts`, then marked
 * failed. A crash between the delivery and the mark leaves the claim to
 * expire, and the effect is delivered again with the same id.
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
 * expired), and deletes delivered ones past retention. Returns the effects
 * delivered.
 */
export async function sweepEffects(deps: DispatchDeps): Promise<number> {
  const policy = deps.policy ?? EFFECT_POLICY;
  const now = deps.now();
  const token = crypto.randomUUID();
  deps.metrics?.count("d1.query", { db: "org", op: "effects_claim" });
  const { results } = await deps.db
    .prepare(
      `UPDATE effects SET lease_token = ?1, lease_until = ?2
       WHERE effect_id IN (
         SELECT effect_id FROM effects
         WHERE state = 'pending' AND next_attempt_at <= ?3
           AND (lease_until IS NULL OR lease_until <= ?3)
         ORDER BY next_attempt_at LIMIT ?4)
       ${RETURNING}`,
    )
    .bind(token, now + policy.leaseMs, now, policy.sweepBatch)
    .all<Row>();
  const delivered = await deliverAll(deps, results, token);
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

async function deliverAll(
  deps: DispatchDeps,
  rows: readonly Row[],
  token: string,
): Promise<number> {
  let delivered = 0;
  for (const row of rows) if (await deliverOne(deps, row, token)) delivered++;
  return delivered;
}

async function deliverOne(deps: DispatchDeps, row: Row, token: string): Promise<boolean> {
  const policy = deps.policy ?? EFFECT_POLICY;
  const sink = deps.sinks.find((s) => s.name === row.sink);
  const effect: Effect = {
    id: row.effect_id,
    sink: row.sink,
    target: row.target,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    attempts: row.attempts,
  };
  try {
    if (!sink) throw new Error(`no sink named ${row.sink}`);
    await sink.deliver(effect, deps.env, deps.db);
  } catch (error) {
    deps.log?.warn("delivering an effect failed", {
      effectId: row.effect_id,
      attempts: row.attempts + 1,
      error,
    });
    deps.metrics?.count("d1.query", { db: "org", op: "effects_retry" });
    // Attempts and backoff from the row itself; only this claim's holder writes.
    await deps.db
      .prepare(
        `UPDATE effects SET attempts = attempts + 1,
           next_attempt_at = ?1 + min(?2 << attempts, ?3),
           last_error = ?4, lease_token = NULL, lease_until = NULL,
           state = CASE WHEN ?5 OR attempts + 1 >= ?6 THEN 'failed' ELSE 'pending' END
         WHERE effect_id = ?7 AND lease_token = ?8`,
      )
      .bind(
        deps.now(),
        policy.backoffMs,
        policy.maxBackoffMs,
        (error instanceof Error ? error.message : String(error)).slice(0, 500),
        sink ? 0 : 1,
        policy.maxAttempts,
        row.effect_id,
        token,
      )
      .run();
    return false;
  }
  deps.metrics?.count("d1.query", { db: "org", op: "effects_done" });
  await deps.db
    .prepare(
      `UPDATE effects SET state = 'done', done_at = ?, lease_token = NULL, lease_until = NULL
       WHERE effect_id = ? AND lease_token = ?`,
    )
    .bind(deps.now(), row.effect_id, token)
    .run();
  return true;
}
