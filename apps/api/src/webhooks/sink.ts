import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { type DomainEvent, eventKey } from "@fyrden/domain";
import type { WebhookBlobsRead } from "../do/repo/webhook-blobs.js";
import type { DeliverOutcome, Effect, EffectSink, PlannedEffect } from "../effects/journal.js";
import { expandedBytesOf } from "./capture.js";
import { CAPTURE_DEADLINE_MS } from "./captures.js";
import {
  blobsOf,
  captureOf,
  composeBody,
  LOGIN_BATCH,
  loginsOf,
  usersOf,
  type WebhookCapture,
} from "./compose.js";
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
 * the sink plans one effect per event, its payload the hooks and either
 * the event's capture (the body as of the event, its long text kept by
 * the repository object) or, for an event without one, a body built from
 * the event alone, bounded in size. Delivering the effect makes the
 * event's deliveries: their rows (each admitted only while its hook has
 * fewer than its cap of outstanding deliveries), the body they share in
 * R2, the first attempt of a few of them, and a queue message for each
 * other one's first attempt. Every step is keyed by the event or the
 * delivery's id (a hash of the event and the hook), so doing one again
 * changes nothing.
 *
 * A body made from a capture is made once, before any delivery: a
 * `webhook_payloads` row owns its object from before it is stored (an
 * intent), the object is stored only if none is (a second run uses the
 * first one's), and the row is then established, with the time the body
 * and its deliveries are kept until. From then on the object is the body,
 * whatever the time. Until then, past the event's deadline, none is made:
 * the first run past it closes the row (`expired`) unless it was
 * established, so no run claimed before the deadline establishes it after.
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
  /**
   * How long after its event a body is still made from a capture: as long
   * as an effect may be repaired (`fyrden effects repair`), or a feed entry
   * delivered. Past it, the event's webhooks are not made.
   */
  captureDeadlineMs: CAPTURE_DEADLINE_MS,
  /** How long past its deadline a body's intent is kept (its object found and deleted after). */
  intentGraceMs: 24 * 60 * 60_000,
  /** The largest body made from a capture (GitHub's cap); larger, the event's webhooks are not made. */
  maxComposedBytes: 25 * 1024 * 1024,
} as const;

const encoder = new TextEncoder();

/** What the deliveries an event makes, as its effect carries them, are whichever their body. */
interface PlannedBase {
  readonly repoId: string;
  readonly eventKey: string;
  readonly event: string;
  readonly action: string | null;
  readonly private: boolean;
  readonly hooks: readonly { readonly id: number; readonly v: number }[];
}

/** An event's deliveries whose body is built from the event alone (events without a capture). */
interface PlannedDeliveries extends PlannedBase {
  readonly body: Record<string, unknown>;
}

/** An event's deliveries whose body is made from its capture. */
interface PlannedCapture extends PlannedBase {
  /** When the event happened (the effects' repair reads it here too). */
  readonly occurredAt: number;
  /** The restore and ownership generations the event was made in (its blobs' fence). */
  readonly epochGen: number;
  readonly ownerGen: number;
  readonly capture: WebhookCapture;
  /**
   * The bytes the body adds besides this payload: its blobs, read back
   * once each, then in the composed body wherever they appear (the
   * dispatcher's byte budget counts them).
   */
  readonly externalBytes: number;
}

type Planned = PlannedDeliveries | PlannedCapture;

const isCapture = (planned: Planned): planned is PlannedCapture => "capture" in planned;

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
 * Calls making an event's deliveries from its capture costs besides their
 * first attempts and the logins' queries (counted from the code, on its
 * costliest path, reserved before any of it runs): `MATERIALIZE_CALLS`
 * without its body put, and the payload's row, its intent, the blobs, the
 * conditional put, the winner's body when it loses, and the
 * establishment. A body found deleted with its repository goes with its
 * payload row in two calls, instead of the messages, their mark and the
 * hooks.
 */
