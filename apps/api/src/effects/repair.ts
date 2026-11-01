import type { Input, Output, repairEffects } from "@fyrden/api-contract";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { ReadModelRefused } from "../read-model/executor.js";
import { MAINTENANCE_RETRY_MS } from "../read-model/maintenance.js";
import { clock } from "../services.js";

/*
 * Repairing effects that failed for good while what they deliver can
 * still matter: an operator reopens them, they keep their ids and what
 * they carry, and the effects cron sends them again. Their claims check
 * their sources as any claim does, so one whose repository was deleted
 * or restored since is ended, not delivered, as is a feed or webhook
 * effect whose repository was transferred (references stand across
 * transfers).
 */

/**
 * How long after its change an effect may still be repaired: feeds drop
 * entries older than this on arrival, and a delivery that late tells no
 * one anything they could still act on. Proposed.
 */
export const REPAIR_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/** Effects one call reopens at most; call again for more. */
export const REPAIR_BATCH = 1_000;

/**
 * Failed effects of sink ?1 journaled since ?2 that a repair reopens: not
 * ended because their source moved on, nor because nothing could deliver
 * them any more (past their deadline, a page gone, no such sink), nor
 * discretionary ones (with attempts of their own: watched activity,
 * admitted for one attempt within a window that is gone), and whose change
 * (or, without one, their journaling) is after ?3.
 */
const REPAIRABLE = `state = 'failed' AND sink = ?1 AND created_at >= ?2 AND max_attempts IS NULL
  AND coalesce(last_error, '') NOT LIKE 'invalidated:%'
  AND coalesce(last_error, '') NOT LIKE 'expired:%'
  AND coalesce(last_error, '') NOT LIKE 'page missing:%'
  AND coalesce(last_error, '') NOT LIKE 'no sink named %'
  AND coalesce(json_extract(payload, '$.occurredAt'), created_at) > ?3`;

/**
 * The `admin.effects.repair` operation (instance administrators): counts
 * the effects a repair would reopen; unless a dry run, reopens up to
 * `REPAIR_BATCH` of them, oldest first, through the read model's executor:
 * pending again, due now and overdue for the cron, the failure kept in
 * `last_error` after `reopened: `. Their attempts count afresh from one,
 * not zero: one ever claimed stays claimed, as a repository's deletion goes
 * by (an invocation that claimed it may still be running, and the deletion
 * waits for it). A reopened effect is retried for its attempts, whatever
 * horizon it had.
 */
export async function repairEffectsOperation(
  ctx: OpContext,
  input: Input<typeof repairEffects>,
): Promise<Output<typeof repairEffects>> {
  const now = clock();
  if (input.since > now)
    throw new OperationError(422, "invalid_since", "`since` is in the future.");
  const db = readModelFor(ctx.env, DEFAULT_ORG_SHARD);
  const bound = [input.sink, input.since, now - REPAIR_HORIZON_MS] as const;
  ctx.metrics.count("d1.query", { db: "org", op: "effects_repair_count" });
  const found = await db
    .prepare(`SELECT count(*) AS count, min(created_at) AS oldest FROM effects WHERE ${REPAIRABLE}`)
    .bind(...bound)
    .first<{ count: number; oldest: number | null }>();
  const eligible = found?.count ?? 0;
  const oldest = found?.oldest ?? null;
  if (input.dry_run || eligible === 0) return { eligible, oldest, reopened: 0 };
  ctx.metrics.count("d1.query", { db: "org", op: "effects_repair" });
  try {
    const { results } = await db
      .prepare(
        `UPDATE effects SET state = 'pending', attempts = min(attempts, 1), deliver_until = NULL,
           next_attempt_at = ?4, recover_at = ?4, lease_token = NULL, lease_until = NULL,
           last_error = 'reopened: ' || coalesce(last_error, '')
         WHERE effect_id IN (SELECT effect_id FROM effects WHERE ${REPAIRABLE}
           ORDER BY created_at, effect_id LIMIT ?5)
         RETURNING effect_id`,
      )
      .bind(...bound, now, REPAIR_BATCH)
      .all<{ effect_id: string }>();
    return { eligible, oldest, reopened: results.length };
  } catch (error) {
    if (error instanceof ReadModelRefused)
      throw new OperationError(
        503,
        "read_model_maintenance",
        "The read model is under maintenance. Try again later.",
        undefined,
        undefined,
        MAINTENANCE_RETRY_MS / 1000,
      );
    throw error;
  }
}
