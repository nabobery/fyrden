import type { DomainEvent } from "@fyrden/domain";
import { eventKey } from "@fyrden/domain";

/**
 * The effects journal. A sink (webhooks, the activity feed) says what an
 * event requires of it, one effect per target; the consumer writes those
 * rows in the same batch as the event's projection, so an event is either
 * projected with its effects journaled or not at all. Effects are keyed by
 * event, sink and target: a redelivered event adds nothing, and every
 * destination dedupes by `effect_id` (a delivery can repeat when its
 * acknowledgement was lost).
 */

/** What an event requires of one sink: a delivery to `target` with `payload`. */
export interface PlannedEffect {
  readonly target: string;
  readonly payload: Record<string, unknown>;
}

/** A journaled effect, as the sink delivers it. */
export interface Effect {
  readonly id: string;
  readonly sink: string;
  readonly target: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

export interface EffectSink {
  /** Lowercase letters and underscores; part of every effect id. */
  readonly name: string;
  /** The effects an event requires; none for events the sink ignores. */
  plan(event: DomainEvent): readonly PlannedEffect[];
  /**
   * Delivers one effect (`db`: the read model it is journaled in). Must be
   * idempotent per `effect.id`; throws to retry later.
   */
  deliver(effect: Effect, env: Env, db: D1Database): Promise<void>;
  /**
   * Delivers several of the sink's effects at once, when the sink can do
   * better than one at a time (one call per destination they share): the
   * dispatcher then hands it every effect of the sink it claimed. Returns
   * the ids delivered and why the others were not; those are retried as a
   * failed `deliver` is. Idempotent per effect id, as `deliver`.
   */
  deliverBatch?(effects: readonly Effect[], env: Env, db: D1Database): Promise<BatchDelivery>;
  /**
   * Calls to other services (Durable Objects, D1) delivering a planned
   * effect of a batch sink makes at most, so an invocation can bound what
   * it delivers itself. One when not said.
   */
  calls?(planned: PlannedEffect): number;
}

/** What a batch delivery did: the effects delivered, and the first failure of the rest. */
export interface BatchDelivery {
  readonly delivered: readonly string[];
  readonly error?: unknown;
}

/** Proposed values. */
export interface EffectPolicy {
  /** A new effect is the sweeper's to retry only after this long (the consumer delivers it first). */
  readonly sweepAfterMs: number;
  /** First retry delay; doubles per attempt up to `maxBackoffMs`. */
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
  /** Attempts before an effect is marked failed. */
  readonly maxAttempts: number;
  /** How long a delivery holds its claim; after that, the sweeper may take the effect over. */
  readonly leaseMs: number;
  /** How long delivered effects are kept (for dedupe evidence and debugging). */
  readonly retentionMs: number;
  /**
   * Effects one claim of a sweep takes at most: a sweep claims page after
   * page while its calls last, so a page bounds the rows (and payloads) one
   * query reads, not what a run delivers.
   */
  readonly sweepPage: number;
  /** Calls to other services one sweep makes at most, its claims and marks included (see `effectCalls`). */
  readonly sweepCalls: number;
  /**
   * Effects one sweep delivers at most, whatever its calls allow: what a
   * run delivers costs CPU time as well as calls (see `EFFECT_POLICY`).
   */
  readonly sweepLimit: number;
  /**
   * Payload bytes one sweep claims at most (a run's first effect goes
   * whatever its size): reading and parsing payloads costs CPU time too.
   */
  readonly sweepBytes: number;
}

/**
 * Calls the effects cron makes besides its sweep's claims and deliveries:
 * the sweep's prune of effects past retention, and reconciling webhook
 * deliveries (about 25:
 * its batches of 4 late sends, 2 hooks to turn off, and one bulk delete of
 * expired bodies). Counted from the code, with room.
 */
export const CRON_CALLS = 50;

/** Calls one effect of a sink delivering one at a time makes at most (its claim, its work, its outcome). */
export const SINGLE_EFFECT_CALLS = 8;

/**
 * Calls one page of a sweep makes besides its effects' deliveries: its
 * claim, giving back what its calls cannot cover, and a batch sink's mark
 * and retry.
 */
export const SWEEP_ROUND_CALLS = 4;

export const EFFECT_POLICY: EffectPolicy = {
  sweepAfterMs: 60_000,
  backoffMs: 30_000,
  maxBackoffMs: 60 * 60 * 1000,
  maxAttempts: 20,
  leaseMs: 5 * 60 * 1000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  // A webhook effect's payload holds its body (up to 192 KiB): a page reads under 5 MiB.
  sweepPage: 25,
  // Free allows 1,000 calls an invocation (measured, docs/operations/limits.md): less the
  // cron's other work, and a margin.
  sweepCalls: 900 - CRON_CALLS,
  // CPU time, not calls, bounds a run: Free allows about 10 ms an invocation (verified,
  // docs/operations/limits.md), and delivering a webhook effect took 0.26 ms of CPU with a
  // small body and 0.5 ms with a 180 KB one (measured locally, 2026-10-17: the dispatcher and
  // the webhook sink with their I/O stubbed). 20 small effects take about 5 ms; the bytes let
  // at most 5 of the largest bodies (192 KiB) through, about 2.5 ms. To be confirmed on Free.
  sweepLimit: 20,
  sweepBytes: 1024 * 1024,
};

/**
 * Effects of sinks that deliver one at a time a consumer invocation of a
 * full batch (5 messages, wrangler.jsonc) delivers itself; the rest wait
 * for the sweeper. Each message fewer leaves room for as many more (see
 * `inlineEffects`). Proposed.
 */
export const INLINE_EFFECTS = 1;

/**
 * The same for an invocation of one message: within a few ms of CPU time,
 * as the sweep's `sweepLimit`, and its payloads within `sweepBytes` (5 of
 * the largest webhook bodies, 192 KiB). Proposed, to be confirmed on Free.
 */
export const INLINE_EFFECTS_ALONE = 5;

/**
 * Effects of sinks that deliver one at a time an invocation of `messages`
 * delivers itself, shared by its messages: the fewer it applies, the more
 * of its calls and CPU are left for delivering. Its calls bound it too
 * (see the events consumer).
 */
export function inlineEffects(messages: number): number {
  return Math.max(INLINE_EFFECTS, INLINE_EFFECTS_ALONE - INLINE_EFFECTS * (messages - 1));
}

/**
 * Effects of sinks that deliver in batches one consumer invocation
 * delivers itself, besides: each message's go in one call, for about four
 * D1 queries whatever their number (a claim, the sink's own lookup, one
 * mark, one retry), and fewer when the invocation's calls run short (see
 * the events consumer). Proposed.
 */
export const INLINE_BATCH_EFFECTS = 8;

const SINK_NAME = /^[a-z][a-z_]*$/;
const MAX_TARGET = 256;

/** The calls delivering `effect` makes at most, as its sink says (`EffectSink.calls`). */
export function effectCalls(sink: EffectSink | undefined, effect: PlannedEffect): number {
  if (!sink?.deliverBatch) return SINGLE_EFFECT_CALLS;
  return sink.calls?.(effect) ?? 1;
}

/** The effect's id: the event key, the sink and the target. */
export function effectId(event: DomainEvent, sink: string, target: string): string {
  return `${eventKey(event.id)}:${sink}:${target}`;
}

const encoder = new TextEncoder();

/** The bytes of effects one journal statement carries at most (a D1 value holds 2 MB). */
const STATEMENT_BYTES = 1024 * 1024;

/**
 * The journal inserts for an envelope's events, guarded like projections:
 * nothing is journaled for an event of an older epoch or an older ownership
 * generation than the read model has seen. The effects go in as few
 * statements as their size allows (one for an ordinary envelope), each
 * returning the ids (and sinks) it inserted (none for an effect already
 * journaled).
 */
export function effectStatements(
  db: D1Database,
  sinks: readonly EffectSink[],
  sourceId: string,
  events: readonly DomainEvent[],
  now: number,
  policy: EffectPolicy = EFFECT_POLICY,
): D1PreparedStatement[] {
  type Row = {
    id: string;
    sink: string;
    target: string;
    payload: string;
    epoch: number;
    ownerGen: number;
  };
  const chunks: Row[][] = [[]];
  let bytes = 0;
  for (const sink of sinks) {
    if (!SINK_NAME.test(sink.name)) throw new Error(`invalid sink name ${sink.name}`);
    for (const event of events)
      for (const planned of sink.plan(event)) {
        if (planned.target.length === 0 || planned.target.length > MAX_TARGET)
          throw new Error(`invalid effect target for sink ${sink.name}`);
        const row = {
          id: effectId(event, sink.name, planned.target),
          sink: sink.name,
          target: planned.target,
          payload: JSON.stringify(planned.payload),
          epoch: event.id.epochGen,
          ownerGen: event.ownerGen,
        };
        // The row as it is bound: UTF-8 JSON, its payload escaped once more.
        const size = encoder.encode(JSON.stringify(row)).length + 1;
        if (bytes + size > STATEMENT_BYTES && (chunks.at(-1)?.length ?? 0) > 0) {
          chunks.push([]);
          bytes = 0;
        }
        chunks.at(-1)?.push(row);
        bytes += size;
      }
  }
  return chunks
    .filter((rows) => rows.length > 0)
    .map((rows) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at)
           SELECT e.value ->> 'id', e.value ->> 'sink', e.value ->> 'target', e.value ->> 'payload', ?1, ?2
           FROM json_each(?3) e
           WHERE (e.value ->> 'epoch') >= (SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?4)
             AND (e.value ->> 'ownerGen') >=
                 coalesce((SELECT owner_gen FROM source_owner WHERE source_id = ?4), 0)
           RETURNING effect_id, sink`,
        )
        .bind(now + policy.sweepAfterMs, now, JSON.stringify(rows), sourceId),
    );
}
