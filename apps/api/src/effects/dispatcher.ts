import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  EFFECT_POLICY,
  type Effect,
  type EffectPolicy,
  type EffectSink,
  effectCalls,
  MESSAGE_CALLS,
  SINGLE_EFFECT_CALLS,
} from "./journal.js";
import type { Publish } from "./queues.js";

/**
 * Delivers journaled effects that a queue message (or the events consumer)
 * names, and records the outcome. A delivery first claims its effects (a
 * lease with a token, the attempt counted), so two messages naming one
 * effect never deliver it at once, and only the claim's holder records the
 * outcome. A delivered effect is marked done; a failed one backs off and a
 * message naming it is sent for when it is due, until `maxAttempts`, then
 * it is marked failed. A crash between the delivery and the mark leaves
 * the claim to expire; the effects cron then sends a message for it again,
 * and it is delivered again with the same id. A claim first checks where
 * the effect came from: one whose source was deleted, restored to an
 * older state or transferred since (unless its sink delivers across
 * transfers) is ended, not delivered. What an invocation's budget does
 * not reach goes back to the queue.
 */

type Row = {
  effect_id: string;
  sink: string;
  target: string;
  payload: string;
  attempts: number;
  bytes: number;
};

export interface DispatchDeps {
  readonly db: D1Database;
  readonly env: Env;
  readonly sinks: readonly EffectSink[];
  readonly now: () => number;
  /** Where effects go back to: their retries, and what a budget did not reach. */
  readonly publish: Publish;
  readonly log?: Logger;
  readonly metrics?: Metrics;
  readonly policy?: EffectPolicy;
}

/** What one invocation may still do, shared by the messages it delivers (see `EffectPolicy.invocation`). */
export interface EffectBudget {
  calls: number;
  effects: number;
  bytes: number;
  /** When it starts no more deliveries. */
  readonly deadline: number;
  /** Whether it claimed anything yet: its first effect goes whatever its cost. */
  started: boolean;
}

/** Adds `id` to `key`'s list in `map`. */
function group<K>(map: Map<K, string[]>, key: K, id: string): void {
  const ids = map.get(key);
  if (ids) ids.push(id);
  else map.set(key, [id]);
}

/** A fresh invocation's budget, from `now`. */
export function invocationBudget(now: number, policy: EffectPolicy = EFFECT_POLICY): EffectBudget {
  const { calls, effects, bytes, deadlineMs } = policy.invocation;
  return { calls, effects, bytes, deadline: now + deadlineMs, started: false };
}

/** Where a pending effect stands when a claim passes it over. */
const ELIGIBLE = `e.sink = ?2 AND e.state = 'pending' AND (e.lease_until IS NULL OR e.lease_until <= ?3)
  AND e.attempts < ?4`;

/**
 * Delivers the effects of `sinkName` that `ids` names, as far as `budget`
 * goes, and sends the rest back to the queue. An id that names no pending
 * effect (delivered, failed, deleted, claimed by someone else) is passed
 * over. Returns the effects delivered. Throws when recording an outcome or
 * sending the rest failed: the caller retries its message, which finds
 * what was done done.
 */
