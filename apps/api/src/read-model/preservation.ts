import { readModelFor } from "../events/read-model.js";
import { EXPORT_TABLES } from "./export.js";
import { admitted } from "./maintenance.js";

/*
 * What a recovery keeps of the read model across a restore: its
 * operational tables' current rows (effects and their deliveries, the
 * sources' fences, the discretionary and search allowances' spending),
 * every column of every row, preserved before the restore and imported
 * after it, so a restore rolls back neither what was delivered nor what was
 * spent. Search's projections, numbers and repairs are not kept: they are
 * reconciled from the repositories again.
 *
 * A step preserves one page of one table under the paused barrier's fence
 * (its generation, checked in the read's own transaction): its rows in key
 * order, each value typed (an integer as its decimal text, so no JavaScript
 * number rounds it; text as it is; a blob as hex), digested, written to the
 * assets bucket under a key holding its digest, and recorded in the
 * directory's catalog before the recovery's place moves on (and only
 * while the page recorded is this one). Once every table is through, the
 * catalog is sealed into a manifest (each page's digest, and the
 * manifest's own), under the same fence, and the recovery awaits its
 * restore. A recovery moves the directory's barrier on to `recovering`, so
 * nothing resumes the writers under it.
 */

/** The tables a recovery preserves, every column of them (`EXPORT_TABLES` names their keys). */
export const PRESERVED_TABLES = [
  "consumer_epochs",
  "discretionary_hours",
  "discretionary_state",
  "effects",
  "events_failed",
  "search_budget",
  "source_owner",
  "webhook_attempts",
  "webhook_deliveries",
  "webhook_payloads",
] as const;

export type PreservedTable = (typeof PRESERVED_TABLES)[number];

/**
 * A preserved page's bounds (Proposed): rows, and bytes of its rows as
 * stored (one alone past it); and the pages a recovery holds at most (its
 * manifest a row of the directory's).
 */
export const PRESERVATION_PAGE = { rows: 200, bytes: 256 * 1024 } as const;
export const PRESERVATION_PAGES = 5_000;

/** A recovery's id: short enough for its pages' object keys. */
const RECOVERY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The format of a preserved page and of the manifest. */
const FORMAT = 1;

/** Where a recovery's pages are kept in the assets bucket. */
export const PRESERVATION_PREFIX = "read-model-recovery/";

/** A value as preserved: its SQLite type, and its text (null for NULL). */
export type Typed = readonly ["null" | "integer" | "real" | "text" | "blob", string | null];

export interface PreservedPage {
  readonly format: typeof FORMAT;
  readonly recovery: string;
  readonly table: PreservedTable;
  readonly page: number;
  readonly columns: readonly string[];
  /** Each row's values, in `columns`' order. */
  readonly rows: readonly (readonly Typed[])[];
}

/**
 * Where preservation stands: the table (by its place in `PRESERVED_TABLES`),
 * its next page and key, and the pages recorded so far.
 */
export interface PreservationCursor {
  readonly table: number;
  readonly page: number;
  readonly after: readonly Typed[] | null;
  readonly pages: number;
}

/** The fence moved, or the recovery is not where a step expected it: nothing more is preserved. */
export class PreservationRefused extends Error {
  constructor(reason: string) {
    super(`preservation refused: ${reason}`);
    this.name = "PreservationRefused";
  }
}

/** A preserved page, or the manifest, does not match what was recorded of it. */
export class PreservationMismatch extends Error {
  constructor(reason: string) {
    super(`preservation mismatch: ${reason}`);
    this.name = "PreservationMismatch";
  }
}

const keyOf = (table: PreservedTable): readonly string[] => {
  const spec = EXPORT_TABLES.find((t) => t.table === table);
  if (!spec) throw new Error(`${table} is not an exported table`);
  return spec.key;
};

/**
 * SQL of a column's typed value, as two columns (its type `t<i>`, its text
 * `v<i>`): each no larger than the value, never one string of the row.
 */
const typed = (column: string, i: number) =>
  `typeof(${column}) AS t${i}, CASE typeof(${column})
     WHEN 'null' THEN NULL WHEN 'blob' THEN hex(${column}) WHEN 'real' THEN printf('%!.17g', ${column})
     ELSE CAST(${column} AS TEXT) END AS v${i}`;

