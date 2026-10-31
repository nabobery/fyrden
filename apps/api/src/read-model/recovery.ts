import { readModelFor } from "../events/read-model.js";
import { TODAY } from "../search/admission.js";
import { FENCING_PAGE, fenceStep } from "../search/recovery.js";
import { clock } from "../services.js";
import { IMPORT_STEP, importStep } from "./import.js";
import { admitted } from "./maintenance.js";
import { PRESERVATION_PAGE, PreservationRefused, preserveStep } from "./preservation.js";
import { handshake, restoreTokenState } from "./restore-token.js";

/*
 * A recovery of the read model after a restore (D1 Time Travel, run by its
 * operator), stage by stage, each step bounded and resumable from where the
 * directory says it stands:
 *
 * - preserving: its operational rows kept (`preserveStep`), until sealed;
 * - awaiting_restore: the operator restores the read model, then reports
 *   the restore (the bookmark it went to, and the one that undoes it): the
 *   restored read model's barrier is brought to the recovery's generation,
 *   paused;
 * - importing: the operational rows made exactly as preserved (`importStep`);
 * - fencing: search readied (`fenceStep`);
 * - resuming: the restore token taken over from what the restored read model
 *   holds and replaced by a handshake; the recovery's charges added to
 *   search's recovery spending and the read model's barrier running, in one
 *   transaction; then the directory's barrier running and the recovery
 *   complete.
 *
 * Each step is charged its stage's most (conservative, never refunded),
 * kept in the directory (the read model is what was restored) until the
 * resume adds them to the read model's spending.
 */

/**
 * A preserved row's entries at most, as D1 counts rows written: itself and
 * each of its table's indexes (`webhook_deliveries`': its key's and eight).
 */
export const MOST_ENTRIES = 10;

/**
 * What a step of each stage is charged, before it is taken (never refunded,
 * whether it wrote or failed): its most rows written and read in the read
 * model. The resume's own is in what it adds to the read model's spending.
 */
export const CHARGES: Record<string, { rows: number; reads: number }> = {
  preserving: { rows: 0, reads: 2 * PRESERVATION_PAGE.rows + 50 },
  awaiting_restore: { rows: 10, reads: 10 },
  // Its count and removal each read the page's keys once and the range's rows (one past what it
  // removes, with the page's own), each row compared reads itself, and each row written or
  // removed is read by its admission's triggers.
  importing: {
    rows: (IMPORT_STEP.rows + IMPORT_STEP.removed) * MOST_ENTRIES + 10,
    reads:
      2 * (2 * PRESERVATION_PAGE.rows + IMPORT_STEP.removed + 1) +
      2 * PRESERVATION_PAGE.rows +
      2 * (IMPORT_STEP.rows + IMPORT_STEP.removed) * MOST_ENTRIES +
      100,
  },
  fencing: { rows: FENCING_PAGE * MOST_ENTRIES + 10, reads: 3 * FENCING_PAGE + 50 },
};
const RESUMING = { rows: 20, reads: 50 };

export type RecoveryStage =
  | "preserving"
  | "awaiting_restore"
  | "importing"
  | "fencing"
  | "resuming"
  | "complete";

export interface RecoveryState {
  readonly recoveryId: string;
  readonly generation: number;
  readonly stage: RecoveryStage;
}

interface Row {
  readonly recovery_id: string;
  readonly generation: number;
  readonly stage: RecoveryStage;
  readonly usage_rows: number;
  readonly usage_reads: number;
}

async function rowOf(env: Pick<Env, "DIRECTORY">, shard: string): Promise<Row | null> {
  return env.DIRECTORY.prepare(
    `SELECT recovery_id, generation, stage, usage_rows, usage_reads FROM read_model_recoveries
     WHERE shard = ?`,
  )
    .bind(shard)
    .first<Row>();
}

/** The shard's recovery, the latest (complete or not); null when there never was one. */
export async function recoveryState(
  env: Pick<Env, "DIRECTORY">,
  shard: string,
): Promise<RecoveryState | null> {
  const row = await rowOf(env, shard);
  return row ? { recoveryId: row.recovery_id, generation: row.generation, stage: row.stage } : null;
}