export async function deliverEffects(
  deps: DispatchDeps,
  sinkName: string,
  ids: readonly string[],
  budget: EffectBudget,
): Promise<number> {
  const policy = deps.policy ?? EFFECT_POLICY;
  const wanted = [...new Set(ids)];
  const sink = deps.sinks.find((s) => s.name === sinkName);
  if (!sink) {
    await failUnknown(deps, sinkName, wanted);
    return 0;
  }
  const unit = sink.deliverBatch ? 1 : SINGLE_EFFECT_CALLS;
  const fits = Math.min(
    budget.effects,
    Math.floor((budget.calls - MESSAGE_CALLS) / unit),
    deps.now() < budget.deadline ? wanted.length : 0,
  );
  // Nothing fits, unless nothing was claimed yet: an invocation always delivers something.
  const count = fits > 0 ? Math.min(fits, wanted.length) : budget.started ? 0 : 1;
  const take = wanted.slice(0, count);
  const later = wanted.slice(count);
  let delivered = 0;
  if (take.length > 0) {
    // Only an invocation's first effect goes whatever its cost, or past the deadline.
    const first = !budget.started;
    budget.calls -= MESSAGE_CALLS;
    const claimed = await claim(deps, policy, sink, take, budget);
    later.unshift(...claimed.passed);
    // As many as the calls left allow, in the message's order; the others go back.
    let taken = 0;
    for (const row of claimed.rows) {
      const cost = effectCalls(sink, { target: row.target, payload: payloadOf(row) });
      if (cost > budget.calls && (!first || taken > 0)) break;
      budget.calls -= cost;
      budget.effects--;
      budget.bytes -= row.bytes;
      taken++;
    }
    if (claimed.rows.length > 0) budget.started = true;
    const back = claimed.rows.slice(taken);
    if (back.length > 0) {
      await release(deps, policy, back, claimed.token);
      later.unshift(...back.map((row) => row.effect_id));
    }
    const outcome = await deliverClaimed(deps, policy, sink, claimed.rows.slice(0, taken), {
      token: claimed.token,
      budget,
      first,
    });
    delivered = outcome.delivered;
    later.unshift(...outcome.unstarted);
    for (const [delay, retried] of outcome.retries)
      await publishOrRecover(deps, sink.name, retried, delay);
    for (const [delay, early] of claimed.early) await deps.publish(sink.name, early, delay);
  }
  if (later.length > 0) await deps.publish(sink.name, later);
  return delivered;
}

/**
 * Claims what it can of `ids` in one batch (one call): ends effects whose
 * source moved on, claims the due ones in order while their payloads fit
 * the budget's bytes (the first whatever its size before anything is
 * claimed), and reads the pending ones it passed over: due ones (past the
 * bytes) to send back now, early ones (a message ahead of its effect's
 * schedule) to send back for when they are due.
 */
async function claim(
  deps: DispatchDeps,
  policy: EffectPolicy,
  sink: EffectSink,
  ids: readonly string[],
  budget: EffectBudget,
): Promise<{
  token: string;
  rows: Row[];
  passed: string[];
  early: Map<number, string[]>;
}> {
  const now = deps.now();
  const token = crypto.randomUUID();
  const list = JSON.stringify(ids);
  deps.metrics?.count("d1.query", { db: "org", op: "effects_claim" });
  const [ended, claimed, passed] = await deps.db.batch<Record<string, unknown>>([
    deps.db
      .prepare(
        `UPDATE effects SET state = 'failed', next_attempt_at = ?3, lease_token = NULL,
           lease_until = NULL,
           last_error = CASE
             WHEN EXISTS (SELECT 1 FROM repos WHERE repo_id = effects.source_id AND deleted = 1)
               THEN 'invalidated: its source was deleted'
             WHEN epoch_gen < (SELECT epoch_gen FROM consumer_epochs WHERE source_id = effects.source_id)
               THEN 'invalidated: its source was restored to an earlier state'
             ELSE 'invalidated: its source was transferred' END
         WHERE effect_id IN (SELECT value FROM json_each(?1)) AND sink = ?2 AND state = 'pending'
           AND (lease_until IS NULL OR lease_until <= ?3) AND source_id IS NOT NULL
           AND (EXISTS (SELECT 1 FROM repos WHERE repo_id = effects.source_id AND deleted = 1)
             OR epoch_gen < (SELECT epoch_gen FROM consumer_epochs WHERE source_id = effects.source_id)
             OR (any_owner = 0 AND owner_gen <
               coalesce((SELECT owner_gen FROM source_owner WHERE source_id = effects.source_id), 0)))
         RETURNING effect_id, last_error`,
      )
      .bind(list, sink.name, now),
    deps.db
      .prepare(
        `UPDATE effects SET lease_token = ?5, lease_until = ?6, recover_at = ?6,
           attempts = attempts + 1
         WHERE effect_id IN (
           SELECT effect_id FROM (
             SELECT e.effect_id, row_number() OVER listed AS n,
               sum(length(CAST(e.payload AS BLOB))) OVER listed AS upto
             FROM json_each(?1) j JOIN effects e ON e.effect_id = j.value
             WHERE ${ELIGIBLE} AND e.next_attempt_at <= ?3
             WINDOW listed AS (ORDER BY j.key ROWS UNBOUNDED PRECEDING))
           WHERE upto <= ?7 OR (n = 1 AND ?8))
         RETURNING effect_id, sink, target, payload, attempts,
           length(CAST(payload AS BLOB)) AS bytes`,
      )
      .bind(
        list,
        sink.name,
        now,
        policy.maxAttempts,
        token,
        now + policy.leaseMs,
        budget.bytes,
        budget.started ? 0 : 1,
      ),
    deps.db
      .prepare(
        `SELECT e.effect_id, e.next_attempt_at FROM json_each(?1) j JOIN effects e
           ON e.effect_id = j.value
         WHERE ${ELIGIBLE} ORDER BY j.key`,
      )
      .bind(list, sink.name, now, policy.maxAttempts),
  ]);
  for (const row of (ended?.results ?? []) as { effect_id: string; last_error: string }[]) {
    deps.metrics?.count("effects.invalidated", { sink: sink.name });
    deps.log?.warn("an effect was ended: its source moved on", {
      effectId: row.effect_id,
      reason: row.last_error,
    });
  }
  // In the message's order (RETURNING has none).
  const order = new Map(ids.map((id, i) => [id, i]));
  const rows = ((claimed?.results ?? []) as Row[]).sort(
    (a, b) => (order.get(a.effect_id) ?? 0) - (order.get(b.effect_id) ?? 0),
  );
  const due: string[] = [];
  const early = new Map<number, string[]>();
  for (const row of (passed?.results ?? []) as { effect_id: string; next_attempt_at: number }[]) {
    if (row.next_attempt_at <= now) {
      due.push(row.effect_id);
      continue;
    }
    const delay = Math.ceil((row.next_attempt_at - now) / 1000);
    group(early, delay, row.effect_id);
  }
  return { token, rows, passed: due, early };
}