/** A row of `typed` columns, as preserved. */
const typedRow = (row: Record<string, unknown>, columns: number): Typed[] =>
  Array.from(
    { length: columns },
    (_, i) => [row[`t${i}`] as Typed[0], (row[`v${i}`] ?? null) as string | null] as const,
  );

/** SQL that binds a typed value back as itself (`?n` its type, `?n+1` its text). */
export const untyped = (n: number) =>
  `CASE ?${n} WHEN 'integer' THEN CAST(?${n + 1} AS INTEGER) WHEN 'real' THEN CAST(?${n + 1} AS REAL)
     WHEN 'blob' THEN unhex(?${n + 1}) ELSE ?${n + 1} END`;

/** A digest's text: SHA-256, hex. */
export async function digestOf(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Recovery {
  readonly recovery_id: string;
  readonly generation: number;
  readonly stage: string;
  readonly cursor: string | null;
}

async function recoveryOf(env: Pick<Env, "DIRECTORY">, shard: string): Promise<Recovery | null> {
  return env.DIRECTORY.prepare(
    "SELECT recovery_id, generation, stage, cursor FROM read_model_recoveries WHERE shard = ?",
  )
    .bind(shard)
    .first<Recovery>();
}

/**
 * Brings the read model's barrier to `generation`, paused, as a maintenance
 * writer at it: past whatever a step of an older generation (a resume under
 * way) left there.
 */
async function pausedAt(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
  generation: number,
): Promise<void> {
  const local = await readModelFor(env, shard)
    .prepare("SELECT phase, generation FROM read_model_barrier WHERE id = 1")
    .first<{ phase: string; generation: number }>();
  if (local?.phase === "paused" && local.generation === generation) return;
  await admitted(env, shard, generation, (org) =>
    org
      .prepare(
        `UPDATE read_model_barrier SET phase = 'paused', generation = ?1
         WHERE id = 1 AND generation <= ?1`,
      )
      .bind(generation),
  );
}

/**
 * Starts the shard's recovery `recoveryId` (preserving first) once both
 * barriers are paused at one generation: at the next one, the directory's
 * barrier `recovering` at it (nothing resumes the writers under it) and the
 * read model's paused at it (so a resume under way, of the generation
 * before, admits nothing more). The one already under way when it is that
 * one (finishing its start). Refused while they are not paused at one
 * generation, while another recovery is under way (one not complete), and
 * for an id not fresh (one used before, or not short).
 */
export async function beginRecovery(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
  recoveryId: string,
): Promise<{ generation: number; stage: string }> {
  if (!RECOVERY_ID.test(recoveryId))
    throw new PreservationRefused("a recovery's id is 1 to 64 letters, digits, _ or -");
  const under = await recoveryOf(env, shard);
  if (under && under.stage !== "complete") {
    if (under.recovery_id !== recoveryId)
      throw new PreservationRefused("another recovery is under way");
    await pausedAt(env, shard, under.generation);
    return { generation: under.generation, stage: under.stage };
  }
  const directory = await env.DIRECTORY.prepare(
    "SELECT phase, generation FROM read_model_barriers WHERE shard = ?",
  )
    .bind(shard)
    .first<{ phase: string; generation: number }>();
  const local = await readModelFor(env, shard)
    .prepare("SELECT phase, generation FROM read_model_barrier WHERE id = 1")
    .first<{ phase: string; generation: number }>();
  if (
    directory?.phase !== "paused" ||
    local?.phase !== "paused" ||
    local.generation !== directory.generation
  )
    throw new PreservationRefused("the read model is not paused");
  const now = Date.now();
  // Taken only from a recovery complete (or none), with an id never used, and the directory's
  // barrier still paused at its generation; then that barrier recovering, for this recovery.
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(
      `INSERT INTO read_model_recoveries (shard, recovery_id, generation, stage, started_at,
         updated_at)
       SELECT ?1, ?2, ?3 + 1, 'preserving', ?4, ?4
       WHERE NOT EXISTS (SELECT 1 FROM read_model_preservation_pages WHERE recovery_id = ?2)
         AND EXISTS (SELECT 1 FROM read_model_barriers
           WHERE shard = ?1 AND phase = 'paused' AND generation = ?3)
       ON CONFLICT (shard) DO UPDATE SET recovery_id = excluded.recovery_id,
         generation = excluded.generation, stage = 'preserving', cursor = NULL, manifest = NULL,
         started_at = excluded.started_at, updated_at = excluded.updated_at
       WHERE read_model_recoveries.stage = 'complete'
         AND read_model_recoveries.recovery_id <> excluded.recovery_id`,
    ).bind(shard, recoveryId, directory.generation, now),
    env.DIRECTORY.prepare(
      `UPDATE read_model_barriers SET phase = 'recovering', generation = ?3 + 1, since = ?4
       WHERE shard = ?1 AND phase = 'paused' AND generation = ?3
         AND EXISTS (SELECT 1 FROM read_model_recoveries
           WHERE shard = ?1 AND recovery_id = ?2 AND stage = 'preserving'
             AND generation = ?3 + 1)`,
    ).bind(shard, recoveryId, directory.generation, now),
  ]);
  const recovery = await recoveryOf(env, shard);
  if (recovery?.recovery_id !== recoveryId || recovery.stage !== "preserving")
    throw new PreservationRefused("the recovery could not start: another, or an id used before");
  await pausedAt(env, shard, recovery.generation);
  return { generation: recovery.generation, stage: recovery.stage };
}

