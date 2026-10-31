import { readModelFor } from "../events/read-model.js";
import { admitted } from "./maintenance.js";
import {
  keyOf,
  PRESERVED_TABLES,
  PreservationMismatch,
  PreservationRefused,
  type PreservedTable,
  preservedPage,
  type Typed,
  untyped,
} from "./preservation.js";

/*
 * A recovery's import, after its restore: each preserved table made again
 * exactly as it was preserved, a page at a time. A page covers the keys
 * after the page before it's last, through its own last (the table's last
 * page, every key after); within that range, a row of the page missing or
 * different in any column is written as preserved, and a row the page does
 * not have is removed. A step writes at most `IMPORT_STEP` of each, as a
 * maintenance writer at the recovery's generation, and moves on to the next
 * page only when its range matched (in the same transaction as its writes,
 * with the place it moved to: `read_model_recovery_progress`, in the read
 * model itself, so a step whose answer was lost is not applied twice). Once
 * the last page is through, every preserved table is its snapshot.
 */

/** What an import step writes at most (Proposed): rows written, their stored bytes, rows removed. */
export const IMPORT_STEP = { rows: 8, bytes: 1024 * 1024, removed: 500 } as const;

/**
 * SQL of a page key's column `i` as itself, from `j` (an element of the
 * page's keys bound as JSON: each key its typed values).
 */
const keyFrom = (i: number) => {
  const [type, text] = [`j.value ->> '$[${i}][0]'`, `j.value ->> '$[${i}][1]'`];
  return `CASE ${type} WHEN 'integer' THEN CAST(${text} AS INTEGER)
    WHEN 'real' THEN CAST(${text} AS REAL) WHEN 'blob' THEN unhex(${text}) ELSE ${text} END`;
};

/** SQL true when `column` holds the typed value bound at `?n` (its type) and `?n+1` (its text). */
const holds = (column: string, n: number) =>
  `(typeof(${column}) = ?${n} AND CASE typeof(${column}) WHEN 'null' THEN 1
     WHEN 'blob' THEN hex(${column}) = ?${n + 1}
     WHEN 'real' THEN printf('%!.17g', ${column}) = ?${n + 1}
     ELSE CAST(${column} AS TEXT) = ?${n + 1} END)`;

interface Progress {
  readonly table: number;
  readonly page: number;
}

async function progressOf(db: D1Database, recoveryId: string): Promise<Progress> {
  const row = await db
    .prepare("SELECT recovery_id, table_index, page FROM read_model_recovery_progress WHERE id = 1")
    .first<{ recovery_id: string; table_index: number; page: number }>();
  return row?.recovery_id === recoveryId
    ? { table: row.table_index, page: row.page }
    : { table: 0, page: 0 };
}

/**
 * One step of the shard's recovery `recoveryId`'s import (`importing`):
 * done once every preserved table is its snapshot.
 */
