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

/**
 * One token of SQL: its kind and its exact text. A `name` is the table's name
 * where a rename quotes it (see `normaliseSql`), its text the name it spells.
 */
export interface SqlToken {
  kind: "word" | "name" | "quoted" | "string" | "blob" | "number" | "variable" | "symbol";
  text: string;
}

// SQLite's tokenizer, so a text splits into the tokens SQLite reads (verified:
// https://sqlite.org/src/file/src/tokenize.c). Every character from U+0080 on
// is a name character, and only these five are whitespace. A number may hold
// `_` digit separators, and name characters right after a number belong to
// it (SQLite reads `1abc` as one, illegal, token).
const SPACE = /[ \t\n\f\r]+/y;
const BLOB = /[xX]'[^']*'?/y;
const NUMBER =
  /(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9][0-9_]*)?)[\w$\u0080-￿]*/y;
const WORD = /[A-Za-z_\u0080-￿][\w$\u0080-￿]*/y;
const VARIABLE = /\?[0-9]*|[:@#$][\w$\u0080-￿]*/y;
const OPERATORS = ["->>", "->", "||", "<=", ">=", "<>", "!=", "==", "<<", ">>"];
const QUOTES: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

/** The match of a sticky pattern at `at`, if there is one. */
function matchAt(pattern: RegExp, sql: string, at: number): string | undefined {
  pattern.lastIndex = at;
  return pattern.exec(sql)?.[0];
}

/** The tokens of `sql` in order, without its comments and whitespace. */
function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const push = (kind: SqlToken["kind"], text: string) => {
    tokens.push({ kind, text });
    i += text.length;
  };
  while (i < sql.length) {
    const ch = sql[i] as string;
    const close = QUOTES[ch];
    const space = matchAt(SPACE, sql, i);
    if (space) i += space.length;
    else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (close) {
      // A doubled quote inside a literal or name is an escaped quote; a
      // bracketed name has no escape. An unclosed one runs to the end.
      let j = i + 1;
      while (j < sql.length && (sql[j] !== close || (close !== "]" && sql[j + 1] === close)))
        j += sql[j] === close ? 2 : 1;
      push(ch === "'" ? "string" : "quoted", sql.slice(i, j + 1));
    } else {
      const blob = matchAt(BLOB, sql, i);
      const number = matchAt(NUMBER, sql, i);
      const word = matchAt(WORD, sql, i);
      const variable = matchAt(VARIABLE, sql, i);
      if (blob) push("blob", blob);
      else if (number) push("number", number);
      else if (word) push("word", word);
      else if (variable) push("variable", variable);
      else push("symbol", OPERATORS.find((op) => sql.startsWith(op, i)) ?? ch);
    }
  }
  return tokens;
}

/** Whether a token is the keyword, written in any letter case. */
const isKeyword = (token: SqlToken | undefined, keyword: string) =>
  token?.kind === "word" && token.text.replace(/[a-z]/g, (c) => c.toUpperCase()) === keyword;

/**
 * The position of the table's name that a rename rewrites. SQLite stores a
 * definition from its own `CREATE TABLE ` or `CREATE [UNIQUE] INDEX ` prefix
 * followed by the text from the object's name on (verified:
 * https://sqlite.org/src/file/src/build.c), and `ALTER TABLE ... RENAME TO`
 * writes the new name in double quotes in the table's definition and after
 * `ON` in its indexes' (verified: https://sqlite.org/src/file/src/alter.c;
 * measured with node:sqlite in packages/cli/test/d1-schema.test.ts).
 */
function tableNameAt(tokens: SqlToken[]): number | undefined {
  if (!isKeyword(tokens[0], "CREATE")) return undefined;
  if (isKeyword(tokens[1], "TABLE")) return 2;
  const index = isKeyword(tokens[1], "UNIQUE") ? 2 : 1;
  if (isKeyword(tokens[index], "INDEX") && isKeyword(tokens[index + 2], "ON")) return index + 3;
  return undefined;
}

/** The name a bare or quoted name token spells; undefined for any other token. */
function nameOf(token: SqlToken): string | undefined {
  if (token.kind === "word") return token.text;
  if (token.kind !== "quoted") return undefined;
  const close = QUOTES[token.text[0] as string] as string;
  if (token.text.length < 2 || !token.text.endsWith(close)) return undefined;
  const inner = token.text.slice(1, -1);
  return close === "]" ? inner : inner.replaceAll(close + close, close);
}

/**
 * The SQL as SQLite's tokens, each with its kind and exact text, so two
 * definitions compare equal only when SQLite reads the same tokens from both.
 * Comments and whitespace are dropped: SQLite ignores them, and whitespace
 * that keeps two tokens apart (`x '41'`, `1 _0`) leaves other tokens than
 * the text without it (`x'41'`, `1_0`). Letter case is kept everywhere: a
 * bare or double-quoted word can be a string (`DEFAULT Alpha`), and SQLite
 * stores each definition as the migration wrote it. The one exception is the
 * table's name where a rename quotes it: there a bare and a quoted name
 * compare by the name they spell, so the `CREATE TABLE "effects"` SQLite
 * stores after a rebuild matches `CREATE TABLE effects`.
 */
export function normaliseSql(sql: string): SqlToken[] {
  const tokens = tokenize(sql);
  const last = tokens.at(-1);
  if (last?.kind === "symbol" && last.text === ";") tokens.pop();
  const at = tableNameAt(tokens);
  const table = at === undefined ? undefined : tokens[at];
  const name = table && nameOf(table);
  if (at !== undefined && name !== undefined) tokens[at] = { kind: "name", text: name };
  return tokens;
}

/** Whether SQLite reads two definitions as the same tokens. */
function sameSql(a: string, b: string): boolean {
  const left = normaliseSql(a);
  const right = normaliseSql(b);
  return (
    left.length === right.length &&
    left.every((token, i) => token.kind === right[i]?.kind && token.text === right[i]?.text)
  );
}

/** An object's identity: a trigger may share a table's name, so its type is part of it. */
const keyOf = (object: SchemaObject) => `${object.type} ${object.name}`;

/** Each object that is missing, extra or different, in the expected file's order. */
export function diffSchema(expected: SchemaObject[], actual: SchemaObject[]): string[] {
  const deployed = new Map(actual.map((o) => [keyOf(o), o]));
  const known = new Set(expected.map(keyOf));
  const problems: string[] = [];
  for (const object of expected) {
    const found = deployed.get(keyOf(object));
    if (!found) problems.push(`${object.name} (${object.type}) is missing`);
    else if (!sameSql(found.sql, object.sql))
      problems.push(`${object.name} (${object.type}) differs`);
  }
  for (const object of actual)
    if (!known.has(keyOf(object)))
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
