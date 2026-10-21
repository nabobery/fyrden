import {
  dohResolver,
  guardedFetch,
  SsrfError,
  type SsrfPolicy,
} from "@fyrden/adapters-cloudflare/net";
import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { HookForDelivery } from "../do/repo/hooks.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { ownHostsOf } from "../git/import/network.js";
import { signature } from "./secrets.js";
import type { DeliveryMessage } from "./sink.js";

/*
 * Webhook delivery attempts. Each attempt is one queue message (or, for a
 * few of an event's first attempts, the webhook sink's own call): its
 * consumer claims the delivery (a lease and a token), reads the hook's
 * current configuration and secrets from the repository object, signs the
 * stored body (Standard Webhooks) and posts it through the SSRF guard,
 * then records the attempt and the outcome under its claim. The sink's
 * first attempts are claimed together, their hooks read together after
 * their claims, and post the body the sink holds (`attemptClaimed`). The deliveries
 * table decides when an attempt is due; a retry is a new message sent with
 * a delay, and the cron sends one again for a due delivery whose message
 * was lost (or whose wait was longer than a queue delay may be).
 */

/** Limits of delivery attempts. Proposed. */
export const ATTEMPT_POLICY = {
  maxAttempts: 8,
  /**
   * Attempts one delivery makes in all, redeliveries by hand included: each
   * is kept with it (4 KiB of its answer at most) until its retention ends.
   */
  maxTotalAttempts: 50,
  /** One attempt's deadline: resolving the host, the request and the response's excerpt. */
  timeoutMs: 10_000,
  /** How long an attempt holds its delivery. */
  leaseMs: 60_000,
  /** The first retry's base delay; doubled per attempt, with full jitter. */
  backoffMs: 60_000,
  maxBackoffMs: 6 * 60 * 60_000,
  /** The longest `Retry-After` honoured. */
  maxRetryAfterMs: 60 * 60_000,
  /** Response bytes kept per attempt. */
  excerptBytes: 4096,
  /** A queue message's longest delay (12 h). */
  maxQueueDelayMs: 12 * 60 * 60_000,
  /** How late a due delivery's message may be before the cron sends another. */
  lateMs: 15 * 60_000,
  /** Due deliveries one cron run sends again, and dead claims it finishes. */
  // A query or two each, beside the cron's other tasks: D1 queries share the
  // invocation's 1,000 calls (a batch counts once; measured, see
  // docs/operations/limits.md).
  reconcileBatch: 4,
  /** Hooks still to be turned off after a 410, told per run (two queries each). */
  disableBatch: 2,
  /**
   * Deliveries past retention one cron run deletes, in three D1 queries and
   * one R2 call whatever their number (R2 deletes up to 1,000 keys a call:
   * https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
   * 288 runs a day delete 288,000: more than Workers Free lets a deployment
   * make (see docs/operations/limits.md).
   */
  pruneBatch: 1_000,
  /** How long a body may take to appear in R2 before a delivery without one fails. */
  bodyWaitMs: 60 * 60_000,
  /** How often a delivery waiting for its body looks again (no attempt spent). */
  bodyRecheckMs: 5 * 60_000,
} as const;
export type AttemptPolicy = { readonly [K in keyof typeof ATTEMPT_POLICY]: number };

export const WEBHOOKS_QUEUE = "fyrden-webhooks";

/**
 * The attempts a delivery may make, in SQL over its row: its own limit (a
 * redelivery's) or the policy's, never past the most any delivery makes.
 * `maxAttempts` and `maxTotal` name the statement's parameters.
 */
const attemptCap = (maxAttempts: string, maxTotal: string) =>
  `min(coalesce(attempt_limit, ${maxAttempts}), ${maxTotal})`;

/** `attemptCap` for a row already read. */
const capOf = (attemptLimit: number | null, policy: AttemptPolicy) =>
  Math.min(attemptLimit ?? policy.maxAttempts, policy.maxTotalAttempts);

