// Which sources need a search reconciliation, by revision, and the repair job:
// asking while one is pending writes nothing, asking during a pass asks for
// another after it, a pass covers the revision it started with, and the job
// works the oldest needs first, a few pages each, only once search indexing is
// on.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, inject, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { reconcileSource } from "../src/search/reconcile.js";
import { REPAIR_POLICY, repairStatement, runSearchRepairs } from "../src/search/repairs.js";
import { api, json, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");
// Written as production writes it: through the read model's executor.
const db = readModelFor(env, DEFAULT_ORG_SHARD);

/** A repository with an issue and its branches pushed: its id. */
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
  const pushed = await postPush(
    target,
    pushBody([{ old: ZERO, new: fx.c1, ref: "refs/heads/main" }], { pack: fx.packC2 }),
  );
  expect(pushed.status).toBe(200);
  const opened = await api("POST", `/repos/${owner.handle}/${repo.name}/issues`, owner.token, {
    title: "One",
  });
  expect(opened.status).toBe(201);
  return repo.id;
}

const repair = (repoId: string) =>
  db
    .prepare(
      "SELECT dirty, active, covered, reason, since, next_at FROM search_repairs WHERE repo_id = ?",
    )
    .bind(repoId)
    .first<{
      dirty: number;
      active: number | null;
      covered: number;
      reason: string;
      since: number;
      next_at: number;
    }>();

async function indexing(on: boolean): Promise<void> {
  await (on
    ? env.DIRECTORY.prepare(
        `INSERT INTO deployment_settings (name, value, updated_at) VALUES ('search_indexing', 'on', 0)
         ON CONFLICT (name) DO UPDATE SET value = 'on'`,
      )
    : env.DIRECTORY.prepare("DELETE FROM deployment_settings WHERE name = 'search_indexing'")
  ).run();
}