/** Ends effects of a sink this deployment does not have: nothing could deliver them. */
async function failUnknown(deps: DispatchDeps, sinkName: string, ids: readonly string[]) {
  deps.metrics?.count("d1.query", { db: "org", op: "effects_retry" });
  await deps.db
    .prepare(
      `UPDATE effects SET state = 'failed', next_attempt_at = ?3, last_error = ?4,
         lease_token = NULL, lease_until = NULL
       WHERE effect_id IN (SELECT value FROM json_each(?1)) AND sink = ?2 AND state = 'pending'
         AND (lease_until IS NULL OR lease_until <= ?3)`,
    )
    .bind(JSON.stringify(ids), sinkName, deps.now(), `no sink named ${sinkName}`)
    .run();
}

/** Gives claimed effects back untried: the attempt is not counted, and their message goes out again. */
async function release(
  deps: DispatchDeps,
  policy: EffectPolicy,
  rows: readonly Row[],
  token: string,
): Promise<void> {
  deps.metrics?.count("d1.query", { db: "org", op: "effects_release" });
  await deps.db
    .prepare(
      `UPDATE effects SET lease_token = NULL, lease_until = NULL, attempts = attempts - 1,
         recover_at = ?3
       WHERE effect_id IN (SELECT value FROM json_each(?1)) AND lease_token = ?2`,
    )
    .bind(JSON.stringify(rows.map((row) => row.effect_id)), token, deps.now() + policy.lateMs)
    .run();
}

/** Payloads parsed, by their row: parsed once for the budget and kept for the delivery. */
const parsed = new WeakMap<Row, Record<string, unknown>>();

function payloadOf(row: Row): Record<string, unknown> {
  let payload = parsed.get(row);
  if (!payload) {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
    parsed.set(row, payload);
  }
  return payload;
}

function effectOf(row: Row): Effect {
  return {
    id: row.effect_id,
    sink: row.sink,
    target: row.target,
    payload: payloadOf(row),
    attempts: row.attempts,
  };
}

