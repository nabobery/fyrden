import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { DomainEvent } from "@fyrden/domain";
import { eventKey } from "@fyrden/domain";

/**
 * The effects journal. A sink (webhooks, the activity feed) says what an
 * event requires of it, one effect per target; the consumer writes those
 * rows in the same batch as the event's projection, so an event is either
 * projected with its effects journaled or not at all, then sends their ids
 * to the sink's queue, whose consumer delivers them. Effects are keyed by
 * event, sink and target: a redelivered event adds nothing, and every
 * destination dedupes by `effect_id` (a delivery can repeat when its
 * acknowledgement was lost). The journal, not the queue, decides: a message
 * only says which effects to look at.
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
   * Delivers one effect (`db`: the read model it is journaled in; `metrics`:
   * the invocation's, for the sink's own calls). Must be idempotent per
   * `effect.id`; throws to retry later.
   */
  deliver(effect: Effect, env: Env, db: D1Database, metrics?: Metrics): Promise<void>;
  /**
   * Delivers several of the sink's effects at once, when the sink can do
   * better than one at a time (one call per destination they share): the
   * dispatcher then hands it every effect of the sink it claimed. Returns
   * the ids delivered and why the others were not; those are retried as a
   * failed `deliver` is. Idempotent per effect id, as `deliver`.
   */
  deliverBatch?(
    effects: readonly Effect[],
    env: Env,
    db: D1Database,
    metrics?: Metrics,
  ): Promise<BatchDelivery>;
  /**
   * Calls to other services (Durable Objects, D1) delivering a planned
   * effect of a batch sink makes at most, so an invocation can bound what
   * it delivers itself. One when not said.
   */
  calls?(planned: PlannedEffect): number;
  /**
   * Its effects stand across a transfer of their source: what they carry
   * does not depend on who owned it (the journal still drops a deleted
   * source's, and a restored epoch's).
   */
  readonly acrossTransfers?: boolean;
  /**
   * Effects one queue message of the sink names at most (`PER_MESSAGE` when
   * not said): about what one invocation delivers in its CPU time (see
   * `EffectPolicy.invocation`), so messages are delivered side by side.
   */
  readonly perMessage?: number;
  /**
   * The events consumer delivers some of the sink's effects itself (see
   * `INLINE_BATCH_EFFECTS`), sparing them a queue's wait; a batch sink only.
   */
  readonly inline?: boolean;
}

/** What a batch delivery did: the effects delivered, and the first failure of the rest. */
export interface BatchDelivery {
  readonly delivered: readonly string[];
  readonly error?: unknown;
}

/** Proposed values. */
export interface EffectPolicy {
  /** First retry delay; doubles per attempt up to `maxBackoffMs`. */
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
  /** Attempts before an effect is marked failed; a claim counts as one, so a run that dies does too. */
  readonly maxAttempts: number;
  /** How long a delivery holds its claim; after that, a message naming the effect may take it over. */
  readonly leaseMs: number;
  /** How long delivered effects are kept (for dedupe evidence and debugging). */
  readonly retentionMs: number;
  /**
   * How long a journaled effect waits for its message to be sent before it
   * is overdue (the consumer may have stopped between its batch and its send).
   */
  readonly publishGraceMs: number;
  /**
   * How long past its due time a published effect waits for its message
   * before it is overdue: longer than a queue's wait under a backlog, so a
   * slow queue is not taken for a lost message.
   */
  readonly lateMs: number;
  /** Overdue effects one run of the effects cron sends again. */
  readonly recoverPage: number;
  /** One effects consumer invocation's share of what it may do (see `EffectBudget`). */
  readonly invocation: {
    /** Calls to other services, its claims and marks included (see `effectCalls`). */
    readonly calls: number;
    /** Effects it delivers at most, whatever its calls allow: delivering costs CPU time too. */
    readonly effects: number;
    /** Payload bytes it claims at most (its first effect whatever its size). */
    readonly bytes: number;
    /**
     * Wall time after which it starts no more deliveries, well within a
     * claim (`leaseMs`): what is left goes back to the queue.
     */
    readonly deadlineMs: number;
  };
}

/** Calls one effect of a sink delivering one at a time makes at most (its work and its outcome). */
export const SINGLE_EFFECT_CALLS = 8;

/**
 * Calls one message of the effects consumer makes besides its effects'
 * deliveries: its claim, giving back what its budget cannot cover, a mark,
 * a retry, and sending what is left or retried.
 */
export const MESSAGE_CALLS = 6;

