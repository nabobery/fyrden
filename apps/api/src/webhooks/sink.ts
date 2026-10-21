import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { type DomainEvent, eventKey } from "@fyrden/domain";
import type { Effect, EffectSink, PlannedEffect } from "../effects/journal.js";
import {
  ATTEMPT_POLICY,
  attemptClaimed,
  type Claimed,
  claimStatement,
  type DeliveryDeps,
  type Prepared,
  Stages,
} from "./deliver.js";
import { entityBody, webhookEventOf } from "./events.js";

/*
 * Webhook deliveries from events. An event names the hooks it goes to
 * (each at its configuration version) and what the repository was then;
 * the sink plans one effect per event, its payload the body (built from
 * the event alone, bounded in size) and the hooks. Delivering the effect
 * makes the event's deliveries: their rows (each admitted only while its
 * hook has fewer than its cap of outstanding deliveries), the body they
 * share in R2, the first attempt of a few of them, and a queue message
 * for each other one's first attempt. Every step is keyed by the
 * delivery's id, a hash of the event and the hook, so doing one again
 * changes nothing.
 */

/** Limits of webhook deliveries. Proposed. */
export const DELIVERY_POLICY = {
  /**
   * A body larger than this, as the journal binds it (UTF-8, escaped
   * twice), is not sent (its deliveries are `dropped`): so one journal
   * statement (1 MB) holds at least five events' effects, and an envelope
   * of 50 events needs at most ten (see the events consumer's budget).
   */
  maxBodyBytes: 192 * 1024,
  /** Deliveries waiting per hook; more are `dropped`. */
  maxOutstanding: 1_000,
  /**
   * Bytes of ref updates a push body lists, as the journal binds them
   * (escaped twice); the rest are counted only.
   */
  maxRefBytes: 128 * 1024,
  /** How long deliveries, their attempts and bodies are kept. */
  retentionMs: 30 * 24 * 60 * 60_000,
} as const;

const encoder = new TextEncoder();

/** The deliveries an event makes, as its effect carries them. */
interface PlannedDeliveries {
  readonly repoId: string;
  readonly eventKey: string;
  readonly event: string;
  readonly action: string | null;
  readonly private: boolean;
  readonly body: Record<string, unknown>;
  readonly hooks: readonly { readonly id: number; readonly v: number }[];
}

/** The queue message for a delivery's next attempt. */
export interface DeliveryMessage {
  readonly delivery: string;
}

/** The body of the delivery an event makes; undefined for no webhook event. */
export function bodyOf(event: DomainEvent): Record<string, unknown> | undefined {
  const name = webhookEventOf(event.type);
  const routing = event.webhooks;
  if (!name || !routing) return undefined;
  const common = {
    event: name.event,
    ...(name.action !== null && { action: name.action }),
    repository: {
      id: event.id.sourceId,
      name: routing.repo.name,
      owner: { id: routing.repo.ownerId },
      private: routing.repo.private,
    },
    sender: event.actor === null ? null : { id: event.actor, act_chain: event.actChain },
    at: new Date(event.at).toISOString(),
    // Deliveries are unordered: where the event stands among the repository's.
    position: { epoch: event.id.epochGen, sequence: event.id.sourceSeq },
  };
  const data = event.data ?? {};
  if (name.event === "ping") return { ...common, hook_id: data.hook_id };
  if (name.event !== "push") return { ...common, ...entityBody(name, event) };
  const refs = (data.refs as { ref: string; old: string | null; new: string | null }[]) ?? [];
  // Listed up to a bound in bytes (long names quoted twice over in the journal stay well under
  // its 2 MB value), the count always: a receiver missing some reads them from the repository.
  const listed: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const r of refs) {
    const ref = {
      ref: r.ref,
      before: r.old,
      after: r.new,
      created: r.old === null,
      deleted: r.new === null,
    };
    // As the journal binds it: UTF-8, escaped twice (the body in its effect, the effect in its row).
    bytes += encoder.encode(JSON.stringify(JSON.stringify(ref))).length;
    if (bytes > DELIVERY_POLICY.maxRefBytes) break;
    listed.push(ref);
  }
  return {
    ...common,
    via: data.via ?? null,
    part: data.part ?? 1,
    parts: data.parts ?? 1,
    refs_count: refs.length,
    refs_truncated: listed.length < refs.length,
    refs: listed,
  };
}

/** Hex SHA-256 of `text`, its first 16 bytes. */
async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The delivery's id (its webhook-id): a hash of the event and the hook. */
export async function deliveryIdOf(eventKeyText: string, hookId: number): Promise<string> {
  return `msg_${await hash(`${eventKeyText}:${hookId}`)}`;
}

