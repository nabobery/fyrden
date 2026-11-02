import type { Input, Output, replayFailedEvents } from "@fyrden/api-contract";
import { OUTBOX_POLICY } from "../do/base/outbox.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { ReadModelRefused } from "../read-model/executor.js";
import { MAINTENANCE_RETRY_MS } from "../read-model/maintenance.js";
import { clock } from "../services.js";

/*
 * Replaying an account's failed envelope: an operator puts the envelope
 * the dead-letter queue kept back on the events queue, and the events
 * consumer applies it as any envelope, within its own budgets. An
 * account's events project nothing; what they mean for its members' feeds
 * (`access.revoked`: repositories purged from the feeds of those who no
 * longer read them) is journaled with ids of the events' own, so applying
 * an envelope again journals nothing it journaled before, and a feed
 * applies a purge once. The record is claimed (`requeued_at`) and sent
 * once; one that fails again goes to the dead-letter queue as any
 * envelope does, a record of its own. A repository's envelope is not
 * replayed: its record asked for its repository's search repair, and a
 * reconciliation brings its projections back whole.
 */

/**
 * How long before a stored payload's retention could end an envelope
 * naming it is no longer replayed: room for the queue's wait and the
 * consumer's retries. Proposed.
 */
export const REPLAY_PAYLOAD_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the record `?1` can be replayed at `?2`, or why not. A stored
 * payload is kept its retention after its event was sent, which is never
 * before the event: one of an event from `?3` or before may be gone (and
 * its purge with it), so its envelope is not replayed.
 */
const STATE = `CASE
  WHEN kind <> 'account' OR source_id IS NULL THEN 'not_replayable'
  WHEN requeued_at IS NOT NULL THEN 'already_replayed'
  WHEN expires_at <= ?2 THEN 'envelope_expired'
  WHEN envelope IS NULL THEN 'envelope_not_kept'
  WHEN EXISTS (SELECT 1 FROM json_each(envelope, '$.events') e
    WHERE e.value ->> 'stored' AND (e.value ->> 'at') <= ?3) THEN 'payload_expired'
  ELSE 'replayable' END`;

const REFUSALS: Readonly<Record<string, () => OperationError>> = {
  not_replayable: () =>
    new OperationError(
      409,
      "not_replayable",
      "Only an account's failed envelope is replayed: a repository's asked for its search repair when it failed, and one that could not be read cannot be.",
    ),
  already_replayed: () =>
    new OperationError(409, "already_replayed", "This failed envelope was replayed already."),
  envelope_expired: () =>
    new OperationError(
      410,
      "envelope_expired",
      "This failed envelope was kept its time and is no longer replayed.",
    ),
  envelope_not_kept: () =>
    new OperationError(
      410,
      "envelope_not_kept",
      "This failed envelope was stored without its events (too large, too deep or not JSON).",
    ),
  payload_expired: () =>
    new OperationError(
      410,
      "payload_expired",
      "This failed envelope names events whose stored payloads may no longer be kept, and is no longer replayed.",
    ),
};

const maintenance = () =>
  new OperationError(
    503,
    "read_model_maintenance",
    "The read model is under maintenance. Try again later.",
    undefined,
    undefined,
    MAINTENANCE_RETRY_MS / 1000,
  );

/**
 * The `admin.events.replay` operation (instance administrators): one
 * read-model batch, under admission, reads the record and claims it when
 * it can be replayed (so nothing is decided, and no absence answered,
 * while the read model is paused or recovering), then one send. A send
 * that fails gives the claim back.
 */
export async function replayFailedEventsOperation(
  ctx: OpContext,
  input: Input<typeof replayFailedEvents>,
): Promise<Output<typeof replayFailedEvents>> {
  const now = clock();
  const db = readModelFor(ctx.env, DEFAULT_ORG_SHARD);
  const bound = [input.id, now, now - OUTBOX_POLICY.payloadRetentionMs + REPLAY_PAYLOAD_MARGIN_MS];
  let read: D1Result<{ state: string }>;
  let claimed: D1Result<{ source_id: string; envelope: string }>;
  ctx.metrics.count("d1.query", { db: "org", op: "events_failed_replay" });
  try {
    [read, claimed] = (await db.batch([
      db.prepare(`SELECT ${STATE} AS state FROM events_failed WHERE id = ?1`).bind(...bound),
      db
        .prepare(
          `UPDATE events_failed SET requeued_at = ?2 WHERE id = ?1 AND ${STATE} = 'replayable'
           RETURNING source_id, envelope`,
        )
        .bind(...bound),
    ])) as [D1Result<{ state: string }>, D1Result<{ source_id: string; envelope: string }>];
  } catch (error) {
    if (error instanceof ReadModelRefused) throw maintenance();
    throw error;
  }
  const state = read.results[0]?.state;
  if (state === undefined)
    throw new OperationError(404, "failure_not_found", "No failed envelope has this id.");
  const claim = claimed.results[0];
  if (!claim) {
    const refusal = REFUSALS[state];
    // Read and claimed in one transaction: a replayable record is always claimed.
    throw refusal ? refusal() : new Error(`a failed envelope left unclaimed: ${state}`);
  }
  try {
    // An envelope the outbox sent as one message: it fits one again.
    await ctx.env.EVENTS.send(JSON.parse(claim.envelope), { contentType: "json" });
    ctx.metrics.count("queue.send", { queue: "events" });
  } catch (error) {
    ctx.log.error("requeueing a failed envelope failed", { error, failureId: input.id });
    // Given back, the record can be replayed again; if that fails too, the request's outcome is
    // unknown (its key refuses retries).
    ctx.metrics.count("d1.query", { db: "org", op: "events_failed_release" });
    await db
      .prepare("UPDATE events_failed SET requeued_at = NULL WHERE id = ?1 AND requeued_at = ?2")
      .bind(input.id, now)
      .run();
    throw new OperationError(
      503,
      "requeue_failed",
      "The events queue did not take the envelope; nothing was replayed. Try again.",
    );
  }
  return { id: input.id, source_id: claim.source_id, requeued_at: now };
}
