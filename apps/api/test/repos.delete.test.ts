import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { advanceDeletion, advanceDeletions, markDeletions } from "../src/repos/deletion.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { basic, type TestRepo } from "./helpers/git-http.js";
import {
  cloneObjects,
  fork,
  inNetwork,
  type Owner,
  runDetach,
  runNetworkJob,
} from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const ORIGIN = "https://fyrden.test";
const fixture = inject("fetchFixtures").single;

let user: Owner;
let handle: string;

beforeAll(async () => {
  user = await principalWithToken("user", "git");
  handle = user.principalId.toLowerCase().replace("_", "-");
});

function api(method: string, path: string, body?: unknown, token = user.token) {
  return exports.default.fetch(`${ORIGIN}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method !== "GET" && { "Idempotency-Key": crypto.randomUUID() }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/** A repository created through the API (so it has an identity and events), holding the fixture. */
async function repoWithData(name = uniqueId("doomed")): Promise<TestRepo & { networkId: string }> {
  const res = await api("POST", "/user/repos", { name });
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: string }>();
  const stub = env.REPO.getByName(id);
  await stub.checkEpoch();
  await loadFixture(stub, fixture);
  const networkId = await inRepo(stub, ({ git }) => git.networkId());
  return { id, name, stub, networkId };
}

const remove = (name: string, token = user.token) =>
  api("DELETE", `/repos/${handle}/${name}`, undefined, token);

async function keysUnder(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    if (!page.truncated) return keys.sort();
    cursor = page.cursor;
  }
}

/** The repository's audit rows archived to R2, as parsed NDJSON lines. */
async function archivedAudit(repoId: string): Promise<{ action: string }[]> {
  const rows: { action: string }[] = [];
  for (const key of await keysUnder(env.ASSETS, "audit/")) {
    if (!key.includes(repoId)) continue;
    const text = await (await env.ASSETS.get(key))?.text();
    for (const line of text?.split("\n") ?? []) if (line) rows.push(JSON.parse(line));
  }
  return rows;
}

function deletionRow(repoId: string) {
  return env.DIRECTORY.prepare(
    `SELECT d.step, d.attempts, d.last_error, r.state FROM repo_deletions d
     JOIN repos r ON r.id = d.repo_id WHERE d.repo_id = ?`,
  )
    .bind(repoId)
    .first<{ step: string; attempts: number; last_error: string | null; state: string }>();
}

function readModelRow(repoId: string) {
  return env.ORG_READ.prepare("SELECT deleted, name FROM repos WHERE repo_id = ?")
    .bind(repoId)
    .first<{ deleted: number; name: string | null }>();
}

/** Rows left in the repository object's storage (a table its deletion dropped has none). */
function storageLeft(stub: DurableObjectStub<RepoDO>) {
  return runInDurableObject(stub, (_: RepoDO, state) => {
    const rows = (table: string) => {
      const exists = state.storage.sql
        .exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", table)
        .one().n;
      return exists ? state.storage.sql.exec(`SELECT count(*) AS n FROM ${table}`).one().n : 0;
    };
    return { meta: rows("repo_meta"), git: rows("git_meta"), packs: rows("packs") };
  });
}

/** `env` with the repository object of `repoId` failing `method` once. */
function failingOnce(repoId: string, method: keyof RepoDO): Env {
  let failed = false;
  const real = env.REPO;
  const ns = new Proxy(real, {
    get(target, prop) {
      if (prop !== "getByName") return Reflect.get(target, prop);
      return (name: string) => {
        const stub = target.getByName(name);
        if (name !== repoId) return stub;
        return new Proxy(stub, {
          get(s, p) {
            if (p === method && !failed) {
              failed = true;
              return () => Promise.reject(new Error(`${String(method)} failed`));
            }
            return (...args: unknown[]) =>
              (s as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[p]?.(...args);
          },
        });
      };
    },
  });
  return new Proxy(env, {
    get: (target, prop) => (prop === "REPO" ? ns : Reflect.get(target, prop)),
  });
}

describe("repos.delete", () => {
  it("deletes a repository: gone at once, then its data, bytes and storage; the name is free", async () => {
    const repo = await repoWithData();
    // An archive of it too, whose segments must go with it.
    const archive = await api("GET", `/repos/${handle}/${repo.name}/tarball`);
    expect(archive.status).toBe(200);
    await archive.arrayBuffer();
    expect((await keysUnder(env.GIT, `net/${repo.networkId}/scratch/`)).length).toBeGreaterThan(0);
    expect(await keysUnder(env.GIT, `net/${repo.networkId}/`)).not.toEqual([]);

    const res = await remove(repo.name);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: repo.id,
      full_name: `${handle}/${repo.name}`,
      state: "deleted",
    });

    expect((await api("GET", `/repos/${handle}/${repo.name}`)).status).toBe(404);
    const lsRefs = await exports.default.fetch(
      `${ORIGIN}/${handle}/${repo.name}.git/info/refs?service=git-upload-pack`,
      { headers: { Authorization: basic(user.token), "Git-Protocol": "version=2" } },
    );
    expect(lsRefs.status).toBe(404);
    expect(await deletionRow(repo.id)).toMatchObject({ step: "done", state: "deleted" });
    expect(await readModelRow(repo.id)).toMatchObject({ deleted: 1 });
    expect(await keysUnder(env.GIT, `net/${repo.networkId}/`)).toEqual([]);
    expect(await storageLeft(repo.stub)).toEqual({ meta: 0, git: 0, packs: 0 });
    // Its audit records outlive it, the deletion's own among them.
    expect((await archivedAudit(repo.id)).map((row) => row.action)).toEqual(
      expect.arrayContaining(["refs.update", "repo.delete"]),
    );
    // The name is free again; the new repository has a new id.
    const again = await api("POST", "/user/repos", { name: repo.name });
    expect(again.status).toBe(201);
    expect((await again.json<{ id: string }>()).id).not.toBe(repo.id);
  });

  it("deletes a repository by a name it had before a rename, and drops the old name", async () => {
    const old = uniqueId("was");
    const repo = await repoWithData(old);
    const name = uniqueId("now");
    expect((await api("PATCH", `/repos/${handle}/${old}`, { name })).status).toBe(200);
    expect(await (await remove(old)).json()).toMatchObject({ id: repo.id, state: "deleted" });
    expect((await api("GET", `/repos/${handle}/${old}`)).status).toBe(404);
    const redirects = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM repo_redirects WHERE repo_id = ?",
    )
      .bind(repo.id)
      .first<{ n: number }>();
    expect(redirects?.n).toBe(0);
  });

  it("keeps a fork's data when its parent is deleted", async () => {
    const parent = await repoWithData();
    const forker = await principalWithToken("user", "git");
    const { repo: child } = await fork(user, parent, forker);
    expect(await (await remove(parent.name)).json()).toMatchObject({ state: "deleted" });

    const status = await inNetwork(parent.networkId, (n) => n.status());
    expect(status.members.map((m) => m.repoId)).toEqual([child.id]);
    for (const pack of status.packs) expect(pack.claims).toEqual([child.id]);
    const clone = await cloneObjects(
      forker,
      child,
      fixture.refs.map((r) => r.oid),
      ["done"],
    );
    expect(clone.error).toBeUndefined();
    expect(clone.objects?.length).toBeGreaterThan(0);
  });

  it("deletes a fork and leaves its parent's data alone", async () => {
    const parent = await repoWithData();
    const forker = await principalWithToken("user", "git");
    const { repo: child } = await fork(user, parent, forker);
    const before = await keysUnder(env.GIT, `net/${parent.networkId}/`);
    // An archive of the fork: its segments sit in the network the parent keeps.
    const archive = await child.stub.archive({ format: "tar.gz", prefix: "child" });
    expect(archive).toMatchObject({ ok: true, value: { state: "ready" } });
    expect((await keysUnder(env.GIT, `net/${parent.networkId}/`)).length).toBeGreaterThan(
      before.length,
    );
    await markDeletions(env, [{ id: child.id, ownerHandle: "x", name: child.name }], {
      actorId: forker.principalId,
    });
    expect(await advanceDeletion(env, child.id)).toBe("deleted");
    expect(await keysUnder(env.GIT, `net/${parent.networkId}/`)).toEqual(before);
    const status = await inNetwork(parent.networkId, (n) => n.status());
    expect(status.members.map((m) => m.repoId)).toEqual([parent.id]);
    for (const pack of status.packs) expect(pack.claims).toEqual([parent.id]);
    const clone = await cloneObjects(
      user,
      parent,
      fixture.refs.map((r) => r.oid),
      ["done"],
    );
    expect(clone.error).toBeUndefined();
  });

  it("lets no fork borrow a frozen repository's packs", async () => {
    const parent = await repoWithData();
    await markDeletions(env, [{ id: parent.id, ownerHandle: handle, name: parent.name }], {
      actorId: user.principalId,
    });
    await parent.stub.prepareDeletion(user.principalId, 1_000);
    await expect(
      inRepo(parent.stub, (instance) => instance.exportForFork("forker", 60_000)),
    ).rejects.toThrow(/being deleted/);
    expect(await advanceDeletion(env, parent.id)).toBe("deleted");
  });

  it("waits to erase while a lease on its packs is held", async () => {
    const repo = await repoWithData();
    await markDeletions(env, [{ id: repo.id, ownerHandle: handle, name: repo.name }], {
      actorId: user.principalId,
    });
    const leaseId = await inRepo(repo.stub, ({ git }) => {
      const packs = git.context.storage.sql
        .exec<{ pack_id: string }>("SELECT pack_id FROM packs")
        .toArray()
        .map((p) => p.pack_id as never);
      const grant = git.leases.grant("read", packs, "a-clone", 60_000);
      if (!grant.ok) throw new Error("lease refused");
      return grant.leaseId;
    });
    expect(await advanceDeletion(env, repo.id)).toBe("deleting");
    expect(await deletionRow(repo.id)).toMatchObject({ step: "erase" });
    expect(await keysUnder(env.GIT, `net/${repo.networkId}/`)).not.toEqual([]);
    await repo.stub.releaseFetchLease(leaseId);
    expect(await advanceDeletion(env, repo.id)).toBe("deleted");
    expect(await keysUnder(env.GIT, `net/${repo.networkId}/`)).toEqual([]);
  });

  it("finishes a deletion whose erase ran but was not recorded", async () => {
    const repo = await repoWithData();
    await markDeletions(env, [{ id: repo.id, ownerHandle: handle, name: repo.name }], {
      actorId: user.principalId,
    });
    expect(await advanceDeletion(failingOnce(repo.id, "eraseForDeletion"), repo.id)).toBe(
      "deleting",
    );
    // The erase happened; the record of it was lost.
    expect(await repo.stub.eraseForDeletion()).toBe("erased");
    expect(await deletionRow(repo.id)).toMatchObject({ step: "erase" });
    expect(await advanceDeletion(env, repo.id)).toBe("deleted");
  });

  it("sends a waiting deletion to the back of the cron's queue", async () => {
    const waiting: { id: string; stub: DurableObjectStub<RepoDO> }[] = [];
    for (let i = 0; i < 2; i++) {
      const repo = await repoWithData();
      await inRepo(repo.stub, (instance) => {
        instance.sendEvents = () => Promise.reject(new Error("queue down"));
      });
      await markDeletions(env, [{ id: repo.id, ownerHandle: handle, name: repo.name }], {
        actorId: user.principalId,
      });
      waiting.push(repo);
    }
    const touched = async () => {
      const { results } = await env.DIRECTORY.prepare(
        "SELECT repo_id, updated_at FROM repo_deletions WHERE repo_id IN (?, ?)",
      )
        .bind(waiting[0]?.id, waiting[1]?.id)
        .all<{ repo_id: string; updated_at: number }>();
      return new Map(results.map((r) => [r.repo_id, r.updated_at]));
    };
    const before = await touched();
    // Older deletions of other tests may come first: run until both had a turn.
    for (let i = 0; i < 50; i++) {
      const now = await touched();
      if (waiting.every((r) => (now.get(r.id) ?? 0) > (before.get(r.id) ?? 0))) break;
      await advanceDeletions(env, { limit: 1 });
    }
    const after = await touched();
    for (const repo of waiting)
      expect(after.get(repo.id)).toBeGreaterThan(before.get(repo.id) ?? 0);
  });

  it("takes no new upload once frozen, and waits for no lease of its own uploads", async () => {
    const repo = await repoWithData();
    await markDeletions(env, [{ id: repo.id, ownerHandle: handle, name: repo.name }], {
      actorId: user.principalId,
    });
    // An abandoned upload's index lease: its writer stopped with the freeze.
    await inRepo(repo.stub, ({ git }) => {
      const packs = git.context.storage.sql
        .exec<{ pack_id: string }>("SELECT pack_id FROM packs")
        .toArray()
        .map((p) => p.pack_id as never);
      if (!git.leases.grant("index", packs, "an-upload", 24 * 60 * 60 * 1000).ok)
        throw new Error("lease refused");
    });
    await repo.stub.prepareDeletion(user.principalId, 1_000);
    expect(await repo.stub.beginPush({ principal: user.principalId, tokenId: "tok" })).toEqual({
      ok: false,
      error: "the repository is being deleted",
    });
    expect(await advanceDeletion(env, repo.id)).toBe("deleted");
  });

  it("waits for a push that may still be storing its body", async () => {
    const repo = await repoWithData();
    const begun = await repo.stub.beginPush({ principal: user.principalId, tokenId: "tok" });
    if (!begun.ok) throw new Error(begun.error);
    await markDeletions(env, [{ id: repo.id, ownerHandle: handle, name: repo.name }], {
      actorId: user.principalId,
    });
    expect(await advanceDeletion(env, repo.id)).toBe("deleting");
    expect(await deletionRow(repo.id)).toMatchObject({ step: "erase" });
    // Long enough ago that its body is no longer being written.
    await inRepo(repo.stub, ({ git }) =>
      git.context.storage.sql.exec(
        "UPDATE uploads SET created_at = created_at - 16 * 60 * 1000 WHERE upload_id = ?",
        begun.uploadId,
      ),
    );
    expect(await advanceDeletion(env, repo.id)).toBe("deleted");
  });

  it("leaves every network it was in, including one it detached from", async () => {
    const repo = await repoWithData();
    const detached = await inNetwork(repo.networkId, (n) =>
      n.detach({ networkId: repo.networkId, repoId: repo.id }),
    );
    if (!detached.ok) throw new Error(detached.error);
    expect(await runDetach(repo.stub)).toBe("done");
    // Its packs of the old network were retired since.
    await inRepo(repo.stub, ({ git }) =>
      git.context.storage.sql.exec("DELETE FROM packs WHERE network_id = ?", repo.networkId),
    );
    await markDeletions(env, [{ id: repo.id, ownerHandle: handle, name: repo.name }], {
      actorId: user.principalId,
    });
    expect(await advanceDeletion(env, repo.id)).toBe("deleted");
    for (const networkId of [repo.networkId, detached.newNetworkId]) {
      const status = await inNetwork(networkId, (n) => n.status());
      expect(status.members).toEqual([]);
    }
  });

  it("drops a deleted repository its network still lists when the network collects", async () => {
    const parent = await repoWithData();
    const forker = await principalWithToken("user", "git");
    const { repo: child } = await fork(user, parent, forker);
    await markDeletions(env, [{ id: child.id, ownerHandle: "x", name: child.name }], {
      actorId: forker.principalId,
    });
    expect(await advanceDeletion(env, child.id)).toBe("deleted");
    // A membership its deletion did not know of (left before networks were recorded).
    await inNetwork(parent.networkId, (n) => n.registry.addMember(child.id, parent.id, "detached"));
    // Its object restarted since, with empty storage.
    await runInDurableObject(child.stub, (_: RepoDO, state) => state.abort()).catch(() => {});
    expect(await runNetworkJob(parent.networkId, "gc")).not.toBe("failed");
    const status = await inNetwork(parent.networkId, (n) => n.status());
    expect(status.members.map((m) => m.repoId)).toEqual([parent.id]);
  });

  it("freezes the repository first: no ref or setting changes once its deletion started", async () => {
    const repo = await repoWithData();
    await markDeletions(env, [{ id: repo.id, ownerHandle: handle, name: repo.name }], {
      actorId: user.principalId,
    });
    await repo.stub.prepareDeletion(user.principalId, 1_000);
    expect(await repo.stub.updateSettings({ description: "late", actor: null })).toEqual({
      ok: false,
      code: "repo_deleted",
    });
    await expect(
      inRepo(repo.stub, ({ git }) =>
        git.refStore.commitSync({
          addPacks: [],
          removePacks: [],
          refUpdates: [
            { name: "refs/heads/late", oldOid: null, newOid: new Uint8Array(20) as never },
          ],
          expectedVersion: git.refStore.readRefsSync().version,
        }),
      ),
    ).rejects.toThrow(/being deleted/);
    // One tombstone, however often the step runs.
    await repo.stub.prepareDeletion(user.principalId, 1_000);
    expect((await repo.stub.exportSnapshot())?.entities[0]).toMatchObject({
      deleted: true,
      row: null,
    });
    expect(await advanceDeletion(env, repo.id)).toBe("deleted");
  });

  it("waits while its events cannot be sent, then the cron finishes it", async () => {
    const repo = await repoWithData();
    await inRepo(repo.stub, (instance) => {
      instance.sendEvents = () => Promise.reject(new Error("queue down"));
    });
    expect(await (await remove(repo.name)).json()).toMatchObject({ state: "deleting" });
    expect(await deletionRow(repo.id)).toMatchObject({ step: "prepare", state: "deleting" });
    // Already gone for every request.
    expect((await api("GET", `/repos/${handle}/${repo.name}`)).status).toBe(404);
    await inRepo(repo.stub, (instance) => {
      instance.sendEvents = async (envelope) => {
        await env.EVENTS.send(envelope, { contentType: "json" });
      };
    });
    await advanceDeletions(env, { limit: 100 });
    expect(await deletionRow(repo.id)).toMatchObject({ step: "done", state: "deleted" });
  });

  it("waits through an audit archive outage and loses no audit row", async () => {
    const repo = await repoWithData();
    await inRepo(repo.stub, (instance) => {
      instance.auditBucket = { put: () => Promise.reject(new Error("R2 down")) };
    });
    expect(await (await remove(repo.name)).json()).toMatchObject({ state: "deleting" });
    expect(await deletionRow(repo.id)).toMatchObject({ step: "prepare" });
    expect(await storageLeft(repo.stub)).toMatchObject({ meta: 1 });
    await inRepo(repo.stub, (instance) => {
      instance.auditBucket = env.ASSETS;
    });
    await advanceDeletions(env, { limit: 100 });
    expect(await deletionRow(repo.id)).toMatchObject({ step: "done" });
    expect((await archivedAudit(repo.id)).map((row) => row.action)).toEqual(
      expect.arrayContaining(["refs.update", "repo.delete"]),
    );
  });

  it.each([
    ["the purge", "deletionTombstone", "purge"],
    ["the erase", "eraseForDeletion", "erase"],
  ] as const)("resumes after a failure in %s", async (_, method, step) => {
    const repo = await repoWithData();
    await markDeletions(env, [{ id: repo.id, ownerHandle: handle, name: repo.name }], {
      actorId: user.principalId,
    });
    expect(await advanceDeletion(failingOnce(repo.id, method), repo.id)).toBe("deleting");
    expect(await deletionRow(repo.id)).toMatchObject({
      step,
      attempts: 1,
      last_error: `${method} failed`,
    });
    expect(await advanceDeletion(env, repo.id)).toBe("deleted");
    expect(await deletionRow(repo.id)).toMatchObject({ step: "done", last_error: null });
    expect(await readModelRow(repo.id)).toMatchObject({ deleted: 1 });
    // Done is done.
    expect(await advanceDeletion(env, repo.id)).toBe("deleted");
  });
});

describe("repos.delete_many", () => {
  it("deletes several repositories by name and reports each", async () => {
    const a = await repoWithData(uniqueId("bulk-a"));
    const b = await repoWithData(uniqueId("bulk-b"));
    const c = await repoWithData(uniqueId("bulk-c"));
    const d = await repoWithData(uniqueId("bulk-d"));
    const other = await principalWithToken("user", "git");
    const theirs = uniqueId("theirs");
    expect((await api("POST", "/user/repos", { name: theirs }, other.token)).status).toBe(201);
    const missing = uniqueId("missing");

    const res = await api("POST", "/user/repos/delete", {
      names: [a.name, a.name.toUpperCase(), b.name, c.name, d.name, missing, theirs],
    });
    expect(res.status).toBe(200);
    const { results } = await res.json<{
      results: { name: string; id: string | null; state: string }[];
    }>();
    expect(results).toEqual([
      { name: a.name, id: a.id, state: "deleted" },
      { name: b.name, id: b.id, state: "deleted" },
      { name: c.name, id: c.id, state: "deleted" },
      // Past what one request advances: the cron finishes it.
      { name: d.name, id: d.id, state: "deleting" },
      { name: missing, id: null, state: "not_found" },
      { name: theirs, id: null, state: "not_found" },
    ]);
    await advanceDeletions(env, { limit: 100 });
    expect(await deletionRow(d.id)).toMatchObject({ step: "done", state: "deleted" });
    const otherHandle = other.principalId.toLowerCase().replace("_", "-");
    const kept = await api("GET", `/repos/${otherHandle}/${theirs}`, undefined, other.token);
    expect(kept.status).toBe(200);
  });
});
