import { type DomainEvent, eventKey } from "@fyrden/domain";
import type { Effect, EffectSink, PlannedEffect } from "../effects/journal.js";
import { entityBody, webhookEventOf } from "./events.js";

/*
 * Webhook deliveries from events. An event names the hooks it goes to
 * (each at its configuration version) and what the repository was then;
 * the sink plans one effect per event, its payload the body (built from
 * the event alone, bounded in size) and the hooks. Delivering the effect
 * makes the event's deliveries: their rows (each admitted only while its
 * hook has fewer than its cap of outstanding deliveries), the body they
 * share in R2, and a queue message for each one's first attempt. Every
 * step is keyed by the delivery's id, a hash of the event and the hook,
 * so doing one again changes nothing.
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

export const webhookSink: EffectSink = {
  name: "webhooks",

  /** One effect per event: every hook it goes to (20 at most) is made in one go. */
  plan(event: DomainEvent): readonly PlannedEffect[] {
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
  },

  async deliver(effect: Effect, env: Env, db: D1Database): Promise<void> {
    await materialize(env, db, effect.payload as unknown as PlannedDeliveries);
  },
};

/**
 * Makes the deliveries an event's effect names: their rows (one statement
 * admits them all, each against its hook's cap), the body they share, and
 * a message for each one's first attempt. Done again, it finds the rows,
 * stores the body again (the same bytes) while any waits, and sends only
 * the messages not sent yet.
 */
async function materialize(env: Env, db: D1Database, planned: PlannedDeliveries): Promise<void> {
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
  // One row per hook: each admitted against its own hook's count of waiting deliveries.
  await db
    .prepare(
      `INSERT INTO webhook_deliveries (delivery_id, repo_id, hook_id, event, action, private,
         payload_key, state, reason, attempts, next_attempt_at, created_at, updated_at, expires_at)
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
       WHERE true
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
    )
    .run();
  const { results: waiting } = await db
    .prepare(
      `SELECT delivery_id, enqueued_at FROM webhook_deliveries
       WHERE delivery_id IN (SELECT value ->> 'id' FROM json_each(?)) AND state = 'pending'`,
    )
    .bind(JSON.stringify(rows))
    .all<{ delivery_id: string; enqueued_at: number | null }>();
  if (waiting.length === 0) return;
  // The body whenever one may still be waiting for it (stored again, it is the same bytes).
  await env.ASSETS.put(payloadKey, bytes, { httpMetadata: { contentType: "application/json" } });
  const results = waiting.filter((r) => r.enqueued_at === null);
  if (results.length === 0) return;
  await env.WEBHOOKS.sendBatch(
    results.map((r) => ({ body: { delivery: r.delivery_id } satisfies DeliveryMessage })),
  );
  await db
    .prepare(
      `UPDATE webhook_deliveries SET enqueued_at = ?1
       WHERE delivery_id IN (SELECT value FROM json_each(?2)) AND enqueued_at IS NULL`,
    )
    .bind(Date.now(), JSON.stringify(results.map((r) => r.delivery_id)))
    .run();
}