export type Claimed = {
  delivery_id: string;
  repo_id: string;
  hook_id: number;
  event: string;
  private: number;
  payload_key: string;
  attempts: number;
  /** Set for a delivery sent again by hand: its last attempt (else the policy's). */
  attempt_limit: number | null;
  created_at: number;
};

/** How an attempt ended. */
type Outcome =
  | { readonly kind: "done"; readonly status: number }
  /** Tried again later (`afterMs`), unless the attempts are spent. */
  | { readonly kind: "retry"; readonly status: number | null; readonly afterMs?: number }
  /** Not an attempt (its body is not stored yet): its number is given back, and it waits. */
  | { readonly kind: "wait"; readonly afterMs: number }
  | { readonly kind: "failed"; readonly status: number | null; readonly reason: string }
  | { readonly kind: "cancelled"; readonly reason: string };

export interface DeliveryDeps {
  readonly env: Env;
  readonly db: D1Database;
  readonly now: () => number;
  readonly policy?: AttemptPolicy;
  readonly metrics?: Metrics;
  /** Where the stages' times go (a new one per attempt when not given). */
  readonly stages?: Stages;
  /** The SSRF policy's resolver (tests replace it). */
  readonly resolver?: (signal: AbortSignal) => SsrfPolicy["resolve"];
}

/** The webhooks queue's consumer: one attempt per message, each message acknowledged. */
export async function consumeWebhooks(
  batch: MessageBatch<DeliveryMessage>,
  env: Env,
  options: { readonly metrics?: Metrics } = {},
): Promise<void> {
  const deps: DeliveryDeps = {
    env,
    db: readModelFor(env, DEFAULT_ORG_SHARD),
    now: () => Date.now(),
    ...(options.metrics && { metrics: options.metrics }),
  };
  for (const message of batch.messages) {
    try {
      await attemptDelivery(deps, message.body.delivery);
    } catch (error) {
      // The delivery keeps its schedule: the cron sends its message again.
      createLogger({ op: "webhooks.deliver" }).error("a delivery attempt failed to run", {
        delivery: message.body.delivery,
        error,
      });
    }
    message.ack();
  }
}

/**
 * The times of the stages of making deliveries (`webhooks.stage_ms`, one
 * point each), kept too for the log line of an event's effect. Stages run
 * side by side overlap: their times do not add up to the time taken.
 */
export class Stages {
  readonly ms: Record<string, number[]> = {};

  constructor(private readonly metrics?: Metrics) {}

  async time<T>(stage: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await run();
    } finally {
      this.add(stage, Date.now() - started);
    }
  }

  add(stage: string, ms: number): void {
    const times = this.ms[stage] ?? [];
    times.push(ms);
    this.ms[stage] = times;
    this.metrics?.count("webhooks.stage_ms", { stage }, ms);
  }
}

/**
 * The statement claiming the delivery's next attempt under `token`: one
 * row, if it is due, no one else holds it, its attempts are not spent and
 * its repository's tombstone is not in (a deletion's cleanups may have run).
 */
export function claimStatement(
  db: D1Database,
  deliveryId: string,
  token: string,
  now: number,
  policy: AttemptPolicy,
): D1PreparedStatement {
  return db
    .prepare(
      // The attempt's number is taken with the claim: a claim that dies uses it up, so the
      // attempts stay bounded however many runs crash.
      `UPDATE webhook_deliveries SET lease_token = ?1, lease_until = ?2, updated_at = ?3,
         attempts = attempts + 1
       WHERE delivery_id = ?4 AND state = 'pending' AND next_attempt_at <= ?3
         AND (lease_until IS NULL OR lease_until <= ?3) AND attempts < ${attemptCap("?5", "?6")}
         AND NOT EXISTS (SELECT 1 FROM repos
                         WHERE repos.repo_id = webhook_deliveries.repo_id AND repos.deleted = 1)
       RETURNING delivery_id, repo_id, hook_id, event, private, payload_key, attempts,
         attempt_limit, created_at`,
    )
    .bind(
      token,
      now + policy.leaseMs,
      now,
      deliveryId,
      policy.maxAttempts,
      policy.maxTotalAttempts,
    );
}

