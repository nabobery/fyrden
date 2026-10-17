import { readdirSync, readFileSync } from "node:fs";
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
  const same = (a: string, b: string) => expect(normaliseSql(a)).toEqual(normaliseSql(b));
  const differ = (a: string, b: string) => expect(normaliseSql(a)).not.toEqual(normaliseSql(b));

  it("is the SQL's tokens as written, each with its kind", () => {
    expect(
      normaliseSql(
        "CREATE TABLE \"effects\" (v BLOB DEFAULT x'41', n DEFAULT 1_0 CHECK (n->>'a' <> \"b\"));",
      ),
    ).toEqual([
      { kind: "word", text: "CREATE" },
      { kind: "word", text: "TABLE" },
      { kind: "name", text: "effects" },
      { kind: "symbol", text: "(" },
      { kind: "word", text: "v" },
      { kind: "word", text: "BLOB" },
      { kind: "word", text: "DEFAULT" },
      { kind: "blob", text: "x'41'" },
      { kind: "symbol", text: "," },
      { kind: "word", text: "n" },
      { kind: "word", text: "DEFAULT" },
      { kind: "number", text: "1_0" },
      { kind: "word", text: "CHECK" },
      { kind: "symbol", text: "(" },
      { kind: "word", text: "n" },
      { kind: "symbol", text: "->>" },
      { kind: "string", text: "'a'" },
      { kind: "symbol", text: "<>" },
      { kind: "quoted", text: '"b"' },
      { kind: "symbol", text: ")" },
      { kind: "symbol", text: ")" },
    ]);
  });

  it("ignores comments, whitespace and line endings, but not literals", () => {
    same(
      "CREATE TABLE t (\r\n  a TEXT, -- the a\n  /* b */ b TEXT DEFAULT '--  x'\n)",
      "CREATE TABLE t (a TEXT, b TEXT DEFAULT '--  x')",
    );
    differ("CREATE TABLE t (a TEXT DEFAULT 'x  y')", "CREATE TABLE t (a TEXT DEFAULT 'x y')");
    differ('CREATE TABLE "a  b" (c)', 'CREATE TABLE "a b" (c)');
  });

  it("ignores spacing between tokens that stay apart without it", () => {
    same("CREATE TABLE t (v TEXT CHECK (v <> 'x'))", "CREATE TABLE t (v TEXT CHECK(v<>'x'))");
    same("CREATE INDEX i ON t (a, b) WHERE a >= 1", "CREATE INDEX i ON t(a,b)WHERE a>=1");
    same(
      "CREATE VIEW v AS SELECT a->>'k' || 'x' FROM t",
      "CREATE VIEW v AS SELECT a ->> 'k'||'x' FROM t",
    );
  });

  it("ignores how the table's name is quoted where a rename quotes it, and nowhere else", () => {
    same('CREATE TABLE "effects" (id TEXT)', "CREATE TABLE effects (id TEXT)");
    same("CREATE TABLE `effects` (id TEXT)", "CREATE TABLE [effects] (id TEXT)");
    same('CREATE TABLE "a b" (c)', "CREATE TABLE [a b] (c)");
    same('CREATE TABLE "a""b" (c)', 'CREATE TABLE `a"b` (c)');
    same('CREATE INDEX i ON "effects" (a)', "CREATE INDEX i ON effects (a)");
    same('CREATE UNIQUE INDEX i ON "effects" (a)', "CREATE UNIQUE INDEX i ON effects (a)");
    // Anywhere else a quoted word may be a string or a different name.
    differ('CREATE INDEX "i" ON t (a)', "CREATE INDEX i ON t (a)");
    differ('CREATE TABLE t ("id" TEXT)', "CREATE TABLE t (id TEXT)");
    differ('CREATE TABLE t (v REFERENCES "p")', "CREATE TABLE t (v REFERENCES p)");
    differ("CREATE TABLE t (v DEFAULT 'x')", 'CREATE TABLE t (v DEFAULT "x")');
  });

  it("keeps letter case: SQLite stores the definition as the migration wrote it", () => {
    // A bare or double-quoted word can be a string default.
    differ("CREATE TABLE t (v TEXT DEFAULT Alpha)", "CREATE TABLE t (v TEXT DEFAULT alpha)");
    differ('CREATE TABLE t (v TEXT DEFAULT "Alpha")', 'CREATE TABLE t (v TEXT DEFAULT "alpha")');
    differ("CREATE TABLE t (id TEXT)", "CREATE TABLE t (id text)");
    differ('CREATE TABLE "Effects" (id TEXT)', "CREATE TABLE effects (id TEXT)");
  });

  it("does not split or join a token at a space", () => {
    // A blob literal against a column aliased by a string.
    differ("CREATE VIEW v AS SELECT x'41' FROM t", "CREATE VIEW v AS SELECT x '41' FROM t");
    differ("CREATE VIEW v AS SELECT X'41' FROM t", "CREATE VIEW v AS SELECT X '41' FROM t");
    // 10 against 1 aliased as _0, and the like.
    differ("CREATE VIEW v AS SELECT 1_0 FROM t", "CREATE VIEW v AS SELECT 1 _0 FROM t");
    differ("CREATE VIEW v AS SELECT 0x1_F FROM t", "CREATE VIEW v AS SELECT 0x1 _F FROM t");
    differ("CREATE VIEW v AS SELECT 1e5 FROM t", "CREATE VIEW v AS SELECT 1 e5 FROM t");
    differ("CREATE VIEW v AS SELECT 1.5 FROM t", "CREATE VIEW v AS SELECT 1 .5 FROM t");
    differ("CREATE VIEW v AS SELECT a$b FROM t", "CREATE VIEW v AS SELECT a $b FROM t");
    differ("CREATE TABLE t (a, b)", "CREATE TABLE t (ab)");
    differ("CREATE TABLE t (v CHECK (v <> 1))", "CREATE TABLE t (v CHECK (v < > 1))");
    differ("CREATE VIEW v AS SELECT a || b FROM t", "CREATE VIEW v AS SELECT a | | b FROM t");
    differ("CREATE VIEW v AS SELECT a ->> b FROM t", "CREATE VIEW v AS SELECT a -> > b FROM t");
    differ("CREATE VIEW v AS SELECT 1 - -1 FROM t", "CREATE VIEW v AS SELECT 1 --1\n FROM t");
  });

  it("still tells apart what SQLite reads differently", () => {
    differ("CREATE TABLE t (v TEXT CHECK (v <> 'x'))", "CREATE TABLE t (v TEXT CHECK (v <> 'X'))");
    differ("CREATE TABLE t (v TEXT CHECK (v <> 'x'))", "CREATE TABLE t (v TEXT CHECK (v < 'x'))");
    differ("CREATE TABLE t (v INTEGER DEFAULT 1)", "CREATE TABLE t (v INTEGER DEFAULT 1.0)");
    differ("CREATE TABLE t (a, b)", 'CREATE TABLE t ("a, b")');
    differ("CREATE TABLE t (v DEFAULT 'it''s')", "CREATE TABLE t (v DEFAULT 'it' 's')");
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

  it("tells apart objects of different types that share a name", () => {
    // SQLite keeps triggers apart from tables, indexes and views: a trigger may share a table's name.
    const effects = table("effects", "CREATE TABLE effects (id TEXT)");
    const trigger = {
      type: "trigger",
      name: "effects",
      sql: "CREATE TRIGGER effects AFTER INSERT ON repos BEGIN SELECT 1; END",
    };
    const repos = table("repos", "CREATE TABLE repos (id TEXT)");
    expect(diffSchema([effects, trigger, repos], [trigger, repos, effects])).toEqual([]);
    expect(diffSchema([effects, repos], [repos, trigger, effects])).toEqual([
      "effects (trigger) is not in the repository",
    ]);
    expect(diffSchema([effects, trigger, repos], [effects, repos])).toEqual([
      "effects (trigger) is missing",
    ]);
  });

  /** The objects SQLite stores for a database, as the deployed check reads them. */
  function schemaOf(db: DatabaseSync): SchemaObject[] {
    return db
      .prepare(SCHEMA_QUERY)
      .all()
      .map((row) => ({ type: String(row.type), name: String(row.name), sql: String(row.sql) }));
  }

  /** The objects SQLite stores for a database after running its migrations in order. */
  function migrated(db: DatabaseSync, dir: string): SchemaObject[] {
    for (const file of readdirSync(resolve(migrations, dir))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(resolve(migrations, dir, file), "utf8"));
    return schemaOf(db);
  }

  it.each(["directory", "org"])(
    "matches the committed %s schema against what SQLite stores for its migrations, letter case included",
    (dir) => {
      const expected = parseExpectedSchema(
        readFileSync(resolve(migrations, `${dir}.expected.sql`), "utf8"),
      );
      const actual = migrated(new DatabaseSync(":memory:"), dir);
      expect(actual.map((o) => o.name).sort()).toEqual(expected.map((o) => o.name).sort());
      expect(diffSchema(expected, actual)).toEqual([]);
    },
  );

  const org = parseExpectedSchema(readFileSync(resolve(migrations, "org.expected.sql"), "utf8"));
  const effects = org.find((o) => o.name === "effects") ?? { type: "table", name: "", sql: "" };

  /** The committed `fyrden-org` schema with `effects` rebuilt by renaming a new table into place. */
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
    return schemaOf(db);
  }

  it("accepts a table rebuilt by renaming, which SQLite stores with its name quoted", () => {
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
      o.name === "effects_due_order" ? { ...o, name: "effects_pending" } : o,
    );
    expect(diffSchema(org, renamedIndex)).toEqual([
      "effects_due_order (index) is missing",
      "effects_pending (index) is not in the repository",
    ]);
  });

  const directory = parseExpectedSchema(
    readFileSync(resolve(migrations, "directory.expected.sql"), "utf8"),
  );
  const principals = directory.find((o) => o.name === "principals") ?? effects;

  /**
   * A `fyrden-directory` whose `principals` lacks a column, with an org and
   * its member, and foreign keys enforced as D1 does.
   */
  function driftedDirectory(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = on");
    for (const object of directory)
      db.exec(
        object === principals
          ? object.sql.replace(
              / require_dpop INTEGER NOT NULL DEFAULT 0\n {2}CHECK \(require_dpop IN \(0, 1\)\),/,
              "",
            )
          : object.sql,
      );
    db.exec(`INSERT INTO principals (id, type, handle, created_at) VALUES
      ('org', 'org', 'acme', 1), ('usr', 'user', 'ada', 1)`);
    db.exec(`INSERT INTO memberships (org_id, principal_id, role, created_at) VALUES
      ('org', 'usr', 'owner', 1)`);
    return db;
  }

  /** Runs `steps` in one transaction with foreign keys deferred, as a D1 migration would. */
  function migrate(db: DatabaseSync, steps: string[]): void {
    db.exec("BEGIN");
    try {
      db.exec("PRAGMA defer_foreign_keys = on");
      for (const step of steps) db.exec(step);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const columns = "id, type, handle, display_name, owner_id, is_instance_admin, created_at";
  const indexes = directory
    .filter((o) => o.type === "index" && o.sql.includes(" ON principals "))
    .map((o) => o.sql);

  it("rebuilds a table other tables reference by the repair steps docs/operations/d1-schema.md gives", () => {
    const db = driftedDirectory();
    expect(diffSchema(directory, schemaOf(db))).toEqual(["principals (table) differs"]);
    migrate(db, [
      "CREATE TABLE principals_copy AS SELECT * FROM principals",
      "DROP TABLE principals",
      principals.sql,
      `INSERT INTO principals (${columns}) SELECT ${columns} FROM principals_copy`,
      "DROP TABLE principals_copy",
      ...indexes,
    ]);
    expect(diffSchema(directory, schemaOf(db))).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM memberships").get()).toEqual({ n: 1 });
  });

  it("fails such a rebuild that renames the new table into place, or loses a referenced row", () => {
    const db = driftedDirectory();
    const renamed = [
      principals.sql.replace(/^CREATE TABLE principals /, "CREATE TABLE principals_new "),
      `INSERT INTO principals_new (${columns}) SELECT ${columns} FROM principals`,
      "DROP TABLE principals",
      "ALTER TABLE principals_new RENAME TO principals",
    ];
    expect(() => migrate(db, renamed)).toThrow(/FOREIGN KEY constraint failed/);
    const losing = [
      "CREATE TABLE principals_copy AS SELECT * FROM principals WHERE id <> 'usr'",
      "DROP TABLE principals",
      principals.sql,
      `INSERT INTO principals (${columns}) SELECT ${columns} FROM principals_copy`,
      "DROP TABLE principals_copy",
    ];
    expect(() => migrate(db, losing)).toThrow(/FOREIGN KEY constraint failed/);
    // Both rolled back: the drifted table and its rows are as they were.
    expect(diffSchema(directory, schemaOf(db))).toEqual(["principals (table) differs"]);
    expect(db.prepare("SELECT count(*) AS n FROM principals").get()).toEqual({ n: 2 });
  });
});
