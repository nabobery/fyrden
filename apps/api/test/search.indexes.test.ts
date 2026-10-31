// An instance administrator's checks and rebuilds of search's full-text
// indexes (`POST /admin/search/indexes/check`, `.../rebuild`): a check
// compares each index named with its projections, one after the other, and
// says which do not match; a rebuild makes a small index again from its
// projections and marks them indexed, refused before either index is
// touched when one holds too much or leaves a projection out, and when
// search's allowance admits none.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, inject, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { READ_MODEL_LEASE, READ_MODEL_LONE_WRITE } from "../src/read-model/executor.js";
import { ADMISSION, RECEIPT_RELEASE, SETTLING } from "../src/search/admission.js";
import { checkIndex, LIVE, REBUILD } from "../src/search/indexes.js";
import { reconcileSource } from "../src/search/reconcile.js";
import { api, json, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");
// Written as production writes it: through the read model's executor.
const db = readModelFor(env, DEFAULT_ORG_SHARD);
const TODAY = "CAST(unixepoch() / 86400 AS INTEGER)";

/** A repository with two issues, reconciled into search: its id. */
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
  for (const title of ["Lantern flickers", "Kettle whistles"])
    expect(
      (await api("POST", `/repos/${owner.handle}/${repo.name}/issues`, owner.token, { title }))
        .status,
    ).toBe(201);
  expect(await reconcileSource(env, { repoId: repo.id, shard: DEFAULT_ORG_SHARD })).toBe("done");
  return repo.id;
}

const check = (token: string, index: string) =>
  json<{ indexes: { index: string; ok: boolean }[] }>(
    api("POST", "/admin/search/indexes/check", token, { index }),
  );
const rebuild = (token: string, index: string) =>
  json<{ indexes: { index: string; ok: boolean }[]; code?: string }>(
    api("POST", "/admin/search/indexes/rebuild", token, { index }),
  );

/** The live documents, and whether each is marked indexed and found by its title's first word. */
const documents = async () =>
  (
    await db
      .prepare(
        `SELECT d.doc_id, d.fts_token IS NOT NULL AS marked,
           (SELECT count(*) FROM search_fts f WHERE search_fts MATCH
             '"' || substr(d.title, 1, instr(d.title || ' ', ' ') - 1) || '"'
             AND f.rowid = d.doc_id) AS found
         FROM search_docs d WHERE d.deleted = 0 ORDER BY d.doc_id`,
      )
      .all<{ doc_id: number; marked: number; found: number }>()
  ).results;

const counters = () =>
  db
    .prepare("SELECT live_docs, indexed_repos FROM search_index_state WHERE id = 1")
    .first<{ live_docs: number; indexed_repos: number }>();

