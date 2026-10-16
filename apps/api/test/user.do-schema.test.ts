// The UserDO schema: no drift from the committed snapshot, and an object
// last migrated by any released build reaches the same schema as a fresh one.
// (A released build before this schema had no tables at all: v0.)

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { applyDoMigrations, dumpSchema } from "@fyrden/adapters-cloudflare/migrations";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { userSchema } from "../src/do/schema/user.js";
import userV0 from "./fixtures/do-schemas/UserDO/v0.sql?raw";

const versions: Record<number, string> = { 0: userV0 };

describe("UserDO schema", () => {
  it("matches the committed expected schema (no drift)", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const schema = await runInDurableObject(stub, (_, state) => dumpSchema(state.storage));
    await expect(schema).toMatchFileSnapshot("./fixtures/do-schemas/UserDO/expected.sql");
  });

  for (const [version, sql] of Object.entries(versions)) {
    it(`migrates from released v${version} to the latest schema`, async () => {
      const stub = env.USER.getByName(uniqueId("usr"));
      const [fromFixture, fresh] = await runInDurableObject(stub, async (_, state) => {
        const fresh = dumpSchema(state.storage);
        await state.storage.deleteAll();
        if (sql.trim()) state.storage.sql.exec(sql);
        state.storage.sql.exec(
          "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
        );
        state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, ?)", Number(version));
        applyDoMigrations(state.storage, userSchema);
        return [dumpSchema(state.storage), fresh];
      });
      expect(fromFixture).toBe(fresh);
    });
  }

  it("wakes a fresh object at the latest version", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const version = await runInDurableObject(
      stub,
      (_, state) =>
        state.storage.sql
          .exec<{ version: number }>("SELECT version FROM _fyrden_schema_version")
          .one().version,
    );
    expect(version).toBe(userSchema.length);
  });
});
