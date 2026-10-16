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
  /** Effects one sweep delivers at most. */
  readonly sweepBatch: number;
}

export const EFFECT_POLICY: EffectPolicy = {
  sweepAfterMs: 60_000,
  backoffMs: 30_000,
  maxBackoffMs: 60 * 60 * 1000,
  maxAttempts: 20,
  leaseMs: 5 * 60 * 1000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  // Each costs about five D1 queries; Free allows 50 an invocation, the cron's other tasks included.
  sweepBatch: 4,
};

/**
 * Effects one consumer invocation delivers itself, whatever its batch;
 * the rest wait for the sweeper (each costs about five D1 queries, of 50
 * an invocation on Free).
 */
export const INLINE_EFFECTS = 2;

/**
 * Effects of sinks that deliver in batches one consumer invocation
 * delivers itself, besides: each message's go in one call, for about four
 * D1 queries whatever their number (a claim, the sink's own lookup, one
 * mark, one retry). Bounded
 * by the calls one delivery makes (a feed effect calls up to 100 feeds;
 * an invocation may make 1,000 calls). Proposed.
 */
export const INLINE_BATCH_EFFECTS = 8;

const SINK_NAME = /^[a-z][a-z_]*$/;
const MAX_TARGET = 256;

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