/** Makes the delivery's next attempt, if it is due and no one else is making it. */
export async function attemptDelivery(deps: DeliveryDeps, deliveryId: string): Promise<void> {
  const policy = deps.policy ?? ATTEMPT_POLICY;
  const token = crypto.randomUUID();
  const stages = deps.stages ?? new Stages(deps.metrics);
  const claimed = await stages.time("claim", () =>
    claimStatement(deps.db, deliveryId, token, deps.now(), policy).first<Claimed>(),
  );
  if (!claimed) return;
  await attemptClaimed({ ...deps, stages }, claimed, token);
}

/**
 * What a first attempt holds already: the body its event's effect stored,
 * and its hook, looked up after its claim (or why it could not be).
 */
export interface Prepared {
  readonly body: Uint8Array;
  readonly hook: HookForDelivery | { readonly kind: "unavailable"; readonly error: unknown };
}

/** Makes the attempt `token` claimed, and records it; from what it holds when `prepared`. */
export async function attemptClaimed(
  deps: DeliveryDeps,
  claimed: Claimed,
  token: string,
  prepared?: Prepared,
): Promise<void> {
  const policy = deps.policy ?? ATTEMPT_POLICY;
  const stages = deps.stages ?? new Stages(deps.metrics);
  const outcome = await attempt(deps, claimed, policy, stages, prepared);
  await stages.time("record", () => record(deps, claimed, token, outcome, policy));
}

async function attempt(
  deps: DeliveryDeps,
  delivery: Claimed,
  policy: AttemptPolicy,
  stages: Stages,
  prepared?: Prepared,
): Promise<
  Outcome & {
    readonly configVersion?: number;
    readonly url?: string;
    readonly durationMs?: number;
    readonly excerpt?: string;
    readonly error?: string;
  }
> {
  const { env } = deps;
  let hook: HookForDelivery;
  try {
    if (prepared?.hook.kind === "unavailable") throw prepared.hook.error;
    hook =
      prepared?.hook ??
      (await stages.time(
        "hook",
        async (): Promise<HookForDelivery> =>
          await env.REPO.getByName(delivery.repo_id).hookForDelivery(delivery.hook_id),
      ));
  } catch (error) {
    // The repository object could not answer now: tried again later (the claim spent an attempt).
    return { kind: "retry", status: null, afterMs: policy.backoffMs, error: errorText(error) };
  }
  if (hook.kind === "gone") return { kind: "cancelled", reason: "hook_deleted" };
  const at = { configVersion: hook.configVersion, url: hook.url };
  if (!hook.active) return { kind: "cancelled", reason: "hook_inactive", ...at };
  if (hook.secrets.length === 0)
    return { kind: "failed", status: null, reason: "secret_unavailable", ...at };
  // Private when the event happened, or now: https only.
  if ((delivery.private === 1 || hook.private) && !isHttps(hook.url))
    return { kind: "failed", status: null, reason: "insecure_url", ...at };
  let body = prepared?.body;
  if (!body) {
    const object = await stages.time("body_read", () => env.ASSETS.get(delivery.payload_key));
    if (!object) {
      if (deps.now() - delivery.created_at > policy.bodyWaitMs)
        return { kind: "failed", status: null, reason: "payload_missing", ...at };
      return { kind: "wait", afterMs: policy.bodyRecheckMs };
    }
    body = new Uint8Array(await object.arrayBuffer());
  }
  const timestamp = Math.floor(deps.now() / 1000);
  const headers = {
    "content-type": "application/json",
    "user-agent": "Fyrden-Hookshot/1",
    "webhook-id": delivery.delivery_id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": await signature(hook.secrets, {
      id: delivery.delivery_id,
      timestamp,
      body,
    }),
    "x-fyrden-event": delivery.event,
  };
  const deadline = AbortSignal.timeout(policy.timeoutMs);
  const ssrf: SsrfPolicy = {
    ownHosts: ownHostsOf(env, hook.apiHost),
    resolve: deps.resolver?.(deadline) ?? dohResolver(undefined, deadline),
    allowHttp: !(delivery.private === 1 || hook.private),
  };
  const started = deps.now();
  let response: Response;
  try {
    response = await guardedFetch(
      hook.url,
      { method: "POST", headers, body, signal: deadline },
      ssrf,
    );
  } catch (error) {
    const durationMs = deps.now() - started;
    stages.add("post", durationMs);
    if (error instanceof SsrfError && error.reason !== "unresolvable")
      return { kind: "failed", status: null, reason: `blocked_${error.reason}`, durationMs, ...at };
    // Unreachable for now (a timeout, a connection, a lookup that failed): tried again.
    return { kind: "retry", status: null, durationMs, error: errorText(error), ...at };
  }
  const excerpt = await excerptOf(response, policy.excerptBytes, deadline);
  const durationMs = deps.now() - started;
  stages.add("post", durationMs);
  const seen = { durationMs, excerpt, ...at };
  const { status } = response;
  if (status >= 200 && status < 300) return { kind: "done", status, ...seen };
  // The receiver is gone: the hook is turned off once this outcome is recorded (see `record`).
  if (status === 410) return { kind: "failed", status, reason: "gone", ...seen };
  if (status === 408 || status === 429 || status >= 500)
    return { kind: "retry", status, ...seen, ...retryAfter(response, policy) };
  return { kind: "failed", status, reason: "refused", ...seen };
}

