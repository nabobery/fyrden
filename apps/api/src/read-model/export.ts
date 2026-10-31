/*
 * A coherent export of the read model: every table's rows, in key order,
 * a page at a time, all under one fence (the read model's barrier paused
 * at one generation, checked in each read's own transaction), so the pages
 * together are one snapshot. A page holds at most `EXPORT_PAGE` rows and
 * bytes of JSON (its framing and cursor counted), measured before it is
 * returned; a row larger than that (an envelope's text, escaped again,
 * may be) is a page of its own, bounded by D1's own limit on a row. Rows
 * are loaded by their stored size, about a page's worth at a time, so a
 * page of large ones holds little more than itself in memory. Its cursor
 * advances only past rows it returned. The manifest names the
 * schema (its migrations), the generation, and each table's columns, with
 * the protocol tables' state (an import makes its own: admission closed,
 * its own barrier, never an exported lease).
 *
 * Not available until a restore floor is recorded (`exportAvailability`):
 * a point from which every write went through the executor.
 */

/** A page's bounds (Proposed). */
export const EXPORT_PAGE = { rows: 200, bytes: 2 * 1024 * 1024 } as const;

/** What a page's framing (its table, brackets and cursor) may take at most of its bytes. */
const FRAMING_BYTES = 1024;

/** Every table of the read model's data, by its key (the protocol tables are the manifest's). */
export const EXPORT_TABLES: readonly { readonly table: string; readonly key: readonly string[] }[] =
  [
    { table: "consumer_epochs", key: ["source_id"] },
    { table: "discretionary_hours", key: ["hour"] },
    { table: "discretionary_state", key: ["id"] },
    { table: "effects", key: ["effect_id"] },
    { table: "events_failed", key: ["id"] },
    { table: "repos", key: ["repo_id"] },
    { table: "search_budget", key: ["day"] },
    { table: "search_byte_reservations", key: ["token"] },
    { table: "search_docs", key: ["doc_id"] },
    { table: "search_index_state", key: ["id"] },
    { table: "search_labels", key: ["repo_id", "label_id"] },
    { table: "search_milestones", key: ["repo_id", "number"] },
    { table: "search_owner_nums", key: ["owner_id"] },
    { table: "search_reconciles", key: ["repo_id"] },
    { table: "search_repo_nums", key: ["repo_id"] },
    { table: "search_repairs", key: ["repo_id"] },
    { table: "search_size", key: ["id"] },
    { table: "search_sources", key: ["repo_id"] },
    { table: "search_sweep", key: ["name"] },
    { table: "source_owner", key: ["source_id"] },
    { table: "webhook_attempts", key: ["delivery_id", "n"] },
    { table: "webhook_deliveries", key: ["delivery_id"] },
    { table: "webhook_payloads", key: ["event_key"] },
  ];

/**
 * The full-text indexes, their vocabularies and their shadow tables: derived
 * from the projections (rebuilt from them), never exported.
 */
export const DERIVED_TABLES = [
  "search_fts",
  "search_fts_config",
  "search_fts_data",
  "search_fts_docsize",
  "search_fts_idx",
  "search_repos_fts",
  "search_repos_fts_config",
  "search_repos_fts_data",
  "search_repos_fts_docsize",
  "search_repos_fts_idx",
  "search_repos_vocab",
  "search_vocab",
] as const;

/** The tables that hold the protocol's state, not data. */
export const PROTOCOL_TABLES = [
  "read_model_barrier",
  "read_model_write",
  "read_model_restore_token",
] as const;

type Key = readonly (string | number)[];

/** Where an export goes on: a table (by its place in `EXPORT_TABLES`) and the key after which. */
export interface ExportCursor {
  readonly table: number;
  readonly after: Key | null;
}

export interface ExportPage {
  readonly table: string;
  readonly rows: readonly Record<string, unknown>[];
  /** Null once every table is done. */
  readonly next: ExportCursor | null;
}

export interface ExportManifest {
  readonly generation: number;
  /** Tables left out: derived from the exported ones (the full-text indexes), rebuilt from them. */
  readonly derived: readonly string[];
  readonly migrations: readonly string[];
  readonly tables: readonly { readonly table: string; readonly columns: readonly string[] }[];
  readonly protocol: Record<string, readonly Record<string, unknown>[]>;
}

/** The fence moved (the barrier no longer paused at the export's generation): start over. */
export class ExportFenceLost extends Error {
  constructor() {
    super("the read model's barrier left the export's generation");
    this.name = "ExportFenceLost";
  }
}

/** The fence, checked in the batch whose reads it covers (a batch is one transaction). */
const fenceStatement = (db: D1Database, generation: number) =>
  db
    .prepare(
      "SELECT 1 AS held FROM read_model_barrier WHERE id = 1 AND phase = 'paused' AND generation = ?",
    )
    .bind(generation);

/** Runs `statements` under the fence; their results. */
async function fenced(
  db: D1Database,
  generation: number,
  statements: D1PreparedStatement[],
): Promise<D1Result<Record<string, unknown>>[]> {
  const [fence, ...results] = await db.batch<Record<string, unknown>>([
    fenceStatement(db, generation),
    ...statements,
  ]);
  if (fence?.results.length !== 1) throw new ExportFenceLost();
  return results;
}

