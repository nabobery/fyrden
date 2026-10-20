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
import repoV31 from "./fixtures/do-schemas/RepoDO/v31.sql?raw";
import repoV32 from "./fixtures/do-schemas/RepoDO/v32.sql?raw";
import repoV33 from "./fixtures/do-schemas/RepoDO/v33.sql?raw";
import repoV34 from "./fixtures/do-schemas/RepoDO/v34.sql?raw";
import repoV35 from "./fixtures/do-schemas/RepoDO/v35.sql?raw";
import repoV36 from "./fixtures/do-schemas/RepoDO/v36.sql?raw";

// One fixture per released schema version: an object last migrated by any
// released build must reach the same schema as a fresh one. The latest
// version has one too, written with its migration: expected.sql follows the
// code (`vitest -u` rewrites it), so only that frozen fixture catches an edit
// to a migration that may already have run somewhere. A new migration adds
// the fixture of its own version and keeps the one before.
const fixtures: Record<
  string,
  { schema: readonly DoMigration[]; versions: Record<number, string> }
> = {
  RepoDO: {
    schema: repoSchema,
    versions: {
      0: repoV0,
      1: repoV1,
      2: repoV2,
      15: repoV15,
      29: repoV29,
      30: repoV30,
      31: repoV31,
      32: repoV32,
      33: repoV33,
      34: repoV34,
      35: repoV35,
      36: repoV36,
    },
  },
};

describe("RepoDO schema", () => {
  it("matches the committed expected schema (no drift)", async () => {
    const stub = env.REPO.getByName(uniqueId("repo"));
    const schema = await runInDurableObject(stub, (_, state) => dumpSchema(state.storage));
    await expect(schema).toMatchFileSnapshot("./fixtures/do-schemas/RepoDO/expected.sql");
  });

  it("has a frozen fixture of the latest version", () => {
    const versions = Object.keys(fixtures.RepoDO?.versions ?? {}).map(Number);
    expect(Math.max(...versions)).toBe(repoSchema.length);
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

  it("keeps a v32 object's pull requests and comments, unlocked, and numbers issues after them", async () => {
    const stub = env.REPO.getByName(uniqueId("repo"));
    const after = await runInDurableObject(stub, async (_, state) => {
      const sql = state.storage.sql;
      await state.storage.deleteAll();
      sql.exec(repoV32);
      sql.exec(
        "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
      );
      sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 32)");
      sql.exec(
        `INSERT INTO repo_meta (id, repo_id, org_id, epoch_gen, created_at, next_number)
         VALUES (1, 'rep_x', 'usr_a', 1, 1, 2)`,
      );
      sql.exec(
        `INSERT INTO pull_requests (number, title, state, draft, author_id, author_root, base_ref,
           base_sha, head_ref, head_sha, created_at, updated_at)
         VALUES (1, 'Change', 'open', 0, 'usr_a', 'usr_a', 'main', ?1, 'feature', ?1, 5, 6)`,
        "0".repeat(40),
      );
      sql.exec(
        `INSERT INTO comments (number, author_id, author_root, body, created_at, updated_at)
         VALUES (1, 'usr_a', 'usr_a', 'Kept', 7, 7)`,
      );
      applyDoMigrations(state.storage, repoSchema);
      return {
        pull: sql.exec("SELECT locked, lock_reason, title FROM pull_requests").toArray(),
        comment: sql.exec("SELECT number, body FROM comments").toArray(),
        next: sql.exec("SELECT next_number FROM repo_meta").one().next_number,
      };
    });
    expect(after).toEqual({
      pull: [{ locked: 0, lock_reason: null, title: "Change" }],
      comment: [{ number: 1, body: "Kept" }],
      next: 2,
    });
  });

  it("keeps a v33 object's issues and pull requests, with no milestone, labels counted from 1", async () => {
    const stub = env.REPO.getByName(uniqueId("repo"));
    const after = await runInDurableObject(stub, async (_, state) => {
      const sql = state.storage.sql;
      await state.storage.deleteAll();
      sql.exec(repoV33);
      sql.exec(
        "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
      );
      sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 33)");
      sql.exec(
        `INSERT INTO repo_meta (id, repo_id, org_id, epoch_gen, created_at, next_number)
         VALUES (1, 'rep_x', 'usr_a', 1, 1, 3)`,
      );
      sql.exec(
        `INSERT INTO pull_requests (number, title, state, draft, author_id, author_root, base_ref,
           base_sha, head_ref, head_sha, created_at, updated_at)
         VALUES (1, 'Change', 'open', 0, 'usr_a', 'usr_a', 'main', ?1, 'feature', ?1, 5, 6)`,
        "0".repeat(40),
      );
      sql.exec(
        `INSERT INTO issues (number, title, state, author_id, author_root, created_at, updated_at)
         VALUES (2, 'Bug', 'open', 'usr_a', 'usr_a', 7, 7)`,
      );
      applyDoMigrations(state.storage, repoSchema);
      return {
        pull: sql.exec("SELECT title, milestone FROM pull_requests").toArray(),
        issue: sql.exec("SELECT title, milestone FROM issues").toArray(),
        meta: sql
          .exec("SELECT next_number, next_label_id, next_milestone FROM repo_meta")
          .toArray(),
      };
    });
    expect(after).toEqual({
      pull: [{ title: "Change", milestone: null }],
      issue: [{ title: "Bug", milestone: null }],
      meta: [{ next_number: 3, next_label_id: 1, next_milestone: 1 }],
    });
  });

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