export async function importStep(
  env: Pick<Env, "DIRECTORY" | "ORG_READ" | "ASSETS">,
  shard: string,
  recoveryId: string,
): Promise<{ done: boolean }> {
  const recovery = await env.DIRECTORY.prepare(
    "SELECT recovery_id, generation, stage FROM read_model_recoveries WHERE shard = ?",
  )
    .bind(shard)
    .first<{ recovery_id: string; generation: number; stage: string }>();
  if (recovery?.recovery_id !== recoveryId || recovery.stage !== "importing")
    throw new PreservationRefused("no such recovery importing");
  const db = readModelFor(env, shard);
  const at = await progressOf(db, recoveryId);
  if (at.table >= PRESERVED_TABLES.length) return { done: true };
  const table = PRESERVED_TABLES[at.table] as PreservedTable;
  const page = await preservedPage(env, recoveryId, table, at.page);
  const key = keyOf(table);
  const keyAt = key.map((k) => page.columns.indexOf(k));
  if (keyAt.some((i) => i < 0)) throw new PreservationRefused(`${table}'s key is not preserved`);
  // The page's range: after the page before's last key, through its own last (or every key on).
  const { results: around } = await env.DIRECTORY.prepare(
    `SELECT page, last_key FROM read_model_preservation_pages
     WHERE recovery_id = ?1 AND table_name = ?2 AND page IN (?3 - 1, ?3 + 1)`,
  )
    .bind(recoveryId, table, at.page)
    .all<{ page: number; last_key: string | null }>();
  const before = around.find((p) => p.page === at.page - 1);
  const last = around.some((p) => p.page === at.page + 1) ? page.rows.at(-1) : undefined;
  // The table as it is now, column for column as it was preserved: refused otherwise (a migration
  // since changed it, and an import would not reproduce its rows).
  const { results: schema } = await db
    .prepare("SELECT name, type FROM pragma_table_info(?) ORDER BY cid")
    .bind(table)
    .all<{ name: string; type: string }>();
  if (
    JSON.stringify(schema.map((c) => [c.name, c.type])) !==
    JSON.stringify(page.columns.map((c, i) => [c, page.types[i]]))
  )
    throw new PreservationMismatch(`${table}'s columns are not those it was preserved with`);
  const order = key.join(", ");
  // Over `?1` the page's keys (JSON), then the range's bounds, bound (never written into the SQL).
  const keysOf = (row: readonly Typed[]) => keyAt.map((i) => row[i] as Typed);
  const bounds: Typed[][] = [];
  const bound = (values: readonly Typed[]) => {
    const first = 2 + bounds.flat().length * 2;
    bounds.push([...values]);
    return `(${values.map((_, i) => untyped(first + 2 * i)).join(", ")})`;
  };
  const lower = before?.last_key ? `(${order}) > ${bound(JSON.parse(before.last_key))}` : "1";
  const upper = last ? `(${order}) <= ${bound(keysOf(last))}` : "1";
  const range = `${lower} AND ${upper}`;
  // The page's keys, as JSON (each at most `PRESERVED_KEY` bytes: within what one string may hold).
  const member = `EXISTS (SELECT 1 FROM json_each(?1) j
    WHERE ${key.map((k, i) => `${table}.${k} IS ${keyFrom(i)}`).join(" AND ")})`;
  const rangeParams = [JSON.stringify(page.rows.map(keysOf)), ...bounds.flat().flat()];
  // How many rows of the range the page does not have (one past what a step removes), and
  // whether each of its rows is held as preserved: only that, never the rows themselves (a
  // restored row may be far larger than the one preserved).
  const results = await db.batch<{ n?: number; same?: number }>([
    db
      .prepare(
        `SELECT count(*) AS n FROM (SELECT 1 FROM ${table} WHERE ${range} AND NOT ${member}
           LIMIT ${IMPORT_STEP.removed + 1})`,
      )
      .bind(...rangeParams),
    ...page.rows.map((row) =>
      db
        .prepare(
          `SELECT ${page.columns.map((c, i) => holds(c, 2 * i + 1)).join(" AND ")} AS same
           FROM ${table}
           WHERE ${key.map((k, i) => `${k} IS ${untyped(2 * page.columns.length + 1 + 2 * i)}`).join(" AND ")}`,
        )
        .bind(...row.flat(), ...keysOf(row).flat()),
    ),
  ]);
  const removing = results[0]?.results[0]?.n ?? 0;
  const differing = page.rows.filter((_, i) => results[i + 1]?.results[0]?.same !== 1);
  // The rows this step writes: a few, of bounded stored bytes (one alone past them).
  const writing: (readonly Typed[])[] = [];
  let bytes = 0;
  for (const row of differing) {
    const size = row.reduce((n, [, text]) => n + (text?.length ?? 0), 0);
    if (
      writing.length >= IMPORT_STEP.rows ||
      (writing.length > 0 && bytes + size > IMPORT_STEP.bytes)
    )
      break;
    writing.push(row);
    bytes += size;
  }
  const through = writing.length === differing.length && removing <= IMPORT_STEP.removed;
  const next: Progress = !through
    ? at
    : page.rows.length === 0 || !last
      ? { table: at.table + 1, page: 0 }
      : { table: at.table, page: at.page + 1 };
  const columns = page.columns.join(", ");
  const values = page.columns.map((_, i) => untyped(2 * i + 1)).join(", ");
  const updates = page.columns
    .filter((c) => !key.includes(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const statements = (org: D1Database) => [
    // Rows of the range the page does not have.
    org
      .prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table}
           WHERE ${range} AND NOT ${member} LIMIT ${IMPORT_STEP.removed})`,
      )
      .bind(...rangeParams),
    ...writing.map((row) =>
      org
        .prepare(
          `INSERT INTO ${table} (${columns}) VALUES (${values})
           ON CONFLICT (${order}) DO ${updates ? `UPDATE SET ${updates}` : "NOTHING"}`,
        )
        .bind(...row.flat()),
    ),
    // Its place, moved on from where this step found it.
    org
      .prepare(
        `INSERT INTO read_model_recovery_progress (id, recovery_id, table_index, page)
         VALUES (1, ?1, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET recovery_id = ?1, table_index = ?4, page = ?5
           WHERE read_model_recovery_progress.recovery_id IS NOT ?1
             OR (read_model_recovery_progress.table_index = ?2
               AND read_model_recovery_progress.page = ?3)`,
      )
      .bind(recoveryId, at.table, at.page, next.table, next.page),
  ];
  if (!(await admitted(env, shard, recovery.generation, statements)))
    throw new PreservationRefused("the barrier left the recovery's generation");
  return { done: next.table >= PRESERVED_TABLES.length };
}
