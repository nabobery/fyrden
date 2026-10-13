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
  /** Delivers one effect. Must be idempotent per `effect.id`; throws to retry later. */
  deliver(effect: Effect, env: Env): Promise<void>;
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
  sweepBatch: 50,
};

const SINK_NAME = /^[a-z][a-z_]*$/;
const MAX_TARGET = 256;

/** The effect's id: the event key, the sink and the target. */
export function effectId(event: DomainEvent, sink: string, target: string): string {
  return `${eventKey(event.id)}:${sink}:${target}`;
}

/**
 * The journal inserts for an envelope's events, guarded like projections:
 * nothing is journaled for an event of an older epoch or an older ownership
 * generation than the read model has seen. Each statement returns the id
 * it inserted (none for an effect already journaled).
 */
export function effectStatements(
  db: D1Database,
  sinks: readonly EffectSink[],
  sourceId: string,
  events: readonly DomainEvent[],
  now: number,
  policy: EffectPolicy = EFFECT_POLICY,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const sink of sinks) {
    if (!SINK_NAME.test(sink.name)) throw new Error(`invalid sink name ${sink.name}`);
    for (const event of events)
      for (const planned of sink.plan(event)) {
        if (planned.target.length === 0 || planned.target.length > MAX_TARGET)
          throw new Error(`invalid effect target for sink ${sink.name}`);
        const id = effectId(event, sink.name, planned.target);
        statements.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6
               WHERE ?7 >= (SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?8)
                 AND ?9 >= coalesce((SELECT owner_gen FROM source_owner WHERE source_id = ?8), 0)
               RETURNING effect_id`,
            )
            .bind(
              id,
              sink.name,
              planned.target,
              JSON.stringify(planned.payload),
              now + policy.sweepAfterMs,
              now,
              event.id.epochGen,
              sourceId,
              event.ownerGen,
            ),
        );
      }
  }
  return statements;
}
