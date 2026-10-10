/**
 * Durable Object schema migrations: forward-only, expand then contract
 *.
 *
 * - Versions start at 1 and increase by one. Version 0 is an empty database.
 * - A migration never changes once released; new behaviour is a new version.
 * - Expand first (add tables, columns, indexes), switch the code, and only in
 *   a later release contract (drop or rename what no released code reads).
 *   A contract step must say so explicitly, which the forward-only check
 *   enforces.
 */
export interface DoMigration {
  version: number;
  name: string;
  /** SQL run in one transaction together with the version bump. */
  sql: string;
  /**
   * Set only on a contract step, with the release after which no code reads
   * what this migration drops or renames.
   */
  contract?: { safeSince: string; reason: string };
}

export class MigrationError extends Error {
  override name = "MigrationError";
}

// Statements that remove or rename schema objects or delete data. A migration
// containing one must be an explicit contract step. They are matched against
// normalised SQL (see `normaliseSql`), where every identifier is one token.
const DESTRUCTIVE = [
  /\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER)\b/i,
  // Anything up to the end of the statement, so a schema-qualified name
  // written with spaces (`main . items`) cannot hide the action.
  /\bALTER\s+TABLE\b[^;]*?\b(DROP|RENAME)\b/i,
  /\bDELETE\s+FROM\b/i,
];

/** Throws if the list is not 1..n in order or a destructive step is unmarked. */
export function validateMigrations(migrations: readonly DoMigration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        `migration "${migration.name}" has version ${migration.version}, expected ${index + 1}`,
      );
    }
    const sql = normaliseSql(migration.sql);
    if (!migration.contract && DESTRUCTIVE.some((pattern) => pattern.test(sql))) {
      throw new MigrationError(
        `migration ${migration.version} "${migration.name}" drops, renames or deletes; ` +
          "mark it as a contract step once no released code reads what it removes",
      );
    }
  });
}

/**
 * Removes comments, replaces string literals with '' and every quoted
 * identifier ("x y", `x`, [x]) with a single placeholder word, so the
 * patterns above see real statements only: `DEFAULT '--'` cannot hide a
 * following statement and a quoted name with spaces is still one token.
 */
export function normaliseSql(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          // A doubled quote inside a literal or identifier is an escaped quote.
          if (close !== "]" && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += ch === "'" ? "''" : "quoted_identifier";
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
