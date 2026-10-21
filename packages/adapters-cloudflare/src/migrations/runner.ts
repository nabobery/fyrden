import { type DoMigration, MigrationError, validateMigrations } from "./do-schema.js";

const VERSION_TABLE = "_fyrden_schema_version";

export interface MigrationResult {
  from: number;
  to: number;
}

/**
 * Brings a Durable Object's SQLite schema up to date. Call it from the
 * constructor inside `ctx.blockConcurrencyWhile`, so no request sees a
 * half-migrated database. Each migration and its version bump commit in one
 * transaction, so a crash leaves the object at a whole version.
 *
 * Refuses to run when the stored version is newer than the code knows:
 * rolling back to code that cannot read the newest schema is not supported.
 */
export function applyDoMigrations(
  storage: DurableObjectStorage,
  migrations: readonly DoMigration[],
): MigrationResult {
  validateMigrations(migrations);
  const sql = storage.sql;
  // Read first: an object waking with nothing to migrate writes nothing. On Workers Free, once
  // the account's rows written for the day are spent, every statement that writes is refused,
  // even one that would change nothing (`CREATE TABLE IF NOT EXISTS`), and reads must still work.
  const known =
    sql
      .exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", VERSION_TABLE)
      .toArray().length > 0;
  if (!known)
    sql.exec(
      `CREATE TABLE ${VERSION_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`,
    );
  const from = currentVersion(storage);
  const latest = migrations.length;
  if (from > latest) {
    throw new MigrationError(`schema version ${from} is newer than this code (latest ${latest})`);
  }
  for (const migration of migrations.slice(from)) {
    storage.transactionSync(() => {
      sql.exec(migration.sql);
      sql.exec(
        `INSERT INTO ${VERSION_TABLE} (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version`,
        migration.version,
      );
    });
  }
  return { from, to: latest };
}

export function currentVersion(storage: DurableObjectStorage): number {
  const row = storage.sql
    .exec<{ version: number }>(`SELECT version FROM ${VERSION_TABLE} WHERE id = 1`)
    .toArray()[0];
  return row?.version ?? 0;
}

/**
 * The schema as `CREATE` statements, sorted, without SQLite and Cloudflare
 * internal tables. Used by schema-drift tests.
 */
export function dumpSchema(storage: DurableObjectStorage): string {
  return storage.sql
    .exec<{ sql: string }>(
      `SELECT sql FROM sqlite_schema
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> '${VERSION_TABLE}'
       ORDER BY type, name`,
    )
    .toArray()
    .map((row) => `${row.sql};`)
    .join("\n");
}