const CAPTURE_CALLS = MATERIALIZE_CALLS - 1 + 6;
/** Directory queries reading the logins of `users` principals. */
const loginCalls = (users: number) => Math.ceil(users / LOGIN_BATCH);
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
    deliver(
      effect: Effect,
      env: Env,
      db: D1Database,
      metrics?: Metrics,
    ): Promise<DeliverOutcome | undefined> {
      return materialize(env, db, effect.payload as unknown as Planned, {
        firstAttempts,
        claimedAt: effect.claimedAt ?? Date.now(),
        ...(metrics && { metrics }),
        ...(options.resolver && { resolver: options.resolver }),
      });
    },
    calls(planned: PlannedEffect): number {
      const payload = planned.payload as unknown as Planned;
      const made = isCapture(payload)
        ? CAPTURE_CALLS + loginCalls(usersOf(payload.capture.tree).length)
        : MATERIALIZE_CALLS;
      return made + ATTEMPT_CALLS * Math.min(payload.hooks.length, firstAttempts);
    },
  };
}

/** One effect per event: every hook it goes to (20 at most) is made in one go. */
function planDeliveries(event: DomainEvent): readonly PlannedEffect[] {
  const routing = event.webhooks;
  const name = webhookEventOf(event.type);
  if (!routing || !name) return [];
  const base = {
    repoId: event.id.sourceId,
    eventKey: eventKey(event.id),
    event: name.event,
    action: name.action,
    private: routing.repo.private,
    hooks: routing.hooks,
  } satisfies PlannedBase;
  const capture = event.stored ? "absent" : captureOf(event.data);
  // Not sent as it is: too large, its stored data could not be read (a body made from it
  // would leave out what happened), or its capture is not one this version reads. A small
  // stand-in, its deliveries made `dropped`.
  const dropped = event.stored
    ? "payload_missing"
    : capture === "invalid"
      ? "payload_invalid"
      : typeof capture === "object" && journaledBytes(capture) > DELIVERY_POLICY.maxBodyBytes
        ? "payload_too_large"
        : undefined;
  if (!dropped && typeof capture === "object")
    return [
      {
        target: "hooks",
        payload: {
          ...base,
          occurredAt: event.at,
          epochGen: event.id.epochGen,
          ownerGen: event.ownerGen,
          capture,
          externalBytes: capture.blobBytes + expandedBytesOf(capture.tree),
        } satisfies PlannedCapture,
      },
    ];
  const made = bodyOf(event) ?? {};
  const tooLarge = !dropped && journaledBytes(made) > DELIVERY_POLICY.maxBodyBytes;
  const body =
    dropped || tooLarge
      ? {
          event: name.event,
          ...(name.action !== null && { action: name.action }),
          dropped: dropped ?? "payload_too_large",
        }
      : made;
  return [{ target: "hooks", payload: { ...base, body } satisfies PlannedDeliveries }];
}

/** `value`'s size as the journal binds it: UTF-8, escaped twice (in its effect, the effect in its row). */
const journaledBytes = (value: unknown) =>
  encoder.encode(JSON.stringify(JSON.stringify(value))).length;

interface MaterializeOptions {
  readonly firstAttempts: number;
  /** When the effect was claimed: a capture's deadline is judged by it. */
  readonly claimedAt: number;
  readonly metrics?: Metrics;
  readonly resolver?: DeliveryDeps["resolver"];
}

/**
 * Makes the deliveries an event's effect names: the body they share, their
 * rows (one statement admits them all, each against its hook's cap), the
 * first attempt of up to `firstAttempts` of them, and a message for each
 * other one's first attempt. Done again, it finds the body and the rows,
 * and attempts or sends only those whose first attempt was neither made
 * nor sent. Answers `ended` when no body can be made from the event's
 * capture (see `establish`).
 */