/** `env` whose repositories in `failing` fail every export. */
function failingFor(failing: ReadonlySet<string>): Env {
  const repos = new Proxy(env.REPO, {
    get(target, prop) {
      if (prop === "getByName")
        return (name: string) =>
          failing.has(name)
            ? { exportPage: () => Promise.reject(new Error("export failed")) }
            : target.getByName(name);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get: (target, prop) => (prop === "REPO" ? repos : Reflect.get(target, prop)),
  });
}

/** `env` whose D1 calls (org and directory, queries and batches) are counted in `seen`. */
function countingCalls(seen: { calls: number }): Env {
  const count = (d1: D1Database): D1Database =>
    new Proxy(d1, {
      get(target, prop) {
        if (prop === "batch")
          return (batch: D1PreparedStatement[]) => {
            seen.calls++;
            return target.batch(batch);
          };
        if (prop === "prepare")
          return (sql: string) => {
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(t, p) {
                  if (p === "bind") return (...v: unknown[]) => wrap(t.bind(...v));
                  if (p === "run" || p === "all" || p === "first" || p === "raw")
                    return (...a: unknown[]) => {
                      seen.calls++;
                      return (Reflect.get(t, p) as (...x: unknown[]) => unknown).apply(t, a);
                    };
                  const value = Reflect.get(t, p);
                  return typeof value === "function" ? value.bind(t) : value;
                },
              });
            return wrap(target.prepare(sql));
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const org = count(env.ORG_READ);
  const directory = count(env.DIRECTORY);
  return new Proxy(env, {
    get: (target, prop) =>
      prop === "ORG_READ" ? org : prop === "DIRECTORY" ? directory : Reflect.get(target, prop),
  });
}

afterEach(() => indexing(false));

describe("search repair needs", () => {
  it("ask once while one is pending, and again after the pass under way", async () => {
    const repoId = uniqueId("rep");
    await repairStatement(db, repoId, "restored", 10).run();
    expect(await repair(repoId)).toEqual({
      dirty: 1,
      active: null,
      covered: 0,
      reason: "restored",
      since: 10,
      next_at: 10,
    });
    // Pending: nothing written.
    expect((await repairStatement(db, repoId, "again", 20).run()).meta.changes).toBe(0);
    // A pass covers revision 1; a need meanwhile asks for revision 2, once.
    await db
      .prepare("UPDATE search_repairs SET active = dirty WHERE repo_id = ?")
      .bind(repoId)
      .run();
    expect((await repairStatement(db, repoId, "during", 30).run()).meta.changes).toBe(1);
    expect((await repairStatement(db, repoId, "during", 40).run()).meta.changes).toBe(0);
    expect(await repair(repoId)).toMatchObject({ dirty: 2, active: 1, covered: 0, since: 10 });
  });

  it("are covered by the pass that started with them, and one asked during it asks for another", async () => {
    const repoId = await repository();
    await repairStatement(db, repoId, "backfill", 1).run();
    expect(await reconcileSource(env, { repoId, shard: "default" }, { pages: 1 })).toBe("more");
    expect(await repair(repoId)).toMatchObject({ dirty: 1, active: 1, covered: 0 });
    await repairStatement(db, repoId, "lost", 2).run();
    expect(await reconcileSource(env, { repoId, shard: "default" })).toBe("done");
    expect(await repair(repoId)).toMatchObject({ dirty: 2, active: null, covered: 1 });
    expect(await reconcileSource(env, { repoId, shard: "default" })).toBe("done");
    expect(await repair(repoId)).toMatchObject({ dirty: 2, active: null, covered: 2 });
  });
});

describe("the search repair job", () => {
  it("does nothing while search indexing is off", async () => {
    const repoId = await repository();
    await repairStatement(db, repoId, "backfill", 1).run();
    expect(await runSearchRepairs(env)).toEqual({ worked: 0 });
    expect(await repair(repoId)).toMatchObject({ dirty: 1, covered: 0 });
  });

  it("works the oldest needs first, a few pages each, the unfinished going to the back", async () => {
    const first = await repository();
    const second = await repository();
    // Only these two need it (earlier tests' sources aside).
    await db.prepare("DELETE FROM search_repairs").run();
    await repairStatement(db, first, "backfill", 1).run();
    await repairStatement(db, second, "backfill", 2).run();
    await indexing(true);
    // The first's whole pass (its start and three kinds) within its turn; one page for the second.
    expect(await runSearchRepairs(env, { pages: REPAIR_POLICY.pagesPerSource + 1 })).toEqual({
      worked: 2,
    });
    expect(await repair(first)).toMatchObject({ dirty: 1, covered: 1 });
    const behind = await repair(second);
    expect(behind).toMatchObject({ dirty: 1, active: 1, covered: 0 });
    expect(behind?.next_at).toBeGreaterThan(2);
    expect(await runSearchRepairs(env)).toMatchObject({ worked: 1 });
    expect(await repair(second)).toMatchObject({ dirty: 1, covered: 1 });
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM search_docs WHERE repo_id IN (?, ?)")
        .bind(first, second)
        .first(),
    ).toEqual({ n: 2 });
  });

  it("gives the others their turns when a source fails, keeping its need", async () => {
    await db.prepare("DELETE FROM search_repairs").run();
    const failing = uniqueId("rep");
    const healthy = await repository();
    await repairStatement(db, failing, "backfill", 1).run();
    await repairStatement(db, healthy, "backfill", 2).run();
    await indexing(true);
    await expect(runSearchRepairs(failingFor(new Set([failing])))).rejects.toThrow(
      /1 search repair\(s\) failed/,
    );
    expect(await repair(healthy)).toMatchObject({ dirty: 1, covered: 1 });
    expect(await repair(failing)).toMatchObject({ dirty: 1, covered: 0 });
  });

  it("puts a source that had its turn behind every one still waiting, whatever the clock", async () => {
    await db.prepare("DELETE FROM search_repairs").run();
    const stuck = [uniqueId("rep"), uniqueId("rep"), uniqueId("rep"), uniqueId("rep")];
    const waiting = await repository();
    for (const id of stuck) await repairStatement(db, id, "backfill", 1).run();
    // Asked for later than the clock reads now (another instance's clock ahead).
    await repairStatement(db, waiting, "backfill", Date.now() + 1_000_000_000).run();
    await indexing(true);
    const broken = failingFor(new Set(stuck));
    // The four oldest fill the run, and fail; then the one waiting is next.
    await expect(runSearchRepairs(broken)).rejects.toThrow(/4 search repair/);
    expect(await repair(waiting)).toMatchObject({ covered: 0 });
    // (The others after it, as many as the run's calls allow.)
    await expect(runSearchRepairs(broken)).rejects.toThrow(/search repair\(s\) failed/);
    expect(await repair(waiting)).toMatchObject({ dirty: 1, covered: 1 });
  });

  it("makes no more D1 calls a run than it is allowed", async () => {
    await db.prepare("DELETE FROM search_repairs").run();
    const sources = [await repository(), await repository(), await repository()];
    for (const [i, id] of sources.entries()) await repairStatement(db, id, "backfill", i).run();
    await indexing(true);
    const seen = { calls: 0 };
    await runSearchRepairs(countingCalls(seen));
    expect(seen.calls).toBeGreaterThan(REPAIR_POLICY.callsPerRun / 2);
    expect(seen.calls).toBeLessThanOrEqual(REPAIR_POLICY.callsPerRun);
  });
});