/** Every document's entry taken out of the index, as the index losing them would; unmarked too. */
async function loseDocuments(): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO search_fts (search_fts, rowid, title, body, repo, kind)
       SELECT 'delete', d.doc_id, d.title, d.body, 'r' || n.num, 'k' || d.kind
       FROM search_docs d JOIN search_repo_nums n ON n.repo_id = d.repo_id
       WHERE d.deleted = 0 AND EXISTS (SELECT 1 FROM search_fts_docsize z WHERE z.id = d.doc_id)`,
    ),
    db.prepare(
      `UPDATE search_index_state SET live_docs = live_docs - (SELECT count(*) FROM search_docs
         WHERE deleted = 0 AND fts_token IS NOT NULL) WHERE id = 1`,
    ),
    db.prepare("UPDATE search_docs SET fts_token = NULL"),
  ]);
}

/** Live documents of a repository with no number (its reconciliation has not given it one). */
async function unnumbered(count: number, numbered = true): Promise<string> {
  const repoId = uniqueId("rep");
  const values = Array.from(
    { length: count },
    (_, i) => `(?1, ${i + 1}, 1, 1, 1, 'Raw ${i}', 0, 0, 1, 1, 1, 1)`,
  ).join(", ");
  await db.batch([
    db
      .prepare(
        `INSERT INTO search_docs (repo_id, number, kind, state, open_state, title, created_at,
           updated_at, epoch_gen, owner_gen, version, updated_seq) VALUES ${values}`,
      )
      .bind(repoId),
    ...(numbered
      ? [
          db
            .prepare(
              `INSERT INTO search_repo_nums (repo_id, num)
               SELECT ?1, next_repo_num FROM search_index_state WHERE id = 1`,
            )
            .bind(repoId),
          db.prepare(
            "UPDATE search_index_state SET next_repo_num = next_repo_num + 1 WHERE id = 1",
          ),
        ]
      : []),
  ]);
  return repoId;
}

/** Search's spending today. */
const spent = () =>
  db
    .prepare(`SELECT rows, reads FROM search_budget WHERE day = ${TODAY}`)
    .first<{ rows: number; reads: number }>()
    .then((r) => r ?? { rows: 0, reads: 0 });

/** Usage of the batches `env` writes whose SQL has `marker`; `before` runs before the first. */
function recording(
  marker: string,
  seen: { rows: number; reads: number }[],
  before?: () => Promise<void>,
): Env {
  let first = true;
  const org = new Proxy(env.ORG_READ, {
    get(target, prop) {
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const sql = statements.map((s) => (s as unknown as { statement: string }).statement);
          if (!sql.some((q) => q.includes(marker))) return target.batch(statements);
          if (first) {
            first = false;
            await before?.();
          }
          const results = await target.batch(statements);
          seen.push({
            rows: results.reduce((n, r) => n + (r.meta.rows_written ?? 0), 0),
            reads: results.reduce((n, r) => n + (r.meta.rows_read ?? 0), 0),
          });
          return results;
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get: (target, prop) => (prop === "ORG_READ" ? org : Reflect.get(target, prop)),
  });
}

async function removeDocuments(repoId: string): Promise<void> {
  await db.prepare("DELETE FROM search_docs WHERE repo_id = ?").bind(repoId).run();
}

describe("a check of search's indexes", () => {
  it("says each index named matches its projections, in order", async () => {
    await repository();
    const admin = await user(true);
    const { status, body } = await check(admin.token, "both");
    expect(status).toBe(200);
    expect(body.indexes).toEqual([
      { index: "documents", ok: true },
      { index: "repositories", ok: true },
    ]);
  });

  it("says which index does not match, and still checks the other", async () => {
    await repository();
    const admin = await user(true);
    await loseDocuments();
    try {
      expect((await check(admin.token, "both")).body.indexes).toEqual([
        { index: "documents", ok: false },
        { index: "repositories", ok: true },
      ]);
      expect((await check(admin.token, "repositories")).body.indexes).toEqual([
        { index: "repositories", ok: true },
      ]);
    } finally {
      expect((await rebuild(admin.token, "documents")).status).toBe(200);
    }
  });

  it("is charged to search's allowance", async () => {
    const admin = await user(true);
    const spent = () =>
      db
        .prepare(`SELECT rows FROM search_budget WHERE day = ${TODAY}`)
        .first<{ rows: number }>()
        .then((r) => r?.rows ?? 0);
    const before = await spent();
    expect((await check(admin.token, "documents")).status).toBe(200);
    expect(await spent()).toBeGreaterThan(before);
  });

  it("is spent when it fails for another reason, the failure thrown", async () => {
    const failing = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "batch")
          return (statements: D1PreparedStatement[]) => {
            const sql = statements.map((s) => (s as unknown as { statement: string }).statement);
            if (sql.some((q) => q.includes("integrity-check")))
              return Promise.reject(new Error("D1_ERROR: Network connection lost."));
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const broken = new Proxy(env, {
      get: (target, prop) => (prop === "ORG_READ" ? failing : Reflect.get(target, prop)),
    });
    const before = await spent();
    await expect(checkIndex(readModelFor(broken, DEFAULT_ORG_SHARD), "documents")).rejects.toThrow(
      /Network connection lost/,
    );
    expect((await spent()).rows - before.rows).toBe(2 * READ_MODEL_LONE_WRITE.rows + 1);
  });

  it("is made only by instance administrators", async () => {
    const someone = await user();
    expect((await check(someone.token, "both")).status).toBe(403);
    expect((await rebuild(someone.token, "both")).status).toBe(403);
  });
});

describe("a rebuild of search's indexes", () => {
  it("makes an index that lost its entries again, its projections marked and counted", async () => {
    await repository();
    const admin = await user(true);
    const before = await documents();
    const counted = await counters();
    expect(before.every((d) => d.marked === 1 && d.found === 1)).toBe(true);
    await loseDocuments();
    expect((await documents()).every((d) => d.marked === 0 && d.found === 0)).toBe(true);
    const { status, body } = await rebuild(admin.token, "both");
    expect(status).toBe(200);
    expect(body.indexes).toEqual([
      { index: "documents", ok: true },
      { index: "repositories", ok: true },
    ]);
    expect(await documents()).toEqual(before);
    expect(await counters()).toEqual(counted);
    expect((await check(admin.token, "both")).body.indexes.every((i) => i.ok)).toBe(true);
  });

  it("is charged what it read and wrote: its look, its batch, its settlement and their leases", async () => {
    await repository();
    const looks: { rows: number; reads: number }[] = [];
    const rebuilds: { rows: number; reads: number }[] = [];
    const watched = recording("WITH live AS", looks);
    const before = await spent();
    const { rebuildPreflight, rebuildIndex } = await import("../src/search/indexes.js");
    const writer = readModelFor(recording("'rebuild'", rebuilds), DEFAULT_ORG_SHARD);
    const { cost } = await rebuildPreflight(readModelFor(watched, DEFAULT_ORG_SHARD), [
      "documents",
    ]);
    expect(await rebuildIndex(writer, "documents", cost)).toBeNull();
    const charged = await spent();
    const [look] = looks;
    const [made] = rebuilds;
    expect(charged.rows - before.rows).toBe(
      (look?.rows ?? 0) +
        (made?.rows ?? 0) +
        2 * READ_MODEL_LEASE.rows +
        RECEIPT_RELEASE.rows +
        SETTLING.rows,
    );
    expect(charged.reads - before.reads).toBe(
      (look?.reads ?? 0) + (made?.reads ?? 0) + RECEIPT_RELEASE.reads + SETTLING.reads,
    );
  });

  it("is refused before either index is touched when one holds more than a rebuild may, its look spent", async () => {
    await repository();
    const admin = await user(true);
    const extra = await unnumbered(REBUILD.rows + 1);
    try {
      const marked = await documents();
      const before = await spent();
      const { status, body } = await rebuild(admin.token, "both");
      expect(status).toBe(409);
      expect(body.code).toBe("index_rebuild_too_large");
      expect(await documents()).toEqual(marked);
      // Its look's reads (a read writes none) and its spending's own write.
      const charged = await spent();
      expect(charged.rows - before.rows).toBe(READ_MODEL_LONE_WRITE.rows + 1);
      expect(charged.reads - before.reads).toBeGreaterThan(READ_MODEL_LONE_WRITE.reads);
    } finally {
      await removeDocuments(extra);
    }
  });

  it("is refused when its projections grew past a rebuild's after it looked", async () => {
    await repository();
    await loseDocuments();
    let extra = "";
    const { rebuildPreflight, rebuildIndex } = await import("../src/search/indexes.js");
    const { cost } = await rebuildPreflight(db, ["documents"]);
    // Grown between the look and the rebuild: refused, the index left as it was.
    const grown = readModelFor(
      recording("'rebuild'", [], async () => {
        extra = await unnumbered(REBUILD.rows + 1);
      }),
      DEFAULT_ORG_SHARD,
    );
    try {
      expect(await rebuildIndex(grown, "documents", cost)).toBe("too_large");
      expect((await documents()).filter((d) => d.doc_id > 0).every((d) => d.found === 0)).toBe(
        true,
      );
    } finally {
      await removeDocuments(extra);
      const admin = await user(true);
      expect((await rebuild(admin.token, "documents")).status).toBe(200);
    }
  });

  it("looks at the repositories the index holds through their own index", async () => {
    const { results } = await db
      .prepare(`EXPLAIN QUERY PLAN ${LIVE.repositories}`)
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join(" | ");
    expect(plan).toMatch(/search_repo_nums USING (COVERING )?INDEX search_repo_nums_indexed/);
  });

  it("is refused while a live document's repository has no number", async () => {
    await repository();
    const admin = await user(true);
    const extra = await unnumbered(1, false);
    try {
      const { status, body } = await rebuild(admin.token, "documents");
      expect(status).toBe(409);
      expect(body.code).toBe("index_reconcile_required");
    } finally {
      await removeDocuments(extra);
    }
  });

  it("is refused when search's allowance admits no rebuild, the index left as it was", async () => {
    await repository();
    const admin = await user(true);
    const spend = (delta: number) =>
      db
        .prepare(
          `INSERT INTO search_budget (day, rows) VALUES (${TODAY}, max(0, ?1))
           ON CONFLICT (day) DO UPDATE SET rows = max(0, rows + ?1)`,
        )
        .bind(delta)
        .run();
    await loseDocuments();
    await spend(ADMISSION.dailyRows);
    try {
      const { status, body } = await rebuild(admin.token, "documents");
      expect(status).toBe(409);
      expect(body.code).toBe("index_rebuild_refused");
      expect((await documents()).every((d) => d.marked === 0 && d.found === 0)).toBe(true);
    } finally {
      await spend(-ADMISSION.dailyRows);
      expect((await rebuild(admin.token, "documents")).status).toBe(200);
    }
  });
});