async function materialize(
  env: Env,
  db: D1Database,
  planned: Planned,
  options: MaterializeOptions,
): Promise<DeliverOutcome | undefined> {
  const { metrics } = options;
  const stages = new Stages(metrics);
  const started = Date.now();
  let outcome = "done";
  try {
    const body = isCapture(planned)
      ? await establish(env, db, planned, options, stages)
      : await legacyBody(planned);
    if ("ended" in body) {
      outcome = body.ended;
      return body;
    }
    outcome = await makeDeliveries(env, db, planned, body, options, stages);
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

/** The body an event's deliveries share, as `makeDeliveries` makes them. */
interface Body {
  readonly key: string;
  /** Its bytes; none when its deliveries are `dropped`. */
  readonly bytes: Uint8Array | null;
  /** Why its deliveries are `dropped`, if they are. */
  readonly dropped: string | null;
  /** Until when the deliveries are kept. */
  readonly expiresAt: number;
  /**
   * Stored while any delivery waits (a body built from the event, stored
   * after its rows); else stored already, and owned by its payload row.
   */
  readonly store: boolean;
}

/** The body built from the event alone, stored after its rows. */
async function legacyBody(planned: PlannedDeliveries): Promise<Body> {
  return {
    key: await bodyKeyOf(planned.repoId, planned.eventKey),
    bytes: encoder.encode(JSON.stringify(planned.body)),
    dropped: typeof planned.body.dropped === "string" ? planned.body.dropped : null,
    expiresAt: Date.now() + DELIVERY_POLICY.retentionMs,
    store: true,
  };
}

const EXPIRED: DeliverOutcome = { ended: "expired: its body was not made within its deadline" };

/**
 * The body an event's capture makes, stored once before any of its
 * deliveries, or why none is (`ended`). In order, a round trip each:
 * the event's payload row (an established one is the body, whatever the
 * time: its object is read back, its deliveries `dropped` if it is gone);
 * past the deadline, the row closed unless established, and none made;
 * the intent (none once the repository's
 * tombstone is in); the blobs, from the repository object while the event
 * is still its own; the logins; the object, stored only if there is none
 * (a run that lost uses the winner's bytes); the establishment, which
 * sets until when the body and its deliveries are kept (refused once the
 * row was closed: the object is then deleted).
 */
async function establish(
  env: Env,
  db: D1Database,
  planned: PlannedCapture,
  options: MaterializeOptions,
  stages: Stages,
): Promise<Body | DeliverOutcome> {
  const { metrics } = options;
  const key = await bodyKeyOf(planned.repoId, planned.eventKey);
  const owned = (bytes: Uint8Array | null, expiresAt: number): Body => ({
    key,
    bytes,
    dropped: bytes ? null : "payload_missing",
    expiresAt,
    store: false,
  });
  const established = async (expiresAt: number) => {
    metrics?.count("r2.class_b", { bucket: "fyrden-assets", op: "webhook_body_get" });
    const object = await stages.time("body_read", () => env.ASSETS.get(key));
    return owned(object ? new Uint8Array(await object.arrayBuffer()) : null, expiresAt);
  };
  metrics?.count("d1.query", { db: "org", op: "webhooks_payload" });
  const found = await stages.time("payload", () =>
    db
      .prepare("SELECT state, expires_at FROM webhook_payloads WHERE event_key = ?")
      .bind(planned.eventKey)
      .first<{ state: string; expires_at: number }>(),
  );
  if (found?.state === "established") return established(found.expires_at);
  if (found?.state === "expired") return EXPIRED;
  const deadline = planned.occurredAt + DELIVERY_POLICY.captureDeadlineMs;
  const intentExpiresAt = deadline + DELIVERY_POLICY.intentGraceMs;
  if (options.claimedAt > deadline) {
    // Past it, the payload is closed unless it was established: a run claimed before the
    // deadline (it can outlive its claim) can then no longer establish it, and one that did
    // and stopped before its deliveries left a body this run makes them from.
    metrics?.count("d1.query", { db: "org", op: "webhooks_expire" }, 2);
    const [, closed] = await stages.time("expire", () =>
      db.batch([
        db
          .prepare(
            `INSERT INTO webhook_payloads (event_key, repo_id, payload_key, state, expires_at)
             VALUES (?1, ?2, ?3, 'expired', ?4)
             ON CONFLICT (event_key) DO UPDATE SET state = 'expired' WHERE state = 'intent'`,
          )
          .bind(planned.eventKey, planned.repoId, key, intentExpiresAt),
        db
          .prepare("SELECT state, expires_at FROM webhook_payloads WHERE event_key = ?")
          .bind(planned.eventKey),
      ]),
    );
    const row = closed?.results[0] as { state: string; expires_at: number } | undefined;
    return row?.state === "established" ? established(row.expires_at) : EXPIRED;
  }
  if (!found) {
    metrics?.count("d1.query", { db: "org", op: "webhooks_intent" }, 2);
    const [, intent] = await stages.time("intent", () =>
      db.batch([
        db
          .prepare(
            // None once the repository's tombstone is in: its cleanups may have run.
            `INSERT INTO webhook_payloads (event_key, repo_id, payload_key, state, expires_at)
             SELECT ?1, ?2, ?3, 'intent', ?4
             WHERE NOT EXISTS (SELECT 1 FROM repos WHERE repo_id = ?2 AND deleted = 1)
             ON CONFLICT (event_key) DO NOTHING`,
          )
          .bind(planned.eventKey, planned.repoId, key, intentExpiresAt),
        db
          .prepare("SELECT state, expires_at FROM webhook_payloads WHERE event_key = ?")
          .bind(planned.eventKey),
      ]),
    );
    const row = intent?.results[0] as { state: string; expires_at: number } | undefined;
    if (!row) return { ended: "invalidated: its source was deleted" };
    // Another run established it meanwhile, or closed it past the deadline.
    if (row.state === "established") return established(row.expires_at);
    if (row.state === "expired") return EXPIRED;
  }
  const { capture } = planned;
  const hashes = blobsOf(capture.tree);
  let texts = new Map<string, string>();
  if (hashes.length > 0) {
    metrics?.count("do.request", { class: "RepoDO", method: "webhookBlobs" });
    const read = await stages.time(
      "blobs",
      async (): Promise<WebhookBlobsRead> =>
        await env.REPO.getByName(planned.repoId).webhookBlobs({
          hashes,
          epochGen: planned.epochGen,
          ownerGen: planned.ownerGen,
        }),
    );
    if ("missing" in read)
      return {
        ended:
          read.missing === "absent"
            ? "payload_missing: a text its body names is no longer kept"
            : `invalidated: its source was ${read.missing}`,
      };
    texts = new Map(Object.entries(read.texts));
  }
  const logins = await stages.time("logins", () => loginsOf(env, usersOf(capture.tree), metrics));
  let composed: Uint8Array;
  try {
    composed = encoder.encode(JSON.stringify(composeBody(capture, texts, logins)));
  } catch (error) {
    return { ended: `payload_invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (composed.length > DELIVERY_POLICY.maxComposedBytes) return { ended: "payload_too_large" };
  metrics?.count("r2.class_a", { bucket: "fyrden-assets", op: "webhook_body_put" });
  const put = await stages.time("body", () =>
    env.ASSETS.put(key, composed, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/json" },
    }),
  );
  let bytes = composed;
  if (put === null) {
    // Another run stored it first: its bytes are the body.
    metrics?.count("r2.class_b", { bucket: "fyrden-assets", op: "webhook_body_get" });
    const winner = await env.ASSETS.get(key);
    if (!winner) throw new Error(`webhook body ${key} was stored by another run, then went`);
    bytes = new Uint8Array(await winner.arrayBuffer());
  }
  metrics?.count("d1.query", { db: "org", op: "webhooks_establish" }, 2);
  const [, now] = await stages.time("establish", () =>
    db.batch([
      db
        .prepare(
          `UPDATE webhook_payloads SET state = 'established', bytes = ?2, expires_at = ?3
           WHERE event_key = ?1 AND state = 'intent'`,
        )
        .bind(planned.eventKey, bytes.length, Date.now() + DELIVERY_POLICY.retentionMs),
      db
        .prepare("SELECT state, expires_at FROM webhook_payloads WHERE event_key = ?")
        .bind(planned.eventKey),
    ]),
  );
  const row = now?.results[0] as { state: string; expires_at: number } | undefined;
  if (row?.state !== "established") {
    // Closed past the deadline by another run, or its row went (collected past its time, or
    // the repository's cleanup): the object is no one's.
    metrics?.count("r2.class_a", { bucket: "fyrden-assets", op: "webhook_body_delete" });
    await env.ASSETS.delete(key);
    return row ? EXPIRED : { ended: "expired: its body's record was removed before it was made" };
  }
  return owned(bytes, row.expires_at);
}

/**
 * `materialize`'s steps once the body is known; what they came to (`done`,
 * `none_waiting`, `deleted`). In this order, each step a round trip: the
 * rows, which wait, and the repository's tombstone (one batch); a body
 * built from the event, stored while any waits; the tombstone again and
 * the first attempts' claims (one batch, each claim also refused once the
 * tombstone is in); the others' messages; the claimed attempts' hooks (one
 * call to the repository object, after their claims: a hook deleted
 * before then cancelled their rows); then the attempts side by side, from
 * the body and hooks held. A body found deleted with its repository goes
 * (and its payload row, when it has one).
 */
async function makeDeliveries(
  env: Env,
  db: D1Database,
  planned: PlannedBase,
  body: Body,
  options: MaterializeOptions,
  stages: Stages,
): Promise<string> {
  const { metrics } = options;
  const payloadKey = body.key;
  const now = Date.now();
  const rows = await Promise.all(
    planned.hooks.map(async (hook) => ({
      id: await deliveryIdOf(planned.eventKey, hook.id),
      hook: hook.id,
    })),
  );
  const { dropped } = body;
  // The body and its payload row, once the repository is found deleted: its cleanups may have
  // listed its bodies before this one was stored.
  const forget = async () => {
    metrics?.count("r2.class_a", { bucket: "fyrden-assets", op: "webhook_body_delete" });
    await env.ASSETS.delete(payloadKey);
    if (body.store) return;
    metrics?.count("d1.query", { db: "org", op: "webhooks_payload_forget" });
    await db
      .prepare("DELETE FROM webhook_payloads WHERE event_key = ?")
      .bind(planned.eventKey)
      .run();
  };
  // One row per hook, each admitted against its own hook's count of waiting deliveries; then
  // those waiting (in the same batch, so they see the rows it admitted), and the tombstone.
  metrics?.count("d1.query", { db: "org", op: "webhooks_materialize" }, 3);
  const [, pending, deletedBefore] = await stages.time("rows", () =>
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
          body.expiresAt,
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
      db
        .prepare("SELECT 1 AS deleted FROM repos WHERE repo_id = ? AND deleted = 1")
        .bind(planned.repoId),
    ]),
  );
  // A body stored before its rows is not left behind by a deletion that refused them.
  if (!body.store && (deletedBefore?.results.length ?? 0) > 0) {
    await forget();
    return "deleted";
  }
  const waiting = (pending?.results ?? []) as { delivery_id: string; enqueued_at: number | null }[];
  if (waiting.length === 0 || !body.bytes) return "none_waiting";
  const bytes = body.bytes;
  if (body.store) {
    // The body whenever one may still be waiting for it (stored again, it is the same bytes).
    metrics?.count("r2.class_a", { bucket: "fyrden-assets", op: "webhook_body_put" });
    await stages.time("body", () =>
      env.ASSETS.put(payloadKey, bytes, { httpMetadata: { contentType: "application/json" } }),
    );
  }
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
    await forget();
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
  await env.WEBHOOKS.sendBatch(
    deliveries.map((delivery) => ({
      body: { delivery } satisfies DeliveryMessage,
      ...(delaySeconds > 0 && { delaySeconds }),
    })),
  );
  metrics?.count("queue.send", { queue: "webhooks" }, deliveries.length);
  metrics?.count("d1.query", { db: "org", op: "webhooks_enqueued" });
  await db
    .prepare(
      `UPDATE webhook_deliveries SET enqueued_at = ?1
       WHERE delivery_id IN (SELECT value FROM json_each(?2)) AND enqueued_at IS NULL`,
    )
    .bind(Date.now(), JSON.stringify(deliveries))
    .run();
}
