import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import {
  type DoMigration,
  MigrationError,
  validateMigrations,
} from "../../src/migrations/index.js";

const v1: DoMigration = {
  version: 1,
  name: "create items",
  sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
};
const v2: DoMigration = {
  version: 2,
  name: "add items.size",
  sql: "ALTER TABLE items ADD COLUMN size INTEGER; CREATE INDEX items_name ON items (name)",
};

const probe = () => env.MIGRATION_PROBE.getByName(uniqueId("mig"));

describe("applyDoMigrations", () => {
  it("migrates an empty object (v0) to the latest version", async () => {
    const stub = probe();
    expect(await stub.migrate([v1, v2])).toEqual({ ok: true, from: 0, to: 2 });
    expect(await stub.schema()).toContain("size INTEGER");
  });

  it("applies only the missing versions when an object is behind", async () => {
    const stub = probe();
    await stub.migrate([v1]);
    await stub.query("INSERT INTO items (name) VALUES ('kept')");
    expect(await stub.migrate([v1, v2])).toEqual({ ok: true, from: 1, to: 2 });
    expect(await stub.query("SELECT name, size FROM items")).toEqual([
      { name: "kept", size: null },
    ]);
  });

  it("does not re-run migrations when the object wakes again", async () => {
    const stub = probe();
    await stub.migrate([v1, v2]);
    await evictDurableObject(stub);
    expect(await stub.migrate([v1, v2])).toEqual({ ok: true, from: 2, to: 2 });
  });

  it("only reads when it wakes with nothing to migrate", async () => {
    // Over its account's daily rows written (Workers Free), a Durable Object refuses every
    // statement that writes, even one changing nothing; its reads must still work.
    const stub = probe();
    await stub.migrate([v1, v2]);
    await evictDurableObject(stub);
    const woke = await stub.migrateRecording([v1, v2]);
    expect(woke).toMatchObject({ ok: true, from: 2, to: 2 });
    expect(woke.statements.every((s) => /^SELECT\b/i.test(s))).toBe(true);
  });

  it("refuses code older than the stored schema", async () => {
    const stub = probe();
    await stub.migrate([v1, v2]);
    expect(await stub.migrate([v1])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/newer than this code/),
    });
  });

  it("rolls back a failing migration together with its version bump", async () => {
    const stub = probe();
    await stub.migrate([v1]);
    const broken: DoMigration = {
      version: 2,
      name: "broken",
      sql: "ALTER TABLE items ADD COLUMN x INTEGER; SELEC 1",
    };
    expect(await stub.migrate([v1, broken])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/syntax error/),
    });
    expect(await stub.schema()).not.toContain(" x INTEGER");
    expect(await stub.migrate([v1, v2])).toEqual({ ok: true, from: 1, to: 2 });
  });
});

describe("validateMigrations (forward-only rule)", () => {
  it.each([
    "DROP TABLE items",
    "ALTER TABLE items DROP COLUMN size",
    "alter table items rename column name to title",
    "ALTER TABLE items RENAME TO things",
    "DROP INDEX items_name",
    "DELETE FROM items",
    "CREATE TABLE harmless (s TEXT DEFAULT '--'); DROP TABLE items",
    "CREATE TABLE h (s TEXT DEFAULT '/*'); DROP TABLE items; -- */",
    'ALTER TABLE "items with spaces" DROP COLUMN size',
    "ALTER TABLE [items with spaces] RENAME TO things",
    "ALTER TABLE main . items DROP COLUMN size",
    "ALTER TABLE main . items RENAME TO changed",
    'ALTER TABLE main /* x */ . "items" DROP COLUMN size',
    "ALTER TABLE main.items\n  DROP COLUMN size",
  ])("rejects an unmarked destructive step: %s", (sql) => {
    expect(() => validateMigrations([v1, { version: 2, name: "destructive", sql }])).toThrow(
      MigrationError,
    );
  });

  it("accepts a destructive step marked as a contract step", () => {
    const contract: DoMigration = {
      version: 2,
      name: "drop items.size",
      sql: "ALTER TABLE items DROP COLUMN size",
      contract: { safeSince: "v0.3.0", reason: "no code reads items.size since v0.3.0" },
    };
    expect(() => validateMigrations([v1, contract])).not.toThrow();
  });

  it("ignores destructive words inside string literals and quoted names", () => {
    const quoted = {
      ...v2,
      sql: `${v2.sql}; CREATE TABLE notes (body TEXT DEFAULT 'DROP TABLE items', "DELETE FROM x" INTEGER)`,
    };
    expect(() => validateMigrations([v1, quoted])).not.toThrow();
  });

  it("does not read past the end of an additive ALTER statement", () => {
    const additive = {
      ...v2,
      sql: `${v2.sql}; ALTER TABLE items ADD COLUMN note TEXT; CREATE TABLE renamed_log (x TEXT)`,
    };
    expect(() => validateMigrations([v1, additive])).not.toThrow();
  });

  it("ignores destructive words inside comments", () => {
    const commented = { ...v2, sql: `-- DROP TABLE items is never done here\n${v2.sql}` };
    expect(() => validateMigrations([v1, commented])).not.toThrow();
  });

  it.each([[[{ ...v1, version: 2 }]], [[v1, v1]], [[v2]]])(
    "rejects versions that are not 1..n in order",
    (migrations) => {
      expect(() => validateMigrations(migrations)).toThrow(/expected/);
    },
  );
});