const keyOf = (row: Record<string, unknown>, key: readonly string[]): Key =>
  key.map((column) => row[column] as string | number);

/** `(a, b) > (?, ?)` (or `>=`, `<=`) over a table's key, its values bound from `first`. */
const compared = (key: readonly string[], op: string, first: number) =>
  `(${key.join(", ")}) ${op} (${key.map((_, i) => `?${first + i}`).join(", ")})`;

/** One page of the export from `cursor`, under the fence of `generation`. */
export async function exportPage(
  db: D1Database,
  generation: number,
  cursor: ExportCursor,
): Promise<ExportPage> {
  const spec = EXPORT_TABLES[cursor.table];
  if (!spec) throw new RangeError(`no table ${cursor.table} to export`);
  const { table, key } = spec;
  const order = key.join(", ");
  const after = cursor.after;
  const [info] = await fenced(db, generation, [
    db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").bind(table),
  ]);
  // Each row's stored bytes (its text as stored; JSON may take more): what is loaded at once.
  const stored = (info?.results ?? [])
    .map((row) => `coalesce(length(CAST(${row.name as string} AS BLOB)), 0)`)
    .join(" + ");
  const [found] = await fenced(db, generation, [
    db
      .prepare(
        `SELECT ${order}, ${stored} AS stored_bytes FROM ${table}
         ${after ? `WHERE ${compared(key, ">", 1)}` : ""}
         ORDER BY ${order} LIMIT ?${key.length + 1}`,
      )
      .bind(...(after ?? key.map(() => null)), EXPORT_PAGE.rows),
  ]);
  const keys = (found?.results ?? []).map((row) => ({
    key: keyOf(row, key),
    stored: row.stored_bytes as number,
  }));
  const rows: Record<string, unknown>[] = [];
  const budget = EXPORT_PAGE.bytes - FRAMING_BYTES;
  const encoder = new TextEncoder();
  let bytes = 0;
  let full = false;
  for (let i = 0; i < keys.length && !full; ) {
    // The next rows whose stored bytes fit what is left (one at least).
    let end = i + 1;
    let loading = keys[i]?.stored ?? 0;
    while (end < keys.length && loading + (keys[end]?.stored ?? 0) <= budget - bytes) {
      loading += keys[end]?.stored ?? 0;
      end++;
    }
    const [from, to] = [keys[i], keys[end - 1]];
    if (!from || !to) break;
    const [loaded] = await fenced(db, generation, [
      db
        .prepare(
          `SELECT * FROM ${table}
           WHERE ${compared(key, ">=", 1)} AND ${compared(key, "<=", key.length + 1)}
           ORDER BY ${order}`,
        )
        .bind(...from.key, ...to.key),
    ]);
    for (const row of loaded?.results ?? []) {
      // Its JSON and the comma before it.
      const size = encoder.encode(JSON.stringify(row)).length + (rows.length > 0 ? 1 : 0);
      if (bytes + size > budget && rows.length > 0) {
        full = true;
        break;
      }
      rows.push(row);
      bytes += size;
      // A row larger than a page goes alone.
      if (bytes > budget) {
        full = true;
        break;
      }
    }
    i = end;
  }
  const last = rows.at(-1);
  // More of this table: after the last row returned. Else the next table, or done.
  const more = full || keys.length === EXPORT_PAGE.rows;
  const next: ExportCursor | null =
    more && last
      ? { table: cursor.table, after: keyOf(last, key) }
      : cursor.table + 1 < EXPORT_TABLES.length
        ? { table: cursor.table + 1, after: null }
        : null;
  return { table, rows, next };
}

/** The export's manifest, under the same fence. */
export async function exportManifest(db: D1Database, generation: number): Promise<ExportManifest> {
  const [migrations, ...rest] = await fenced(db, generation, [
    db.prepare("SELECT name FROM d1_migrations ORDER BY id"),
    ...EXPORT_TABLES.map(({ table }) =>
      db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").bind(table),
    ),
    ...PROTOCOL_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`)),
  ]);
  const columns = rest.slice(0, EXPORT_TABLES.length);
  const protocol = rest.slice(EXPORT_TABLES.length);
  return {
    generation,
    derived: DERIVED_TABLES,
    migrations: (migrations?.results ?? []).map((row) => row.name as string),
    tables: EXPORT_TABLES.map(({ table }, i) => ({
      table,
      columns: (columns[i]?.results ?? []).map((row) => row.name as string),
    })),
    protocol: Object.fromEntries(
      PROTOCOL_TABLES.map((table, i) => [table, protocol[i]?.results ?? []]),
    ),
  };
}

/**
 * Whether a coherent export can be made: only once the restore floor (a
 * point from which writes outside the executor were refused) is recorded.
 */
export function exportAvailability(restoreFloor: string | null): {
  readonly available: boolean;
  readonly reason: "no_restore_floor" | null;
} {
  return restoreFloor === null
    ? { available: false, reason: "no_restore_floor" }
    : { available: true, reason: null };
}
