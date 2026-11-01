import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { READ_MODEL_LEASE, READ_MODEL_LONE_WRITE } from "../read-model/executor.js";
import {
  ADMITTED,
  admitStatements,
  type CallBudget,
  GROWTH,
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
 * its own batch, then settled at what it wrote). An instance administrator
 * may check an index against its projections, and rebuild a small one.
 */

/** The indexes, by the virtual table each is. */
export const INDEXES = { documents: "search_fts", repositories: "search_repos_fts" } as const;

export type SearchIndex = keyof typeof INDEXES;

/**
 * Settles what a batch that admitted itself (`admitStatements`, on `day`)
 * reserved: the reservation goes back, what the batch wrote and read is
 * charged, with its receipt's release (later, by an observation), this
 * settlement and its admission.
 */
function settledStatement(
  db: D1Database,
  day: number,
  reserved: number,
  used: { rows: number; reads: number },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE search_budget SET rows = max(0, rows - ?2 + ?3), reads = reads + ?4
       WHERE day = ?1`,
    )
    .bind(
      day,
      reserved,
      used.rows + RECEIPT_RELEASE.rows + SETTLING.rows,
      used.reads + RECEIPT_RELEASE.reads + SETTLING.reads,
    );
}

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
    await settledStatement(db, day, MERGE.rows, used).run();
    merged++;
  }
  return merged;
}

/** What an index's check reports as a damaged index (or one that does not match its content). */
const DAMAGED = /SQLITE_CORRUPT|database disk image is malformed/i;

/**
 * Checks `index` against the projections it is built from (FTS5's
 * integrity check, comparing it with its content): false when it is damaged
 * or does not match them; any other failure is thrown. Charged to search's
 * spending, whatever the outcome, as a write of its own (D1 counts none of
 * the index's own reads).
 */
export async function checkIndex(
  db: D1Database,
  index: SearchIndex,
  metrics?: Metrics,
): Promise<boolean> {
  const table = INDEXES[index];
  let ok = true;
  metrics?.count("d1.query", { db: "org", op: "search_index_check" });
  // The check's batch and the spending's own, each a write of its own; spent however it ended.
  const spend = () => {
    metrics?.count("d1.query", { db: "org", op: "search_spent" });
    return spentStatement(db, {
      rows: 2 * READ_MODEL_LONE_WRITE.rows,
      reads: 2 * READ_MODEL_LONE_WRITE.reads,
    }).run();
  };
  try {
    await db.batch([
      db.prepare(`INSERT INTO ${table} (${table}, rank) VALUES ('integrity-check', 1)`),
    ]);
  } catch (error) {
    if (!DAMAGED.test(String(error))) {
      // The failure is what is thrown, whether or not its spending could be recorded.
      await spend().catch(() => {});
      throw error;
    }
    ok = false;
  }
  await spend();
  return ok;
}

/** The most an index rebuilt at once may hold: live projections, and their text's bytes. */
export const REBUILD = { rows: 256, bytes: 1_048_576 };

/**
 * Each index's projections, the live ones it is built from, read no further
 * than one past what a rebuild may hold: their count, their text's bytes,
 * and those its content leaves out (a document of a repository with no
 * number yet, a repository whose owner has none).
 */
export const LIVE = {
  documents: `WITH live AS (SELECT repo_id, title, body FROM search_docs WHERE deleted = 0
      LIMIT ${REBUILD.rows + 1})
    SELECT count(*) AS n,
      coalesce(sum(length(CAST(title AS BLOB)) + coalesce(length(CAST(body AS BLOB)), 0)), 0)
        AS bytes,
      coalesce(sum(NOT EXISTS (SELECT 1 FROM search_repo_nums n WHERE n.repo_id = live.repo_id)),
        0) AS unmapped
    FROM live`,
  repositories: `WITH live AS (SELECT repo_id FROM search_repo_nums WHERE indexed = 1
      LIMIT ${REBUILD.rows + 1})
    SELECT count(*) AS n,
      coalesce(sum(length(CAST(r.name AS BLOB)) + coalesce(length(CAST(r.description AS BLOB)), 0)),
        0) AS bytes,
      coalesce(sum(r.repo_id IS NOT NULL AND r.deleted = 0 AND NOT EXISTS (SELECT 1
        FROM search_owner_nums o WHERE o.owner_id = r.owner_id)), 0) AS unmapped
    FROM live LEFT JOIN repos r ON r.repo_id = live.repo_id`,
} as const satisfies Record<SearchIndex, string>;

/**
 * What a rebuild writes besides its index once it is: every live
 * projection marked indexed (`?2`, a fresh token, for those not marked
 * yet), and the index's count of them set to theirs.
 */
const MARKS = {
  documents: [
    "UPDATE search_docs SET fts_token = ?2 WHERE deleted = 0 AND fts_token IS NULL",
    "UPDATE search_index_state SET live_docs = (SELECT count(*) FROM search_docs WHERE deleted = 0) WHERE id = 1",
  ],
  repositories: [
    "UPDATE search_repo_nums SET fts_token = ?2 WHERE indexed = 1 AND fts_token IS NULL",
    "UPDATE search_index_state SET indexed_repos = (SELECT count(*) FROM search_repo_nums WHERE indexed = 1) WHERE id = 1",
  ],
} as const satisfies Record<SearchIndex, readonly string[]>;

export interface Preflight {
  readonly n: number;
  readonly bytes: number;
  readonly unmapped: number;
}

/**
 * Each index's live projections, as a rebuild would find them (`LIVE`),
 * and what looking cost (its reads: a read goes to the database, without
 * an admission or a lease; charged with the first rebuild, or spent when
 * none follows).
 */
export async function rebuildPreflight(
  db: D1Database,
  indexes: readonly SearchIndex[],
  metrics?: Metrics,
): Promise<{ found: Preflight[]; cost: { rows: number; reads: number } }> {
  metrics?.count("d1.query", { db: "org", op: "search_rebuild_preflight" });
  const results = await db.batch<Preflight>(indexes.map((index) => db.prepare(LIVE[index])));
  const used = usedBy(results);
  return {
    found: results.map((r) => r.results[0] ?? { n: 0, bytes: 0, unmapped: 0 }),
    cost: { rows: used.rows, reads: used.reads },
  };
}

/** Spends what a look (`rebuildPreflight`) cost when no rebuild follows it. */
export function preflightSpent(
  db: D1Database,
  cost: { rows: number; reads: number },
): D1PreparedStatement {
  // With the spending's own write (its admission and its lease).
  return spentStatement(db, {
    rows: cost.rows + READ_MODEL_LONE_WRITE.rows,
    reads: cost.reads + READ_MODEL_LONE_WRITE.reads,
  });
}

/** Why a rebuild was not made (its index left as it was). */
export type RebuildRefusal = "too_large" | "reconcile_required" | "refused";

/**
 * What a rebuild reserves: rows for its marks and counter, and the growth
 * of the most a rebuild may hold (what its projections are when it runs:
 * they may have grown since they were looked at, within its limits).
 */
const REBUILT = {
  rows: 2 * REBUILD.rows + 8,
  bytes: GROWTH.factor * REBUILD.bytes + GROWTH.entity * REBUILD.rows,
};

/**
 * Rebuilds `index` from its projections in one batch of its own, admitted
 * as any other write of search's (`REBUILT`), and only while its
 * projections still fit what a rebuild may hold with none left out: the
 * index dropped and made again, every live projection marked indexed, its
 * count set. Settled at what it wrote (with `before`, what came before it
 * and is charged with it), or spent when refused; both a write of its own,
 * each with its lease.
 */
export async function rebuildIndex(
  db: D1Database,
  index: SearchIndex,
  before: { rows: number; reads: number },
  metrics?: Metrics,
): Promise<RebuildRefusal | null> {
  const table = INDEXES[index];
  const token = crypto.randomUUID();
  const { rows, bytes } = REBUILT;
  // Its projections still within a rebuild's, none left out.
  const fits = `(SELECT n <= ${REBUILD.rows} AND bytes <= ${REBUILD.bytes} AND unmapped = 0
    FROM (${LIVE[index]}))`;
  const when = `${ADMITTED(1)} AND ${fits}`;
  metrics?.count("d1.query", { db: "org", op: "search_rebuild" });
  const results = await db.batch([
    ...admitStatements(db, token, rows, bytes),
    db.prepare(`INSERT INTO ${table} (${table}) SELECT 'rebuild' WHERE ${when}`).bind(token),
    // (A mark's own token is the batch's: any fresh one marks it.)
    ...MARKS[index].map((sql) =>
      db.prepare(`${sql} AND ${when}`).bind(...(sql.includes("?2") ? [token, token] : [token])),
    ),
    db
      .prepare(`SELECT ${when} AS rebuilt, (SELECT unmapped FROM (${LIVE[index]})) AS unmapped`)
      .bind(token),
  ]);
  const batch = usedBy(results);
  // Its batch's and its settlement's leases, and what came before.
  const used = {
    rows: batch.rows + 2 * READ_MODEL_LEASE.rows + before.rows,
    reads: batch.reads + before.reads,
  };
  const day = (results[1]?.results[0] as { day?: number } | undefined)?.day;
  const found = results.at(-1)?.results[0] as { rebuilt: number; unmapped: number } | undefined;
  metrics?.count("d1.query", { db: "org", op: "search_settle" });
  if (day === undefined) {
    await spentStatement(db, {
      rows: used.rows + SPENDING.rows,
      reads: used.reads + SPENDING.reads,
    }).run();
    return "refused";
  }
  await settledStatement(db, day, rows, used).run();
  if (found?.rebuilt === 1) return null;
  return (found?.unmapped ?? 0) > 0 ? "reconcile_required" : "too_large";
}
