// Search's reconciliation of a source with its repository: a pass sets the
// source's cutoff at the export's position first, then walks the export beside
// the projection writing only differences, marks rows the export lacks deleted
// (unless an event after it wrote them), and collects the deletions its cutoff
// covers. A superseded pass writes nothing; a restore or transfer meanwhile
// starts another.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { ExportPage, ExportPageRequest } from "../src/do/repo/export.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { epochStatement } from "../src/queues/events-consumer.js";
import { withReadModel } from "../src/read-model/executor.js";
import { ADMISSION } from "../src/search/admission.js";
import { RECONCILE_POLICY, reconcileSource } from "../src/search/reconcile.js";
import { repairStatement } from "../src/search/repairs.js";
import { docStatements, labelStatement } from "../src/search/statements.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

/**
 * An issue's statement group, run in one batch as production runs it;
 * `changes` whether its row changed (D1's own count takes in the full-text
 * index's work).
 */
const docStatement = (...args: Parameters<typeof docStatements>) => ({
  run: async () => {
    const [db, position, entity] = args;
    const row = () =>
      db
        .prepare("SELECT * FROM search_docs WHERE repo_id = ? AND number = ?")
        .bind(position.repoId, Number(entity.id.slice(entity.id.lastIndexOf("#") + 1)))
        .first();
    const before = JSON.stringify(await row());
    await db.batch(docStatements(...args));
    return { meta: { changes: JSON.stringify(await row()) === before ? 0 : 1 } };
  },
});

const fx = inject("pushFixtures");
// Written as production writes it: through the read model's executor.
const db = readModelFor(env, DEFAULT_ORG_SHARD);

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const stub = () => env.REPO.getByName(repo.id);
const target = () => ({ repoId: repo.id, shard: "default" });

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  const pushTarget: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    pushTarget,
    pushBody(
      [
        { old: ZERO, new: fx.c1, ref: "refs/heads/main" },
        { old: ZERO, new: fx.c2, ref: "refs/heads/feature" },
      ],
      { pack: fx.packC2 },
    ),
  );
  expect(pushed.status).toBe(200);
});

async function call(method: string, route: string, body?: unknown): Promise<void> {
  const res = await api(method, `${path}${route}`, owner.token, body);
  expect(res.status, `${method} ${route}`).toBeLessThan(300);
}

/** Where the repository's events stand now. */
async function position() {
  const page = (await stub().exportPage({ kind: "repo", after: 0, limit: 1 })) as unknown as {
    epochGen: number;
    ownerGen: number;
    watermark: number;
  };
  return page;
}

const docs = async () =>
  (
    await db
      .prepare(
        `SELECT number, kind, deleted, title, deleted_epoch, deleted_seq, updated_seq
         FROM search_docs WHERE repo_id = ? ORDER BY number`,
      )
      .bind(repo.id)
      .all<Record<string, unknown>>()
  ).results;