/** What delivering claimed effects did: how many it delivered, which to retry when, which it never started. */
interface Delivered {
  readonly delivered: number;
  /** Effects to try again, by the seconds until they are due. */
  readonly retries: Map<number, string[]>;
  /** Effects given back untried (the invocation's deadline passed). */
  readonly unstarted: string[];
}

/**
 * Delivers claimed effects: a batch sink's together in one call (each
 * still has its own claim and outcome), another's one at a time, while the
 * invocation's deadline allows (the rest are given back; the deadline may
 * have passed during the claim). An invocation's `first` effect goes
 * whatever the time.
 */
async function deliverClaimed(
  deps: DispatchDeps,
  policy: EffectPolicy,
  sink: EffectSink,
  claimed: readonly Row[],
  claim: { token: string; budget: EffectBudget; first: boolean },
): Promise<Delivered> {
  const result: Delivered = { delivered: 0, retries: new Map(), unstarted: [] };
  let rows = claimed;
  if (rows.length === 0) return result;
  const { token } = claim;
  const late = (i: number) => (i > 0 || !claim.first) && deps.now() >= claim.budget.deadline;
  if (sink.deliverBatch && deps.now() >= claim.budget.deadline) {
    // Past the deadline: the invocation's first effect alone, if it is that.
    const left = rows.slice(claim.first ? 1 : 0);
    if (left.length > 0) {
      await release(deps, policy, left, token);
      result.unstarted.push(...left.map((row) => row.effect_id));
    }
    rows = rows.slice(0, rows.length - left.length);
    if (rows.length === 0) return result;
  }
  const done: string[] = [];
  const failures: { rows: Row[]; error: unknown }[] = [];
  if (sink.deliverBatch) {
    let outcome: Awaited<ReturnType<NonNullable<EffectSink["deliverBatch"]>>>;
    try {
      outcome = await sink.deliverBatch(
        rows.map(effectOf),
        deps.env,
        deps.db,
        deps.metrics,
        deps.now(),
      );
    } catch (error) {
      outcome = { delivered: [], error };
    }
    const delivered = new Set(outcome.delivered);
    done.push(...rows.filter((row) => delivered.has(row.effect_id)).map((row) => row.effect_id));
    // Those it ended, for good (a query per reason).
    const told = new Set<string>();
    for (const end of outcome.ended ?? []) {
      const ids = new Set(end.ids);
      const gone = rows.filter(
        (row) =>
          ids.has(row.effect_id) && !delivered.has(row.effect_id) && !told.has(row.effect_id),
      );
      for (const row of gone) told.add(row.effect_id);
      if (gone.length > 0) await markEnded(deps, sink, gone, token, end.reason);
    }
    // The failures the sink told apart, each recorded with its own error: those of one error
    // text together (a query each); the rest together.
    const byText = new Map<string, { rows: Row[]; error: unknown }>();
    for (const failure of outcome.failures ?? []) {
      const ids = new Set(failure.ids);
      const failed = rows.filter(
        (row) =>
          ids.has(row.effect_id) && !delivered.has(row.effect_id) && !told.has(row.effect_id),
      );
      if (failed.length === 0) continue;
      for (const row of failed) told.add(row.effect_id);
      const text = errorText(failure.error);
      const group = byText.get(text) ?? { rows: [], error: failure.error };
      group.rows.push(...failed);
      byText.set(text, group);
    }
    failures.push(...byText.values());
    const rest = rows.filter((row) => !delivered.has(row.effect_id) && !told.has(row.effect_id));
    if (rest.length > 0)
      failures.push({ rows: rest, error: outcome.error ?? new Error("not delivered") });
  } else {
    for (const [i, row] of rows.entries()) {
      if (late(i)) {
        const left = rows.slice(i);
        await release(deps, policy, left, token);
        result.unstarted.push(...left.map((r) => r.effect_id));
        break;
      }
      try {
        await sink.deliver(effectOf(row), deps.env, deps.db, deps.metrics);
        done.push(row.effect_id);
      } catch (error) {
        failures.push({ rows: [row], error });
      }
    }
  }
  for (const failure of failures) {
    const retried = await markFailed(deps, policy, failure.rows, token, failure.error);
    for (const row of retried) {
      const delay = Math.ceil((row.next_attempt_at - deps.now()) / 1000);
      group(result.retries, delay, row.effect_id);
    }
  }
  if (done.length > 0) await markDone(deps, done, token);
  return { ...result, delivered: done.length };
}