export const EFFECT_POLICY: EffectPolicy = {
  backoffMs: 30_000,
  maxBackoffMs: 60 * 60 * 1000,
  maxAttempts: 20,
  leaseMs: 5 * 60 * 1000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  publishGraceMs: 60_000,
  lateMs: 10 * 60_000,
  // A claim, a send per sink (100 messages a call) and a mark per failed send: with the cron's
  // other work (reconciling webhook deliveries, about 25 calls, and the prune) about 35 calls a
  // run, far within the 1,000 an invocation has.
  recoverPage: 100,
  invocation: {
    // Free allows 1,000 calls an invocation (measured, docs/operations/limits.md), less a margin.
    calls: 900,
    // CPU time, not calls, bounds an invocation: Free allows about 10 ms (verified,
    // docs/operations/limits.md), and a cron run delivering 20 webhook effects took 42 to 86 ms
    // on Free (measured, 2026-10-17). Each sink's messages carry fewer (`EffectSink.perMessage`),
    // and its queue's batch size bounds how many messages an invocation takes; this caps a batch.
    effects: 20,
    // A webhook effect's payload holds its body (up to 192 KiB): at most 5 of the largest.
    bytes: 1024 * 1024,
    deadlineMs: 60_000,
  },
};

/**
 * Effects of sinks that deliver in batches and are delivered inline
 * (`EffectSink.inline`) one events consumer invocation delivers itself:
 * each message's go in one call, for about four D1 queries whatever their
 * number (a claim, the sink's own lookup, one mark, one retry), and fewer
 * when the invocation's calls run short (see the events consumer). The
 * rest go to their queue. Proposed.
 */
export const INLINE_BATCH_EFFECTS = 8;

/** Effects a queue message names at most, unless its sink says (`EffectSink.perMessage`). Proposed. */
export const PER_MESSAGE = 10;

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
 * generation than the read model has seen. Each effect is due at once, and
 * keeps where it came from for its claim to check again. The effects go in as few
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
  return journalStatements(db, sourceId, planEffects(sinks, events), now, policy);
}

/** An effect an event requires, as it is journaled. */
export interface JournalRow {
  readonly id: string;
  readonly sink: string;
  readonly target: string;
  readonly payload: string;
  readonly epoch: number;
  readonly ownerGen: number;
  readonly anyOwner: 0 | 1;
  /** The calls delivering it makes at most (see `effectCalls`). */
  readonly calls: number;
}

/** The effects `events` require of `sinks`, each sink asked once per event. */
export function planEffects(
  sinks: readonly EffectSink[],
  events: readonly DomainEvent[],
): JournalRow[] {
  const rows: JournalRow[] = [];
  for (const sink of sinks) {
    if (!SINK_NAME.test(sink.name)) throw new Error(`invalid sink name ${sink.name}`);
    for (const event of events)
      for (const planned of sink.plan(event)) {
        if (planned.target.length === 0 || planned.target.length > MAX_TARGET)
          throw new Error(`invalid effect target for sink ${sink.name}`);
        rows.push({
          id: effectId(event, sink.name, planned.target),
          sink: sink.name,
          target: planned.target,
          payload: JSON.stringify(planned.payload),
          epoch: event.id.epochGen,
          ownerGen: event.ownerGen,
          anyOwner: sink.acrossTransfers ? 1 : 0,
          calls: effectCalls(sink, planned),
        });
      }
  }
  return rows;
}

/** `effectStatements` for effects already planned (`planEffects`). */
export function journalStatements(
  db: D1Database,
  sourceId: string,
  planned: readonly JournalRow[],
  now: number,
  policy: EffectPolicy = EFFECT_POLICY,
): D1PreparedStatement[] {
  type Row = Omit<JournalRow, "calls">;
  const chunks: Row[][] = [[]];
  let bytes = 0;
  for (const { calls: _calls, ...row } of planned) {
    // The row as it is bound: UTF-8 JSON, its payload escaped once more.
    const size = encoder.encode(JSON.stringify(row)).length + 1;
    if (bytes + size > STATEMENT_BYTES && (chunks.at(-1)?.length ?? 0) > 0) {
      chunks.push([]);
      bytes = 0;
    }
    chunks.at(-1)?.push(row);
    bytes += size;
  }
  return chunks
    .filter((rows) => rows.length > 0)
    .map((rows) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO effects (effect_id, sink, target, payload, next_attempt_at,
             created_at, source_id, epoch_gen, owner_gen, any_owner, recover_at)
           SELECT e.value ->> 'id', e.value ->> 'sink', e.value ->> 'target', e.value ->> 'payload',
             ?2, ?2, ?4, e.value ->> 'epoch', e.value ->> 'ownerGen', e.value ->> 'anyOwner', ?1
           FROM json_each(?3) e
           WHERE (e.value ->> 'epoch') >= (SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?4)
             AND ((e.value ->> 'anyOwner') = 1 OR (e.value ->> 'ownerGen') >=
                 coalesce((SELECT owner_gen FROM source_owner WHERE source_id = ?4), 0))
             -- Nothing of a deleted repository once its tombstone is in: its cleanups may have run.
             AND NOT EXISTS (SELECT 1 FROM repos WHERE repo_id = ?4 AND deleted = 1)
           RETURNING effect_id, sink`,
        )
        .bind(now + policy.publishGraceMs, now, JSON.stringify(rows), sourceId),
    );
}