/** Where an event's body is kept: one object for all its deliveries. */
export async function bodyKeyOf(repoId: string, eventKeyText: string): Promise<string> {
  return `webhooks/${repoId}/${await hash(eventKeyText)}.json`;
}

/**
 * Deliveries whose first attempt the sink makes itself, an effect: the
 * rest go to the webhooks queue for it. Each saves a queue hop (a batch
 * wait) and its three queue operations, at the CPU time of an attempt
 * (signing the body, the request): on Free, an invocation of the webhooks
 * queue making up to 5 attempts took 12 ms of CPU at the median (measured,
 * 2026-10-18). Proposed.
 */
export const FIRST_ATTEMPTS = 2;

/**
 * Calls making an event's deliveries costs besides their first attempts
 * (counted from the code): the rows, the body, the claims, the others'
 * messages and their mark, the hooks (or the body's deletion instead).
 */
const MATERIALIZE_CALLS = 7;
/**
 * Calls one first attempt costs at most (its claim, body and hook are the
 * event's): its record, then a retry's message or turning off a hook whose
 * receiver answered 410 (three), and, should any of that fail, reading its
 * row and queuing it instead (three).
 */
const ATTEMPT_CALLS = 7;

export interface WebhookSinkOptions {
  /** First attempts made per event (`FIRST_ATTEMPTS`). */
  readonly firstAttempts?: number;
  /** The SSRF guard's resolver (tests replace it). */
  readonly resolver?: DeliveryDeps["resolver"];
}

export const webhookSink: EffectSink = createWebhookSink();

/** The webhook sink, making `firstAttempts` first attempts per event. */
export function createWebhookSink(options: WebhookSinkOptions = {}): EffectSink {
  const firstAttempts = options.firstAttempts ?? FIRST_ATTEMPTS;
  return {
    name: "webhooks",
    // An event's deliveries to up to 20 hooks: the costliest effect to make (CPU time on Free).
    perMessage: 2,
    plan: planDeliveries,
    async deliver(effect: Effect, env: Env, db: D1Database, metrics?: Metrics): Promise<void> {
      await materialize(env, db, effect.payload as unknown as PlannedDeliveries, {
        firstAttempts,
        ...(metrics && { metrics }),
        ...(options.resolver && { resolver: options.resolver }),
      });
    },
    calls(planned: PlannedEffect): number {
      const hooks = (planned.payload as unknown as PlannedDeliveries).hooks.length;
      return MATERIALIZE_CALLS + ATTEMPT_CALLS * Math.min(hooks, firstAttempts);
    },
  };
}

/** One effect per event: every hook it goes to (20 at most) is made in one go. */
function planDeliveries(event: DomainEvent): readonly PlannedEffect[] {
  const routing = event.webhooks;
  const made = bodyOf(event);
  if (!routing || !made) return [];
  // Not sent as it is: too large, or its stored data could not be read (a body made from it
  // would leave out what happened). A small stand-in, its deliveries made `dropped`.
  const dropped = event.stored
    ? "payload_missing"
    : encoder.encode(JSON.stringify(JSON.stringify(made))).length > DELIVERY_POLICY.maxBodyBytes
      ? "payload_too_large"
      : undefined;
  const body = dropped
    ? { event: made.event, ...(made.action !== undefined && { action: made.action }), dropped }
    : made;
  return [
    {
      target: "hooks",
      payload: {
        repoId: event.id.sourceId,
        eventKey: eventKey(event.id),
        event: body.event as string,
        action: typeof made.action === "string" ? made.action : null,
        private: routing.repo.private,
        body,
        hooks: routing.hooks,
      } satisfies PlannedDeliveries,
    },
  ];
}

/**
 * Makes the deliveries an event's effect names: their rows (one statement
 * admits them all, each against its hook's cap), the body they share, the
 * first attempt of up to `firstAttempts` of them, and a message for each
 * other one's first attempt. Done again, it finds the rows, stores the
 * body again (the same bytes) while any waits, and attempts or sends only
 * those whose first attempt was neither made nor sent.
 *
 * In this order, each step a round trip: the rows and which wait (one
 * batch); the body; the tombstone and the first attempts' claims (one
 * batch, each claim also refused once the tombstone is in); the others'
 * messages; the claimed attempts' hooks (one call to the repository
 * object, after their claims: a hook deleted before then cancelled their
 * rows); then the attempts side by side, from the body and hooks held.
 */
async function materialize(
  env: Env,
  db: D1Database,
  planned: PlannedDeliveries,
  options: {
    readonly firstAttempts: number;
    readonly metrics?: Metrics;
    readonly resolver?: DeliveryDeps["resolver"];
  },
): Promise<void> {
  const { metrics } = options;
  const stages = new Stages(metrics);
  const started = Date.now();
  let outcome = "done";
  try {
    outcome = await makeDeliveries(env, db, planned, options, stages);
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    createLogger({ op: "webhooks.materialize" }).info("an event's deliveries", {
      repo: planned.repoId,
      event: planned.eventKey,
      hooks: planned.hooks.length,
      outcome,
      elapsedMs: Date.now() - started,
      stagesMs: stages.ms,
    });
  }
}

