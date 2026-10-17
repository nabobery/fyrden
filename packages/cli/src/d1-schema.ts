import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type WranglerRunner, wrangler } from "./wrangler.ts";

/**
 * D1 schema drift: D1 records a migration as applied by file name only, so
 * a database that ran an earlier text of a migration never gets the later
 * one, and nothing else notices. These checks compare a deployment's
 * database with the schema its migrations produce, committed as
 * `apps/api/migrations/<dir>.expected.sql` by apps/api/test/d1-schema.test.ts.
 */

export interface SchemaObject {
  type: string;
  name: string;
  sql: string;
}

/** Where the repair steps are. */
export const SCHEMA_RUNBOOK = "docs/operations/d1-schema.md";

// The objects the migrations make, as apps/api/test/d1-schema.test.ts selects
// them: no internal tables (SQLite's, Cloudflare's, wrangler's migration log)
// and no index SQLite makes itself (no SQL).
const SCHEMA_QUERY =
  "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL " +
  "AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' AND name <> 'd1_migrations'";

const HEADER = /^-- (table|index|view|trigger) (\S+)$/;

/** The objects of an expected schema file: `-- <type> <name>` lines, each followed by its SQL. */
export function parseExpectedSchema(text: string): SchemaObject[] {
  const objects: SchemaObject[] = [];
  let current: { type: string; name: string; lines: string[] } | undefined;
  const flush = () => {
    if (current)
      objects.push({
        type: current.type,
        name: current.name,
        sql: current.lines.join("\n").trimEnd().replace(/;$/, ""),
      });
  };
  // A checkout with CRLF line endings reads the same.
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      flush();
      current = { type: header[1] as string, name: header[2] as string, lines: [] };
    } else if (current) current.lines.push(line);
    else if (line.trim() !== "")
      throw new Error("not an expected schema: it must start with a -- <type> <name> line");
  }
  flush();
  return objects;
}

/**
 * The SQL without comments, with every run of whitespace as one space and
 * none inside brackets or before a comma, so only a real change differs.
 * String literals and quoted names are kept as they are.
 */
export function normaliseSql(sql: string): string {
  // Alternately SQL and a quoted literal or name.
  const parts: string[] = [];
  let code = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      code += " ";
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      code += " ";
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      // A doubled quote inside a literal or name is an escaped quote.
      while (j < sql.length && (sql[j] !== close || (close !== "]" && sql[j + 1] === close)))
        j += sql[j] === close ? 2 : 1;
      parts.push(code, sql.slice(i, j + 1));
      code = "";
      i = j + 1;
    } else {
      code += ch;
      i++;
    }
  }
  parts.push(code);
  return parts
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/\s+/g, " ")
            .replace(/\( /g, "(")
            .replace(/ ([),])/g, "$1"),
    )
    .join("")
    .trim()
    .replace(/ ?;$/, "");
}

/** Each object that is missing, extra or different, in the expected file's order. */
export function diffSchema(expected: SchemaObject[], actual: SchemaObject[]): string[] {
  const deployed = new Map(actual.map((o) => [o.name, o]));
  const known = new Set(expected.map((o) => o.name));
  const problems: string[] = [];
  for (const object of expected) {
    const found = deployed.get(object.name);
    if (!found) problems.push(`${object.name} (${object.type}) is missing`);
    else if (found.type !== object.type || normaliseSql(found.sql) !== normaliseSql(object.sql))
      problems.push(`${object.name} (${object.type}) differs`);
  }
  for (const object of actual)
    if (!known.has(object.name))
      problems.push(`${object.name} (${object.type}) is not in the repository`);
  return problems;
}

/**
 * Runs one read-only query on a deployed D1 database. `configArgs` names the
 * generated deploy config, when there is one; without it wrangler finds the
 * database by name.
 */
export async function queryRemote<T>(
  runner: WranglerRunner,
  apiDir: string,
  db: string,
  sql: string,
  configArgs: string[] = [],
): Promise<T[]> {
  const args = ["d1", "execute", db, "--remote", "--json", "--command", sql, ...configArgs];
  const out = await wrangler(runner, args, { cwd: apiDir });
  const [result] = JSON.parse(out) as { results?: T[] }[];
  if (!result?.results)
    throw new Error(`wrangler d1 execute ${db} answered no results: ${out.slice(0, 500)}`);
  return result.results;
}

export interface SchemaCheck {
  /** The expected file, relative to the repository root. */
  expectedFile: string;
  /** Empty when the database matches. */
  problems: string[];
}

/** Compares one deployed database with its committed expected schema. */
export async function checkD1Schema(
  runner: WranglerRunner,
  apiDir: string,
  db: { name: string; migrationsDir: string },
  configArgs: string[] = [],
): Promise<SchemaCheck> {
  const file = `${db.migrationsDir.replace(/\/+$/, "")}.expected.sql`;
  const expected = parseExpectedSchema(await readFile(join(apiDir, file), "utf8"));
  const actual = await queryRemote<SchemaObject>(runner, apiDir, db.name, SCHEMA_QUERY, configArgs);
  return { expectedFile: `apps/api/${file}`, problems: diffSchema(expected, actual) };
}

/** The sentence naming what differs between a database and its expected schema. */
export function driftMessage(db: string, check: SchemaCheck): string {
  return `${db} schema differs from ${check.expectedFile}: ${check.problems.join(", ")}.`;
}
