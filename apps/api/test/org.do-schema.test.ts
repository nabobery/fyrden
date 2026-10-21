// The OrgDO schema: no drift from the committed snapshot, and an object
// last migrated by any released build reaches the same schema as a fresh one.
// (A released build before this schema had no tables at all: v0.) The latest
// version has a fixture too, written with its migration: expected.sql follows
// the code (`vitest -u` rewrites it), so only that frozen fixture catches an
// edit to a migration that may already have run somewhere.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { applyDoMigrations, dumpSchema } from "@fyrden/adapters-cloudflare/migrations";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { orgSchema } from "../src/do/schema/org.js";
import orgV0 from "./fixtures/do-schemas/OrgDO/v0.sql?raw";
import orgV5 from "./fixtures/do-schemas/OrgDO/v5.sql?raw";
import orgV6 from "./fixtures/do-schemas/OrgDO/v6.sql?raw";
import orgV7 from "./fixtures/do-schemas/OrgDO/v7.sql?raw";
import orgV8 from "./fixtures/do-schemas/OrgDO/v8.sql?raw";

const versions: Record<number, string> = { 0: orgV0, 5: orgV5, 6: orgV6, 7: orgV7, 8: orgV8 };

describe("OrgDO schema", () => {
  it("matches the committed expected schema (no drift)", async () => {
    const stub = env.ORG.getByName(uniqueId("org"));
    const schema = await runInDurableObject(stub, (_, state) => dumpSchema(state.storage));
    await expect(schema).toMatchFileSnapshot("./fixtures/do-schemas/OrgDO/expected.sql");
  });

  it("has a frozen fixture of the latest version", () => {
    expect(Math.max(...Object.keys(versions).map(Number))).toBe(orgSchema.length);
  });

  for (const [version, sql] of Object.entries(versions)) {
    it(`migrates from released v${version} to the latest schema`, async () => {
      const stub = env.ORG.getByName(uniqueId("org"));
      const [fromFixture, fresh] = await runInDurableObject(stub, async (_, state) => {
        const fresh = dumpSchema(state.storage);
        await state.storage.deleteAll();
        if (sql.trim()) state.storage.sql.exec(sql);
        state.storage.sql.exec(
          "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
        );
        state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, ?)", Number(version));
        applyDoMigrations(state.storage, orgSchema);
        return [dumpSchema(state.storage), fresh];
      });
      expect(fromFixture).toBe(fresh);
    });
  }

  it("wakes a fresh object at the latest version", async () => {
    const stub = env.ORG.getByName(uniqueId("org"));
    const version = await runInDurableObject(
      stub,
      (_, state) =>
        state.storage.sql
          .exec<{ version: number }>("SELECT version FROM _fyrden_schema_version")
          .one().version,
    );
    expect(version).toBe(orgSchema.length);
  });
});