/** `materialize`'s steps; what they came to (`done`, `none_waiting`, `deleted`). */
async function makeDeliveries(
  env: Env,
  db: D1Database,
  planned: PlannedDeliveries,
  options: {
    readonly firstAttempts: number;
    readonly metrics?: Metrics;
    readonly resolver?: DeliveryDeps["resolver"];
  },
  stages: Stages,
): Promise<string> {
  const { metrics } = options;
  const bytes = new TextEncoder().encode(JSON.stringify(planned.body));
  const payloadKey = await bodyKeyOf(planned.repoId, planned.eventKey);
  const now = Date.now();
  const rows = await Promise.all(
    planned.hooks.map(async (hook) => ({
      id: await deliveryIdOf(planned.eventKey, hook.id),
      hook: hook.id,
    })),
  );
  const dropped = typeof planned.body.dropped === "string" ? planned.body.dropped : null;
  // One row per hook, each admitted against its own hook's count of waiting deliveries; then
  // those waiting (in the same batch, so they see the rows it admitted).
  metrics?.count("d1.query", { db: "org", op: "webhooks_materialize" }, 2);
  const [, pending] = await stages.time("rows", () =>
    db.batch([
      db
        .prepare(
          `INSERT INTO webhook_deliveries (delivery_id, repo_id, hook_id, event, action, private,
             payload_key, state, reason, attempts, next_attempt_at, created_at, updated_at,
             expires_at)
           SELECT r.value ->> 'id', ?1, r.value ->> 'hook', ?2, ?3, ?4, ?5,
             CASE WHEN ?6 IS NOT NULL OR (SELECT count(*) FROM webhook_deliveries
                              WHERE repo_id = ?1 AND hook_id = r.value ->> 'hook' AND state = 'pending') >= ?7
                  THEN 'dropped' ELSE 'pending' END,
             CASE WHEN ?6 IS NOT NULL THEN ?6
                  WHEN (SELECT count(*) FROM webhook_deliveries
                        WHERE repo_id = ?1 AND hook_id = r.value ->> 'hook' AND state = 'pending') >= ?7
                  THEN 'too_many_outstanding' ELSE NULL END,
             0, ?8, ?8, ?8, ?9
           FROM json_each(?10) r
           -- None of a deleted repository once its tombstone is in: its cleanups may have run.
           WHERE NOT EXISTS (SELECT 1 FROM repos WHERE repo_id = ?1 AND deleted = 1)
           ON CONFLICT (delivery_id) DO NOTHING`,
        )
        .bind(
          planned.repoId,
          planned.event,
          planned.action,
          planned.private ? 1 : 0,
          payloadKey,
          dropped,
          DELIVERY_POLICY.maxOutstanding,
          now,
          now + DELIVERY_POLICY.retentionMs,
          JSON.stringify(rows),
        ),
      db
        .prepare(
          // In the event's hook order: the first attempts are its first hooks' still waiting.
          `SELECT w.delivery_id, w.enqueued_at FROM json_each(?) r
           JOIN webhook_deliveries w ON w.delivery_id = r.value ->> 'id'
           WHERE w.state = 'pending' ORDER BY r.key`,
        )
        .bind(JSON.stringify(rows)),
    ]),
  );
  const waiting = (pending?.results ?? []) as { delivery_id: string; enqueued_at: number | null }[];
  if (waiting.length === 0) return "none_waiting";
  // The body whenever one may still be waiting for it (stored again, it is the same bytes).
  metrics?.count("r2.class_a", { bucket: "fyrden-assets", op: "webhook_body_put" });
  await stages.time("body", () =>
    env.ASSETS.put(payloadKey, bytes, { httpMetadata: { contentType: "application/json" } }),
  );
  const unsent = waiting.filter((r) => r.enqueued_at === null).map((r) => r.delivery_id);
  const own = unsent.slice(0, options.firstAttempts);
  const attemptDeps: DeliveryDeps = {
    env,
    db,
    now: () => Date.now(),
    stages,
    ...(metrics && { metrics }),
    ...(options.resolver && { resolver: options.resolver }),
  };
  const policy = ATTEMPT_POLICY;
  const tokens = own.map(() => crypto.randomUUID());
  // The repository's deletion may have listed its bodies before this one was stored: its
  // tombstone comes before that, so either the cleanup saw the body or this sees the
  // tombstone. Read after the body is stored, with the first attempts' claims, which the
  // tombstone refuses as well.
  metrics?.count("d1.query", { db: "org", op: "webhooks_claim" }, 1 + own.length);
  const claimedAt = Date.now();
  const [tombstone, ...claims] = await stages.time("claim", () =>
    db.batch([
      db
        .prepare("SELECT 1 AS deleted FROM repos WHERE repo_id = ? AND deleted = 1")
        .bind(planned.repoId),
      ...own.map((delivery, i) =>
        claimStatement(db, delivery, tokens[i] as string, claimedAt, policy),
      ),
    ]),
  );
  if ((tombstone?.results.length ?? 0) > 0) {
    metrics?.count("r2.class_a", { bucket: "fyrden-assets", op: "webhook_body_delete" });
    await env.ASSETS.delete(payloadKey);
    return "deleted";
  }
  // The others' messages first: an attempt can take its receiver's whole deadline. Should
  // they fail, the claimed attempts are still made (or queued), and then the failure told.
  const failures: unknown[] = [];
  await enqueue(env, db, unsent.slice(own.length), metrics).catch((error) => failures.push(error));
  const claimed = claims.flatMap((result, i) => {
    const row = result.results[0] as Claimed | undefined;
    return row ? [{ row, token: tokens[i] as string }] : [];
  });
  if (claimed.length === 0) {
    if (failures.length > 0) throw failures[0];
    return "done";
  }
  // Their hooks now, after their claims, in one call.
  metrics?.count("do.request", { class: "RepoDO", method: "hooksForDelivery" });
  let hooks: Prepared["hook"][];
  try {
    hooks = await stages.time(
      "hooks",
      async (): Promise<Prepared["hook"][]> =>
        await env.REPO.getByName(planned.repoId).hooksForDelivery(
          claimed.map((c) => c.row.hook_id),
        ),
    );
  } catch (error) {
    // Each attempt is then tried again later, as when its own lookup fails.
    hooks = claimed.map(() => ({ kind: "unavailable" as const, error }));
  }
  // Side by side, each with its own fallback; every one seen through before any failure is told.
  const results = await Promise.allSettled(
    claimed.map(async ({ row, token }, i) => {
      try {
        await attemptClaimed(attemptDeps, row, token, {
          body: bytes,
          hook: hooks[i] ?? { kind: "unavailable", error: new Error("no hook looked up") },
        });
      } catch (error) {
        // Not made, or not recorded: queued instead.
        createLogger({ op: "webhooks.deliver" }).warn("a first attempt failed to run; queued", {
          delivery: row.delivery_id,
          error,
        });
        await enqueueWhenClaimable(env, db, row.delivery_id, metrics);
      }
    }),
  );
  for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length > 0) throw failures[0];
  return "done";
}

