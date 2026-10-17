import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  diffSchema,
  normaliseSql,
  parseExpectedSchema,
  SCHEMA_QUERY,
  type SchemaObject,
} from "../src/d1-schema.ts";

const migrations = resolve(import.meta.dirname, "../../../apps/api/migrations");

describe("expected D1 schemas", () => {
  it.each(["directory", "org"])(
    "reads every object of the committed %s schema back as the test wrote it",
    (db) => {
      const text = readFileSync(resolve(migrations, `${db}.expected.sql`), "utf8");
      const objects = parseExpectedSchema(text);
      expect(objects.length).toBeGreaterThan(10);
      // The format apps/api/test/d1-schema.test.ts writes.
      expect(objects.map((o) => `-- ${o.type} ${o.name}\n${o.sql};\n`).join("\n")).toBe(text);
      // As a checkout with CRLF line endings has it.
      const crlf = parseExpectedSchema(text.replaceAll("\n", "\r\n"));
      expect(crlf.map((o) => [o.name, normaliseSql(o.sql)])).toEqual(
        objects.map((o) => [o.name, normaliseSql(o.sql)]),
      );
    },
  );

  it("refuses a file that is not in the expected format", () => {
    expect(() => parseExpectedSchema("CREATE TABLE t (a);\n")).toThrow(/not an expected schema/);
  });
});

describe("normaliseSql", () => {
  it("ignores comments, whitespace and line endings, but not literals", () => {
    expect(
      normaliseSql("CREATE TABLE t (\r\n  a TEXT, -- the a\n  /* b */ b TEXT DEFAULT '--  x'\n)"),
    ).toBe(normaliseSql("CREATE TABLE t (a TEXT, b TEXT DEFAULT '--  x')"));
    expect(normaliseSql("CREATE TABLE t (a TEXT DEFAULT 'x  y')")).not.toBe(
      normaliseSql("CREATE TABLE t (a TEXT DEFAULT 'x y')"),
    );
    expect(normaliseSql('CREATE TABLE "a  b" (c)')).not.toBe(
      normaliseSql('CREATE TABLE "a b" (c)'),
    );
  });

  it("ignores how a name is quoted, letter case outside literals and spacing between tokens", () => {
    const same = (a: string, b: string) => expect(normaliseSql(a)).toBe(normaliseSql(b));
    same('CREATE TABLE "effects" (id TEXT)', "CREATE TABLE effects (id TEXT)");
    same("CREATE TABLE `effects` ([id] TEXT)", "create table EFFECTS (Id text)");
    same("CREATE TABLE t (v TEXT CHECK (v <> 'x'))", "CREATE TABLE t (v TEXT CHECK(v<>'x'))");
    same("CREATE INDEX i ON t (a, b) WHERE a >= 1", "CREATE INDEX i ON t(a,b)WHERE a>=1");
    // A name that needs its quotes keeps them, whichever quotes they are.
    same('CREATE TABLE "A B" (c)', "CREATE TABLE [a b] (c)");
    same('CREATE TABLE "a""b" (c)', 'CREATE TABLE `a"b` (c)');
  });

  it("still tells apart what SQLite reads differently", () => {
    const differ = (a: string, b: string) => expect(normaliseSql(a)).not.toBe(normaliseSql(b));
    differ("CREATE TABLE t (v TEXT CHECK (v <> 'x'))", "CREATE TABLE t (v TEXT CHECK (v <> 'X'))");
    differ("CREATE TABLE t (v TEXT CHECK (v <> 'x'))", "CREATE TABLE t (v TEXT CHECK (v < 'x'))");
    differ("CREATE TABLE t (v INTEGER DEFAULT 1)", "CREATE TABLE t (v INTEGER DEFAULT 1.0)");
    differ("CREATE TABLE t (a, b)", "CREATE TABLE t (ab)");
    differ("CREATE TABLE t (a, b)", 'CREATE TABLE t ("a, b")');
    // A quoted keyword is a name or a string; the bare keyword is the keyword.
    differ('CREATE TABLE t (v DEFAULT "current_time")', "CREATE TABLE t (v DEFAULT current_time)");
  });
});