/** The fence, in the batch whose reads it covers: the read model paused at `generation`. */
const fence = (db: D1Database, generation: number) =>
  db
    .prepare(
      "SELECT 1 AS held FROM read_model_barrier WHERE id = 1 AND phase = 'paused' AND generation = ?",
    )
    .bind(generation);

/** Runs `statements` under the fence; their results (refused when it no longer holds). */
async function fenced(
  db: D1Database,
  generation: number,
  statements: D1PreparedStatement[],
): Promise<D1Result<Record<string, unknown>>[]> {
  const [held, ...results] = await db.batch<Record<string, unknown>>([
    fence(db, generation),
    ...statements,
  ]);
  if (held?.results.length !== 1) throw new PreservationRefused("the barrier left its generation");
  return results;
}

/**
 * Reads the page of `table` after `after` (typed key values), under the
 * fence: its columns and rows, at most a page's rows and stored bytes (a
 * row larger than the bytes alone). Its keys and their rows' stored sizes
 * first, then only the rows that fit, so a page of large rows loads little
 * more than itself.
 */
async function readPage(
  db: D1Database,
  generation: number,
  table: PreservedTable,
  after: readonly Typed[] | null,
): Promise<{ columns: string[]; rows: Typed[][]; bytes: number; more: boolean }> {
  const key = keyOf(table);
  const [info] = await fenced(db, generation, [
    db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").bind(table),
  ]);
  const columns = (info?.results ?? []).map((r) => r.name as string);
  const order = key.join(", ");
  const bounds = (n: number) => key.map((_, i) => untyped(n + 2 * i)).join(", ");
  const stored = columns
    .map((column) => `coalesce(length(CAST(${column} AS BLOB)), 0)`)
    .join(" + ");
  const [found] = await fenced(db, generation, [
    db
      .prepare(
        `SELECT ${key.map((k, i) => typed(k, i)).join(", ")}, ${stored} AS stored FROM ${table}
         ${after ? `WHERE (${order}) > (${bounds(1)})` : ""}
         ORDER BY ${order} LIMIT ${PRESERVATION_PAGE.rows + 1}`,
      )
      .bind(...(after ?? []).flat()),
  ]);
  const keys = (found?.results ?? []).map((row) => ({
    key: typedRow(row, key.length),
    stored: row.stored as number,
  }));
  // The rows whose stored bytes fit a page (one at least).
  let take = 0;
  let bytes = 0;
  for (const { stored: size } of keys.slice(0, PRESERVATION_PAGE.rows)) {
    if (take > 0 && bytes + size > PRESERVATION_PAGE.bytes) break;
    take++;
    bytes += size;
  }
  if (take === 0) return { columns, rows: [], bytes: 0, more: false };
  const [first, last] = [keys[0]?.key ?? [], keys[take - 1]?.key ?? []];
  const [loaded] = await fenced(db, generation, [
    db
      .prepare(
        `SELECT ${columns.map(typed).join(", ")} FROM ${table}
         WHERE (${order}) >= (${bounds(1)}) AND (${order}) <= (${bounds(1 + 2 * key.length)})
         ORDER BY ${order}`,
      )
      .bind(...first.flat(), ...last.flat()),
  ]);
  const rows = (loaded?.results ?? []).map((row) => typedRow(row, columns.length));
  return { columns, rows, bytes, more: take < keys.length };
}