/**
 * Sends retried effects' message for when they are due; when that fails,
 * makes them overdue from then, so the effects cron sends it.
 */
async function publishOrRecover(
  deps: DispatchDeps,
  sinkName: string,
  ids: readonly string[],
  delaySeconds: number,
): Promise<void> {
  try {
    await deps.publish(sinkName, ids, delaySeconds);
  } catch (error) {
    deps.log?.warn("sending retried effects failed; the effects cron sends them", { error });
    deps.metrics?.count("d1.query", { db: "org", op: "effects_recover" });
    await deps.db
      .prepare(
        `UPDATE effects SET recover_at = next_attempt_at
         WHERE effect_id IN (SELECT value FROM json_each(?1)) AND state = 'pending'
           AND lease_token IS NULL`,
      )
      .bind(JSON.stringify(ids))
      .run();
  }
}

/**
 * Backs failed effects off (from each one's own attempts, the claim's
 * included) in one query, or marks them failed after the last attempt.
 * Only this claim's holder writes. Returns the ones still pending, with
 * when they are due.
 */
async function markFailed(
  deps: DispatchDeps,
  policy: EffectPolicy,
  rows: readonly Row[],
  token: string,
  error: unknown,
): Promise<{ effect_id: string; next_attempt_at: number }[]> {
  for (const row of rows)
    deps.log?.warn("delivering an effect failed", {
      effectId: row.effect_id,
      attempts: row.attempts,
      error,
    });
  deps.metrics?.count("d1.query", { db: "org", op: "effects_retry" });
  const backoff = "min(?2 << (attempts - 1), ?3)";
  const { results } = await deps.db
    .prepare(
      `UPDATE effects SET next_attempt_at = CASE WHEN attempts >= ?6 THEN ?1 ELSE ?1 + ${backoff} END,
         recover_at = ?1 + ${backoff} + ?4,
         last_error = ?5, lease_token = NULL, lease_until = NULL,
         state = CASE WHEN attempts >= ?6 THEN 'failed' ELSE 'pending' END
       WHERE effect_id IN (SELECT value FROM json_each(?7)) AND lease_token = ?8
       RETURNING effect_id, state, next_attempt_at`,
    )
    .bind(
      deps.now(),
      policy.backoffMs,
      policy.maxBackoffMs,
      policy.lateMs,
      errorText(error),
      policy.maxAttempts,
      JSON.stringify(rows.map((row) => row.effect_id)),
      token,
    )
    .all<{ effect_id: string; state: string; next_attempt_at: number }>();
  for (const row of results)
    if (row.state === "failed")
      deps.metrics?.count("effects.failed", { sink: rows[0]?.sink ?? "" });
  return results.filter((row) => row.state === "pending");
}

/**
 * Ends claimed effects for good with `reason`, in one query: no attempt is
 * left to them. Only this claim's holder writes.
 */
