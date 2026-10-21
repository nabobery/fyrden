// A repository object restored from a backup taken before its deletion (or
// part of it): it takes no work as the repository it was, freezes again, and
// its deletion runs again from the start, in a new generation that an earlier
// pass's late checkpoints cannot move.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { epochHooks, readDirectoryEpoch } from "../src/do/repo/epoch.js";
import { allocateEpoch } from "../src/events/epochs.js";
import {
  advanceDeletion,
  advanceDeletions,
  deletionHooks,
  markDeletions,
} from "../src/repos/deletion.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const ORIGIN = "https://fyrden.test";
const fixture = inject("fetchFixtures").single;

let user: { principalId: string; token: string };
let handle: string;

beforeAll(async () => {
  user = await principalWithToken("user", "git");
  handle = user.principalId.toLowerCase().replace("_", "-");
});

afterEach(() => {
  delete epochHooks.beforeRead;
  delete deletionHooks.beforeSave;
});

async function repoWithData() {
  const name = uniqueId("restored");
  const res = await exports.default.fetch(`${ORIGIN}/api/user/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${user.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ name, private: true }),
  });
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: string }>();
  const stub = env.REPO.getByName(id);
  await stub.checkEpoch();
  await loadFixture(stub, fixture);
  return { id, name, stub };
}

const job = (repoId: string) =>
  env.DIRECTORY.prepare(
    `SELECT d.step, d.gen, r.state FROM repo_deletions d JOIN repos r ON r.id = d.repo_id
     WHERE d.repo_id = ?`,
  )
    .bind(repoId)
    .first<{ step: string; gen: number; state: string }>();

const receipts = async (repoId: string) =>
  (
    await env.DIRECTORY.prepare(
      "SELECT cleanup, gen FROM repo_deletion_cleanups WHERE repo_id = ? ORDER BY cleanup",
    )
      .bind(repoId)
      .all<{ cleanup: string; gen: number }>()
  ).results;

/** `env` whose repository objects never erase (their erase fails). */
const neverErasing: Env = new Proxy(env, {
  get(target, prop) {
    if (prop !== "REPO") return Reflect.get(target, prop);
    return new Proxy(target.REPO, {
      get(ns, p) {
        if (p !== "getByName") return Reflect.get(ns, p);
        return (name: string) => {
          const stub = ns.getByName(name);
          return new Proxy(stub, {
            get(s, m) {
              if (m === "eraseForDeletion")
                return () => Promise.reject(new Error("held before the erase"));
              return (...args: unknown[]) =>
                (s as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[m]?.(
                  ...args,
                );
            },
          });
        };
      },
    });
  },
});

/** Deletes `repo` up to its erase (cleanups done), the erase not run. */
async function deletedUpToErase(repo: { id: string; name: string }) {
  await markDeletions(env, [{ id: repo.id, ownerHandle: handle, name: repo.name }], {
    actorId: user.principalId,
  });
  for (let i = 0; i < 10 && (await job(repo.id))?.step !== "erase"; i++)
    await advanceDeletion(neverErasing, repo.id);
  expect(await job(repo.id)).toMatchObject({ step: "erase", gen: 0 });
  expect((await receipts(repo.id)).length).toBeGreaterThan(0);
}

/**
 * The object as restored from before its deletion froze it: not frozen, in
 * the next epoch the restore runbook allocated, in a new instance.
 */
async function restoredFromBefore(stub: DurableObjectStub<RepoDO>, repoId: string) {
  await runInDurableObject(stub, (_: RepoDO, state) => {
    state.storage.sql.exec("UPDATE repo_meta SET deleting_at = NULL, write_frozen = 0");
  });
  await allocateEpoch(env.DIRECTORY, repoId);
  await runInDurableObject(stub, (_: RepoDO, state) => state.abort("restore")).catch(() => {});
  return env.REPO.getByName(repoId);
}

const storageLeft = (stub: DurableObjectStub<RepoDO>) =>
  runInDurableObject(stub, (_: RepoDO, state) =>
    state.storage.sql
      .exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'repo_meta'")
      .one().n === 0
      ? 0
      : state.storage.sql.exec("SELECT count(*) AS n FROM repo_meta").one().n,
  );

describe("a deleted repository's object restored from before its deletion", () => {
  it("answers nothing as the repository, freezes again, and its deletion runs again", async () => {
    const repo = await repoWithData();
    await deletedUpToErase(repo);
    const restored = await restoredFromBefore(repo.stub, repo.id);
    // Its first call, by id (no directory lookup on the way): refused as deleted.
    expect(await restored.readableBy(user.principalId)).toBe(false);
    expect(await inRepo(restored, (r) => r.events.isDeleted())).toBe(true);
    // Reopened from the start, in a new generation; the earlier pass's cleanups count no more.
    expect(await job(repo.id)).toMatchObject({ step: "prepare", gen: 1, state: "deleting" });
    await advanceDeletions(env, { limit: 100 });
    expect(await job(repo.id)).toMatchObject({ step: "done", gen: 1, state: "deleted" });
    expect((await receipts(repo.id)).every((r) => r.gen === 1)).toBe(true);
    expect(await storageLeft(restored)).toBe(0);
  });

  it("is erased again when its deletion had finished", async () => {
    const repo = await repoWithData();
    await deletedUpToErase(repo);
    // As if the erase had run and the deletion finished, the object then restored from a backup.
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare("UPDATE repo_deletions SET step = 'done' WHERE repo_id = ?").bind(
        repo.id,
      ),
      env.DIRECTORY.prepare("UPDATE repos SET state = 'deleted' WHERE id = ?").bind(repo.id),
    ]);
    const restored = await restoredFromBefore(repo.stub, repo.id);
    expect(await restored.readableBy(user.principalId)).toBe(false);
    expect(await job(repo.id)).toMatchObject({ step: "prepare", gen: 1, state: "deleted" });
    await advanceDeletions(env, { limit: 100 });
    expect(await job(repo.id)).toMatchObject({ step: "done", gen: 1, state: "deleted" });
    expect(await storageLeft(restored)).toBe(0);
  });

  it("is reopened once a restore, however many calls find it", async () => {
    const repo = await repoWithData();
    await deletedUpToErase(repo);
    const restored = await restoredFromBefore(repo.stub, repo.id);
    await restored.readableBy(user.principalId);
    await runInDurableObject(restored, (_: RepoDO, state) => state.abort("again")).catch(() => {});
    await env.REPO.getByName(repo.id).readableBy(user.principalId);
    expect(await job(repo.id)).toMatchObject({ step: "prepare", gen: 1 });
  });

  it("lends no fork its packs when that is its first call", async () => {
    const repo = await repoWithData();
    await deletedUpToErase(repo);
    const restored = await restoredFromBefore(repo.stub, repo.id);
    // As the network object asks a parent for a new fork's half (by id, no directory lookup).
    await expect(inRepo(restored, (r) => r.exportForFork("net_holder", 60_000))).rejects.toThrow(
      "deleted",
    );
    expect(await job(repo.id)).toMatchObject({ step: "prepare", gen: 1 });
  });

  it("is erased again when restored from after its freeze, its deletion finished", async () => {
    const repo = await repoWithData();
    await deletedUpToErase(repo);
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare("UPDATE repo_deletions SET step = 'done' WHERE repo_id = ?").bind(
        repo.id,
      ),
      env.DIRECTORY.prepare("UPDATE repos SET state = 'deleted' WHERE id = ?").bind(repo.id),
    ]);
    // The backup already frozen (taken during the deletion, before the erase).
    await allocateEpoch(env.DIRECTORY, repo.id);
    await runInDurableObject(repo.stub, (_: RepoDO, state) => state.abort("restore")).catch(
      () => {},
    );
    const restored = env.REPO.getByName(repo.id);
    expect(await restored.readableBy(user.principalId)).toBe(false);
    expect(await job(repo.id)).toMatchObject({ step: "prepare", gen: 1 });
    await advanceDeletions(env, { limit: 100 });
    expect(await job(repo.id)).toMatchObject({ step: "done", gen: 1 });
    expect(await storageLeft(restored)).toBe(0);
  });

  it("gives a generation from it as a template nothing when that is its first call", async () => {
    const repo = await repoWithData();
    await deletedUpToErase(repo);
    const restored = await restoredFromBefore(repo.stub, repo.id);
    expect(await inRepo(restored, (r) => r.templateTree())).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await job(repo.id)).toMatchObject({ step: "prepare", gen: 1 });
  });

  it("refuses to begin a detach, rather than failing, while the directory cannot be asked", async () => {
    const repo = await repoWithData();
    await allocateEpoch(env.DIRECTORY, repo.id);
    await runInDurableObject(repo.stub, (_: RepoDO, state) => state.abort("restore")).catch(
      () => {},
    );
    epochHooks.beforeRead = () => Promise.reject(new Error("the directory is down"));
    const fresh = env.REPO.getByName(repo.id);
    expect(await inRepo(fresh, (r) => r.beginDetach("net_elsewhere"))).toMatchObject({
      ok: false,
    });
  });

  it("reopens its deletion once, however often the restore's reading is retried", async () => {
    const repo = await repoWithData();
    await deletedUpToErase(repo);
    await allocateEpoch(env.DIRECTORY, repo.id);
    const metrics = { count() {} } as unknown as Parameters<typeof readDirectoryEpoch>[1];
    // As if the object failed to take the epoch after each reading.
    for (let i = 0; i < 2; i++)
      expect(await readDirectoryEpoch(env, metrics, repo.id, 1, Date.now())).toMatchObject({
        deleted: true,
      });
    expect(await job(repo.id)).toMatchObject({ step: "prepare", gen: 1 });
  });

  it("runs no job and answers no read while the directory cannot be asked", async () => {
    const repo = await repoWithData();
    await deletedUpToErase(repo);
    const restored = await restoredFromBefore(repo.stub, repo.id);
    // A background job due now, as the restored storage may hold one.
    const queued = await runInDurableObject(restored, (_: RepoDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO jobs (job_id, kind, state, next_run_at, created_at, updated_at)
         VALUES ('restored-job', 'feed_pages_prune', 'queued', ?1, ?1, ?1)`,
        Date.now(),
      );
      return "restored-job";
    });
    epochHooks.beforeRead = () => Promise.reject(new Error("the directory is down"));
    await runDurableObjectAlarm(restored);
    const state = () =>
      runInDurableObject(
        restored,
        (_: RepoDO, storage) =>
          storage.storage.sql
            .exec<{ state: string }>("SELECT state FROM jobs WHERE job_id = ?", queued)
            .one().state,
      );
    expect(await state()).toBe("queued");
    await expect(inRepo(restored, (r) => r.hookForDelivery(1))).rejects.toThrow(
      "the directory is down",
    );
    delete epochHooks.beforeRead;
    await runDurableObjectAlarm(restored);
    // Frozen: the job is stopped, not run.
    expect(await state()).toBe("failed");
    expect(await job(repo.id)).toMatchObject({ step: "prepare", gen: 1 });
  });
});