describe("diffSchema", () => {
  const table = (name: string, sql: string) => ({ type: "table", name, sql });

  it("names each object that is missing, extra or different", () => {
    const expected = [
      table("effects", "CREATE TABLE effects (id TEXT, lease_token TEXT)"),
      table("repos", "CREATE TABLE repos (id TEXT)"),
      { type: "index", name: "effects_due", sql: "CREATE INDEX effects_due ON effects (id)" },
    ];
    const actual = [
      table("effects", "CREATE TABLE effects (id TEXT)"),
      table("repos", "CREATE TABLE repos (\n  id TEXT -- the id\n)"),
      table("scratch", "CREATE TABLE scratch (x)"),
    ];
    expect(diffSchema(expected, actual)).toEqual([
      "effects (table) differs",
      "effects_due (index) is missing",
      "scratch (table) is not in the repository",
    ]);
    expect(diffSchema(expected, expected)).toEqual([]);
  });

  const org = parseExpectedSchema(readFileSync(resolve(migrations, "org.expected.sql"), "utf8"));
  const effects = org.find((o) => o.name === "effects") ?? { type: "table", name: "", sql: "" };

  /** The committed `fyrden-org` schema with `effects` rebuilt as docs/operations/d1-schema.md says. */
  function rebuiltOrg(definition: string): SchemaObject[] {
    const db = new DatabaseSync(":memory:");
    for (const object of org) db.exec(object.sql);
    db.exec(
      "INSERT INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at) VALUES ('e1', 's', 't', '{}', 1, 1)",
    );
    db.exec(definition.replace(/^CREATE TABLE effects /, "CREATE TABLE effects_new "));
    // Copy the columns both versions have.
    const columns = db
      .prepare("SELECT group_concat(name, ', ') AS list FROM pragma_table_info('effects_new')")
      .get()?.list;
    db.exec(`INSERT INTO effects_new (${columns}) SELECT ${columns} FROM effects`);
    db.exec("DROP TABLE effects");
    db.exec("ALTER TABLE effects_new RENAME TO effects");
    for (const object of org)
      if (object.type === "index" && object.sql.includes(" ON effects ")) db.exec(object.sql);
    expect(db.prepare("SELECT count(*) AS n FROM effects").get()).toEqual({ n: 1 });
    return db
      .prepare(SCHEMA_QUERY)
      .all()
      .map((row) => ({ type: String(row.type), name: String(row.name), sql: String(row.sql) }));
  }

  it("accepts a table rebuilt by the repair steps, which SQLite stores with its name quoted", () => {
    expect(effects.name).toBe("effects");
    const actual = rebuiltOrg(effects.sql);
    expect(actual.find((o) => o.name === "effects")?.sql).toMatch(/^CREATE TABLE "effects" \(/);
    expect(diffSchema(org, actual)).toEqual([]);
  });

  it("still reports a rebuilt table whose definition is not the expected one", () => {
    const retyped = effects.sql.replace("attempts INTEGER", "attempts TEXT");
    const withoutColumn = effects.sql.replace(/\n {2}last_error TEXT,/, "");
    const relabelled = effects.sql.replace("'failed'))", "'dead'))");
    for (const definition of [retyped, withoutColumn, relabelled]) {
      expect(definition).not.toBe(effects.sql);
      const actual = rebuiltOrg(definition);
      expect(diffSchema(org, actual)).toEqual(["effects (table) differs"]);
    }
    const renamedIndex = org.map((o) =>
      o.name === "effects_due" ? { ...o, name: "effects_pending" } : o,
    );
    expect(diffSchema(org, renamedIndex)).toEqual([
      "effects_due (index) is missing",
      "effects_pending (index) is not in the repository",
    ]);
  });
});
