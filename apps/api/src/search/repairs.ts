import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { clock } from "../services.js";
import { type CallBudget, counted, spentStatement } from "./admission.js";

/** What a rotation writes and reads at most: the source's row and its due index entry. */
const ROTATION = { rows: 2, reads: 4 };

import { reconcileSource, STEP_CALLS, sweepTombstones } from "./reconcile.js";

/*
 * Which sources' search projections need a reconciliation, and the job that
 * works them. A need is recorded by revision (`search_repairs`): asking
 * while one is pending writes nothing, so a burst of failures costs one
 * row; asking during a pass asks for another pass after it. A pass records
 * the revision it covers when it starts and marks it covered when it ends
 * (`reconcile.ts`). Nothing runs while the deployment's `search_indexing`
 * setting is off.
 */

/** Proposed values. */
export const REPAIR_POLICY = {
  /** Export pages the job works through a run, across its sources. */
  pagesPerRun: 20,
  /** Pages one source gets a run before the next one's turn. */
  pagesPerSource: 5,
  /**
   * D1 calls a run makes at most: it runs in an invocation of its own (the
   * maintenance object's `repairSearch`), of Free's 50 a Worker invocation
   * (a batch one), with room left for the run's own reads and writes.
   */
  callsPerRun: 40,
};

/** Whether the deployment writes and repairs search's projections. */
export async function searchIndexing(env: Pick<Env, "DIRECTORY">): Promise<boolean> {
  const row = await env.DIRECTORY.prepare(
    "SELECT value FROM deployment_settings WHERE name = 'search_indexing'",
  ).first<{ value: string }>();
  return row?.value === "on";
}

/**
 * The statement that asks for a source's reconciliation: the next
 * revision past the one covered (or past the pass under way), unless one
 * is already pending or the repository is deleted. With `when`, only while
 * its condition holds (SQL over `?1` the repository and `?4` its value),
 * as the batch it is in finds it.
 */
export function repairStatement(
  db: D1Database,
  repoId: string,
  reason: string,
  now: number,
  when?: { readonly where: string; readonly value: string | number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO search_repairs (repo_id, dirty, covered, reason, since, next_at)
       SELECT ?1, 1, 0, ?2, ?3, ?3
       -- Never for a deleted repository (its projections are being purged).
       WHERE NOT EXISTS (SELECT 1 FROM repos WHERE repo_id = ?1 AND deleted = 1)
         ${when ? `AND ${when.where}` : ""}
       ON CONFLICT (repo_id) DO UPDATE SET
         dirty = coalesce(search_repairs.active, search_repairs.covered) + 1,
         reason = excluded.reason,
         since = CASE WHEN search_repairs.dirty > search_repairs.covered THEN search_repairs.since
           ELSE excluded.since END,
         next_at = CASE WHEN search_repairs.dirty > search_repairs.covered
           THEN search_repairs.next_at ELSE excluded.next_at END
       WHERE search_repairs.dirty <= coalesce(search_repairs.active, search_repairs.covered)`,
    )
    .bind(repoId, reason, now, ...(when ? [when.value] : []));
}

/**
 * Works the sources that need a reconciliation, oldest need first, each
 * `pagesPerSource` pages before the next one's turn (it goes to the back),
 * up to `pagesPerRun` pages in all. A source that fails keeps its need and
 * goes to the back too; the others still get their turns, and the run
 * throws afterwards. The run stops when search's allowance for the day (or
 * the database's size) leaves no room, or before a turn whose calls would not
 * fit in `callsPerRun`. Nothing while search indexing is off.
 */
export async function runSearchRepairs(
  env: Env,
  options: { metrics?: Metrics; pages?: number; calls?: number } = {},
): Promise<{ worked: number }> {
  const { metrics } = options;
  const calls: CallBudget = { left: options.calls ?? REPAIR_POLICY.callsPerRun };
  metrics?.count("d1.query", { db: "directory", op: "search_indexing" });
  calls.left--;
  if (!(await searchIndexing(env))) return { worked: 0 };
  const db = counted(readModelFor(env, DEFAULT_ORG_SHARD), calls);
  let pages = options.pages ?? REPAIR_POLICY.pagesPerRun;
  const sources = Math.ceil(pages / REPAIR_POLICY.pagesPerSource);
  metrics?.count("d1.query", { db: "org", op: "search_repairs_due" });
  const { results, meta } = await db
    .prepare(
      `SELECT repo_id FROM search_repairs WHERE dirty > covered
       ORDER BY next_at, repo_id LIMIT ?`,
    )
    .bind(sources)
    .all<{ repo_id: string }>();
  // The selection's reads, charged with the first rotation (or on their own).
  let selected = meta.rows_read ?? 0;
  let worked = 0;
  const failures: unknown[] = [];
  for (const { repo_id: repoId } of results) {
    // A turn needs a step's calls and its rotation's.
    if (pages <= 0 || calls.left < STEP_CALLS + 1) break;
    const turn = Math.min(pages, REPAIR_POLICY.pagesPerSource);
    pages -= turn;
    worked++;
    try {
      const outcome = await reconcileSource(
        env,
        { repoId, shard: DEFAULT_ORG_SHARD },
        { pages: turn, calls, ...(metrics && { metrics }) },
      );
      // The day's allowance (or the database's size) holds every source back: until a later run.
      // Meanwhile removals, which are made whatever the allowance, of any source (they may be
      // what makes room again).
      if (outcome === "blocked") {
        await sweepTombstones(db, metrics);
        break;
      }
    } catch (error) {
      // Its need stays; the others still get their turns.
      failures.push(error);
    }
    // Its turn is over: behind every source still waiting (past the last one's place, whatever
    // the clock says), when it still is (a pass not finished, failed, or asked for again).
    // Charged with search's spending (the row and its due index entry, read as it is placed).
    metrics?.count("d1.query", { db: "org", op: "search_repairs_rotate" });
    await db.batch([
      db
        .prepare(
          `UPDATE search_repairs SET next_at = max(?2,
             (SELECT max(next_at) + 1 FROM search_repairs WHERE dirty > covered))
           WHERE repo_id = ?1 AND dirty > covered`,
        )
        .bind(repoId, clock()),
      spentStatement(db, { rows: ROTATION.rows, reads: ROTATION.reads + selected }),
    ]);
    selected = 0;
  }
  if (selected > 0) await spentStatement(db, { rows: 0, reads: selected }).run();
  if (failures.length > 0)
    throw new AggregateError(failures, `${failures.length} search repair(s) failed`);
  return { worked };
}