describe("a deletion checkpoint", () => {
  /** Holds the earlier pass's `erase → done` until `meanwhile` ran. */
  const holdingDone = (meanwhile: () => Promise<unknown>) => {
    deletionHooks.beforeSave = async (from, to) => {
      if (from !== "erase" || to !== "done") return;
      delete deletionHooks.beforeSave;
      await meanwhile();
    };
  };

  it("of an earlier pass is refused once the deletion was reopened and came back to the erase", async () => {
    const repo = await repoWithData();
    await deletedUpToErase(repo);
    holdingDone(() =>
      env.DIRECTORY.prepare(
        "UPDATE repo_deletions SET gen = gen + 1, step = 'erase' WHERE repo_id = ?",
      )
        .bind(repo.id)
        .run(),
    );
    expect(await advanceDeletion(env, repo.id)).toBe("deleting");
    expect(await job(repo.id)).toMatchObject({ step: "erase", gen: 1, state: "deleting" });
  });

  it("of an earlier pass that erased leaves the reopened deletion to run from the start", async () => {
    const repo = await repoWithData();
    await deletedUpToErase(repo);
    // The earlier pass's erase ran; a restore reopened the deletion before it recorded it.
    holdingDone(() =>
      env.DIRECTORY.prepare(
        "UPDATE repo_deletions SET gen = gen + 1, step = 'prepare' WHERE repo_id = ?",
      )
        .bind(repo.id)
        .run(),
    );
    expect(await advanceDeletion(env, repo.id)).toBe("deleting");
    expect(await job(repo.id)).toMatchObject({ step: "prepare", gen: 1, state: "deleting" });
    // The new pass finds the object erased already, and finishes.
    expect(await advanceDeletion(env, repo.id)).toBe("deleted");
    expect(await job(repo.id)).toMatchObject({ step: "done", gen: 1, state: "deleted" });
  });
});