async function markEnded(
  deps: DispatchDeps,
  sink: EffectSink,
  rows: readonly Row[],
  token: string,
  reason: string,
): Promise<void> {
  deps.log?.warn("an effect was ended", { effectIds: rows.map((row) => row.effect_id), reason });
  deps.metrics?.count("d1.query", { db: "org", op: "effects_end" });
  const { results } = await deps.db
    .prepare(
      `UPDATE effects SET state = 'failed', next_attempt_at = ?1, last_error = ?2,
         lease_token = NULL, lease_until = NULL
       WHERE effect_id IN (SELECT value FROM json_each(?3)) AND lease_token = ?4
       RETURNING effect_id`,
    )
    .bind(deps.now(), reason.slice(0, 500), JSON.stringify(rows.map((row) => row.effect_id)), token)
    .all();
  const metric = reason.startsWith("invalidated:") ? "effects.invalidated" : "effects.failed";
  deps.metrics?.count(metric, { sink: sink.name }, results.length);
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

/** What one run of the recovery did. */
export interface Recovered {
  /** Overdue effects whose message was sent again. */
  readonly sent: number;
  /** Overdue effects ended instead: their attempts spent (a last claim died), or their sink gone. */
  readonly ended: number;
}

/**
 * Sends a message again for overdue effects (their message lost, never
 * sent, or a claim that died), the longest overdue first, a page a run.
 * Each is taken by moving its `recover_at` on, so two runs never send one
 * twice and a later run reaches the next ones; a send that fails makes its
 * effects overdue again for the next run. An effect whose attempts are
 * spent, or whose sink is gone, is failed instead.
 */
export async function recoverEffects(deps: DispatchDeps): Promise<Recovered> {
  const policy = deps.policy ?? EFFECT_POLICY;
  const now = deps.now();
  const sinks = JSON.stringify(deps.sinks.map((sink) => sink.name));
  const ending = "(attempts >= ?4 OR sink NOT IN (SELECT value FROM json_each(?5)))";
  deps.metrics?.count("d1.query", { db: "org", op: "effects_recover" });
  const { results } = await deps.db
    .prepare(
      `UPDATE effects SET recover_at = ?1 + ?2,
         state = CASE WHEN ${ending} THEN 'failed' ELSE state END,
         next_attempt_at = CASE WHEN ${ending} THEN ?1 ELSE next_attempt_at END,
         last_error = CASE WHEN attempts >= ?4 THEN 'attempts spent'
           WHEN sink NOT IN (SELECT value FROM json_each(?5)) THEN 'no sink named ' || sink
           ELSE last_error END,
         lease_token = CASE WHEN ${ending} THEN NULL ELSE lease_token END,
         lease_until = CASE WHEN ${ending} THEN NULL ELSE lease_until END
       WHERE effect_id IN (
         SELECT effect_id FROM effects WHERE state = 'pending' AND recover_at <= ?1
         ORDER BY recover_at, effect_id LIMIT ?3)
       RETURNING effect_id, sink, state`,
    )
    .bind(now, policy.lateMs, policy.recoverPage, policy.maxAttempts, sinks)
    .all<{ effect_id: string; sink: string; state: string }>();
  const bySink = new Map<string, string[]>();
  let ended = 0;
  for (const row of results) {
    if (row.state !== "pending") {
      ended++;
      deps.metrics?.count("effects.failed", { sink: row.sink });
      continue;
    }
    group(bySink, row.sink, row.effect_id);
  }
  let sent = 0;
  const failures: unknown[] = [];
  for (const [sink, ids] of bySink) {
    try {
      await deps.publish(sink, ids);
      sent += ids.length;
      deps.metrics?.count("effects.recovered", { sink }, ids.length);
    } catch (error) {
      failures.push(error);
      deps.metrics?.count("d1.query", { db: "org", op: "effects_recover" });
      // Overdue again from now, unless something moved them on since.
      await deps.db
        .prepare(
          `UPDATE effects SET recover_at = ?1
           WHERE effect_id IN (SELECT value FROM json_each(?2)) AND state = 'pending'
             AND recover_at = ?3`,
        )
        .bind(now, JSON.stringify(ids), now + policy.lateMs)
        .run();
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, `recovering effects: ${failures.length} send(s) failed`);
  return { sent, ended };
}

/** Deletes delivered and failed effects past retention (failed ones counted from their last attempt). */
export async function pruneEffects(deps: DispatchDeps): Promise<void> {
  const policy = deps.policy ?? EFFECT_POLICY;
  deps.metrics?.count("d1.query", { db: "org", op: "effects_prune" });
  await deps.db
    .prepare(
      `DELETE FROM effects WHERE (state = 'done' AND done_at <= ?1)
         OR (state = 'failed' AND next_attempt_at <= ?1)`,
    )
    .bind(deps.now() - policy.retentionMs)
    .run();
}

/** An error as an effect's `last_error` keeps it. */
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