/** The page's object key: the recovery's, the table's, its number and digest. */
const objectKey = (recovery: string, table: string, page: number, digest: string) =>
  `${PRESERVATION_PREFIX}${recovery}/${table}/${page}-${digest}.json`;

/**
 * One step of preserving the shard's operational rows for its recovery
 * `recoveryId` (`preserving`, at its generation): the next page, or, once
 * every table is through, the manifest sealed and the recovery awaiting its
 * restore. Done once it awaits it. A step repeated (its answer lost) finds
 * its page recorded and moves on.
 */
export async function preserveStep(
  env: Pick<Env, "DIRECTORY" | "ORG_READ" | "ASSETS">,
  shard: string,
  recoveryId: string,
): Promise<{ stage: string; done: boolean }> {
  const recovery = await recoveryOf(env, shard);
  if (!recovery || recovery.recovery_id !== recoveryId)
    throw new PreservationRefused("no such recovery");
  if (recovery.stage !== "preserving")
    return { stage: recovery.stage, done: recovery.stage !== "preserving" };
  const cursor = (
    recovery.cursor ? JSON.parse(recovery.cursor) : { table: 0, page: 0, after: null, pages: 0 }
  ) as PreservationCursor;
  if (cursor.table >= PRESERVED_TABLES.length) return seal(env, shard, recovery);
  if (cursor.pages >= PRESERVATION_PAGES)
    throw new PreservationRefused(
      `more than ${PRESERVATION_PAGES} pages to preserve: recover into a fresh database instead`,
    );
  const table = PRESERVED_TABLES[cursor.table] as PreservedTable;
  const db = readModelFor(env, shard);
  const { columns, rows, bytes, more } = await readPage(
    db,
    recovery.generation,
    table,
    cursor.after,
  );
  const page: PreservedPage = {
    format: FORMAT,
    recovery: recoveryId,
    table,
    page: cursor.page,
    columns,
    rows,
  };
  const text = JSON.stringify(page);
  const digest = await digestOf(text);
  const key = objectKey(recoveryId, table, cursor.page, digest);
  // The object first (its name holds its digest: one already there is this page), then its record.
  if (!(await env.ASSETS.head(key))) await env.ASSETS.put(key, text);
  const keyColumns = keyOf(table).map((k) => columns.indexOf(k));
  const last = rows.at(-1);
  const lastKey = last ? keyColumns.map((i) => last[i] as Typed) : null;
  const pages = cursor.pages + 1;
  const next: PreservationCursor = more
    ? { table: cursor.table, page: cursor.page + 1, after: lastKey, pages }
    : { table: cursor.table + 1, page: 0, after: null, pages };
  const [recorded] = await env.DIRECTORY.batch<{ digest: string }>([
    env.DIRECTORY.prepare(
      `INSERT INTO read_model_preservation_pages
         (recovery_id, table_name, page, object_key, digest, rows, bytes, last_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (recovery_id, table_name, page) DO UPDATE SET digest = digest
       RETURNING digest`,
    ).bind(
      recoveryId,
      table,
      cursor.page,
      key,
      digest,
      rows.length,
      bytes,
      lastKey ? JSON.stringify(lastKey) : null,
    ),
    // Its place moves on only from where this step found it, and only past this page as recorded.
    env.DIRECTORY.prepare(
      `UPDATE read_model_recoveries SET cursor = ?3, updated_at = ?4
       WHERE shard = ?1 AND recovery_id = ?2 AND stage = 'preserving' AND cursor IS ?5
         AND EXISTS (SELECT 1 FROM read_model_preservation_pages
           WHERE recovery_id = ?2 AND table_name = ?6 AND page = ?7 AND digest = ?8)`,
    ).bind(
      shard,
      recoveryId,
      JSON.stringify(next),
      Date.now(),
      recovery.cursor,
      table,
      cursor.page,
      digest,
    ),
  ]);
  if (recorded?.results[0]?.digest !== digest)
    throw new PreservationMismatch(`${table} page ${cursor.page} was recorded with another digest`);
  return { stage: "preserving", done: false };
}