/** The response's first bytes as text (its body is never read further). */
async function excerptOf(response: Response, max: number, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max && !signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    // What came before the error is kept.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - at);
    bytes.set(part, at);
    at += part.length;
    if (at >= bytes.length) break;
  }
  // Kept as text of at most `max` UTF-8 bytes (a malformed byte reads as U+FFFD, three bytes).
  let text = "";
  let length = 0;
  for (const char of new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes)) {
    const charBytes = new TextEncoder().encode(char).length;
    if (length + charBytes > max) break;
    text += char;
    length += charBytes;
  }
  return text;
}

/** A `Retry-After` the receiver gave (seconds or a date), within the honoured maximum. */
function retryAfter(response: Response, policy: AttemptPolicy): { afterMs?: number } {
  const value = response.headers.get("retry-after");
  if (!value) return {};
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return {};
  return { afterMs: Math.min(ms, policy.maxRetryAfterMs) };
}

/** Records the attempt and its outcome, under the claim; schedules the next attempt. */
async function record(
  deps: DeliveryDeps,
  delivery: Claimed,
  token: string,
  outcome: Awaited<ReturnType<typeof attempt>>,
  policy: AttemptPolicy,
): Promise<void> {
  const { db } = deps;
  const now = deps.now();
  // The number the claim took (every attempt counts, one that reached no receiver too); a wait
  // for the body gives it back.
  const attempts = outcome.kind === "wait" ? delivery.attempts - 1 : delivery.attempts;
  let state: string;
  let next = now;
  let reason: string | null = null;
  switch (outcome.kind) {
    case "done":
      state = "done";
      break;
    case "failed":
      state = "failed";
      reason = outcome.reason;
      break;
    case "cancelled":
      state = "cancelled";
      reason = outcome.reason;
      break;
    case "wait":
      state = "pending";
      next = now + outcome.afterMs;
      break;
    case "retry": {
      if (attempts >= capOf(delivery.attempt_limit, policy)) {
        state = "failed";
        reason = "attempts_spent";
        break;
      }
      state = "pending";
      const backoff = Math.min(
        policy.backoffMs * 2 ** Math.max(0, attempts - 1),
        policy.maxBackoffMs,
      );
      next = now + (outcome.afterMs ?? Math.floor(Math.random() * backoff) + 1_000);
      break;
    }
  }
  // Only while the delivery is still this claim's, and still waiting (a deleted hook cancels
  // it, clearing its claim).
  const owned = "delivery_id = ?1 AND lease_token = ?2 AND state = 'pending'";
  const statements: D1PreparedStatement[] = [];
  if (outcome.kind !== "wait")
    statements.push(
      db
        .prepare(
          `INSERT INTO webhook_attempts (delivery_id, n, at, config_version, url, status,
             duration_ms, response_excerpt, error)
           SELECT ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
           WHERE EXISTS (SELECT 1 FROM webhook_deliveries WHERE ${owned})
           ON CONFLICT (delivery_id, n) DO NOTHING`,
        )
        .bind(
          delivery.delivery_id,
          token,
          attempts,
          now,
          outcome.configVersion ?? null,
          outcome.url ?? null,
          "status" in outcome ? outcome.status : null,
          outcome.durationMs ?? null,
          outcome.excerpt ?? null,
          outcome.error ??
            (outcome.kind === "failed" || outcome.kind === "cancelled" ? outcome.reason : null),
        ),
    );
  const sendNow = state === "pending" && next - now <= policy.maxQueueDelayMs;
  const gone = outcome.kind === "failed" && outcome.reason === "gone";
  statements.push(
    db
      .prepare(
        `UPDATE webhook_deliveries SET state = ?3, reason = ?4, attempts = ?5, next_attempt_at = ?6,
           last_status = coalesce(?7, last_status),
           enqueued_at = CASE WHEN ?8 THEN ?9 ELSE enqueued_at END,
           disable_hook_version = ?10, disable_retry_at = CASE WHEN ?10 IS NULL THEN NULL ELSE ?9 END,
           lease_token = NULL, lease_until = NULL, updated_at = ?9
         WHERE ${owned}`,
      )
      .bind(
        delivery.delivery_id,
        token,
        state,
        reason,
        attempts,
        next,
        "status" in outcome ? outcome.status : null,
        sendNow ? 1 : 0,
        now,
        gone ? (outcome.configVersion ?? null) : null,
      ),
  );
  const results = await db.batch(statements);
  const updated = results.at(-1)?.meta.changes ?? 0;
  // Only an outcome this claim recorded turns the hook off; a failure to tell the repository
  // object is retried by the cron.
  if (updated > 0 && gone) await disableFor(deps, delivery.delivery_id);
  // A later wait than a message may be delayed, or a claim lost meanwhile: the cron sees to it.
  if (updated > 0 && sendNow)
    await deps.env.WEBHOOKS.send({ delivery: delivery.delivery_id } satisfies DeliveryMessage, {
      delaySeconds: Math.max(0, Math.ceil((next - now) / 1000)),
    });
}

