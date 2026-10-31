import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  ADMITTED,
  admitStatements,
  type CallBudget,
  RECEIPT_RELEASE,
  SETTLING,
  SPENDING,
  spentStatement,
  usedBy,
} from "./admission.js";

/*
 * The full-text indexes' upkeep. FTS5 merges an index's segments a little
 * with every write (its automerge); what that leaves unfinished, a merge
 * finishes a few pages at a time: the repair job asks for one of each index
 * every run, once its sources had their turns, within search's allowance as
 * any other write of search's (its rows reserved and its growth admitted in
 * its own batch, then settled at what it wrote).
 */

/** The indexes, by the virtual table each is. */
export const INDEXES = { documents: "search_fts", repositories: "search_repos_fts" } as const;

/**
 * A merge: the pages of work it asks for (SQLite's approximate target, a
 * positive one continuing merges already begun), and what it reserves:
 * rows of the day's allowance (D1 counts 3 written with its batch's
 * admission, none of the index's own work) and growth (the pages it may
 * write; measured, a page at most: test/search.merge.test.ts).
 */
export const MERGE = { pages: 64, rows: 8, bytes: 64 * 4_096 };

/** D1 calls a merge makes at most: its batch, and its settlement (or spending). */
export const MERGE_CALLS = 2;

/**
 * Merges each index a little (`MERGE.pages`), as long as the calls fit
 * (`keep` of them left for the caller's own after): how many were made. Each is admitted in its own batch (its rows of the
 * day's allowance and its growth) and settled at what it wrote; refused
 * (the allowance spent, or the database at its size threshold), its batch
 * is spent and the rest wait for a later run.
 */
export async function mergeIndexes(
  db: D1Database,
  calls: CallBudget,
  keep: number,
  metrics?: Metrics,
): Promise<number> {
  let merged = 0;
  for (const table of Object.values(INDEXES)) {
    if (calls.left < MERGE_CALLS + keep) break;
    const token = crypto.randomUUID();
    metrics?.count("d1.query", { db: "org", op: "search_merge" });
    const results = await db.batch([
      ...admitStatements(db, token, MERGE.rows, MERGE.bytes),
      db
        .prepare(`INSERT INTO ${table} (${table}, rank) SELECT 'merge', ?2 WHERE ${ADMITTED(1)}`)
        .bind(token, MERGE.pages),
    ]);
    // The batch's own, the executor's admission with its last result.
    const used = usedBy(results);
    const day = (results[1]?.results[0] as { day?: number } | undefined)?.day;
    metrics?.count("d1.query", { db: "org", op: "search_settle" });
    if (day === undefined) {
      // Refused: what it read and wrote is spent anyway, and the other index waits too.
      await spentStatement(db, {
        rows: used.rows + SPENDING.rows,
        reads: used.reads + SPENDING.reads,
      }).run();
      break;
    }
    // What it reserved goes back, what it wrote (its receipt's release, later, too), the settlement
    // and its admission are charged.
    await db
      .prepare(
        `UPDATE search_budget SET rows = max(0, rows - ?2 + ?3), reads = reads + ?4
         WHERE day = ?1`,
      )
      .bind(
        day,
        MERGE.rows,
        used.rows + RECEIPT_RELEASE.rows + SETTLING.rows,
        used.reads + RECEIPT_RELEASE.reads + SETTLING.reads,
      )
      .run();
    merged++;
  }
  return merged;
}
