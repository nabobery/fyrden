// What search may spend of the org database: a day's allowance of rows written
// and read, reserved before a step and settled after, and a size threshold. A
// reconciliation with no room is blocked (and the repair job stops for the run);
// a step whose day ended before it wrote writes nothing.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import {
  ADMISSION,
  reserve,
  SETTLING,
  settleStatement,
  sizeStatement,
  tickStatement,
} from "../src/search/admission.js";
import {
  collectTombstones,
  RECONCILE_POLICY,
  reconcileSource,
  sweepTombstones,
} from "../src/search/reconcile.js";
import { repairStatement, runSearchRepairs } from "../src/search/repairs.js";
import { docStatement } from "../src/search/statements.js";
import { api, json, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");
// Written as production writes it: through the read model's executor.
const db = readModelFor(env, DEFAULT_ORG_SHARD);

const today = async () =>
  (await db.prepare("SELECT CAST(unixepoch() / 86400 AS INTEGER) AS d").first<{ d: number }>())
    ?.d ?? 0;

const budget = async () =>
  db
    .prepare("SELECT rows, reads FROM search_budget WHERE day = ?")
    .bind(await today())
    .first<{ rows: number; reads: number }>();

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
        title: "One",
      })
    ).status,
  ).toBe(201);
  return repo.id;
}

/**
 * `env` whose org database makes reservations number `from` and later come
 * back dated yesterday (a step whose day ended while it ran), and counts
 * every call and the rows each wrote.
 */
