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
import runV6 from "./fixtures/do-schemas/RunDO/v6.sql?raw";
import runV7 from "./fixtures/do-schemas/RunDO/v7.sql?raw";

const versions: Record<number, string> = {
  0: runV0,
  1: runV1,
  2: runV2,
  3: runV3,
  4: runV4,
  5: runV5,
  6: runV6,
  7: runV7,
};

describe("RunDO schema", () => {
  it("migrates a pre-v6 run to unknown, ineligible origin without inferring trust", async () => {
    const stub = env.RUN.getByName(uniqueId("run"));
    const migrated = await runInDurableObject(stub, async (_, state) => {
      await state.storage.deleteAll();
      state.storage.sql.exec(runV5);
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
      state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 5)");
      applyDoMigrations(state.storage, runSchema);
      return state.storage.sql.exec("SELECT trust, fork FROM runs").toArray();
    });
    expect(migrated).toEqual([{ trust: "untrusted", fork: 1 }]);
  });

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
        finalized: 1,
        unmasked: 1,
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
        unmasked: 1,
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

  it.each([987, null])(
    "seals every pre-masking assigned task and preserves its data, run updated=%s",
    async (updatedAt) => {
      const stub = env.RUN.getByName(uniqueId("run"));
      const result = await runInDurableObject(stub, async (_, state) => {
        await state.storage.deleteAll();
        const sql = state.storage.sql;
        sql.exec(runV4);
        if (updatedAt !== null)
          sql.exec(
            `INSERT INTO runs (id, run_id, repo_id, sha, ref, event, actor_id, workflow_path,
          workflow_source, contexts, spec_digest, attempt, created_at, updated_at)
         VALUES (1, 'legacy-run', 'legacy-repo', ?, 'refs/heads/main', 'push', 'usr_old',
          '.github/workflows/ci.yml', '', '{}', 'legacy-digest', 1, 0, ?)`,
            "a".repeat(40),
            updatedAt,
          );
        sql.exec(
          `INSERT INTO run_instances (job_id, attempt, job_key, idx, total, name, name_key,
          status, conclusion, timeout_ms, task, completed_at)
         VALUES
          (1, 1, 'confirmed', 0, 1, 'confirmed', 'confirmed', 'in_progress', NULL, 60000, 41, NULL),
          (2, 1, 'streaming', 0, 1, 'streaming', 'streaming', 'in_progress', NULL, 60000, 42, NULL),
          (3, 1, 'complete', 0, 1, 'complete', 'complete', 'completed', 'success', 60000, 43, 300),
          (4, 1, 'omitted', 0, 1, 'omitted', 'omitted', 'completed', 'success', 60000, 44, 400),
          (5, 1, 'assigning', 0, 1, 'assigning', 'assigning', 'in_progress', NULL, 60000, 45, NULL),
          (6, 1, 'unassigned', 0, 1, 'unassigned', 'unassigned', 'queued', NULL, 60000, NULL, NULL)`,
        );
        sql.exec(
          `INSERT INTO ci_tasks (wire_id, job_id, task, runner_id, confirmed_at)
         VALUES (101, 1, 41, 1, 100), (102, 2, 42, 1, 100),
          (103, 3, 43, 1, 100), (104, 4, 44, 1, 100)`,
        );
        sql.exec(
          `INSERT INTO ci_logs (task, ack_index, state, rows, bytes, omitted_rows, updated_at)
         VALUES (42, 2, 'streaming', 2, 128, 0, 200),
          (43, 3, 'complete', 3, 192, 0, 300),
          (44, 1, 'incomplete', 0, 81, 1, 400)`,
        );
        sql.exec(
          `INSERT INTO ci_log_chunks (task, start_index, end_index, bytes, r2_key, created_at)
         VALUES (42, 0, 2, 128, 'streaming-key', 200),
          (43, 0, 3, 192, 'complete-key', 300),
          (44, 0, 1, 81, 'omission-key', 400)`,
        );
        const before = {
          tasks: sql.exec("SELECT * FROM ci_tasks ORDER BY task").toArray(),
          instances: sql.exec("SELECT * FROM run_instances ORDER BY job_id").toArray(),
          chunks: sql.exec("SELECT * FROM ci_log_chunks ORDER BY task").toArray(),
        };
        sql.exec(
          "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
        );
        sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 4)");
        applyDoMigrations(state.storage, runSchema);
        const legacy = sql
          .exec(
            "SELECT task, ack_index, state, rows, bytes, omitted_rows, updated_at, ended_at, finalized, unmasked FROM ci_logs ORDER BY task",
          )
          .toArray();
        sql.exec("INSERT INTO ci_logs (task, updated_at) VALUES (46, 555)");
        return {
          before,
          legacy,
          tasks: sql.exec("SELECT * FROM ci_tasks ORDER BY task").toArray(),
          instances: sql.exec("SELECT * FROM run_instances ORDER BY job_id").toArray(),
          chunks: sql.exec("SELECT * FROM ci_log_chunks ORDER BY task").toArray(),
          masks: sql.exec("SELECT * FROM ci_log_masks").toArray(),
          fresh: sql.exec("SELECT state, finalized, unmasked FROM ci_logs WHERE task = 46").one(),
        };
      });
      expect(result.legacy).toEqual([
        {
          task: 41,
          ack_index: 0,
          state: "incomplete",
          rows: 0,
          bytes: 0,
          omitted_rows: 0,
          updated_at: updatedAt ?? 0,
          ended_at: null,
          finalized: 1,
          unmasked: 1,
        },
        {
          task: 42,
          ack_index: 2,
          state: "incomplete",
          rows: 2,
          bytes: 128,
          omitted_rows: 0,
          updated_at: 200,
          ended_at: null,
          finalized: 1,
          unmasked: 1,
        },
        {
          task: 43,
          ack_index: 3,
          state: "complete",
          rows: 3,
          bytes: 192,
          omitted_rows: 0,
          updated_at: 300,
          ended_at: null,
          finalized: 1,
          unmasked: 1,
        },
        {
          task: 44,
          ack_index: 1,
          state: "incomplete",
          rows: 0,
          bytes: 81,
          omitted_rows: 1,
          updated_at: 400,
          ended_at: 400,
          finalized: 1,
          unmasked: 1,
        },
        {
          task: 45,
          ack_index: 0,
          state: "incomplete",
          rows: 0,
          bytes: 0,
          omitted_rows: 0,
          updated_at: updatedAt ?? 0,
          ended_at: null,
          finalized: 1,
          unmasked: 1,
        },
      ]);
      expect(result.tasks).toEqual(result.before.tasks);
      expect(result.instances).toEqual(result.before.instances);
      expect(result.chunks).toEqual(result.before.chunks);
      expect(result.masks).toEqual([]);
      expect(result.fresh).toEqual({ state: "streaming", finalized: 0, unmasked: 0 });
    },
  );

  it("backfills known end times without inventing one for an active v4 task", async () => {
    const stub = env.RUN.getByName(uniqueId("run"));
    const rows = await runInDurableObject(stub, async (_, state) => {
      await state.storage.deleteAll();
      state.storage.sql.exec(runV4);
      state.storage.sql.exec(
        `INSERT INTO run_instances (job_id, attempt, job_key, idx, total, name, name_key,
          status, conclusion, timeout_ms, task, completed_at)
         VALUES (1, 1, 'ended', 0, 1, 'ended', 'ended', 'completed', 'success', 60000, 41, 123),
           (2, 1, 'active', 0, 1, 'active', 'active', 'in_progress', NULL, 60000, 42, NULL)`,
      );
      state.storage.sql.exec(
        "INSERT INTO ci_logs (task, state, updated_at) VALUES (41, 'incomplete', 456), (42, 'streaming', 456)",
      );
      state.storage.sql.exec(
        "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
      );
      state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 4)");
      applyDoMigrations(state.storage, runSchema);
      return state.storage.sql.exec("SELECT task, ended_at FROM ci_logs ORDER BY task").toArray();
    });
    expect(rows).toEqual([
      { task: 41, ended_at: 123 },
      { task: 42, ended_at: null },
    ]);
  });

  it("rebuilds v6 masks as plain rows, each with a fresh id and a conservative crossing length", async () => {
    const stub = env.RUN.getByName(uniqueId("run"));
    const values = { token: `fyrden_job_${"t".repeat(36)}`, added: "é-added-value\u0000" };
    const rows = await runInDurableObject(stub, async (_, state) => {
      await state.storage.deleteAll();
      const sql = state.storage.sql;
      sql.exec(runV6);
      sql.exec(
        `INSERT INTO ci_log_masks (task, seq, kind, from_index, value)
         VALUES (41, 0, 'job_token', 0, ?), (41, 1, 'add_mask', 7, ?), (42, 0, 'job_token', 0, ?)`,
        values.token,
        values.added,
        values.token,
      );
      sql.exec(
        "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
      );
      sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 6)");
      applyDoMigrations(state.storage, runSchema);
      return sql.exec("SELECT * FROM ci_log_masks ORDER BY task, seq").toArray();
    });
    const utf8 = (text: string) => new TextEncoder().encode(text).length;
    expect(rows).toEqual([
      expect.objectContaining({
        task: 41,
        seq: 0,
        kind: "job_token",
        from_index: 0,
        cross_len: 6 * utf8(values.token),
        key_id: null,
        value: values.token,
      }),
      expect.objectContaining({
        task: 41,
        seq: 1,
        kind: "add_mask",
        from_index: 7,
        cross_len: 6 * utf8(values.added),
        key_id: null,
        value: values.added,
      }),
      expect.objectContaining({ task: 42, seq: 0, kind: "job_token", key_id: null }),
    ]);
    const ids = rows.map((row) => row.mask_id);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves a run from v6 bound to no owner", async () => {
    const stub = env.RUN.getByName(uniqueId("run"));
    const owners = await runInDurableObject(stub, async (_, state) => {
      await state.storage.deleteAll();
      const sql = state.storage.sql;
      sql.exec(runV6);
      sql.exec(
        `INSERT INTO runs (id, run_id, repo_id, sha, ref, event, actor_id, workflow_path,
           workflow_source, contexts, spec_digest, attempt, created_at, updated_at)
         VALUES (1, 'old-run', 'old-repo', ?, 'refs/heads/main', 'push', 'usr_old',
           '.github/workflows/ci.yml', '', '{}', 'original-digest', 1, 0, 0)`,
        "a".repeat(40),
      );
      sql.exec(
        "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
      );
      sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 6)");
      applyDoMigrations(state.storage, runSchema);
      return sql.exec("SELECT owner_id FROM runs").toArray();
    });
    expect(owners).toEqual([{ owner_id: null }]);
  });

  it("takes secret masks from v7", async () => {
    const stub = env.RUN.getByName(uniqueId("run"));
    const kinds = await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec(
        `INSERT INTO ci_log_masks (task, seq, kind, from_index, mask_id, cross_len, key_id, value)
         VALUES (1, 0, 'secret', 0, 'id', 3, 'key', 'nonce.sealed')`,
      );
      return state.storage.sql.exec("SELECT kind FROM ci_log_masks").toArray();
    });
    expect(kinds).toEqual([{ kind: "secret" }]);
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
