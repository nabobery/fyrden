// The UserDO schema: no drift from the committed snapshot, and an object
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
import { userSchema } from "../src/do/schema/user.js";
import userV0 from "./fixtures/do-schemas/UserDO/v0.sql?raw";
import userV2 from "./fixtures/do-schemas/UserDO/v2.sql?raw";
import userV3 from "./fixtures/do-schemas/UserDO/v3.sql?raw";
import userV4 from "./fixtures/do-schemas/UserDO/v4.sql?raw";
import userV5 from "./fixtures/do-schemas/UserDO/v5.sql?raw";
import userV6 from "./fixtures/do-schemas/UserDO/v6.sql?raw";
import userV7 from "./fixtures/do-schemas/UserDO/v7.sql?raw";
import userV8 from "./fixtures/do-schemas/UserDO/v8.sql?raw";
import userV9 from "./fixtures/do-schemas/UserDO/v9.sql?raw";
import userV10 from "./fixtures/do-schemas/UserDO/v10.sql?raw";
import userV11 from "./fixtures/do-schemas/UserDO/v11.sql?raw";

const versions: Record<number, string> = {
  0: userV0,
  2: userV2,
  3: userV3,
  4: userV4,
  5: userV5,
  6: userV6,
  7: userV7,
  8: userV8,
  9: userV9,
  10: userV10,
  11: userV11,
};

describe("UserDO schema", () => {
  it("matches the committed expected schema (no drift)", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const schema = await runInDurableObject(stub, (_, state) => dumpSchema(state.storage));
    await expect(schema).toMatchFileSnapshot("./fixtures/do-schemas/UserDO/expected.sql");
  });

  it("has a frozen fixture of the latest version", () => {
    expect(Math.max(...Object.keys(versions).map(Number))).toBe(userSchema.length);
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
