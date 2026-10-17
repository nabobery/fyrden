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
export const SCHEMA_QUERY =
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

// SQLite's keywords (verified: https://www.sqlite.org/lang_keywords.html). A
// quoted name spelled like one keeps its quotes: unquoted it could read as the
// keyword (`DEFAULT "current_time"` is a string, `DEFAULT current_time` the time).
const KEYWORDS = new Set(
  `abort action add after all alter always analyze and as asc attach autoincrement before
  begin between by cascade case cast check collate column commit conflict constraint create
  cross current current_date current_time current_timestamp database default deferrable
  deferred delete desc detach distinct do drop each else end escape except exclude exclusive
  exists explain fail filter first following for foreign from full generated glob group groups
  having if ignore immediate in index indexed initially inner insert instead intersect into is
  isnull join key last left like limit match materialized natural no not nothing notnull null
  nulls of offset on or order others outer over partition plan pragma preceding primary query
  raise range recursive references regexp reindex release rename replace restrict returning
  right rollback row rows savepoint select set table temp temporary then ties to transaction
  trigger unbounded union unique update using vacuum values view virtual when where window
  with without`.split(/\s+/),
);

// SQLite's tokens as its tokenizer reads them (verified:
// https://sqlite.org/src/file/src/tokenize.c): every character from U+0080 on
// is a name character, and only these five are whitespace.
const SPACE = /[ \t\n\f\r]+/y;
const NUMBER = /0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const WORD = /[\w$\u0080-\uffff]+/y;
const BARE_NAME = /^[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*$/;
const OPERATORS = ["->>", "->", "||", "<=", ">=", "<>", "!=", "==", "<<", ">>"];
const QUOTES: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

/** SQLite compares keywords and names ignoring the case of ASCII letters only. */
const foldCase = (text: string) => text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());

/** A name in one spelling however it was quoted: bare when it can be, else in double quotes. */
function nameToken(name: string): string {
  const folded = foldCase(name);
  return BARE_NAME.test(name) && !KEYWORDS.has(folded)
    ? folded
    : `"${folded.replaceAll('"', '""')}"`;
}

/** The match of a sticky pattern at `at`, if there is one. */
function matchAt(pattern: RegExp, sql: string, at: number): string | undefined {
  pattern.lastIndex = at;
  return pattern.exec(sql)?.[0];
}

/**
 * The SQL as its tokens, one space apart, so two texts SQLite reads the same
 * way compare equal: comments and the spacing between tokens are dropped,
 * keywords and names lose their letter case, and a quoted name is spelled
 * one way (`"effects"`, `[effects]` and `effects` are one name). String
 * literals and numbers are kept exactly as written.
 */
export function normaliseSql(sql: string): string {
  const tokens: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const close = QUOTES[ch];
    const space = matchAt(SPACE, sql, i);
    const number = matchAt(NUMBER, sql, i);
    const word = matchAt(WORD, sql, i);
    if (space) i += space.length;
    else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (close) {
      let j = i + 1;
      // A doubled quote inside a literal or name is an escaped quote; a
      // bracketed name has no escape.
      while (j < sql.length && (sql[j] !== close || (close !== "]" && sql[j + 1] === close)))
        j += sql[j] === close ? 2 : 1;
      tokens.push(
        ch === "'"
          ? sql.slice(i, j + 1)
          : nameToken(sql.slice(i + 1, j).replaceAll(close + close, close)),
      );
      i = j + 1;
    } else if (number) {
      tokens.push(number);
      i += number.length;
    } else if (word) {
      tokens.push(foldCase(word));
      i += word.length;
    } else {
      const operator = OPERATORS.find((op) => sql.startsWith(op, i)) ?? ch;
      tokens.push(operator);
      i += operator.length;
    }
  }
  if (tokens.at(-1) === ";") tokens.pop();
  return tokens.join(" ");
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
