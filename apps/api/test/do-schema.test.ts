import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  applyDoMigrations,
  type DoMigration,
  dumpSchema,
} from "@fyrden/adapters-cloudflare/migrations";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { OPEN_FROM_HEAD_REPO } from "../src/do/repo/pulls.js";
import { repoSchema } from "../src/do/schema/repo.js";
import repoV0 from "./fixtures/do-schemas/RepoDO/v0.sql?raw";
import repoV1 from "./fixtures/do-schemas/RepoDO/v1.sql?raw";
import repoV2 from "./fixtures/do-schemas/RepoDO/v2.sql?raw";
import repoV15 from "./fixtures/do-schemas/RepoDO/v15.sql?raw";
import repoV29 from "./fixtures/do-schemas/RepoDO/v29.sql?raw";
import repoV30 from "./fixtures/do-schemas/RepoDO/v30.sql?raw";

// One fixture per released schema version: an object last migrated by any
// released build must reach the same schema as a fresh one.
const fixtures: Record<
  string,
  { schema: readonly DoMigration[]; versions: Record<number, string> }
> = {
  RepoDO: {
    schema: repoSchema,
    versions: { 0: repoV0, 1: repoV1, 2: repoV2, 15: repoV15, 29: repoV29, 30: repoV30 },
  },
};

describe("RepoDO schema", () => {
  it("matches the committed expected schema (no drift)", async () => {
    const stub = env.REPO.getByName(uniqueId("repo"));
    const schema = await runInDurableObject(stub, (_, state) => dumpSchema(state.storage));
    await expect(schema).toMatchFileSnapshot("./fixtures/do-schemas/RepoDO/expected.sql");
  });

  for (const [version, sql] of Object.entries(fixtures.RepoDO?.versions ?? {})) {
    it(`migrates from released v${version} to the latest schema`, async () => {
      const stub = env.REPO.getByName(uniqueId("repo"));
      const [fromFixture, fresh] = await runInDurableObject(stub, async (_, state) => {
        const fresh = dumpSchema(state.storage);
        await state.storage.deleteAll();
        if (sql.trim()) state.storage.sql.exec(sql);
        state.storage.sql.exec(
          "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
        );
        state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, ?)", Number(version));
        applyDoMigrations(state.storage, repoSchema);
        return [dumpSchema(state.storage), fresh];
      });
      expect(fromFixture).toBe(fresh);
    });
  }

  it("finds a head repository's open pull requests through an index, in number order", async () => {
    const stub = env.REPO.getByName(uniqueId("repo"));
    const plan = await runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${OPEN_FROM_HEAD_REPO}`, "r", 0, 20)
        .toArray()
        .map((r) => r.detail),
    );
    expect(plan).toEqual([expect.stringMatching(/USING INDEX pull_requests_head_repo /)]);
  });

  it("wakes a fresh object at the latest version", async () => {
    const stub = env.REPO.getByName(uniqueId("repo"));
    const version = await runInDurableObject(
      stub,
      (_, state) =>
        state.storage.sql
          .exec<{ version: number }>("SELECT version FROM _fyrden_schema_version")
          .one().version,
    );
    expect(version).toBe(repoSchema.length);
  });
});