const count = async (table: string) =>
  (
    await db
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE repo_id = ?`)
      .bind(repo.id)
      .first<{ n: number }>()
  )?.n;

const cutoff = () =>
  db
    .prepare("SELECT cutoff_epoch, cutoff_seq FROM search_sources WHERE repo_id = ?")
    .bind(repo.id)
    .first<{ cutoff_epoch: number; cutoff_seq: number }>();

/** `env` whose org read model records each page's batch statement count. */
function recording(batches: number[]): Env {
  const org = new Proxy(env.ORG_READ, {
    get(target, prop) {
      if (prop === "batch")
        return (statements: D1PreparedStatement[]) => {
          // A page's batch (its checkpoint among them): its statement count.
          const sql = statements.map((s) => (s as unknown as { statement: string }).statement);
          if (sql.some((q) => q.includes("UPDATE search_reconciles SET kind")))
            batches.push(statements.length);
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

/** `env` whose repository object's exports are counted, and `onFirst` runs after the first. */
function watched(calls: { n: number }, onFirst?: () => Promise<void>): Env {
  const stubs = new Proxy(env.REPO, {
    get(target, prop) {
      if (prop !== "getByName") {
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (name: string) => {
        const real = target.getByName(name);
        return {
          exportPage: async (request: ExportPageRequest) => {
            const page = await real.exportPage(request);
            calls.n++;
            if (calls.n === 1) await onFirst?.();
            return page;
          },
        };
      };
    },
  });
  return new Proxy(env, {
    get: (target, prop) => (prop === "REPO" ? stubs : Reflect.get(target, prop)),
  });
}

/** The database's own UTC day. */
const today = async () =>
  (await db.prepare("SELECT CAST(unixepoch() / 86400 AS INTEGER) AS d").first<{ d: number }>())
    ?.d ?? 0;

const repairStateOf = (repoId: string) =>
  db.prepare("SELECT dirty, covered FROM search_repairs WHERE repo_id = ?").bind(repoId).first();

describe("search reconciliation", () => {
  it("brings the projection to the repository's state, its cutoff set at the export's position", async () => {
    await call("POST", "/issues", { title: "One" });
    await call("POST", "/pulls", { title: "Two", head: "feature", base: "main" });
    await call("POST", "/issues", { title: "Three" });
    await call("DELETE", "/issues/3");
    await call("POST", "/milestones", { title: "v1" });
    const at = await position();

    expect(await reconcileSource(env, target())).toBe("done");

    // Three's tombstone had nothing projected: it writes nothing.
    expect(await docs()).toMatchObject([
      { number: 1, kind: 1, deleted: 0, title: "One" },
      { number: 2, kind: 2, deleted: 0, title: "Two" },
    ]);
    expect(await count("search_labels")).toBe(9);
    expect(await count("search_milestones")).toBe(1);
    expect(await cutoff()).toEqual({ cutoff_epoch: at.epochGen, cutoff_seq: at.watermark });
    expect(
      await db.prepare("SELECT name FROM repos WHERE repo_id = ?").bind(repo.id).first(),
    ).toEqual({ name: repo.name });
    expect(
      await db
        .prepare("SELECT gen, kind FROM search_reconciles WHERE repo_id = ?")
        .bind(repo.id)
        .first(),
    ).toEqual({ gen: 1, kind: "done" });
  });

  it("writes nothing for rows that already match", async () => {
    await call("POST", "/issues", { title: "One" });
    await call("POST", "/milestones", { title: "v1" });
    expect(await reconcileSource(env, target())).toBe("done");
    const batches: number[] = [];
    expect(await reconcileSource(recording(batches), target())).toBe("done");
    // Each kind's page: its checkpoint alone; then the repository's own row (its epoch and its
    // fourteen statements, its index entry with it) with the last checkpoint and the revision
    // covered; each batch between the executor's opening and closing of admission.
    expect(batches).toEqual([1, 1, 1, 17].map((n) => n + 2));
  });

  it("marks deleted what the export lacks, unless an event after it began wrote it", async () => {
    await call("POST", "/issues", { title: "One" });
    expect(await reconcileSource(env, target())).toBe("done");
    const { cutoff_epoch: epoch } = (await cutoff()) ?? { cutoff_epoch: 0 };
    // Rows the repository does not have: one from before (lost deletion), one an event
    // after the next export's start wrote (kept: its own event will be followed).
    await db
      .prepare(
        `INSERT INTO search_docs (repo_id, number, kind, state, open_state, title, created_at,
           updated_at, epoch_gen, owner_gen, version, updated_seq)
         VALUES (?1, 40, 1, 1, 1, 'Lost', 0, 0, ?2, 1, 1, 1),
                (?1, 41, 1, 1, 1, 'Later', 0, 0, ?2, 1, 1, 9000000)`,
      )
      .bind(repo.id, epoch)
      .run();
    await db
      .prepare(
        `INSERT INTO search_labels (repo_id, label_id, name, color, epoch_gen, owner_gen, version,
           updated_seq) VALUES (?, 99, 'gone', 'ffffff', ?, 1, 1, 1)`,
      )
      .bind(repo.id, epoch)
      .run();

    expect(await reconcileSource(env, target())).toBe("done");
    const after = await docs();
    // Forty marked deleted at the export's position, then collected (the cutoff covers it).
    expect(after.map((d) => [d.number, d.deleted, d.title])).toEqual([
      [1, 0, "One"],
      [41, 0, "Later"],
    ]);
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM search_labels WHERE repo_id = ? AND label_id = 99")
        .bind(repo.id)
        .first(),
    ).toEqual({ n: 0 });
  });

  it("refuses an event its cutoff covers, and admits one after it", async () => {
    await call("POST", "/issues", { title: "One" });
    expect(await reconcileSource(env, target())).toBe("done");
    const at = (await cutoff()) ?? { cutoff_epoch: 0, cutoff_seq: 0 };
    const edit = (sourceSeq: number, title: string, version: number) =>
      docStatement(
        db,
        { repoId: repo.id, epochGen: at.cutoff_epoch, ownerGen: 1, sourceSeq },
        {
          type: "issue",
          id: `${repo.id}#1`,
          version,
          deleted: false,
          row: {
            number: 1,
            title,
            body: null,
            state: "open",
            stateReason: null,
            duplicateOf: null,
            locked: false,
            lockReason: null,
            authorId: owner.principalId,
            authorRoot: owner.principalId,
            closedAt: null,
            closedBy: null,
            createdAt: 1,
            updatedAt: 2,
            labels: [],
            assignees: [],
            milestone: null,
          },
        },
      ).run();
    // A delayed edit the export already carried (or superseded): refused, whatever its version.
    expect((await edit(at.cutoff_seq, "Delayed", 99)).meta.changes).toBe(0);
    expect((await edit(at.cutoff_seq + 1, "Later", 99)).meta.changes).toBe(1);
    expect((await docs())[0]?.title).toBe("Later");
  });

  it("collects a deletion the cutoff covers, keeps one of unknown position, and nothing comes back", async () => {
    await call("POST", "/issues", { title: "One" });
    await call("POST", "/issues", { title: "Two" });
    expect(await reconcileSource(env, target())).toBe("done");
    await call("DELETE", "/issues/2");
    // A deletion the projection holds with no known position stays.
    await db
      .prepare(
        `INSERT INTO search_docs (repo_id, number, kind, deleted, epoch_gen, owner_gen, version,
           updated_seq) VALUES (?, 77, 1, 1, 1, 1, 1, 1)`,
      )
      .bind(repo.id)
      .run();

    expect(await reconcileSource(env, target())).toBe("done");
    // Two's deletion was projected (its export's tombstone carries where it is), then collected.
    expect((await docs()).map((d) => [d.number, d.deleted])).toEqual([
      [1, 0],
      [77, 1],
    ]);
    const at = (await cutoff()) ?? { cutoff_epoch: 0, cutoff_seq: 0 };
    // Two's creation, delivered late: before the cutoff, refused.
    const late = await docStatement(
      db,
      { repoId: repo.id, epochGen: at.cutoff_epoch, ownerGen: 1, sourceSeq: 2 },
      {
        type: "issue",
        id: `${repo.id}#2`,
        version: 1,
        deleted: false,
        row: {
          number: 2,
          title: "Two",
          body: null,
          state: "open",
          stateReason: null,
          duplicateOf: null,
          locked: false,
          lockReason: null,
          authorId: owner.principalId,
          authorRoot: owner.principalId,
          closedAt: null,
          closedBy: null,
          createdAt: 1,
          updatedAt: 1,
          labels: [],
          assignees: [],
          milestone: null,
        },
      },
    ).run();
    expect(late.meta.changes).toBe(0);
  });

  it("goes a page a call, resuming where it stopped", async () => {
    await call("POST", "/issues", { title: "One" });
    const kind = async () =>
      (
        await db
          .prepare("SELECT kind FROM search_reconciles WHERE repo_id = ?")
          .bind(repo.id)
          .first<{ kind: string }>()
      )?.kind;
    expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
    expect(await kind()).toBe("subjects");
    expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
    expect(await kind()).toBe("labels");
    expect(await count("search_docs")).toBe(1);
    expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
    expect(await kind()).toBe("milestones");
    // The walk through, the repository's own row is the last step, a page of its own.
    expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
    expect(await kind()).toBe("milestones");
    expect(await reconcileSource(env, target(), { pages: 1 })).toBe("done");
    expect(await kind()).toBe("done");
  });

  it("starts another pass when the repository's ownership moves meanwhile, and the old one writes nothing", async () => {
    await call("POST", "/issues", { title: "One" });
    expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
    const { gen: first } = (await db
      .prepare("SELECT gen FROM search_reconciles WHERE repo_id = ?")
      .bind(repo.id)
      .first<{ gen: number }>()) ?? { gen: 0 };
    // A transfer moved it on: the next page is stale, and a pass starts at the new ownership.
    await runInDurableObject(stub(), (_: RepoDO, state) => {
      state.storage.sql.exec("UPDATE repo_meta SET owner_gen = owner_gen + 1 WHERE id = 1");
    });
    expect(await reconcileSource(env, target(), { pages: 10 })).toBe("done");
    const pass = await db
      .prepare(
        "SELECT gen, epoch_gen, owner_gen, watermark, kind FROM search_reconciles WHERE repo_id = ?",
      )
      .bind(repo.id)
      .first<{
        gen: number;
        epoch_gen: number;
        owner_gen: number;
        watermark: number;
        kind: string;
      }>();
    expect(pass).toMatchObject({ gen: first + 1, kind: "done" });
    expect((await docs()).map((d) => d.number)).toEqual([1]);

    // A pass's write is admitted only while that pass is the source's: the same write at the
    // current pass's position, under the first pass's generation, is refused.
    const day = await today();
    const write = (gen: number) =>
      docStatement(
        db,
        {
          repoId: repo.id,
          epochGen: pass?.epoch_gen ?? 0,
          ownerGen: pass?.owner_gen ?? 0,
          sourceSeq: pass?.watermark ?? 0,
        },
        {
          type: "issue",
          id: `${repo.id}#5`,
          version: 1,
          deleted: false,
          row: {
            number: 5,
            title: "Late",
            body: null,
            state: "open",
            stateReason: null,
            duplicateOf: null,
            locked: false,
            lockReason: null,
            authorId: owner.principalId,
            authorRoot: owner.principalId,
            closedAt: null,
            closedBy: null,
            createdAt: 1,
            updatedAt: 1,
            labels: [],
            assignees: [],
            milestone: null,
          },
        },
        { by: "reconcile", gen, kind: "subjects", after: 0, day },
      ).run();
    // (While a pass is under way.)
    await db
      .prepare("UPDATE search_reconciles SET kind = 'subjects' WHERE repo_id = ?")
      .bind(repo.id)
      .run();
    expect((await write(first)).meta.changes).toBe(0);
    expect((await write(first + 1)).meta.changes).toBe(1);
  });

  it("keeps a deletion made after the pass began, so the entity's earlier events find it deleted", async () => {
    expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
    const start = (await cutoff()) ?? { cutoff_epoch: 0, cutoff_seq: 0 };
    // Made and deleted after the export's position, before its page is read.
    await call("POST", "/issues", { title: "Fleeting" });
    await call("DELETE", "/issues/1");
    expect(await reconcileSource(env, target())).toBe("done");
    const [kept] = await docs();
    expect(kept).toMatchObject({ number: 1, deleted: 1, title: null });
    expect(Number(kept?.deleted_seq)).toBeGreaterThan(start.cutoff_seq);
    // Its creation, delivered late (after the cutoff, before the deletion): refused.
    const late = await docStatement(
      db,
      {
        repoId: repo.id,
        epochGen: start.cutoff_epoch,
        ownerGen: 1,
        sourceSeq: start.cutoff_seq + 1,
      },
      {
        type: "issue",
        id: `${repo.id}#1`,
        version: 1,
        deleted: false,
        row: {
          number: 1,
          title: "Fleeting",
          body: null,
          state: "open",
          stateReason: null,
          duplicateOf: null,
          locked: false,
          lockReason: null,
          authorId: owner.principalId,
          authorRoot: owner.principalId,
          closedAt: null,
          closedBy: null,
          createdAt: 1,
          updatedAt: 1,
          labels: [],
          assignees: [],
          milestone: null,
        },
      },
    ).run();
    expect(late.meta.changes).toBe(0);
    expect((await docs())[0]?.deleted).toBe(1);
  });

  it("leaves the pass partial when a deletion's new row is refused its growth", async () => {
    await repairStatement(db, repo.id, "backfill", 1).run();
    expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
    // Made and deleted after the export's position: its page needs the deletion's own row.
    await call("POST", "/issues", { title: "Fleeting" });
    await call("DELETE", "/issues/1");
    // Room for reserving the step's rows, not for its growth (what earlier steps reserved released
    // first, by an observation).
    await withReadModel(env, "default", (readModel) =>
      readModel.prepare("UPDATE search_size SET bytes = bytes WHERE id = 1").run(),
    );
    await db
      .prepare("UPDATE search_size SET bytes = ? WHERE id = 1")
      .bind(ADMISSION.maxBytes - 1)
      .run();
    try {
      // The page that needed it: no row written, and the pass partial from then on (its revision
      // not covered, so a whole pass follows and nothing it did not write can come back unnoticed).
      expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
      expect(await docs()).toEqual([]);
      expect(
        await db
          .prepare("SELECT kind, partial FROM search_reconciles WHERE repo_id = ?")
          .bind(repo.id)
          .first(),
      ).toEqual({ kind: "labels", partial: 1 });
      expect(await reconcileSource(env, target())).toBe("done");
    } finally {
      await db.prepare("UPDATE search_size SET bytes = 0 WHERE id = 1").run();
    }
    expect(await repairStateOf(repo.id)).toMatchObject({ covered: 0 });
  });

  it("marks a label the export lacks deleted where it found it gone, and an earlier change cannot bring it back", async () => {
    await call("POST", "/labels", { name: "transient", color: "123456" });
    expect(await reconcileSource(env, target())).toBe("done");
    const { id } = (await db
      .prepare("SELECT label_id AS id FROM search_labels WHERE repo_id = ? AND name = 'transient'")
      .bind(repo.id)
      .first<{ id: number }>()) ?? { id: 0 };
    expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
    const start = (await cutoff()) ?? { cutoff_epoch: 0, cutoff_seq: 0 };
    // Renamed, then deleted, after the export's position (labels leave no tombstone).
    await call("PATCH", "/labels/transient", { new_name: "renamed" });
    await call("DELETE", "/labels/renamed");
    expect(await reconcileSource(env, target())).toBe("done");
    const gone = await db
      .prepare(
        "SELECT deleted, name, version, deleted_seq FROM search_labels WHERE repo_id = ? AND label_id = ?",
      )
      .bind(repo.id, id)
      .first<{ deleted: number; name: string | null; version: number; deleted_seq: number }>();
    // Found gone after the cutoff: kept (not collected), its version as it was.
    expect(gone).toMatchObject({ deleted: 1, name: null, version: 1 });
    expect(gone?.deleted_seq).toBeGreaterThan(start.cutoff_seq);
    // The rename, delivered late: a later version, but at or before where it was found gone.
    const rename = await labelStatement(
      db,
      {
        repoId: repo.id,
        epochGen: start.cutoff_epoch,
        ownerGen: 1,
        sourceSeq: start.cutoff_seq + 1,
      },
      {
        type: "label",
        id: `${repo.id}#labels/${id}`,
        version: 2,
        deleted: false,
        row: {
          id,
          name: "renamed",
          color: "123456",
          description: null,
          isDefault: false,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    ).run();
    expect(rename.meta.changes).toBe(0);
    // The next pass's cutoff covers it: collected.
    expect(await reconcileSource(env, target())).toBe("done");
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM search_labels WHERE repo_id = ? AND label_id = ?")
        .bind(repo.id, id)
        .first(),
    ).toEqual({ n: 0 });
  });

  it("refuses a page's writes once another caller has worked that page", async () => {
    await call("POST", "/issues", { title: "One" });
    expect(await reconcileSource(env, target(), { pages: 2 })).toBe("more");
    const pass = await db
      .prepare(
        "SELECT gen, epoch_gen, owner_gen, watermark, kind FROM search_reconciles WHERE repo_id = ?",
      )
      .bind(repo.id)
      .first<{
        gen: number;
        epoch_gen: number;
        owner_gen: number;
        watermark: number;
        kind: string;
      }>();
    expect(pass?.kind).toBe("labels");
    // A caller still at the subjects page it read: its writes are refused.
    const stale = await docStatement(
      db,
      {
        repoId: repo.id,
        epochGen: pass?.epoch_gen ?? 0,
        ownerGen: pass?.owner_gen ?? 0,
        sourceSeq: pass?.watermark ?? 0,
      },
      {
        type: "issue",
        id: `${repo.id}#9`,
        version: 1,
        deleted: false,
        row: {
          number: 9,
          title: "Stale",
          body: null,
          state: "open",
          stateReason: null,
          duplicateOf: null,
          locked: false,
          lockReason: null,
          authorId: owner.principalId,
          authorRoot: owner.principalId,
          closedAt: null,
          closedBy: null,
          createdAt: 1,
          updatedAt: 1,
          labels: [],
          assignees: [],
          milestone: null,
        },
      },
      { by: "reconcile", gen: pass?.gen ?? 0, kind: "subjects", after: 0, day: await today() },
    ).run();
    expect(stale.meta.changes).toBe(0);
    expect(await reconcileSource(env, target())).toBe("done");
    expect((await docs()).map((d) => d.number)).toEqual([1]);
  });

  it("does not start a pass its fences refuse, and tries again later", async () => {
    await call("POST", "/issues", { title: "One" });
    // The read model's ownership is ahead of the object's (a transfer landing).
    await db
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 99)")
      .bind(repo.id)
      .run();
    expect(await reconcileSource(env, target())).toBe("more");
    expect(await cutoff()).toBeNull();
    expect(await count("search_reconciles")).toBe(0);
    expect(await count("search_docs")).toBe(0);
  });

  it("compares a page's projection rows a bounded number at a time", async () => {
    await call("POST", "/issues", { title: "One" });
    expect(await reconcileSource(env, target())).toBe("done");
    const { cutoff_epoch: epoch } = (await cutoff()) ?? { cutoff_epoch: 0 };
    // Rows the repository lacks, past its last number: more than a page of them.
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 10 UNION ALL SELECT i + 1 FROM n WHERE i < 16)
         INSERT INTO search_docs (repo_id, number, kind, state, open_state, title, created_at,
           updated_at, epoch_gen, owner_gen, version, updated_seq)
         SELECT ?1, i, 1, 1, 1, 'Orphan', 0, 0, ?2, 1, 1, 1 FROM n`,
      )
      .bind(repo.id, epoch)
      .run();
    const rows = RECONCILE_POLICY.rowsPerPage;
    RECONCILE_POLICY.rowsPerPage = 3;
    try {
      const batches: number[] = [];
      expect(await reconcileSource(recording(batches), target(), { pages: 20 })).toBe("done");
      // The subjects in three pages of at most 3 rows, each its rows the export lacks marked
      // deleted (three statements each: the indexed count, the index entry, the row) and its
      // checkpoint (issue 1, matching, writes nothing), between the executor's opening and
      // closing of admission.
      expect(batches.slice(0, 3)).toEqual([7, 10, 7].map((n) => n + 2));
    } finally {
      RECONCILE_POLICY.rowsPerPage = rows;
    }
    expect((await docs()).map((d) => d.number)).toEqual([1]);
  });

  it("moves an older deletion on to a newer one, so a restored entity deleted again stays deleted", async () => {
    await call("POST", "/issues", { title: "Again" });
    // The projection holds this number's deletion from an earlier epoch (before a restore).
    await db
      .prepare(
        `INSERT INTO search_docs (repo_id, number, kind, deleted, deleted_epoch, deleted_seq,
           epoch_gen, owner_gen, version, updated_seq) VALUES (?, 1, 1, 1, 0, 5, 0, 1, 9, 5)`,
      )
      .bind(repo.id)
      .run();
    expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
    const start = (await cutoff()) ?? { cutoff_epoch: 0, cutoff_seq: 0 };
    // Edited and deleted again after the export's position.
    await call("PATCH", "/issues/1", { title: "Edited" });
    await call("DELETE", "/issues/1");
    expect(await reconcileSource(env, target())).toBe("done");
    const [row] = await docs();
    expect(row).toMatchObject({ number: 1, deleted: 1, deleted_epoch: start.cutoff_epoch });
    expect(Number(row?.deleted_seq)).toBeGreaterThan(start.cutoff_seq);
    // The edit, delivered late: refused.
    const late = await docStatement(
      db,
      {
        repoId: repo.id,
        epochGen: start.cutoff_epoch,
        ownerGen: 1,
        sourceSeq: start.cutoff_seq + 1,
      },
      {
        type: "issue",
        id: `${repo.id}#1`,
        version: 2,
        deleted: false,
        row: {
          number: 1,
          title: "Edited",
          body: null,
          state: "open",
          stateReason: null,
          duplicateOf: null,
          locked: false,
          lockReason: null,
          authorId: owner.principalId,
          authorRoot: owner.principalId,
          closedAt: null,
          closedBy: null,
          createdAt: 1,
          updatedAt: 2,
          labels: [],
          assignees: [],
          milestone: null,
        },
      },
    ).run();
    expect(late.meta.changes).toBe(0);
  });

  it("does not finish a pass its fences start refusing midway, and tries again later", async () => {
    await call("POST", "/issues", { title: "One" });
    expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
    const pass = await db
      .prepare("SELECT owner_gen FROM search_reconciles WHERE repo_id = ?")
      .bind(repo.id)
      .first<{ owner_gen: number }>();
    // A transfer's fence lands in the read model before the repository answers under it.
    await db
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, ?)")
      .bind(repo.id, (pass?.owner_gen ?? 0) + 1)
      .run();
    expect(await reconcileSource(env, target())).toBe("more");
    expect(
      await db
        .prepare("SELECT kind, after FROM search_reconciles WHERE repo_id = ?")
        .bind(repo.id)
        .first(),
    ).toEqual({ kind: "subjects", after: 0 });
    expect(await count("search_docs")).toBe(0);
  });

  it("writes nothing of a finishing step another pass superseded, and does not call it done", async () => {
    await call("PATCH", "", { description: "before" });
    expect(await reconcileSource(env, target())).toBe("done");
    await call("PATCH", "", { description: "after" });
    await repairStatement(db, repo.id, "changed", 2).run();
    // Up to the pass's last step: the repository's own row.
    for (let step = 0; step < 4; step++)
      expect(await reconcileSource(env, target(), { pages: 1 })).toBe("more");
    const pass = await db
      .prepare("SELECT gen, kind, after FROM search_reconciles WHERE repo_id = ?")
      .bind(repo.id)
      .first<{ gen: number; kind: string; after: number }>();
    expect(pass).toMatchObject({ kind: "milestones", after: -1 });
    // Once this step has read the repository, a newer pass takes the source over.
    const stubs = new Proxy(env.REPO, {
      get(target, prop) {
        if (prop !== "getByName") {
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (name: string) => {
          const real = target.getByName(name);
          return {
            exportPage: async (request: ExportPageRequest) => {
              const page = await real.exportPage(request);
              await db
                .prepare(
                  "UPDATE search_reconciles SET gen = gen + 1, kind = 'subjects', after = 0 WHERE repo_id = ?",
                )
                .bind(repo.id)
                .run();
              return page;
            },
          };
        };
      },
    });
    const racing = new Proxy(env, {
      get: (target, prop) => (prop === "REPO" ? stubs : Reflect.get(target, prop)),
    });
    expect(await reconcileSource(racing, target(), { pages: 1 })).toBe("more");
    expect(
      await db.prepare("SELECT description FROM repos WHERE repo_id = ?").bind(repo.id).first(),
    ).toEqual({ description: "before" });
    expect(
      await db
        .prepare("SELECT gen, kind, after FROM search_reconciles WHERE repo_id = ?")
        .bind(repo.id)
        .first(),
    ).toEqual({ gen: (pass?.gen ?? 0) + 1, kind: "subjects", after: 0 });
  });

  it("writes the repository's own row from a snapshot read after the pass took its revision", async () => {
    await call("PATCH", "", { description: "before" });
    await repairStatement(db, repo.id, "backfill", 1).run();
    // Between the pass's first snapshot and its start: the repository changes, and its change
    // asks for a repair (already pending: nothing written).
    let first = true;
    const stubs = new Proxy(env.REPO, {
      get(target, prop) {
        if (prop !== "getByName") {
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (name: string) => {
          const real = target.getByName(name);
          return {
            exportPage: async (request: ExportPageRequest) => {
              const page = await real.exportPage(request);
              if (first) {
                first = false;
                await call("PATCH", "", { description: "after" });
                await repairStatement(db, repo.id, "changed", 2).run();
              }
              return page;
            },
          };
        };
      },
    });
    const racing = new Proxy(env, {
      get: (target, prop) => (prop === "REPO" ? stubs : Reflect.get(target, prop)),
    });
    expect(await reconcileSource(racing, target())).toBe("done");
    expect(
      await db.prepare("SELECT description FROM repos WHERE repo_id = ?").bind(repo.id).first(),
    ).toEqual({ description: "after" });
    expect(await repairStateOf(repo.id)).toEqual({ dirty: 1, covered: 1 });
  });

  it("marks deleted a label whose deletion was asked for before the pass took its revision", async () => {
    await call("POST", "/labels", { name: "racing", color: "123456" });
    expect(await reconcileSource(env, target())).toBe("done");
    await repairStatement(db, repo.id, "backfill", 1).run();
    const id = (
      await db
        .prepare("SELECT label_id AS id FROM search_labels WHERE repo_id = ? AND name = 'racing'")
        .bind(repo.id)
        .first<{ id: number }>()
    )?.id;
    // Between the pass's first snapshot and its start: the label renamed (its event projected),
    // then deleted (its event lost; the repair it asks for is already pending).
    const racing = watched({ n: 0 }, async () => {
      await call("PATCH", "/labels/racing", { new_name: "raced" });
      const labels = (await stub().exportPage({
        kind: "labels",
        after: 0,
        limit: 200,
      })) as unknown as ExportPage;
      const renamed = labels.entities.find((e) => e.id.endsWith(`/${id}`));
      if (!renamed) throw new Error("no label");
      await epochStatement(db, repo.id, labels.epochGen, 0).run();
      await labelStatement(
        db,
        {
          repoId: repo.id,
          epochGen: labels.epochGen,
          ownerGen: labels.ownerGen,
          sourceSeq: labels.watermark,
        },
        renamed,
      ).run();
      await call("DELETE", "/labels/raced");
      await repairStatement(db, repo.id, "lost", 2).run();
    });
    expect(await reconcileSource(racing, target(), { pages: 10 })).toBe("done");
    expect(
      await db
        .prepare("SELECT deleted, name FROM search_labels WHERE repo_id = ? AND label_id = ?")
        .bind(repo.id, id)
        .first(),
    ).toEqual({ deleted: 1, name: null });
    expect(await repairStateOf(repo.id)).toEqual({ dirty: 1, covered: 1 });
  });

  it("reads no more exports a call than its pages", async () => {
    await call("POST", "/issues", { title: "One" });
    const calls = { n: 0 };
    expect(await reconcileSource(watched(calls), target(), { pages: 4 })).toBe("more");
    expect(calls.n).toBe(4);
    expect(await reconcileSource(watched(calls), target(), { pages: 1 })).toBe("done");
    expect(calls.n).toBe(5);
  });
});