/** The restore its operator reports: the bookmark the read model went to, and the undoing one. */
export interface RestoreReceipt {
  readonly bookmark: string;
  readonly undoBookmark: string;
}

/**
 * One step of the shard's recovery `recoveryId`, as its stage says (one
 * awaiting its restore moves on only with the operator's `restore`): where
 * it stands after it.
 */
export async function recoveryStep(
  env: Pick<Env, "DIRECTORY" | "ORG_READ" | "ASSETS">,
  shard: string,
  recoveryId: string,
  restore?: RestoreReceipt,
): Promise<RecoveryState> {
  const row = await rowOf(env, shard);
  if (row?.recovery_id !== recoveryId) throw new PreservationRefused("no such recovery");
  const { stage, generation } = row;
  const charged = async () => {
    const charge = CHARGES[stage];
    if (charge)
      await env.DIRECTORY.prepare(
        `UPDATE read_model_recoveries SET usage_rows = usage_rows + ?2, usage_reads = usage_reads + ?3
         WHERE recovery_id = ?1`,
      )
        .bind(recoveryId, charge.rows, charge.reads)
        .run();
  };
  /** The stage moved on from this one. */
  const advanced = (to: RecoveryStage, extra = "", ...params: (string | number)[]) =>
    env.DIRECTORY.prepare(
      `UPDATE read_model_recoveries SET stage = ?3, cursor = NULL, updated_at = ?4 ${extra}
       WHERE recovery_id = ?1 AND stage = ?2`,
    )
      .bind(recoveryId, stage, to, clock(), ...params)
      .run();
  // Charged first: a step that fails after it wrote is charged all the same.
  if (stage !== "awaiting_restore" || restore) await charged();
  switch (stage) {
    case "preserving":
      await preserveStep(env, shard, recoveryId);
      break;
    case "awaiting_restore": {
      if (!restore) break;
      // The restored read model's barrier, whatever it held, brought to this recovery's generation.
      if (
        !(await admitted(env, shard, generation, (org) =>
          org
            .prepare(
              `UPDATE read_model_barrier SET phase = 'paused', generation = ?1
               WHERE id = 1 AND generation <= ?1`,
            )
            .bind(generation),
        ))
      )
        throw new PreservationRefused("the barrier left the recovery's generation");
      await advanced(
        "importing",
        ", restore_bookmark = ?5, undo_bookmark = ?6",
        restore.bookmark,
        restore.undoBookmark,
      );
      break;
    }
    case "importing":
      if ((await importStep(env, shard, recoveryId)).done) await advanced("fencing");
      break;
    case "fencing":
      await fenceStep(env, shard, recoveryId);
      break;
    case "resuming":
      await resume(env, shard, recoveryId, generation);
      break;
    case "complete":
      break;
  }
  const after = await recoveryState(env, shard);
  if (!after) throw new PreservationRefused("no such recovery");
  return after;
}

/**
 * The resume: the restore token taken over from what the restored read
 * model holds (it is the read model the directory knows now) and replaced;
 * the recovery's charges and the read model's barrier running, in one
 * transaction (made once: only while it is paused at the recovery's
 * generation); then the directory's barrier running and the recovery
 * complete. A resume interrupted is finished from where it stopped.
 */
