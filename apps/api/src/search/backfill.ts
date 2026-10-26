import type { backfillSearch, Input, Output } from "@fyrden/api-contract";
import { readModelFor } from "../events/read-model.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock } from "../services.js";
import { spentStatement } from "./admission.js";
import { REQUEST_ROWS, repairStatement, searchIndexing } from "./repairs.js";

/** Repositories one call of the backfill asks for (one batch of requests in each read model). */
const BACKFILL_REPOS = 100;

/**
 * The `admin.search.backfill` operation (instance administrators; the
 * executor checked it): asks for a reconciliation of a page of the active
 * repositories in the directory, in their read models, charged with
 * search's spending in the same batch (as if each wrote its row). The
 * maintenance's repair job then populates (or corrects) their projections
 * within the day's allowance. Only while search indexing is on: a
 * repository published meanwhile (its id may sort before the cursor) is
 * projected from its events, or, published late enough that some may have
 * been dropped, asks for its own reconciliation (`afterPublication`).
 */
export async function backfillSearchOperation(
  ctx: OpContext,
  input: Input<typeof backfillSearch>,
): Promise<Output<typeof backfillSearch>> {
  ctx.metrics.count("d1.query", { db: "directory", op: "search_indexing" });
  if (!(await searchIndexing(ctx.env)))
    throw new OperationError(
      409,
      "search_indexing_off",
      "Search indexing is off: a backfill asked now would miss the repositories made before it is turned on.",
    );
  ctx.metrics.count("d1.query", { db: "directory", op: "search_backfill_repos" });
  const { results } = await ctx.env.DIRECTORY.prepare(
    "SELECT id, org_shard FROM repos WHERE id > ? AND state = 'active' ORDER BY id LIMIT ?",
  )
    .bind(input.cursor ?? "", BACKFILL_REPOS)
    .all<{ id: string; org_shard: string }>();
  const byShard = new Map<string, string[]>();
  for (const { id, org_shard: shard } of results)
    byShard.set(shard, [...(byShard.get(shard) ?? []), id]);
  const now = clock();
  let requested = 0;
  for (const [shard, ids] of byShard) {
    const db = readModelFor(ctx.env, shard);
    ctx.metrics.count("d1.query", { db: "org", op: "search_backfill" }, ids.length + 1);
    const done = await db.batch([
      ...ids.map((id) => repairStatement(db, id, "backfill", now)),
      spentStatement(db, { rows: ids.length * REQUEST_ROWS, reads: 0 }),
    ]);
    requested += done
      .slice(0, ids.length)
      .filter((result) => (result.meta.changes ?? 0) > 0).length;
  }
  return {
    requested,
    next_cursor: results.length === BACKFILL_REPOS ? (results.at(-1)?.id ?? null) : null,
  };
}