/**
 * Seals the recovery's catalog into its manifest (every page in order, with
 * its digest and rows, and the manifest's own digest), and moves the
 * recovery on to await its restore.
 */
async function seal(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
  recovery: Recovery,
): Promise<{ stage: string; done: boolean }> {
  const { results } = await env.DIRECTORY.prepare(
    `SELECT table_name, page, digest, rows FROM read_model_preservation_pages
     WHERE recovery_id = ? ORDER BY table_name, page`,
  )
    .bind(recovery.recovery_id)
    .all<{ table_name: string; page: number; digest: string; rows: number }>();
  // Under the fence: still paused at its generation, so nothing changed since its pages.
  const db = readModelFor(env, shard);
  const [applied] = await fenced(db, recovery.generation, [
    db.prepare("SELECT name FROM d1_migrations ORDER BY id"),
  ]);
  const migrations = { results: (applied?.results ?? []) as { name: string }[] };
  const body = {
    format: FORMAT,
    recovery: recovery.recovery_id,
    shard,
    generation: recovery.generation,
    migrations: migrations.results.map((m) => m.name),
    pages: results.map((r) => [r.table_name, r.page, r.digest, r.rows]),
  };
  const manifest = { ...body, digest: await digestOf(JSON.stringify(body)) };
  await env.DIRECTORY.prepare(
    `UPDATE read_model_recoveries SET stage = 'awaiting_restore', manifest = ?3, cursor = NULL,
       updated_at = ?4
     WHERE shard = ?1 AND recovery_id = ?2 AND stage = 'preserving'`,
  )
    .bind(shard, recovery.recovery_id, JSON.stringify(manifest), Date.now())
    .run();
  const after = await recoveryOf(env, shard);
  return { stage: after?.stage ?? "preserving", done: after?.stage !== "preserving" };
}

/**
 * A preserved page of the recovery, checked against its record and the
 * sealed manifest: its object's digest, its rows' count, its place. Throws
 * `PreservationMismatch` when any differs.
 */
export async function preservedPage(
  env: Pick<Env, "DIRECTORY" | "ASSETS">,
  recoveryId: string,
  table: PreservedTable,
  page: number,
): Promise<PreservedPage> {
  const recorded = await env.DIRECTORY.prepare(
    `SELECT p.object_key, p.digest, p.rows, r.manifest FROM read_model_preservation_pages p
     JOIN read_model_recoveries r ON r.recovery_id = p.recovery_id
     WHERE p.recovery_id = ? AND p.table_name = ? AND p.page = ?`,
  )
    .bind(recoveryId, table, page)
    .first<{ object_key: string; digest: string; rows: number; manifest: string | null }>();
  if (!recorded) throw new PreservationMismatch(`${table} page ${page} is not recorded`);
  if (!recorded.manifest) throw new PreservationMismatch("the preservation is not sealed");
  const manifest = JSON.parse(recorded.manifest) as {
    digest: string;
    pages: [string, number, string, number][];
  };
  const { digest: sealed, ...body } = manifest;
  if ((await digestOf(JSON.stringify(body))) !== sealed)
    throw new PreservationMismatch("the manifest does not match its digest");
  if (
    !manifest.pages.some(
      ([t, p, d, n]) => t === table && p === page && d === recorded.digest && n === recorded.rows,
    )
  )
    throw new PreservationMismatch(`${table} page ${page} is not in the manifest as recorded`);
  const object = await env.ASSETS.get(recorded.object_key);
  if (!object) throw new PreservationMismatch(`${table} page ${page}'s object is missing`);
  const text = await object.text();
  if ((await digestOf(text)) !== recorded.digest)
    throw new PreservationMismatch(`${table} page ${page}'s object does not match its digest`);
  const parsed = JSON.parse(text) as PreservedPage;
  if (
    parsed.recovery !== recoveryId ||
    parsed.table !== table ||
    parsed.page !== page ||
    parsed.rows.length !== recorded.rows
  )
    throw new PreservationMismatch(`${table} page ${page} is not the page recorded`);
  return parsed;
}