/**
 * Queues a delivery whose first attempt failed to run, for when its row
 * lets an attempt claim it: a claim taken before the failure holds it for
 * its lease, and a retry recorded before a failed send is due later. None
 * for a delivery no longer waiting.
 */
async function enqueueWhenClaimable(
  env: Env,
  db: D1Database,
  delivery: string,
  metrics?: Metrics,
): Promise<void> {
  metrics?.count("d1.query", { db: "org", op: "webhooks_claimable" });
  const row = await db
    .prepare(
      "SELECT next_attempt_at, lease_until FROM webhook_deliveries WHERE delivery_id = ? AND state = 'pending'",
    )
    .bind(delivery)
    .first<{ next_attempt_at: number; lease_until: number | null }>();
  if (!row) return;
  const at = Math.max(row.next_attempt_at, row.lease_until ?? 0);
  const delay = Math.min(Math.max(0, at - Date.now()), ATTEMPT_POLICY.maxQueueDelayMs);
  await enqueue(env, db, [delivery], metrics, Math.ceil(delay / 1000));
}

/** Sends a message for each delivery's first attempt (after `delaySeconds`), and marks them sent. */
async function enqueue(
  env: Env,
  db: D1Database,
  deliveries: readonly string[],
  metrics?: Metrics,
  delaySeconds = 0,
): Promise<void> {
  if (deliveries.length === 0) return;
  metrics?.count("queue.send", { queue: "webhooks" });
  await env.WEBHOOKS.sendBatch(
    deliveries.map((delivery) => ({
      body: { delivery } satisfies DeliveryMessage,
      ...(delaySeconds > 0 && { delaySeconds }),
    })),
  );
  metrics?.count("d1.query", { db: "org", op: "webhooks_enqueued" });
  await db
    .prepare(
      `UPDATE webhook_deliveries SET enqueued_at = ?1
       WHERE delivery_id IN (SELECT value FROM json_each(?2)) AND enqueued_at IS NULL`,
    )
    .bind(Date.now(), JSON.stringify(deliveries))
    .run();
}