/** What one cron run of reconciliation did, step by step. */
export interface Reconciled {
  /** Late deliveries whose message was sent again. */
  readonly sent: number;
  /** Deliveries with their attempts spent (a last attempt's run died with its claim), now failed. */
  readonly finished: number;
  /** Requests to turn a hook off after a 410 that were tried again. */
  readonly disabled: number;
  /** Deliveries past retention deleted (with their attempts, and the bodies of those sent). */
  readonly pruned: number;
}

/**
 * The cron's share, in independent steps, each bounded on its own: sends a
 * message again for due deliveries whose message is late, fails those
 * whose last attempt died with its claim, tries again to turn off hooks
 * whose receiver answered 410, and deletes deliveries past retention. A
 * step that fails (a queue or a repository object unavailable) stops none
 * of the others; the failures are thrown together once all have run.
 */
export async function reconcileWebhooks(deps: DeliveryDeps): Promise<Reconciled> {
  const policy = deps.policy ?? ATTEMPT_POLICY;
  const log = createLogger({ op: "webhooks.reconcile" });
  const failures: unknown[] = [];
  const fail = (step: string, error: unknown, delivery?: string) => {
    log.error("a reconciliation step failed", { step, ...(delivery && { delivery }), error });
    failures.push(error);
  };
  const step = async <T>(name: string, run: () => Promise<T>, none: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      fail(name, error);
      return none;
    }
  };
  const late = await step(
    "resend",
    () => resendLate(deps, policy, (delivery, error) => fail("resend", error, delivery)),
    { sent: 0, finished: 0 },
  );
  const reconciled: Reconciled = {
    sent: late.sent,
    finished: late.finished + (await step("finish", () => finishDeadClaims(deps, policy), 0)),
    disabled: await step("disable", () => disableGone(deps, policy), 0),
    pruned: await step("prune", () => pruneExpired(deps, policy), 0),
  };
  if (failures.length > 0)
    throw new AggregateError(failures, `webhook reconciliation: ${failures.length} failure(s)`);
  return reconciled;
}

