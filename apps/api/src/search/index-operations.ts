import type { checkSearchIndex, Input, Output, rebuildSearchIndex } from "@fyrden/api-contract";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { ReadModelRefused } from "../read-model/executor.js";
import { MAINTENANCE_RETRY_MS } from "../read-model/maintenance.js";
import {
  checkIndex,
  preflightSpent,
  REBUILD,
  type RebuildRefusal,
  rebuildIndex,
  rebuildPreflight,
  type SearchIndex,
} from "./indexes.js";

/** The indexes an operation names, in their order. */
const named = (index: SearchIndex | "both"): SearchIndex[] =>
  index === "both" ? ["documents", "repositories"] : [index];

/** A write the read model refused for its maintenance, as the operations answer it. */
async function unlessMaintained<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
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

/**
 * The `admin.search.check_index` operation (instance administrators):
 * checks each index named against its projections, one after the other.
 */
export async function checkSearchIndexOperation(
  ctx: OpContext,
  input: Input<typeof checkSearchIndex>,
): Promise<Output<typeof checkSearchIndex>> {
  const db = readModelFor(ctx.env, DEFAULT_ORG_SHARD);
  return unlessMaintained(async () => {
    const indexes: Output<typeof checkSearchIndex>["indexes"] = [];
    for (const index of named(input.index))
      indexes.push({ index, ok: await checkIndex(db, index, ctx.metrics) });
    return { indexes };
  });
}

const REFUSALS: Record<RebuildRefusal, [string, string]> = {
  too_large: [
    "index_rebuild_too_large",
    `An index rebuilt at once holds at most ${REBUILD.rows} live projections and ${REBUILD.bytes} bytes of their text: ask for a backfill instead.`,
  ],
  reconcile_required: [
    "index_reconcile_required",
    "A live issue or pull request has no repository number yet: ask for a backfill, whose reconciliation gives it one.",
  ],
  refused: [
    "index_rebuild_refused",
    "Search's allowance for the day, or the database's size, admits no rebuild now.",
  ],
};

/**
 * The `admin.search.rebuild_index` operation (instance administrators):
 * looks at each index named first, refusing before any is rebuilt when one
 * holds too much or leaves a projection out; then rebuilds them in order.
 */
export async function rebuildSearchIndexOperation(
  ctx: OpContext,
  input: Input<typeof rebuildSearchIndex>,
): Promise<Output<typeof rebuildSearchIndex>> {
  const db = readModelFor(ctx.env, DEFAULT_ORG_SHARD);
  const refuse = (why: RebuildRefusal): never => {
    const [code, detail] = REFUSALS[why];
    throw new OperationError(409, code, detail);
  };
  const indexes = named(input.index);
  return unlessMaintained(async () => {
    const { found, cost } = await rebuildPreflight(db, indexes, ctx.metrics);
    const why = found.some((live) => live.n > REBUILD.rows || live.bytes > REBUILD.bytes)
      ? "too_large"
      : found.some((live) => live.unmapped > 0)
        ? "reconcile_required"
        : null;
    if (why) {
      ctx.metrics.count("d1.query", { db: "org", op: "search_spent" });
      await preflightSpent(db, cost).run();
      refuse(why);
    }
    const rebuilt: Output<typeof rebuildSearchIndex>["indexes"] = [];
    for (const [i, index] of indexes.entries()) {
      // The look charged with the first.
      const refused = await rebuildIndex(
        db,
        index,
        i === 0 ? cost : { rows: 0, reads: 0 },
        ctx.metrics,
      );
      if (refused) refuse(refused);
      rebuilt.push({ index, ok: true });
    }
    return { indexes: rebuilt };
  });
}
