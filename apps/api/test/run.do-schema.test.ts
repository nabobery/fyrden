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
import runV4 from "./fixtures/do-schemas/RunDO/v4.sql?raw";
import runV5 from "./fixtures/do-schemas/RunDO/v5.sql?raw";

const versions: Record<number, string> = {
  0: runV0,
  1: runV1,
  2: runV2,
  3: runV3,
  4: runV4,
  5: runV5,
};

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

  it("preserves v4 acknowledgements, omissions and chunks when adding masking", async () => {
    const stub = env.RUN.getByName(uniqueId("run"));
    const rows = await runInDurableObject(stub, async (_, state) => {
      await state.storage.deleteAll();
      state.storage.sql.exec(runV4);
      state.storage.sql.exec(
        "INSERT INTO ci_logs (task, ack_index, state, rows, bytes, omitted_rows, updated_at) VALUES (41, 1, 'incomplete', 0, 81, 1, 123), (42, 3, 'complete', 3, 96, 0, 456)",
      );
      state.storage.sql.exec(
        "INSERT INTO ci_log_chunks (task, start_index, end_index, bytes, r2_key, created_at) VALUES (41, 0, 1, 81, 'omission-key', 123)",
      );
      state.storage.sql.exec(
        "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
      );
      state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 4)");
      applyDoMigrations(state.storage, runSchema);
      return {
        logs: state.storage.sql.exec("SELECT * FROM ci_logs ORDER BY task").toArray(),
        chunks: state.storage.sql.exec("SELECT * FROM ci_log_chunks").toArray(),
      };
    });
    expect(rows.logs).toEqual([
      {
        task: 41,
        ack_index: 1,
        state: "incomplete",
        rows: 0,
        bytes: 81,
        omitted_rows: 1,
        updated_at: 123,
        mask_carry: null,
        ended_at: null,
        gap_remaining: 0,
        finalized: 0,
      },
      {
        task: 42,
        ack_index: 3,
        state: "complete",
        rows: 3,
        bytes: 96,
        omitted_rows: 0,
        updated_at: 456,
        mask_carry: null,
        ended_at: null,
        gap_remaining: 0,
        finalized: 1,
      },
    ]);
    expect(rows.chunks).toEqual([
      {
        task: 41,
        start_index: 0,
        end_index: 1,
        bytes: 81,
        r2_key: "omission-key",
        created_at: 123,
      },
    ]);
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