function clocked(
  from = Number.POSITIVE_INFINITY,
  seen: { calls: number; written: number; read?: number } = { calls: 0, written: 0 },
): Env {
  let reservations = 0;
  const statementsOf = (batch: D1PreparedStatement[]) =>
    batch.map((s) => (s as unknown as { statement: string }).statement);
  const written = (results: D1Result | D1Result[]) => {
    for (const r of Array.isArray(results) ? results : [results]) {
      seen.written += r.meta.rows_written ?? 0;
      seen.read = (seen.read ?? 0) + (r.meta.rows_read ?? 0);
    }
  };
  const org = new Proxy(env.ORG_READ, {
    get(target, prop) {
      if (prop === "batch")
        return async (batch: D1PreparedStatement[]) => {
          seen.calls++;
          const results = await target.batch(batch);
          written(results);
          if (statementsOf(batch).some((q) => q.includes("SET rows = rows + ?1")))
            if (++reservations >= from)
              for (const r of results)
                for (const row of r.results as { day?: number }[])
                  if (row.day !== undefined) row.day -= 1;
          return results;
        };
      if (prop === "prepare")
        return (sql: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(statement, {
              get(t, p) {
                if (p === "bind") return (...v: unknown[]) => wrap(t.bind(...v));
                if (p === "run" || p === "all" || p === "first" || p === "raw")
                  return async (...a: unknown[]) => {
                    seen.calls++;
                    const out = await (
                      Reflect.get(t, p) as (...x: unknown[]) => Promise<unknown>
                    ).apply(t, a);
                    if (p === "run" || p === "all") written(out as D1Result);
                    return out;
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
  return new Proxy(env, {
    get: (target, prop) => (prop === "ORG_READ" ? org : Reflect.get(target, prop)),
  });
}

beforeEach(async () => {
  // Each test starts from an empty day, a small database, and no deletions for a sweep to
  // meet but its own (the sweep looks across every source).
  await db.batch([
    db.prepare("DELETE FROM search_sweep"),
    db.prepare("DELETE FROM search_docs WHERE deleted = 1"),
    db.prepare("DELETE FROM search_labels WHERE deleted = 1"),
    db.prepare("DELETE FROM search_milestones WHERE deleted = 1"),
    db.prepare("DELETE FROM search_budget"),
    db.prepare("UPDATE search_size SET clock = 0, observed = 0, bytes = 0 WHERE id = 1"),
  ]);
});

afterEach(() =>
  env.DIRECTORY.prepare("DELETE FROM deployment_settings WHERE name = 'search_indexing'").run(),
);

describe("search's allowance", () => {
  it("reserves within the day's allowance, gives back what a step did not use, and refuses past it", async () => {
    const taken = await reserve(db, { rows: 30_000, reads: 10 });
    expect(taken).toMatchObject({ day: await today(), rows: 30_000, reads: 10 });
    if (!taken) throw new Error("not reserved");
    await settleStatement(db, taken, { rows: 1_000, reads: 4 }).run();
    // What the step used, with what reserving it wrote and read and what settling it may.
    expect(await budget()).toEqual({
      rows: 1_000 + taken.overhead.rows + SETTLING.rows,
      reads: 4 + taken.overhead.reads + SETTLING.reads,
    });
    const spent = (await budget())?.rows ?? 0;
    expect(await reserve(db, { rows: ADMISSION.dailyRows - spent + 1, reads: 0 })).toBeNull();
    // (That refusal's own cost is spent too.)
    const after = (await budget())?.rows ?? 0;
    expect(await reserve(db, { rows: ADMISSION.dailyRows - after, reads: 0 })).not.toBeNull();
    expect(await reserve(db, { rows: 1, reads: 0 })).toBeNull();
  });

  it("allows removals only once the database is at its size threshold, and keeps the latest batch's size", async () => {
    const threshold = ADMISSION.maxBytes;
    // Any database is above a threshold of a byte: looked at again, still there, so the
    // reservation allows removals only.
    ADMISSION.maxBytes = 1;
    await db.prepare("UPDATE search_size SET bytes = 1 WHERE id = 1").run();
    try {
      expect(await reserve(db, { rows: 1, reads: 1 })).toMatchObject({ removalsOnly: true });
    } finally {
      ADMISSION.maxBytes = threshold;
    }
    // An earlier batch's report, arriving after a later one's, does not replace it.
    const tick = async () => (await tickStatement(db).first<{ clock: number }>())?.clock ?? 0;
    const earlier = await tick();
    const later = await tick();
    await sizeStatement(db, later, 2_000).run();
    await sizeStatement(db, earlier, 1_000).run();
    expect(
      await db.prepare("SELECT observed, bytes FROM search_size WHERE id = 1").first(),
    ).toEqual({
      observed: later,
      bytes: 2_000,
    });
  });

  it("charges a refused reservation's own reads", async () => {
    await db
      .prepare("INSERT INTO search_budget (day, rows, reads) VALUES (?, ?, 0)")
      .bind(await today(), ADMISSION.dailyRows)
      .run();
    expect(await reserve(db, { rows: 1, reads: 1 })).toBeNull();
    expect((await budget())?.reads).toBeGreaterThan(0);
  });

  it("removes deletions a cutoff covers even while blocked, which may make room again", async () => {
    const repoId = await repository();
    expect(await reconcileSource(env, { repoId, shard: "default" })).toBe("done");
    await db
      .prepare(
        `INSERT INTO search_docs (repo_id, number, kind, deleted, deleted_epoch, deleted_seq,
           epoch_gen, owner_gen, version, updated_seq) VALUES (?, 90, 1, 1, 0, 1, 0, 1, 1, 1)`,
      )
      .bind(repoId)
      .run();
    await db
      .prepare("UPDATE search_budget SET rows = ? WHERE day = ?")
      .bind(ADMISSION.dailyRows, await today())
      .run();
    expect(await reconcileSource(env, { repoId, shard: "default" })).toBe("blocked");
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM search_docs WHERE repo_id = ? AND number = 90")
        .bind(repoId)
        .first(),
    ).toEqual({ n: 0 });
  });

  it("charges the repair job's own writes too (a source's rotation)", async () => {
    const repoId = await repository();
    await db.prepare("DELETE FROM search_repairs").run();
    await repairStatement(db, repoId, "backfill", 1).run();
    await env.DIRECTORY.prepare(
      "INSERT INTO deployment_settings (name, value, updated_at) VALUES ('search_indexing', 'on', 0)",
    ).run();
    const seen = { calls: 0, written: 0, read: 0 };
    // One page: the pass is not done, and the source goes to the back.
    await runSearchRepairs(clocked(Number.POSITIVE_INFINITY, seen), { pages: 1 });
    expect((await budget())?.rows ?? 0).toBeGreaterThanOrEqual(seen.written);
    expect((await budget())?.reads ?? 0).toBeGreaterThanOrEqual(seen.read);
  });

  it("is settled by a reconciliation to what it used, and the size it reported recorded", async () => {
    const repoId = await repository();
    expect(await reconcileSource(env, { repoId, shard: "default" })).toBe("done");
    const used = await budget();
    // Rows written (the issue, nine labels, bookkeeping) and read: far below what was reserved.
    expect(used?.rows).toBeGreaterThan(10);
    expect(used?.rows).toBeLessThan(500);
    expect(used?.reads).toBeGreaterThan(0);
    const size = await db
      .prepare("SELECT observed, bytes FROM search_size WHERE id = 1")
      .first<{ observed: number; bytes: number }>();
    expect(size?.observed).toBeGreaterThan(0);
    expect(size?.bytes).toBeGreaterThan(0);
  });

  it("blocks a reconciliation with no room, writing nothing, and stops the repair job's run", async () => {
    const repoId = await repository();
    await db
      .prepare("INSERT INTO search_budget (day, rows, reads) VALUES (?, ?, 0)")
      .bind(await today(), ADMISSION.dailyRows)
      .run();
    expect(await reconcileSource(env, { repoId, shard: "default" })).toBe("blocked");
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM search_reconciles WHERE repo_id = ?")
        .bind(repoId)
        .first(),
    ).toEqual({ n: 0 });

    await db.prepare("DELETE FROM search_repairs").run();
    const other = await repository();
    await repairStatement(db, repoId, "backfill", 1).run();
    await repairStatement(db, other, "backfill", 2).run();
    await env.DIRECTORY.prepare(
      "INSERT INTO deployment_settings (name, value, updated_at) VALUES ('search_indexing', 'on', 0)",
    ).run();
    // Blocked at the first source: the run ends there.
    expect(await runSearchRepairs(env)).toEqual({ worked: 1 });
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM search_reconciles WHERE repo_id IN (?, ?)")
        .bind(repoId, other)
        .first(),
    ).toEqual({ n: 0 });
  });

  it("refuses a step's writes once its day has ended", async () => {
    const repoId = await repository();
    expect(await reconcileSource(env, { repoId, shard: "default" }, { pages: 1 })).toBe("more");
    const pass = await db
      .prepare(
        "SELECT gen, epoch_gen, owner_gen, watermark FROM search_reconciles WHERE repo_id = ?",
      )
      .bind(repoId)
      .first<{ gen: number; epoch_gen: number; owner_gen: number; watermark: number }>();
    const write = async (day: number) =>
      (
        await docStatement(
          db,
          {
            repoId,
            epochGen: pass?.epoch_gen ?? 0,
            ownerGen: pass?.owner_gen ?? 0,
            sourceSeq: pass?.watermark ?? 0,
          },
          {
            type: "issue",
            id: `${repoId}#9`,
            version: 1,
            deleted: true,
            row: null,
            deletedAt: { epochGen: 99, sourceSeq: 1 },
          },
          { by: "reconcile", gen: pass?.gen ?? 0, kind: "subjects", after: 0, day },
        ).run()
      ).meta.changes;
    // Reserved yesterday: nothing written today.
    expect(await write((await today()) - 1)).toBe(0);
    expect(await write(await today())).toBe(1);
  });

  it("writes nothing of a step whose day ended while it ran: its start, its page, its last step", async () => {
    const repoId = await repository();
    // The pass's start reserved yesterday: no pass, no cutoff.
    expect(await reconcileSource(clocked(1), { repoId, shard: "default" }, { pages: 1 })).toBe(
      "more",
    );
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM search_sources WHERE repo_id = ?")
        .bind(repoId)
        .first(),
    ).toEqual({ n: 0 });
    // Started today; its subjects page reserved yesterday: nothing read, nothing projected.
    expect(await reconcileSource(clocked(2), { repoId, shard: "default" }, { pages: 2 })).toBe(
      "more",
    );
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM search_docs WHERE repo_id = ?")
        .bind(repoId)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await db.prepare("SELECT kind FROM search_reconciles WHERE repo_id = ?").bind(repoId).first(),
    ).toEqual({ kind: "subjects" });
    // Through its walk today; its last step reserved yesterday: the repository's row unwritten.
    expect(await reconcileSource(env, { repoId, shard: "default" }, { pages: 3 })).toBe("more");
    expect(await reconcileSource(clocked(1), { repoId, shard: "default" }, { pages: 1 })).toBe(
      "more",
    );
    expect(
      await db.prepare("SELECT count(*) AS n FROM repos WHERE repo_id = ?").bind(repoId).first(),
    ).toEqual({ n: 0 });
    expect(await reconcileSource(env, { repoId, shard: "default" }, { pages: 1 })).toBe("done");
    expect(
      await db.prepare("SELECT count(*) AS n FROM repos WHERE repo_id = ?").bind(repoId).first(),
    ).toEqual({ n: 1 });
  });

  it("charges every row search's work writes, its own bookkeeping included", async () => {
    const repoId = await repository();
    const seen = { calls: 0, written: 0, read: 0 };
    expect(
      await reconcileSource(clocked(Number.POSITIVE_INFINITY, seen), { repoId, shard: "default" }),
    ).toBe("done");
    const charged = await budget();
    // At least what was written and read; at most a few rows of each settling's allowance more.
    expect(charged?.rows ?? 0).toBeGreaterThanOrEqual(seen.written);
    expect(charged?.rows ?? 0).toBeLessThanOrEqual(seen.written + 2 * 5);
    expect(charged?.reads ?? 0).toBeGreaterThanOrEqual(seen.read);
  });

  it("looks at the size again when the one held is at the threshold, so a database that shrank is let through", async () => {
    await db
      .prepare("UPDATE search_size SET bytes = ? WHERE id = 1")
      .bind(ADMISSION.maxBytes)
      .run();
    const seen = { calls: 0, written: 0 };
    const taken = await reserve(clocked(Number.POSITIVE_INFINITY, seen).ORG_READ, {
      rows: 1,
      reads: 1,
    });
    expect(taken).not.toBeNull();
    // Both attempts and the look at the size are its cost.
    expect(taken?.overhead.rows).toBe(seen.written);
    const size = await db
      .prepare("SELECT bytes FROM search_size WHERE id = 1")
      .first<{ bytes: number }>();
    expect(size?.bytes).toBeLessThan(ADMISSION.maxBytes);
  });

  it("removes any source's covered deletions while every source is blocked, not only the first's", async () => {
    const first = await repository();
    const second = await repository();
    for (const id of [first, second])
      expect(await reconcileSource(env, { repoId: id, shard: "default" })).toBe("done");
    // The second holds removable deletions; the first, the oldest need, holds none.
    await db
      .prepare(
        `INSERT INTO search_docs (repo_id, number, kind, deleted, deleted_epoch, deleted_seq,
           epoch_gen, owner_gen, version, updated_seq) VALUES (?, 90, 1, 1, 0, 1, 0, 1, 1, 1)`,
      )
      .bind(second)
      .run();
    await db.prepare("DELETE FROM search_repairs").run();
    await repairStatement(db, first, "backfill", 1).run();
    await repairStatement(db, second, "backfill", 2).run();
    await env.DIRECTORY.prepare(
      "INSERT INTO deployment_settings (name, value, updated_at) VALUES ('search_indexing', 'on', 0)",
    ).run();
    await db
      .prepare("UPDATE search_budget SET rows = ? WHERE day = ?")
      .bind(ADMISSION.dailyRows, await today())
      .run();
    expect(await runSearchRepairs(env)).toEqual({ worked: 1 });
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM search_docs WHERE repo_id = ? AND number = 90")
        .bind(second)
        .first(),
    ).toEqual({ n: 0 });
  });

  it("removes what is gone while the database is at its size threshold, adds nothing, and covers no repair", async () => {
    const repoId = await repository();
    expect(await reconcileSource(env, { repoId, shard: "default" })).toBe("done");
    const { cutoff_epoch: epoch } = (await db
      .prepare("SELECT cutoff_epoch FROM search_sources WHERE repo_id = ?")
      .bind(repoId)
      .first<{ cutoff_epoch: number }>()) ?? { cutoff_epoch: 0 };
    // Live rows of issues the repository no longer has (their deletions lost).
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 50 UNION ALL SELECT i + 1 FROM n WHERE i < 59)
         INSERT INTO search_docs (repo_id, number, kind, state, open_state, title, body,
           created_at, updated_at, epoch_gen, owner_gen, version, updated_seq)
         SELECT ?1, i, 1, 1, 1, 'Stale', 'text', 0, 0, ?2, 1, 1, 1 FROM n`,
      )
      .bind(repoId, epoch)
      .run();
    // And an issue the projection does not have yet.
    await db.prepare("DELETE FROM search_docs WHERE repo_id = ? AND number = 1").bind(repoId).run();
    await repairStatement(db, repoId, "lost", 1).run();
    const threshold = ADMISSION.maxBytes;
    ADMISSION.maxBytes = 1;
    try {
      expect(await reconcileSource(env, { repoId, shard: "default" }, { pages: 10 })).toBe("done");
    } finally {
      ADMISSION.maxBytes = threshold;
    }
    const docs = await db
      .prepare("SELECT number, deleted FROM search_docs WHERE repo_id = ? ORDER BY number")
      .bind(repoId)
      .all<{ number: number; deleted: number }>();
    // The stale ones marked deleted (then removed, covered); issue 1 not added.
    expect(docs.results.filter((d) => d.deleted === 0)).toEqual([]);
    expect(docs.results.some((d) => d.number === 1)).toBe(false);
    // A partial pass covers nothing: a whole one follows once there is room.
    expect(
      await db
        .prepare("SELECT dirty, covered FROM search_repairs WHERE repo_id = ?")
        .bind(repoId)
        .first(),
    ).toEqual({ dirty: 1, covered: 0 });
    expect(await reconcileSource(env, { repoId, shard: "default" })).toBe("done");
    expect(
      await db
        .prepare("SELECT dirty, covered FROM search_repairs WHERE repo_id = ?")
        .bind(repoId)
        .first(),
    ).toEqual({ dirty: 1, covered: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM search_docs WHERE repo_id = ? AND number = 1 AND deleted = 0",
        )
        .bind(repoId)
        .first(),
    ).toEqual({ n: 1 });
  });

  it("sweeps covered deletions across sources a bounded number at a time, passing over uncovered ones", async () => {
    const page = RECONCILE_POLICY.collectPage;
    RECONCILE_POLICY.collectPage = 20;
    try {
      await db.prepare("DELETE FROM search_sweep").run();
      // Source A (first in the index's order): many deletions its cutoff does not cover yet.
      const a = `rep_${"0".repeat(20)}a${uniqueId("x").slice(-6)}`;
      const b = `rep_${"z".repeat(20)}b${uniqueId("x").slice(-6)}`;
      await db.batch([
        db
          .prepare(
            "INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq) VALUES (?, 1, 1)",
          )
          .bind(a),
        db
          .prepare(
            "INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq) VALUES (?, 1, 100)",
          )
          .bind(b),
        db
          .prepare(
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
             INSERT INTO search_docs (repo_id, number, kind, deleted, deleted_epoch, deleted_seq,
               epoch_gen, owner_gen, version, updated_seq)
             SELECT ?, i, 1, 1, 1, 50, 1, 1, 1, 1 FROM n`,
          )
          .bind(a),
        // Source B: one its cutoff covers.
        db
          .prepare(
            `INSERT INTO search_docs (repo_id, number, kind, deleted, deleted_epoch, deleted_seq,
               epoch_gen, owner_gen, version, updated_seq) VALUES (?, 1, 1, 1, 1, 50, 1, 1, 1, 1)`,
          )
          .bind(b),
      ]);
      const left = async () =>
        (
          await db
            .prepare("SELECT count(*) AS n FROM search_docs WHERE repo_id = ?")
            .bind(b)
            .first<{ n: number }>()
        )?.n;
      let sweeps = 0;
      while ((await left()) !== 0 && sweeps < 20) {
        const seen = { calls: 0, written: 0, read: 0 };
        await sweepTombstones(clocked(Number.POSITIVE_INFINITY, seen).ORG_READ);
        sweeps++;
        // Each sweep reads about its page of each table, not every deletion there is.
        expect(seen.read).toBeLessThan(3 * 20 * 4);
      }
      expect(await left()).toBe(0);
      // A's 100 at 20 a sweep, then B's: within a few sweeps, and A's still there.
      expect(sweeps).toBeLessThanOrEqual(7);
      expect(
        await db.prepare("SELECT count(*) AS n FROM search_docs WHERE repo_id = ?").bind(a).first(),
      ).toEqual({ n: 100 });
    } finally {
      RECONCILE_POLICY.collectPage = page;
    }
  });

  it("removes only what is still the deletion it saw, when its row id is reused meanwhile", async () => {
    const [a, b] = [uniqueId("rep"), uniqueId("rep")];
    const docId = 9_000_000 + Math.floor(Math.random() * 1_000_000);
    await db.batch([
      db
        .prepare(
          "INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq) VALUES (?, 1, 100)",
        )
        .bind(a),
      db
        .prepare(
          `INSERT INTO search_docs (doc_id, repo_id, number, kind, deleted, deleted_epoch,
             deleted_seq, epoch_gen, owner_gen, version, updated_seq)
           VALUES (?, ?, 1, 1, 1, 1, 50, 1, 1, 1, 1)`,
        )
        .bind(docId, a),
    ]);
    let looked = false;
    // Between the sweep's look and its removal: A's deletion goes (its repository's cleanup),
    // and B's live document takes its row id.
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch")
          return async (batch: D1PreparedStatement[]) => {
            const results = await target.batch(batch);
            if (!looked) {
              looked = true;
              await target.batch([
                target.prepare("DELETE FROM search_docs WHERE doc_id = ?").bind(docId),
                target
                  .prepare(
                    `INSERT INTO search_docs (doc_id, repo_id, number, kind, deleted, state,
                       open_state, title, created_at, updated_at, epoch_gen, owner_gen, version,
                       updated_seq) VALUES (?, ?, 1, 1, 0, 1, 1, 'live', 0, 0, 1, 1, 1, 1)`,
                  )
                  .bind(docId, b),
              ]);
            }
            return results;
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await sweepTombstones(racing);
    expect(looked).toBe(true);
    expect(
      await db
        .prepare("SELECT repo_id, deleted FROM search_docs WHERE doc_id = ?")
        .bind(docId)
        .first(),
    ).toEqual({ repo_id: b, deleted: 0 });
  });

  it("reads only the deletions it removes, however many the cutoff does not cover yet", async () => {
    const repoId = uniqueId("rep");
    await db.batch([
      db
        .prepare("INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq) VALUES (?, 1, 1)")
        .bind(repoId),
      db
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
           INSERT INTO search_docs (repo_id, number, kind, deleted, deleted_epoch, deleted_seq,
             epoch_gen, owner_gen, version, updated_seq)
           SELECT ?, i, 1, 1, 1, 50, 1, 1, 1, 1 FROM n`,
        )
        .bind(repoId),
    ]);
    const seen = { calls: 0, written: 0, read: 0 };
    expect(await collectTombstones(clocked(Number.POSITIVE_INFINITY, seen).ORG_READ, repoId)).toBe(
      0,
    );
    expect(seen.read).toBeLessThan(50);
  });

  it("reads a bounded number of rows a sweep, even at the end of a long run of tied deletions", async () => {
    const page = RECONCILE_POLICY.collectPage;
    RECONCILE_POLICY.collectPage = 20;
    try {
      await db.prepare("DELETE FROM search_sweep").run();
      const repoId = `rep_${"0".repeat(20)}c${uniqueId("x").slice(-6)}`;
      await db.batch([
        db
          .prepare(
            "INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq) VALUES (?, 1, 1)",
          )
          .bind(repoId),
        db
          .prepare(
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
             INSERT INTO search_docs (repo_id, number, kind, deleted, deleted_epoch, deleted_seq,
               epoch_gen, owner_gen, version, updated_seq)
             SELECT ?, i, 1, 1, 1, 50, 1, 1, 1, 1 FROM n`,
          )
          .bind(repoId),
      ]);
      // The sweep's place: the 980th of them.
      const near = await db
        .prepare(
          "SELECT rowid AS row FROM search_docs WHERE repo_id = ? ORDER BY rowid LIMIT 1 OFFSET 979",
        )
        .bind(repoId)
        .first<{ row: number }>();
      await db
        .prepare(
          `INSERT INTO search_sweep (name, repo_id, deleted_epoch, deleted_seq, row)
           VALUES ('search_docs', ?, 1, 50, ?)`,
        )
        .bind(repoId, near?.row)
        .run();
      const seen = { calls: 0, written: 0, read: 0 };
      await sweepTombstones(clocked(Number.POSITIVE_INFINITY, seen).ORG_READ);
      expect(seen.read).toBeLessThan(4 * 20 * 3 + 50);
    } finally {
      RECONCILE_POLICY.collectPage = page;
    }
  });
});
