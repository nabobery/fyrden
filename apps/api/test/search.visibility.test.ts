// Which sources search may show, by recovery generation: a source is
// visible while its row's generation is the read model's
// (`search_index_state.recovery_gen`), or it has none (nothing of it was
// restored). A recovery raises the read model's generation, hiding every
// source with a row at once; only a whole reconciliation started under the
// new generation makes its source visible again. A pass started before it
// writes nothing more, and a new one follows.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, inject, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { reconcileSource } from "../src/search/reconcile.js";
import { SOURCE_VISIBLE } from "../src/search/visibility.js";
import { api, json, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");
// Written as production writes it: through the read model's executor.
const db = readModelFor(env, DEFAULT_ORG_SHARD);

/** A repository with an issue: its id. */
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
  return repo.id;
}

const target = (repoId: string) => ({ repoId, shard: DEFAULT_ORG_SHARD });

/** Reconciles `repoId` through to its pass's end. */
async function reconciled(repoId: string, using: Env = env): Promise<void> {
  for (let call = 0; call < 12; call++)
    if ((await reconcileSource(using, target(repoId))) !== "more") return;
  throw new Error("still reconciling");
}

const visible = async (repoId: string) =>
  (
    await db
      .prepare(`SELECT ${SOURCE_VISIBLE("?1")} AS visible`)
      .bind(repoId)
      .first<{ visible: number }>()
  )?.visible;

/** The source's live projected issues. */
const documents = async (repoId: string) =>
  (
    await db
      .prepare("SELECT count(*) AS n FROM search_docs WHERE repo_id = ? AND deleted = 0")
      .bind(repoId)
      .first<{ n: number }>()
  )?.n;

/** The repository's row in the read model, and whether its index entry is there. */
const repositoryRow = (repoId: string) =>
  db
    .prepare(
      `SELECT r.name, r.version, n.indexed, n.fts_token,
         EXISTS (SELECT 1 FROM search_repos_fts_docsize z WHERE z.id = n.num) AS entry
       FROM repos r LEFT JOIN search_repo_nums n ON n.repo_id = r.repo_id WHERE r.repo_id = ?`,
    )
    .bind(repoId)
    .first();

/** The read model's recovery generation set to `gen` (as a recovery raises it). */
const recover = (gen: number) =>
  db.prepare("UPDATE search_index_state SET recovery_gen = ? WHERE id = 1").bind(gen).run();

const pass = (repoId: string) =>
  db
    .prepare("SELECT gen, kind, after, recovery_gen FROM search_reconciles WHERE repo_id = ?")
    .bind(repoId)
    .first<{ gen: number; kind: string; after: number; recovery_gen: number }>();

/** `env` whose first batch of a reconciliation's checkpoint runs `before` first. */
function racing(before: () => Promise<unknown>): Env {
  let raced = false;
  const org = new Proxy(env.ORG_READ, {
    get(target, prop) {
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const sql = statements.map((s) => (s as unknown as { statement: string }).statement);
          if (!raced && sql.some((q) => q.includes("UPDATE search_reconciles SET kind"))) {
            raced = true;
            await before();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get: (target, prop) => (prop === "ORG_READ" ? org : Reflect.get(target, prop)),
  });
}

// Each test's generation its own; the file's others see none raised.
afterEach(() => recover(0));

describe("a source's visibility", () => {
  it("is every source's while nothing was recovered, with a row or without", async () => {
    const repoId = await repository();
    expect(await visible(repoId)).toBe(1);
    await reconciled(repoId);
    expect(await visible(repoId)).toBe(1);
    expect(await visible(uniqueId("rep"))).toBe(1);
  });

  it("is lost by every source with a row once a recovery raises the generation, until a whole pass under it", async () => {
    const repoId = await repository();
    await reconciled(repoId);
    await recover(1);
    expect(await visible(repoId)).toBe(0);
    // A source with no row had nothing restored.
    expect(await visible(uniqueId("rep"))).toBe(1);
    await reconciled(repoId);
    expect(await pass(repoId)).toMatchObject({ kind: "done", recovery_gen: 1 });
    expect(await visible(repoId)).toBe(1);
  });

  it("is not given by a pass started before the generation rose: its step writes nothing, and a new pass follows", async () => {
    const repoId = await repository();
    expect(await reconcileSource(env, target(repoId), { pages: 1 })).toBe("more");
    const before = await pass(repoId);
    // Its issues' page, raced: the issue it would project, not projected.
    expect(await documents(repoId)).toBe(0);
    await reconcileSource(
      racing(() => recover(1)),
      target(repoId),
      { pages: 1 },
    );
    expect(await pass(repoId)).toEqual(before);
    expect(await documents(repoId)).toBe(0);
    expect(await visible(repoId)).toBe(0);
    // The next call starts a pass of the new generation, which ends visible.
    expect(await reconcileSource(env, target(repoId), { pages: 1 })).toBe("more");
    expect(await pass(repoId)).toMatchObject({
      gen: (before?.gen ?? 0) + 1,
      kind: "subjects",
      recovery_gen: 1,
    });
    await reconciled(repoId);
    expect(await visible(repoId)).toBe(1);
  });

  it("is not given by a finishing step raced by the generation: the repository's row and entry stay as they were", async () => {
    const repoId = await repository();
    // Up to its last step, the repository's own row older than its snapshot.
    for (let step = 0; step < 12 && (await pass(repoId))?.after !== -1; step++)
      await reconcileSource(env, target(repoId), { pages: 1 });
    expect(await pass(repoId)).toMatchObject({ kind: "milestones", after: -1 });
    await db
      .prepare("UPDATE repos SET name = 'stale', version = 0 WHERE repo_id = ?")
      .bind(repoId)
      .run();
    const stale = await repositoryRow(repoId);
    const before = await pass(repoId);
    await reconcileSource(
      racing(() => recover(1)),
      target(repoId),
      { pages: 1 },
    );
    expect(await repositoryRow(repoId)).toEqual(stale);
    expect(await pass(repoId)).toEqual(before);
    expect(await visible(repoId)).toBe(0);
    // A pass of the new generation writes it, and ends visible.
    await reconciled(repoId);
    expect((await repositoryRow(repoId))?.name).not.toBe("stale");
    expect(await visible(repoId)).toBe(1);
  });

  it("is not given by a pass that ended partial", async () => {
    const repoId = await repository();
    await reconciled(repoId);
    await recover(1);
    expect(await reconcileSource(env, target(repoId), { pages: 1 })).toBe("more");
    // Something it wrote refused on the way (as a refused growth marks it).
    await db
      .prepare(
        "UPDATE search_reconciles SET partial = 1, partial_reason = 'growth' WHERE repo_id = ?",
      )
      .bind(repoId)
      .run();
    await reconciled(repoId);
    expect(await pass(repoId)).toMatchObject({ kind: "done" });
    expect(await visible(repoId)).toBe(0);
  });

  it("is a new source's from its first pass after a recovery", async () => {
    await recover(1);
    const repoId = await repository();
    expect(await visible(repoId)).toBe(1);
    expect(await reconcileSource(env, target(repoId), { pages: 1 })).toBe("more");
    expect(await visible(repoId)).toBe(1);
    await reconciled(repoId);
    expect(await visible(repoId)).toBe(1);
  });

  it("is not given by a rebuild of the indexes", async () => {
    const repoId = await repository();
    await reconciled(repoId);
    await recover(1);
    const admin = await user(true);
    expect(
      (await api("POST", "/admin/search/indexes/rebuild", admin.token, { index: "both" })).status,
    ).toBe(200);
    expect(await visible(repoId)).toBe(0);
  });
});
