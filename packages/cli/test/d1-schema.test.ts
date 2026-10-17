import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { diffSchema, normaliseSql, parseExpectedSchema } from "../src/d1-schema.ts";

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
});
