import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { renameRepo } from "../src/repos/directory.js";
import { moveRef } from "./helpers/gc.js";
import { basic } from "./helpers/git-http.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const ORIGIN = "https://fyrden.test";
let user: { principalId: string; token: string };
let handle: string;

beforeAll(async () => {
  user = await principalWithToken("user", "pat");
  handle = user.principalId.toLowerCase().replace("_", "-");
});

type Repo = {
  id: string;
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
};

function api(method: string, path: string, body?: unknown) {
  return exports.default.fetch(`${ORIGIN}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${user.token}`,
      ...(body !== undefined && {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function create(name: string): Promise<Repo> {
  const res = await api("POST", "/user/repos", { name });
  expect(res.status).toBe(201);
  return res.json<Repo>();
}

const update = (name: string, body: unknown) => api("PATCH", `/repos/${handle}/${name}`, body);

async function get(name: string): Promise<Repo | number> {
  const res = await api("GET", `/repos/${handle}/${name}`);
  return res.ok ? res.json<Repo>() : res.status;
}

/** The repository's current snapshot, as its object would export it. */
async function snapshot(id: string) {
  const exported = await env.REPO.getByName(id).exportSnapshot();
  return exported?.entities[0];
}

function auditRows(id: string) {
  return inRepo(env.REPO.getByName(id), (repo) =>
    repo.git.context.storage.sql
      .exec<{ action: string; actor_id: string; details: string }>(
        "SELECT action, actor_id, details FROM audit_log WHERE action = 'repo.update' ORDER BY seq",
      )
      .toArray()
      .map((row) => ({ ...row, details: JSON.parse(row.details) })),
  );
}

function lsRefs(name: string) {
  return exports.default.fetch(`${ORIGIN}/${handle}/${name}.git/git-upload-pack`, {
    method: "POST",
    headers: {
      Authorization: basic(user.token),
      "Content-Type": "application/x-git-upload-pack-request",
      "Git-Protocol": "version=2",
    },
    body: "0014command=ls-refs\n0017object-format=sha1\n0001000csymrefs\n000bunborn\n0000",
  });
}

describe("repos.update", () => {
  it("renames a repository; the old name keeps working for the API and git", async () => {
    const old = uniqueId("before");
    const name = uniqueId("after");
    const repo = await create(old);
    const res = await update(old, { name });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: repo.id, name, full_name: `${handle}/${name}` });

    expect(await get(name)).toMatchObject({ id: repo.id, name });
    expect(await get(old)).toMatchObject({ id: repo.id, name });
    expect((await lsRefs(old)).status).toBe(200);
    expect((await lsRefs(name)).status).toBe(200);

    expect(await snapshot(repo.id)).toMatchObject({ version: 2, row: { name } });
    expect(await auditRows(repo.id)).toEqual([
      {
        action: "repo.update",
        actor_id: user.principalId,
        details: { name: { from: old, to: name } },
      },
    ]);
    const directoryAudit = await env.DIRECTORY.prepare(
      "SELECT actor_id, details FROM audit_log WHERE action = 'repo.rename' AND target_id = ?",
    )
      .bind(repo.id)
      .all<{ actor_id: string; details: string }>();
    expect(directoryAudit.results.map((r) => [r.actor_id, JSON.parse(r.details)])).toEqual([
      [user.principalId, { from: old, to: name }],
    ]);
  });

  it("refuses a name another repository has, changing nothing", async () => {
    const a = await create(uniqueId("taken-a"));
    const b = await create(uniqueId("taken-b"));
    const res = await update(a.name, { name: b.name.toUpperCase(), description: "x" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "name_taken" });
    expect(await get(a.name)).toMatchObject({ id: a.id, name: a.name, description: null });
    expect(await snapshot(a.id)).toMatchObject({ version: 1 });
  });

  it("gives an old name up to a repository created with it", async () => {
    const old = uniqueId("reused");
    const repo = await create(old);
    expect((await update(old, { name: uniqueId("moved") })).status).toBe(200);
    // Resolved through the redirect, and remembered.
    expect(await get(old)).toMatchObject({ id: repo.id });
    const fresh = await create(old);
    expect(await get(old)).toMatchObject({ id: fresh.id, name: old });
    const redirects = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM repo_redirects WHERE repo_id = ?",
    )
      .bind(repo.id)
      .first<{ n: number }>();
    expect(redirects?.n).toBe(0);
  });

  it("keeps another repository's redirect when the rename cannot happen", async () => {
    const old = uniqueId("kept");
    const other = await create(old);
    expect((await update(old, { name: uniqueId("elsewhere") })).status).toBe(200);
    const leaving = await create(uniqueId("leaving"));
    // Deleted after the caller resolved it.
    await env.DIRECTORY.prepare("UPDATE repos SET state = 'deleting' WHERE id = ?")
      .bind(leaving.id)
      .run();
    const renamed = await renameRepo(
      env,
      { id: leaving.id, ownerId: user.principalId, ownerHandle: handle, name: leaving.name },
      old,
      { actorId: user.principalId },
    );
    expect(renamed).toBeUndefined();
    expect(await get(old)).toMatchObject({ id: other.id });
  });

  it("forgets the name a concurrent rename gave up", async () => {
    const [a, b, c] = [uniqueId("race-a"), uniqueId("race-b"), uniqueId("race-c")];
    const repo = await create(a);
    // Both resolved the repository as `a`.
    const stale = { id: repo.id, ownerId: user.principalId, ownerHandle: handle, name: a };
    expect(await renameRepo(env, stale, b, { actorId: user.principalId })).toMatchObject({
      value: b,
    });
    expect(await get(b)).toMatchObject({ name: b });
    expect(await renameRepo(env, stale, c, { actorId: user.principalId })).toMatchObject({
      value: c,
    });
    expect(await get(b)).toMatchObject({ name: c });
  });

  it("follows a chain of renames and a rename back", async () => {
    const [a, b, c] = [uniqueId("chain-a"), uniqueId("chain-b"), uniqueId("chain-c")];
    const repo = await create(a);
    expect((await update(a, { name: b })).status).toBe(200);
    // The old name works for the update too.
    expect((await update(a, { name: c })).status).toBe(200);
    for (const name of [a, b, c]) expect(await get(name)).toMatchObject({ id: repo.id, name: c });
    expect((await update(b, { name: a })).status).toBe(200);
    for (const name of [a, b, c]) expect(await get(name)).toMatchObject({ id: repo.id, name: a });
    expect(await snapshot(repo.id)).toMatchObject({ version: 4, row: { name: a } });
  });

  it("changes only the case of a name without a redirect", async () => {
    const name = uniqueId("casing");
    const repo = await create(name);
    const upper = name.toUpperCase();
    expect(await (await update(name, { name: upper })).json()).toMatchObject({ name: upper });
    const redirects = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM repo_redirects WHERE repo_id = ?",
    )
      .bind(repo.id)
      .first<{ n: number }>();
    expect(redirects?.n).toBe(0);
    expect(await get(name)).toMatchObject({ id: repo.id, name: upper });
  });

  it("sets and clears the description", async () => {
    const repo = await create(uniqueId("described"));
    const set = await update(repo.name, { description: "A widget factory" });
    expect(await set.json()).toMatchObject({ description: "A widget factory" });
    expect(await get(repo.name)).toMatchObject({ description: "A widget factory" });
    expect(await snapshot(repo.id)).toMatchObject({
      version: 2,
      row: { description: "A widget factory" },
    });
    // The same value again writes nothing.
    expect((await update(repo.name, { description: "A widget factory" })).status).toBe(200);
    expect(await snapshot(repo.id)).toMatchObject({ version: 2 });
    expect(await (await update(repo.name, { description: "" })).json()).toMatchObject({
      description: null,
    });
    expect(await (await update(repo.name, { description: null })).json()).toMatchObject({
      description: null,
    });
    expect(await snapshot(repo.id)).toMatchObject({ version: 3, row: { description: null } });
    expect((await auditRows(repo.id)).map((row) => row.details)).toEqual([
      { description: true },
      { description: true },
    ]);
  });

  it("moves the default branch to an existing branch", async () => {
    const repo = await create(uniqueId("branches"));
    const stub = env.REPO.getByName(repo.id);
    await moveRef(stub, "refs/heads/main", null, "01".repeat(20));
    await moveRef(stub, "refs/heads/dev", null, "01".repeat(20));
    const res = await update(repo.name, { default_branch: "dev" });
    expect(await res.json()).toMatchObject({ default_branch: "dev" });
    expect(await get(repo.name)).toMatchObject({ default_branch: "dev" });
    const exported = await snapshot(repo.id);
    expect(exported?.row?.defaultBranch).toBe("refs/heads/dev");
    expect((await auditRows(repo.id)).map((row) => row.details)).toEqual([
      { default_branch: { from: "refs/heads/main", to: "refs/heads/dev" } },
    ]);
  });

  it("refuses a branch that does not exist, changing nothing, with or without a rename", async () => {
    const repo = await create(uniqueId("nobranch"));
    const versionBefore = (await snapshot(repo.id))?.version;
    for (const body of [
      { default_branch: "missing" },
      { default_branch: "missing", name: uniqueId("renamed"), description: "x" },
    ]) {
      const res = await update(repo.name, body);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: "branch_not_found" });
    }
    expect(await get(repo.name)).toMatchObject({
      name: repo.name,
      description: null,
      default_branch: "main",
    });
    expect((await snapshot(repo.id))?.version).toBe(versionBefore);
  });

  it("refuses an update that changes nothing it knows", async () => {
    const repo = await create(uniqueId("empty"));
    expect((await update(repo.name, {})).status).toBe(422);
    expect((await update(repo.name, { description: "x".repeat(351) })).status).toBe(422);
  });

  it("catches the object up on a rename it missed, and ignores one that arrives late", async () => {
    const old = uniqueId("missed");
    const name = uniqueId("caught-up");
    const repo = await create(old);
    // The directory renamed, but the object never heard of it.
    const renamed = await renameRepo(
      env,
      { id: repo.id, ownerId: user.principalId, ownerHandle: handle, name: old },
      name,
      { actorId: user.principalId },
    );
    expect(renamed).toEqual({ value: name, gen: 1 });
    expect(await snapshot(repo.id)).toMatchObject({ row: { name: old } });
    // The next update, even by the old name, hands the object the directory's name.
    expect((await update(old, { description: "later" })).status).toBe(200);
    expect(await snapshot(repo.id)).toMatchObject({
      row: { name, description: "later" },
    });
    // A rename older than the one recorded changes nothing.
    const stub = env.REPO.getByName(repo.id);
    const newest = uniqueId("newest");
    expect(
      await stub.updateSettings({ name: { value: newest, gen: 2 }, actor: null }),
    ).toMatchObject({ ok: true });
    const late = await stub.updateSettings({ name: { value: name, gen: 1 }, actor: null });
    expect(late).toMatchObject({ ok: true });
    expect(await snapshot(repo.id)).toMatchObject({ row: { name: newest } });
  });
});
