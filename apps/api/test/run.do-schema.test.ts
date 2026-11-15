// The RunDO schema: no drift from the committed snapshot, and an object
// last migrated by any released build reaches the same schema as a fresh one.
// (Released builds before this schema had an empty RunDO class: v0.) The latest
// version has a fixture too, written with its migration: expected.sql follows
// the code (`vitest -u` rewrites it), so only that frozen fixture catches an
// edit to a migration that may already have run somewhere.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { applyDoMigrations, dumpSchema } from "@fyrden/adapters-cloudflare/migrations";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { runSchema } from "../src/do/schema/run.js";
import runV0 from "./fixtures/do-schemas/RunDO/v0.sql?raw";
import runV1 from "./fixtures/do-schemas/RunDO/v1.sql?raw";

import runV2 from "./fixtures/do-schemas/RunDO/v2.sql?raw";
import runV3 from "./fixtures/do-schemas/RunDO/v3.sql?raw";

const versions: Record<number, string> = { 0: runV0, 1: runV1, 2: runV2, 3: runV3 };

describe("RunDO schema", () => {
  it("binds an existing v1 run to its repository and original spec", async () => {
    const stub = env.RUN.getByName(uniqueId("run"));
    const identity = await runInDurableObject(stub, async (_, state) => {
      await state.storage.deleteAll();
      state.storage.sql.exec(runV1);
      state.storage.sql.exec(
        `INSERT INTO runs (id, run_id, repo_id, sha, ref, event, actor_id, workflow_path,
           workflow_source, contexts, spec_digest, attempt, created_at, updated_at)
         VALUES (1, 'old-run', 'old-repo', ?, 'refs/heads/main', 'push', 'usr_old',
           '.github/workflows/ci.yml', '', '{}', 'original-digest', 1, 0, 0)`,
        "a".repeat(40),
      );
      state.storage.sql.exec(
        "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)",
      );
      state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 1)");
      applyDoMigrations(state.storage, runSchema);
      return state.storage.sql.exec("SELECT repo_id, spec_digest FROM run_identity").toArray();
    });
    expect(identity).toEqual([{ repo_id: "old-repo", spec_digest: "original-digest" }]);
  });

  it("matches the committed expected schema (no drift)", async () => {
    const stub = env.RUN.getByName(uniqueId("run"));
    const schema = await runInDurableObject(stub, (_, state) => dumpSchema(state.storage));
    await expect(schema).toMatchFileSnapshot("./fixtures/do-schemas/RunDO/expected.sql");
  });

  it("has a frozen fixture of the latest version", () => {
    expect(Math.max(...Object.keys(versions).map(Number))).toBe(runSchema.length);
  });

  for (const [version, sql] of Object.entries(versions)) {
    it(`migrates from released v${version} to the latest schema`, async () => {
      const stub = env.RUN.getByName(uniqueId("run"));
      const [fromFixture, fresh] = await runInDurableObject(stub, async (_, state) => {
        const fresh = dumpSchema(state.storage);
        await state.storage.deleteAll();
        if (sql.trim()) state.storage.sql.exec(sql);
        state.storage.sql.exec(
          "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
        );
        state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, ?)", Number(version));
        applyDoMigrations(state.storage, runSchema);
        return [dumpSchema(state.storage), fresh];
      });
      expect(fromFixture).toBe(fresh);
    });
  }

  it("wakes a fresh object at the latest version", async () => {
    const stub = env.RUN.getByName(uniqueId("run"));
    const version = await runInDurableObject(
      stub,
      (_, state) =>
        state.storage.sql
          .exec<{ version: number }>("SELECT version FROM _fyrden_schema_version")
          .one().version,
    );
    expect(version).toBe(runSchema.length);
  });
});