/**
 * Sends a message again for due deliveries whose message is late (lost, or
 * never sent for a wait over a queue's longest delay), claiming each by its
 * schedule so two runs send one. A send that fails leaves its delivery due
 * from now: a later run finds it late again and sends it then. One whose
 * attempts are spent (no message could make another) is failed instead.
 */
async function resendLate(
  deps: DeliveryDeps,
  policy: AttemptPolicy,
  failed: (delivery: string, error: unknown) => void,
): Promise<{ sent: number; finished: number }> {
  const { db, env } = deps;
  const now = deps.now();
  const late = await db
    .prepare(
      `SELECT delivery_id, next_attempt_at FROM webhook_deliveries
       WHERE state = 'pending' AND next_attempt_at <= ?1
         AND (lease_until IS NULL OR lease_until <= ?2)
       ORDER BY next_attempt_at LIMIT ?3`,
    )
    .bind(now - policy.lateMs, now, policy.reconcileBatch)
    .all<{ delivery_id: string; next_attempt_at: number }>();
  let sent = 0;
  let finished = 0;
  const spent = `attempts >= ${attemptCap("?4", "?5")}`;
  for (const row of late.results) {
    // Unclaimed still: a claim made since the read keeps its schedule, and may be the last.
    const moved = await db
      .prepare(
        `UPDATE webhook_deliveries SET next_attempt_at = ?1, enqueued_at = ?1, updated_at = ?1,
           state = CASE WHEN ${spent} THEN 'failed' ELSE state END,
           reason = CASE WHEN ${spent} THEN 'attempts_spent' ELSE reason END,
           lease_token = CASE WHEN ${spent} THEN NULL ELSE lease_token END,
           lease_until = CASE WHEN ${spent} THEN NULL ELSE lease_until END
         WHERE delivery_id = ?2 AND state = 'pending' AND next_attempt_at = ?3
           AND (lease_until IS NULL OR lease_until <= ?1)
         RETURNING state`,
      )
      .bind(now, row.delivery_id, row.next_attempt_at, policy.maxAttempts, policy.maxTotalAttempts)
      .first<{ state: string }>();
    if (!moved) continue;
    if (moved.state === "failed") {
      finished++;
      continue;
    }
    try {
      await env.WEBHOOKS.send({ delivery: row.delivery_id } satisfies DeliveryMessage);
      sent++;
    } catch (error) {
      // Each on its own: the others are still sent.
      failed(row.delivery_id, error);
    }
  }
  return { sent, finished };
}

/** A last attempt whose run died with its claim: nothing more to try (claims are few: indexed). */
async function finishDeadClaims(deps: DeliveryDeps, policy: AttemptPolicy): Promise<number> {
  const { db } = deps;
  const now = deps.now();
  const finished = await db
    .prepare(
      `UPDATE webhook_deliveries SET state = 'failed', reason = 'attempts_spent',
         lease_token = NULL, lease_until = NULL, updated_at = ?1
       WHERE delivery_id IN (
         SELECT delivery_id FROM webhook_deliveries
         WHERE state = 'pending' AND lease_until IS NOT NULL AND lease_until <= ?1
           AND attempts >= ${attemptCap("?2", "?4")}
         LIMIT ?3)`,
    )
    .bind(now, policy.maxAttempts, policy.reconcileBatch, policy.maxTotalAttempts)
    .run();
  return finished.meta.changes;
}

