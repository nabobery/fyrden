import type {
  beginReadModelRecovery,
  getReadModelRecovery,
  Input,
  Output,
  stepReadModelRecovery,
} from "@fyrden/api-contract";
import { MAINTENANCE_OBJECT } from "../cron/maintenance.js";
import { DEFAULT_ORG_SHARD } from "../events/read-model.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { beginRecovery } from "./preservation.js";
import { type RecoveryState, recoveryState } from "./recovery.js";

/*
 * The read model's recovery as instance administrators drive it through the
 * API (its one shard): its start, where it stands, and its steps (each in
 * the maintenance object, a request of its own).
 */

const answer = (state: RecoveryState) => ({
  recovery_id: state.recoveryId,
  generation: state.generation,
  stage: state.stage,
});

/** A recovery's refusal (also across the maintenance object's RPC, by its message), as answered. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (message.startsWith("preservation refused"))
      throw new OperationError(409, "recovery_refused", message);
    if (message.startsWith("preservation mismatch"))
      throw new OperationError(409, "preservation_mismatch", message);
    throw error;
  }
}

/** The `admin.read_model.recovery.begin` operation. */
export async function beginReadModelRecoveryOperation(
  ctx: OpContext,
  input: Input<typeof beginReadModelRecovery>,
): Promise<Output<typeof beginReadModelRecovery>> {
  ctx.metrics.count("d1.query", { db: "directory", op: "read_model_recovery_begin" }, 4);
  return refusing(async () => {
    const begun = await beginRecovery(ctx.env, DEFAULT_ORG_SHARD, input.recovery_id);
    return {
      recovery_id: input.recovery_id,
      generation: begun.generation,
      stage: begun.stage as Output<typeof beginReadModelRecovery>["stage"],
    };
  });
}

/** The `admin.read_model.recovery.get` operation. */
export async function getReadModelRecoveryOperation(
  ctx: OpContext,
  _input: Input<typeof getReadModelRecovery>,
): Promise<Output<typeof getReadModelRecovery>> {
  ctx.metrics.count("d1.query", { db: "directory", op: "read_model_recovery" });
  const state = await recoveryState(ctx.env, DEFAULT_ORG_SHARD);
  if (!state) throw new OperationError(404, "not_found", "The read model was never recovered.");
  return answer(state);
}

/** The `admin.read_model.recovery.step` operation: one step, in the maintenance object. */
export async function stepReadModelRecoveryOperation(
  ctx: OpContext,
  input: Input<typeof stepReadModelRecovery>,
): Promise<Output<typeof stepReadModelRecovery>> {
  ctx.metrics.count("do.request", { class: "MaintenanceDO", method: "recoverReadModel" });
  return refusing(async () =>
    answer(
      await ctx.env.MAINTENANCE.getByName(MAINTENANCE_OBJECT).recoverReadModel(
        input.recovery_id,
        input.restore
          ? { bookmark: input.restore.bookmark, undoBookmark: input.restore.undo_bookmark }
          : undefined,
      ),
    ),
  );
}