async function resume(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
  recoveryId: string,
  generation: number,
): Promise<void> {
  const db = readModelFor(env, shard);
  // The token: taken over from what the restored read model holds, then replaced (whatever it was,
  // matched too: a restore to it again would go unseen), each recorded in the recovery's cursor.
  const at = await env.DIRECTORY.prepare(
    "SELECT cursor FROM read_model_recoveries WHERE recovery_id = ? AND stage = 'resuming'",
  )
    .bind(recoveryId)
    .first<{ cursor: string | null }>();
  const cursor = (at?.cursor ? JSON.parse(at.cursor) : {}) as {
    adopted?: string | null;
    rotated?: true;
  };
  const record = (next: typeof cursor) =>
    env.DIRECTORY.prepare(
      `UPDATE read_model_recoveries SET cursor = ?2 WHERE recovery_id = ?1 AND stage = 'resuming'
         AND cursor IS ?3`,
    )
      .bind(recoveryId, JSON.stringify(next), at?.cursor ?? null)
      .run();
  if (!cursor.rotated) {
    // Each of these steps charged before it is taken (the transfer's own is in what it adds).
    await env.DIRECTORY.prepare(
      `UPDATE read_model_recoveries SET usage_rows = usage_rows + ?2, usage_reads = usage_reads + ?3
       WHERE recovery_id = ?1`,
    )
      .bind(recoveryId, RESUMING.rows, RESUMING.reads)
      .run();
    if (!("adopted" in cursor)) {
      const held = await db
        .prepare("SELECT token FROM read_model_restore_token WHERE id = 1")
        .first<{ token: string }>();
      // Taken over and recorded together, only from where this step found the cursor: a step
      // stalled meanwhile takes nothing over again.
      const unchanged = `EXISTS (SELECT 1 FROM read_model_recoveries
        WHERE shard = ?1 AND recovery_id = ?4 AND stage = 'resuming' AND cursor IS ?5)`;
      await env.DIRECTORY.batch([
        env.DIRECTORY.prepare(
          `UPDATE read_model_barriers SET token_completed = ?2, token_next = NULL,
             token_previous = NULL
           WHERE shard = ?1 AND phase = 'recovering' AND generation = ?3 AND ${unchanged}`,
        ).bind(shard, held?.token ?? null, generation, recoveryId, at?.cursor ?? null),
        env.DIRECTORY.prepare(
          `UPDATE read_model_recoveries SET cursor = ?2
           WHERE recovery_id = ?1 AND stage = 'resuming' AND cursor IS ?3`,
        ).bind(recoveryId, JSON.stringify({ adopted: held?.token ?? null }), at?.cursor ?? null),
      ]);
      return;
    }
    if (
      (await handshake(env, shard)) !== "matched" ||
      (await restoreTokenState(env, shard)) !== "matched"
    )
      throw new PreservationRefused("the restore token could not be replaced");
    await record({ ...cursor, rotated: true });
    return;
  }
  const usage = await rowOf(env, shard);
  const local = await db
    .prepare("SELECT phase, generation FROM read_model_barrier WHERE id = 1")
    .first<{ phase: string; generation: number }>();
  if (local?.phase === "paused" && local.generation === generation) {
    const paused = `EXISTS (SELECT 1 FROM read_model_barrier
      WHERE id = 1 AND phase = 'paused' AND generation = ?1)`;
    if (
      !(await admitted(env, shard, generation, (org) => [
        org.prepare(
          `INSERT INTO search_budget (day) VALUES (${TODAY}) ON CONFLICT (day) DO NOTHING`,
        ),
        org
          .prepare(
            `UPDATE search_budget SET recovery_rows = recovery_rows + ?2,
               recovery_reads = recovery_reads + ?3
             WHERE day = ${TODAY} AND ${paused}`,
          )
          .bind(
            generation,
            (usage?.usage_rows ?? 0) + RESUMING.rows,
            (usage?.usage_reads ?? 0) + RESUMING.reads,
          ),
        org
          .prepare(
            "UPDATE read_model_barrier SET phase = 'running' WHERE id = 1 AND phase = 'paused' AND generation = ?1",
          )
          .bind(generation),
      ]))
    )
      throw new PreservationRefused("the barrier left the recovery's generation");
  } else if (local?.phase !== "running" || local.generation !== generation)
    throw new PreservationRefused("the read model's barrier is not the recovery's");
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(
      `UPDATE read_model_barriers SET phase = 'running', since = ?3
       WHERE shard = ?1 AND phase = 'recovering' AND generation = ?2`,
    ).bind(shard, generation, clock()),
    env.DIRECTORY.prepare(
      `UPDATE read_model_recoveries SET stage = 'complete', updated_at = ?2
       WHERE recovery_id = ?1 AND stage = 'resuming'`,
    ).bind(recoveryId, clock()),
  ]);
}
