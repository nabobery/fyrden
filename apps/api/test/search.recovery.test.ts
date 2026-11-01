// What a recovery does to search before the writers resume (its fencing):
// the read model's recovery generation raised (every restored source with a
// row hidden), a row for every restored source (also one found only in a
// child table), the sources the directory no longer has active tombstoned
// and their purge asked at this generation, and a reconciliation asked of
// every active repository. After the resume, the purges remove the
// tombstoned sources' search rows (an older generation's are dropped), and
// a source's reconciliation makes it visible again.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, inject, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { admitted, pauseReadModel, resumeReadModel } from "../src/read-model/maintenance.js";
import { beginRecovery, preserveStep } from "../src/read-model/preservation.js";
import { reconcileSource } from "../src/search/reconcile.js";
import { fenceStep, runSearchPurges } from "../src/search/recovery.js";
import { SOURCE_VISIBLE } from "../src/search/visibility.js";
import { api, json, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");
const db = readModelFor(env, DEFAULT_ORG_SHARD);

/** A repository with an issue, reconciled into search: its id. */
async function repository(): Promise<string> {
  const owner = await user();
  const repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  expect(
    (
      await postPush(
        target,
        pushBody([{ old: ZERO, new: fx.c1, ref: "refs/heads/main" }], { pack: fx.packC2 }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await api("POST", `/repos/${owner.handle}/${repo.name}/issues`, owner.token, {
        title: "Lantern flickers",
      })
    ).status,
  ).toBe(201);
  for (let call = 0; call < 12; call++)
    if ((await reconcileSource(env, { repoId: repo.id, shard: DEFAULT_ORG_SHARD })) !== "more")
      break;
  return repo.id;
}

const recovery = () =>
  env.DIRECTORY.prepare(
    "SELECT recovery_id, generation, stage, cursor FROM read_model_recoveries WHERE shard = ?",
  )
    .bind(DEFAULT_ORG_SHARD)
    .first<{ recovery_id: string; generation: number; stage: string; cursor: string | null }>();

const gen = async () =>
  (
    await db.prepare("SELECT recovery_gen FROM search_index_state WHERE id = 1").first<{
      recovery_gen: number;
    }>()
  )?.recovery_gen ?? 0;

const visible = async (repoId: string) =>
  (
    await db
      .prepare(`SELECT ${SOURCE_VISIBLE("?1")} AS v`)
      .bind(repoId)
      .first<{ v: number }>()
  )?.v;

const count = async (table: string, repoId: string) =>
  (
    await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE repo_id = ?`).bind(repoId).first<{
      n: number;
    }>()
  )?.n;

/** A recovery preserved, imported and fencing (`before`, as the restore left the read model). */
async function fencing(
  before: (org: D1Database) => D1PreparedStatement[] = () => [],
): Promise<string> {
  for (let step = 0; step < 5; step++)
    if ((await pauseReadModel(env, DEFAULT_ORG_SHARD)).phase === "paused") break;
  const id = uniqueId("rcv");
  await beginRecovery(env, DEFAULT_ORG_SHARD, id);
  for (let step = 0; step < 200; step++)
    if ((await preserveStep(env, DEFAULT_ORG_SHARD, id)).done) break;
  const generation = (await recovery())?.generation ?? 0;
  const restore = before(db);
  if (restore.length > 0)
    expect(await admitted(env, DEFAULT_ORG_SHARD, generation, () => before(db))).toBe(true);
  await env.DIRECTORY.prepare(
    "UPDATE read_model_recoveries SET stage = 'fencing' WHERE recovery_id = ?",
  )
    .bind(id)
    .run();
  return id;
}

async function fenced(id: string): Promise<void> {
  for (let step = 0; step < 200; step++)
    if ((await fenceStep(env, DEFAULT_ORG_SHARD, id)).done) return;
  throw new Error("still fencing");
}

/** The writers running again, as a recovery's resume leaves them. */
async function resumed(): Promise<void> {
  await env.DIRECTORY.prepare("UPDATE read_model_recoveries SET stage = 'complete'").run();
  await env.DIRECTORY.prepare(
    "UPDATE read_model_barriers SET phase = 'paused' WHERE phase = 'recovering'",
  ).run();
  await resumeReadModel(env, DEFAULT_ORG_SHARD);
}

afterEach(resumed);

describe("a recovery's fencing of search", () => {
  it("hides every restored source, tombstones those no longer active, and asks a reconciliation of the active", async () => {
    const [active, gone] = [await repository(), await repository()];
    const [unknown, orphan] = [uniqueId("rep"), uniqueId("rep")];
    const before = await gen();
    expect(await visible(active)).toBe(1);
    const id = await fencing((org) => [
      // Restored: rows of a repository unknown to the directory, and one only a label knows.
      org
        .prepare(
          `INSERT INTO search_docs (repo_id, number, kind, state, open_state, title, created_at,
             updated_at, epoch_gen, owner_gen, version, updated_seq)
           VALUES (?1, 1, 1, 1, 1, 'Restored', 0, 0, 1, 1, 1, 1)`,
        )
        .bind(unknown),
      org
        .prepare(
          `INSERT INTO search_labels (repo_id, label_id, name, color, epoch_gen, owner_gen,
             version, updated_seq) VALUES (?, 1, 'restored', 'ffffff', 1, 1, 1, 1)`,
        )
        .bind(orphan),
    ]);
    // Deleted in the directory since (its rows restored).
    await env.DIRECTORY.prepare("UPDATE repos SET state = 'deleted' WHERE id = ?").bind(gone).run();
    await fenced(id);
    expect((await recovery())?.stage).toBe("resuming");
    expect(await gen()).toBe(before + 1);
    for (const repoId of [active, gone, unknown, orphan]) {
      expect(await count("search_sources", repoId), repoId).toBe(1);
      expect(await visible(repoId), repoId).toBe(0);
    }
    const tombstoned = await db
      .prepare(
        `SELECT r.repo_id, p.recovery_gen FROM repos r JOIN search_purges p ON p.repo_id = r.repo_id
         WHERE r.deleted = 1 AND r.repo_id IN (?, ?, ?, ?) ORDER BY r.repo_id`,
      )
      .bind(active, gone, unknown, orphan)
      .all<{ repo_id: string; recovery_gen: number }>();
    expect(tombstoned.results).toEqual(
      [gone, unknown, orphan].sort().map((repo_id) => ({ repo_id, recovery_gen: before + 1 })),
    );
    const asked = await db
      .prepare(
        "SELECT repo_id, reason FROM search_repairs WHERE repo_id IN (?, ?) AND dirty > covered",
      )
      .bind(active, gone)
      .all<{ repo_id: string; reason: string }>();
    expect(asked.results).toEqual([{ repo_id: active, reason: "recovered" }]);
  });

  it("purges the tombstoned sources' search rows once resumed, and the active one is visible after its pass", async () => {
    const active = await repository();
    const unknown = uniqueId("rep");
    const id = await fencing((org) => [
      org
        .prepare(
          `INSERT INTO search_docs (repo_id, number, kind, state, open_state, title, created_at,
             updated_at, epoch_gen, owner_gen, version, updated_seq)
           VALUES (?1, 1, 1, 1, 1, 'Restored', 0, 0, 1, 1, 1, 1)`,
        )
        .bind(unknown),
    ]);
    await fenced(id);
    // Not while the barrier is recovering: nothing purged.
    await runSearchPurges(env, DEFAULT_ORG_SHARD);
    expect(await count("search_docs", unknown)).toBe(1);
    await resumed();
    for (let run = 0; run < 10 && (await count("search_purges", unknown)) !== 0; run++)
      await runSearchPurges(env, DEFAULT_ORG_SHARD);
    expect(await count("search_docs", unknown)).toBe(0);
    expect(await count("search_sources", unknown)).toBe(0);
    expect(await count("search_purges", unknown)).toBe(0);
    expect(
      await db.prepare("SELECT deleted FROM repos WHERE repo_id = ?").bind(unknown).first(),
    ).toEqual({ deleted: 1 });
    for (let call = 0; call < 12; call++)
      if ((await reconcileSource(env, { repoId: active, shard: DEFAULT_ORG_SHARD })) !== "more")
        break;
    expect(await visible(active)).toBe(1);
  });

  it("drops an older generation's purge without touching its source", async () => {
    const old = uniqueId("rep");
    await db.batch([
      db
        .prepare(
          `INSERT INTO repos (repo_id, deleted, epoch_gen, version, owner_gen, updated_seq, updated_at)
           VALUES (?, 1, 0, 0, 0, 0, 0)`,
        )
        .bind(old),
      db
        .prepare(
          `INSERT INTO search_labels (repo_id, label_id, name, color, epoch_gen, owner_gen,
             version, updated_seq) VALUES (?, 1, 'kept', 'ffffff', 1, 1, 1, 1)`,
        )
        .bind(old),
      // Asked at generation 1; the read model's since past it.
      db.prepare("INSERT INTO search_purges (repo_id, recovery_gen) VALUES (?, 1)").bind(old),
      db.prepare("UPDATE search_index_state SET recovery_gen = max(recovery_gen, 2) WHERE id = 1"),
    ]);
    await runSearchPurges(env, DEFAULT_ORG_SHARD);
    expect(await count("search_purges", old)).toBe(0);
    expect(await count("search_labels", old)).toBe(1);
  });

  it("tombstones a repository the directory has deleting that the restore knows nothing of", async () => {
    const deleting = await repository();
    const id = await fencing((org) => [
      // Made, and tombstoned, after the restore's point: the restored read model has none of it.
      org.prepare("DELETE FROM repos WHERE repo_id = ?").bind(deleting),
      org.prepare("DELETE FROM search_docs WHERE repo_id = ?").bind(deleting),
      org.prepare("DELETE FROM search_sources WHERE repo_id = ?").bind(deleting),
      org.prepare("DELETE FROM search_repo_nums WHERE repo_id = ?").bind(deleting),
      org.prepare("DELETE FROM search_reconciles WHERE repo_id = ?").bind(deleting),
      org.prepare("DELETE FROM search_repairs WHERE repo_id = ?").bind(deleting),
      org.prepare("DELETE FROM search_labels WHERE repo_id = ?").bind(deleting),
      org.prepare("DELETE FROM search_milestones WHERE repo_id = ?").bind(deleting),
    ]);
    await env.DIRECTORY.prepare("UPDATE repos SET state = 'deleting' WHERE id = ?")
      .bind(deleting)
      .run();
    await fenced(id);
    expect(
      await db.prepare("SELECT deleted FROM repos WHERE repo_id = ?").bind(deleting).first(),
    ).toEqual({
      deleted: 1,
    });
  });

  it("finds each restored source once among many rows of one", async () => {
    const many = uniqueId("rep");
    const few = uniqueId("rep");
    const id = await fencing((org) => [
      org
        .prepare(
          `INSERT INTO search_labels (repo_id, label_id, name, color, epoch_gen, owner_gen, version,
             updated_seq)
           WITH RECURSIVE k(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM k WHERE v < 300)
           SELECT ?, v, 'l' || v, 'ffffff', 1, 1, 1, 1 FROM k`,
        )
        .bind(many),
      org
        .prepare(
          `INSERT INTO search_labels (repo_id, label_id, name, color, epoch_gen, owner_gen, version,
             updated_seq) VALUES (?, 1, 'one', 'ffffff', 1, 1, 1, 1)`,
        )
        .bind(few),
    ]);
    await fenced(id);
    expect(await count("search_sources", many)).toBe(1);
    expect(await count("search_sources", few)).toBe(1);
  });

  it("leaves a newer recovery's purge asked meanwhile, when an older one's is dropped", async () => {
    const source = uniqueId("rep");
    await db.batch([
      db.prepare("INSERT INTO search_purges (repo_id, recovery_gen) VALUES (?, 1)").bind(source),
      db.prepare("UPDATE search_index_state SET recovery_gen = max(recovery_gen, 2) WHERE id = 1"),
    ]);
    const now = await gen();
    // Between its look and its drop, a newer recovery asks the source's purge again.
    const org = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const sql = statements.map((s) => (s as unknown as { statement: string }).statement);
            if (sql.some((q) => q.includes("DELETE FROM search_purges")))
              await db
                .prepare("UPDATE search_purges SET recovery_gen = ? WHERE repo_id = ?")
                .bind(now, source)
                .run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const watched = new Proxy(env, {
      get: (target, prop) => (prop === "ORG_READ" ? org : Reflect.get(target, prop)),
    });
    await runSearchPurges(watched, DEFAULT_ORG_SHARD);
    expect(
      await db
        .prepare("SELECT recovery_gen FROM search_purges WHERE repo_id = ?")
        .bind(source)
        .first(),
    ).toEqual({ recovery_gen: now });
  });

  it("resumes where it stopped: the generation raised once", async () => {
    await repository();
    const before = await gen();
    const id = await fencing();
    await fenceStep(env, DEFAULT_ORG_SHARD, id);
    await fenceStep(env, DEFAULT_ORG_SHARD, id);
    expect(await gen()).toBe(before + 1);
    // As a step made again from the same place (its answer lost): the generation it chose stands.
    const at = (await recovery())?.cursor;
    await env.DIRECTORY.prepare("UPDATE read_model_recoveries SET cursor = ? WHERE recovery_id = ?")
      .bind(JSON.stringify({ phase: "generation", target: before + 1 }), id)
      .run();
    await fenceStep(env, DEFAULT_ORG_SHARD, id);
    expect(await gen()).toBe(before + 1);
    expect(at).not.toBeNull();
    await fenced(id);
    expect(await gen()).toBe(before + 1);
  });
});