/** Hooks whose receiver answered 410 and that could not be turned off then, the longest waiting first. */
async function disableGone(deps: DeliveryDeps, policy: AttemptPolicy): Promise<number> {
  const undisabled = await deps.db
    .prepare(
      `SELECT delivery_id FROM webhook_deliveries WHERE disable_hook_version IS NOT NULL
       ORDER BY disable_retry_at LIMIT ?`,
    )
    .bind(policy.disableBatch)
    .all<{ delivery_id: string }>();
  for (const row of undisabled.results) await disableFor(deps, row.delivery_id);
  return undisabled.results.length;
}

/**
 * Deletes the deliveries longest past retention, a batch a run, each
 * event's whole: the deliveries an event made share its body, so the batch
 * takes an event only when it holds every delivery that names that body
 * (one it ends inside of waits for the next run, then first in line). The
 * bodies go first (one bulk delete; a run that fails after it finds them
 * gone next time), then the attempts and rows. An event none of whose
 * deliveries was sent never had its body stored: its rows go without an
 * R2 delete.
 */
async function pruneExpired(deps: DeliveryDeps, policy: AttemptPolicy): Promise<number> {
  const { db, env } = deps;
  const { results } = await db
    .prepare(
      // Through the expiry index, so the batch bounds the rows read; then each body's count of
      // deliveries through its index (an event's hooks, 20 at most).
      `WITH batch AS (
         SELECT delivery_id, payload_key, state FROM webhook_deliveries
         WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2),
       whole AS (
         SELECT payload_key, max(state != 'dropped') AS sent FROM batch GROUP BY payload_key
         HAVING count(*) = (SELECT count(*) FROM webhook_deliveries d
                            WHERE d.payload_key = batch.payload_key))
       SELECT b.delivery_id, b.payload_key, w.sent FROM batch b JOIN whole w USING (payload_key)`,
    )
    .bind(deps.now(), policy.pruneBatch)
    .all<{ delivery_id: string; payload_key: string; sent: number }>();
  if (results.length === 0) return 0;
  const bodies = [...new Set(results.filter((r) => r.sent === 1).map((r) => r.payload_key))];
  if (bodies.length > 0) await env.ASSETS.delete(bodies);
  const ids = JSON.stringify(results.map((r) => r.delivery_id));
  await db.batch([
    db
      .prepare("DELETE FROM webhook_attempts WHERE delivery_id IN (SELECT value FROM json_each(?))")
      .bind(ids),
    db
      .prepare(
        "DELETE FROM webhook_deliveries WHERE delivery_id IN (SELECT value FROM json_each(?))",
      )
      .bind(ids),
  ]);
  return results.length;
}

/**
 * Turns off the hook a delivery's 410 names, if it is still at the
 * configuration that delivery used, then clears the request; when the
 * repository object cannot be told, the request stays for the cron.
 */
async function disableFor(deps: DeliveryDeps, deliveryId: string): Promise<void> {
  const { db, env } = deps;
  const row = await db
    .prepare(
      "SELECT repo_id, hook_id, disable_hook_version FROM webhook_deliveries WHERE delivery_id = ?",
    )
    .bind(deliveryId)
    .first<{ repo_id: string; hook_id: number; disable_hook_version: number | null }>();
  if (row?.disable_hook_version == null) return;
  try {
    await env.REPO.getByName(row.repo_id).disableHook(
      row.hook_id,
      row.disable_hook_version,
      "the receiver answered 410 Gone",
    );
  } catch (error) {
    createLogger({ op: "webhooks.disable" }).warn("turning a hook off failed; tried again later", {
      delivery: deliveryId,
      error,
    });
    // To the back of the line: other hooks' requests are tried before this one again.
    await db
      .prepare("UPDATE webhook_deliveries SET disable_retry_at = ? WHERE delivery_id = ?")
      .bind(deps.now(), deliveryId)
      .run();
    return;
  }
  // Done, or the hook changed since (then it stays as it is now).
  await db
    .prepare(
      "UPDATE webhook_deliveries SET disable_hook_version = NULL WHERE delivery_id = ? AND disable_hook_version = ?",
    )
    .bind(deliveryId, row.disable_hook_version)
    .run();
}

/** Whether a hook URL is https (as its parser reads it). */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.name : "error").slice(0, 200);
}
