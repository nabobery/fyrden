// Repository transfers: a repository moves to another account with its
// history, collaborators and storage; the old account's team grants stay
// behind, the old path redirects, and nothing changes it while it moves.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Envelope } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { allocateEpoch } from "../src/events/epochs.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { markDeletions } from "../src/repos/deletion.js";
import { authorize, renameRepo, resolveRepo } from "../src/repos/directory.js";
import { advanceTransfer } from "../src/repos/transfer.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { entry as feedEntry } from "./helpers/feed.js";
import { scopedToken } from "./helpers/principals.js";
import { postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");

let admin: Who;

beforeAll(async () => {
  admin = await user(true);
});

type Repo = { id: string; name: string; owner: string };

async function newOrg(owner: Who): Promise<string> {
  const login = uniqueId("org").slice(0, 39);
  const res = await api("POST", "/admin/organizations", admin.token, {
    login,
    admin: owner.handle,
  });
  expect(res.status).toBe(201);
  return login;
}

async function pushedRepo(owner: Who, path: string): Promise<Repo> {
  const repo = (await json<Repo>(api("POST", path, owner.token, { name: uniqueId("t") }))).body;
  const reply = await postPush(
    {
      repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
      owner: {
        principalId: owner.principalId,
        token: await scopedToken(owner.principalId, [], "git"),
      },
      path: `/${repo.owner}/${repo.name}.git`,
    },
    pushBody([{ old: ZERO, new: fx.c2, ref: "refs/heads/main" }], { pack: fx.packC2 }),
  );
  expect(reply.report).toContain("ok refs/heads/main\n");
  return repo;
}

const transfer = (who: Who, repo: Repo, body: Record<string, unknown>) =>
  json<{ state: string; repo: Repo; code?: string }>(
    api("POST", `/repos/${repo.owner}/${repo.name}/transfer`, who.token, body),
  );

const quota = async (path: string, token: string) =>
  (await json<{ storage_bytes: number }>(api("GET", path, token))).body.storage_bytes;

/** Sends of `repoId`'s object, kept here instead of going to the queue. */
const sentBy = new Map<string, Envelope[]>();

/** From now on, until the object restarts, `repoId`'s sends are kept, not sent. */
async function keepSends(repoId: string): Promise<void> {
  await runInDurableObject(env.REPO.getByName(repoId), (repo: RepoDO) => {
    if (!sentBy.has(repoId)) sentBy.set(repoId, []);
    repo.sendEvents = async (envelope) => {
      sentBy.get(repoId)?.push(envelope);
    };
  });
}

/** What `repoId`'s object sent since last asked (its outbox drained now). */
async function sent(repoId: string): Promise<Envelope[]> {
  await runInDurableObject(env.REPO.getByName(repoId), (repo: RepoDO) => repo.outbox.drain(repoId));
  return sentBy.get(repoId)?.splice(0) ?? [];
}

describe("repository transfers", () => {
  it("refuse a batch of the old owner that commits after the move, newer though it is", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    // An event of the old owner, routed (taken from the outbox) but not applied yet.
    await keepSends(repo.id);
    await api("PATCH", `/repos/${owner.handle}/${repo.name}`, owner.token, {
      description: "stale",
    });
    const stale = await sent(repo.id);
    const staleVersion = Math.max(
      ...stale.flatMap((e) => e.events.map((event) => event.entity?.version ?? 0)),
    );
    expect(staleVersion).toBeGreaterThan(0);
    const row = () =>
      env.ORG_READ.prepare(
        "SELECT owner_id, owner_gen, version, description FROM repos WHERE repo_id = ?",
      )
        .bind(repo.id)
        .first<{ owner_id: string; owner_gen: number; version: number; description: string }>();
    // The move commits first; then the old owner's batch, the newest event yet: refused.
    const org = await newOrg(owner);
    expect((await transfer(owner, repo, { new_owner: org })).status).toBe(200);
    for (const envelope of stale) await applyEnvelope(env, envelope);
    expect((await row())?.version ?? 0).toBeLessThan(staleVersion);
    // The new owner's change lands, and the old batch, again, moves nothing back.
    await keepSends(repo.id);
    await api("PATCH", `/repos/${org}/${repo.name}`, owner.token, { description: "fresh" });
    for (const envelope of await sent(repo.id))
      expect(await applyEnvelope(env, envelope)).toBe("applied");
    const fresh = await row();
    expect(fresh).toMatchObject({ owner_gen: 2, description: "fresh" });
    for (const envelope of stale) await applyEnvelope(env, envelope);
    expect(await row()).toEqual(fresh);
  });

  it("move a user's repository to an organization, with its history, collaborators and storage", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const reader = await user();
    await api(
      "PUT",
      `/repos/${owner.handle}/${repo.name}/collaborators/${reader.handle}`,
      owner.token,
      {
        permission: "pull",
      },
    );
    const used = await quota("/user/quota", owner.token);
    expect(used).toBeGreaterThan(0);
    const org = await newOrg(owner);
    const moved = await transfer(owner, repo, { new_owner: org });
    expect(moved).toMatchObject({
      status: 200,
      body: { state: "transferred", repo: { id: repo.id, owner: org, name: repo.name } },
    });
    // The new path; the old one redirects; the collaborator still reads.
    const at = `/repos/${org}/${repo.name}`;
    const branches = await json<{ branches: { commit: { sha: string } }[] }>(
      api("GET", `${at}/branches`, owner.token),
    );
    expect(branches.body.branches.map((b) => b.commit.sha)).toEqual([fx.c2]);
    expect(
      (await json<Repo>(api("GET", `/repos/${owner.handle}/${repo.name}`, owner.token))).body,
    ).toMatchObject({
      id: repo.id,
      owner: org,
    });
    expect((await api("GET", `${at}/branches`, reader.token)).status).toBe(200);
    // Its storage is the organization's now.
    expect(await quota("/user/quota", owner.token)).toBe(0);
    expect(await quota(`/orgs/${org}/quota`, owner.token)).toBe(used);
    // The read model takes no event of the old owner generation.
    const fence = await env.ORG_READ.prepare(
      "SELECT owner_gen FROM source_owner WHERE source_id = ?",
    )
      .bind(repo.id)
      .first<{ owner_gen: number }>();
    expect(fence?.owner_gen).toBe(2);
    // Pushes go on at the new path.
    const pushed = await postPush(
      {
        repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
        owner: {
          principalId: owner.principalId,
          token: await scopedToken(owner.principalId, [], "git"),
        },
        path: `/${org}/${repo.name}.git`,
      },
      pushBody([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }], { pack: fx.packC3ThinOnC2 }),
    );
    expect(pushed.report).toContain("ok refs/heads/main\n");
  });

  it("record the request that started them, in the directory and in the repository", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const org = await newOrg(owner);
    const res = await api("POST", `/repos/${owner.handle}/${repo.name}/transfer`, owner.token, {
      new_owner: org,
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get("X-Request-Id");
    expect(requestId).toBeTruthy();
    const directory = await env.DIRECTORY.prepare(
      "SELECT request_id FROM audit_log WHERE action = 'repo.transfer' AND target_id = ?",
    )
      .bind(repo.id)
      .first<{ request_id: string | null }>();
    expect(directory?.request_id).toBe(requestId);
    const own = await runInDurableObject(env.REPO.getByName(repo.id), (_: RepoDO, state) =>
      state.storage.sql
        .exec<{ actor_id: string; request_id: string | null }>(
          "SELECT actor_id, request_id FROM audit_log WHERE action = 'repo.transfer'",
        )
        .one(),
    );
    expect(own).toEqual({ actor_id: owner.principalId, request_id: requestId });
  });

  it("leave the old organization's team grants behind, keeping collaborators", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const repo = await pushedRepo(owner, `/orgs/${org}/repos`);
    const member = await user();
    await api("PUT", `/orgs/${org}/memberships/${member.handle}`, owner.token, {});
    const team = (
      await json<{ slug: string }>(
        api("POST", `/orgs/${org}/teams`, owner.token, { name: uniqueId("team") }),
      )
    ).body.slug;
    await api("PUT", `/orgs/${org}/teams/${team}/memberships/${member.handle}`, owner.token, {});
    await api("PUT", `/orgs/${org}/teams/${team}/repos/${org}/${repo.name}`, owner.token, {
      permission: "push",
    });
    const outside = await user();
    await api("PUT", `/repos/${org}/${repo.name}/collaborators/${outside.handle}`, owner.token, {
      permission: "pull",
    });
    expect((await api("GET", `/repos/${org}/${repo.name}`, member.token)).status).toBe(200);
    const moved = await transfer(owner, repo, {
      new_owner: owner.handle,
      new_name: uniqueId("mine"),
    });
    expect(moved.body.state).toBe("transferred");
    const at = `/repos/${owner.handle}/${moved.body.repo.name}`;
    expect((await api("GET", at, member.token)).status).toBe(404);
    expect((await api("GET", at, outside.token)).status).toBe(200);
  });

  it("are refused when the new account cannot take the repository, which then takes changes again", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const org = await newOrg(owner);
    expect((await api("POST", `/orgs/${org}/repos`, owner.token, { name: repo.name })).status).toBe(
      201,
    );
    expect(await transfer(owner, repo, { new_owner: org })).toMatchObject({
      status: 409,
      body: { code: "name_taken" },
    });
    expect(await transfer(owner, repo, { new_owner: owner.handle })).toMatchObject({
      status: 422,
      body: { code: "same_owner" },
    });
    const stranger = await user();
    expect(await transfer(stranger, repo, { new_owner: stranger.handle })).toMatchObject({
      status: 404,
    });
    const write = await api(
      "PUT",
      `/repos/${owner.handle}/${repo.name}/contents/still-mine.txt`,
      owner.token,
      {
        message: "still mine",
        content: btoa("a"),
      },
    );
    expect(write.status).toBe(200);
  });

  it("take no push while the repository moves, and resume from any step", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const org = await newOrg(owner);
    const orgId = await idOf(org);
    // A transfer started, frozen, and interrupted after its first step.
    const transferId = await pendingTransfer(repo, owner.principalId, orgId, "directory");
    expect(
      await env.REPO.getByName(repo.id).freezeForTransfer({
        transferId,
        from: owner.principalId,
        to: orgId,
      }),
    ).toEqual({ ok: true });
    const refused = await postPush(
      {
        repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
        owner: {
          principalId: owner.principalId,
          token: await scopedToken(owner.principalId, [], "git"),
        },
        path: `/${owner.handle}/${repo.name}.git`,
      },
      pushBody([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }], { pack: fx.packC3ThinOnC2 }),
    );
    expect(new TextDecoder().decode(refused.bytes)).toContain("being transferred");
    // Nothing else changes it meanwhile, in the directory or the object.
    const path = `/repos/${owner.handle}/${repo.name}`;
    for (const [method, at, body] of [
      ["PATCH", path, { name: uniqueId("renamed") }],
      ["PATCH", path, { is_template: true }],
      ["PATCH", path, { description: "moving" }],
      [
        "POST",
        `${path}/rulesets`,
        {
          name: "r",
          enforcement: "active",
          conditions: { ref_name: { include: ["~ALL"] } },
          rules: [{ type: "deletion" }],
        },
      ],
      ["DELETE", path, undefined],
      ["PUT", `${path}/collaborators/${owner.handle}`, { permission: "pull" }],
    ] as const) {
      const res = await json<{ code: string }>(api(method, at, owner.token, body));
      expect(res, `${method} ${JSON.stringify(body)}`).toMatchObject({
        status: 409,
        body: { code: "repo_transferring" },
      });
    }
    // Nor does a second transfer start.
    expect(await transfer(owner, repo, { new_owner: org })).toMatchObject({
      status: 409,
      body: { code: "transfer_in_progress" },
    });
    // The cron's share finishes it; running a finished step again changes nothing.
    expect(await advanceTransfer(env, repo.id)).toEqual({ state: "transferred", error: null });
    for (const step of ["directory", "grants", "fence", "repo"]) {
      await env.DIRECTORY.prepare("UPDATE repo_transfers SET step = ? WHERE repo_id = ?")
        .bind(step, repo.id)
        .run();
      expect(await advanceTransfer(env, repo.id)).toEqual({ state: "transferred", error: null });
    }
    const audits = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'repo.transfer'",
    )
      .bind(repo.id)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
    expect(
      (await json<Repo>(api("GET", `/repos/${org}/${repo.name}`, owner.token))).body.owner,
    ).toBe(org);
    // Its storage was counted once, at the organization.
    expect(await quota(`/orgs/${org}/quota`, owner.token)).toBeGreaterThan(0);
    expect(await quota("/user/quota", owner.token)).toBe(0);
    // A late runner of the finished transfer freezes nothing.
    expect(
      await env.REPO.getByName(repo.id).freezeForTransfer({
        transferId,
        from: orgId,
        to: owner.principalId,
      }),
    ).toEqual({ ok: true });
    expect(await frozen(repo.id)).toBe(false);
  });

  it("are advanced by one runner at a time", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const orgId = await idOf(await newOrg(owner));
    await pendingTransfer(repo, owner.principalId, orgId, "freeze");
    await env.DIRECTORY.prepare("UPDATE repo_transfers SET lease_id = 'other', lease_until = ?")
      .bind(Date.now() + 60_000)
      .run();
    expect(await advanceTransfer(env, repo.id)).toEqual({ state: "transferring", error: null });
    expect(await frozen(repo.id)).toBe(false);
    // Its lease run out (the runner died), another takes it over.
    await env.DIRECTORY.prepare("UPDATE repo_transfers SET lease_until = 0 WHERE repo_id = ?")
      .bind(repo.id)
      .run();
    expect(await advanceTransfer(env, repo.id)).toEqual({ state: "transferred", error: null });
  });

  it("leave a collaborator's feed of the repository whole while it moves", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const reader = await user();
    const collaborators = `/repos/${owner.handle}/${repo.name}/collaborators`;
    await api("PUT", `${collaborators}/${reader.handle}`, owner.token, { permission: "pull" });
    await env.USER.getByName(reader.principalId).applyFeed([
      feedEntry({
        repoId: repo.id,
        version: 1,
        principal: reader.principalId,
        occurredAt: Date.now() - 1_000,
      }),
    ]);
    const keys = async () =>
      (
        await json<{ items: { item_key: string }[] }>(api("GET", "/feed", reader.token))
      ).body.items.map((i) => i.item_key);
    const key = `${repo.id}:pull/1:activity`;
    expect(await keys()).toEqual([key]);
    // Frozen, and paused right after the old account let go of it and of its collaborators.
    const orgId = await idOf(await newOrg(owner));
    const transferId = await pendingTransfer(repo, owner.principalId, orgId, "directory");
    await env.REPO.getByName(repo.id).freezeForTransfer({
      transferId,
      from: owner.principalId,
      to: orgId,
    });
    await env.ORG.getByName(owner.principalId).releaseRepo(transferId, repo.id);
    // A read now pulls the old account's list, the collaborator gone from it.
    await runInDurableObject(env.REPO.getByName(repo.id), (r: RepoDO) => r.acl.reset());
    expect(await keys()).toEqual([]);
    // The runner moves it on from there: the collaborator goes with it and reads all again.
    expect(await advanceTransfer(env, repo.id)).toEqual({ state: "transferred", error: null });
    expect(await keys()).toEqual([key]);
  });

  it("finish calling a transfer off when interrupted, and refuse a late freeze of it", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const orgId = await idOf(await newOrg(owner));
    const transferId = await pendingTransfer(repo, owner.principalId, orgId, "cancelling");
    const stub = env.REPO.getByName(repo.id);
    expect(
      await stub.freezeForTransfer({ transferId, from: owner.principalId, to: orgId }),
    ).toEqual({ ok: true });
    expect(await advanceTransfer(env, repo.id)).toMatchObject({ state: "failed" });
    expect(await frozen(repo.id)).toBe(false);
    expect(
      await stub.freezeForTransfer({ transferId, from: owner.principalId, to: orgId }),
    ).toEqual({ ok: false, code: "ended" });
    expect(await frozen(repo.id)).toBe(false);
    const write = await api(
      "PUT",
      `/repos/${owner.handle}/${repo.name}/contents/after.txt`,
      owner.token,
      { message: "after", content: btoa("a") },
    );
    expect(write.status).toBe(200);
  });

  it("refuse to start while the repository is being deleted, and leave a moved repository's storage behind", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const org = await newOrg(owner);
    const orgId = await idOf(org);
    // A late confirmation for the old account after the move is not counted there.
    const moved = await transfer(owner, repo, { new_owner: org });
    expect(moved.body.state).toBe("transferred");
    await env.ORG.getByName(owner.principalId).confirmStorage({
      uploadId: uniqueId("upload"),
      repoId: repo.id,
      bytes: 50,
    });
    expect(await quota("/user/quota", owner.token)).toBe(0);
    // An ACL notice from the old account changes nothing for the new one.
    await env.REPO.getByName(repo.id).invalidateAcl(owner.principalId, 9, 9_999);
    expect(await env.REPO.getByName(repo.id).roleOf(owner.principalId, "write")).toBe("admin");
    // Deleting, it cannot be transferred.
    expect((await api("DELETE", `/repos/${org}/${repo.name}`, owner.token)).status).toBeLessThan(
      300,
    );
    expect(
      await transfer(owner, { ...repo, owner: org }, { new_owner: owner.handle }),
    ).toMatchObject({ status: 404 });
    expect(orgId).toBeTruthy();
  });
});

describe("after a transfer, requests authorized for the old owner", () => {
  it("rename and delete nothing, and its former user owner is decided by the repository", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const orgAdmin = await user();
    const org = await newOrg(orgAdmin);
    await api("PUT", `/orgs/${org}/memberships/${owner.handle}`, orgAdmin.token, {});
    // Read before the move, as a slow request (or another isolate's cache) would have it.
    const before = await resolveRepo(env, owner.handle, repo.name, { consistency: "primary" });
    if (!before) throw new Error("not found");
    const stale = { ...before };
    expect((await transfer(owner, repo, { new_owner: org })).body.state).toBe("transferred");
    expect(
      await renameRepo(env, stale, uniqueId("late"), { actorId: owner.principalId }),
    ).toBeUndefined();
    expect(await markDeletions(env, [stale], { actorId: owner.principalId })).toEqual(new Set());
    // Removed from the organization, the former owner reads nothing through the old entry.
    await api("DELETE", `/orgs/${org}/memberships/${owner.handle}`, orgAdmin.token);
    const auth = {
      principalId: owner.principalId,
      principalType: "user" as const,
      scopes: [] as string[],
      repoIds: null,
    };
    expect(await authorize(env, auth, stale, "contents:read")).toBe(false);
    expect(
      (await json<Repo>(api("GET", `/repos/${org}/${repo.name}`, orgAdmin.token))).body.name,
    ).toBe(repo.name);
  });

  it("grant nothing in the old account, which handed over what it had when it let go", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const repo = await pushedRepo(owner, `/orgs/${org}/repos`);
    const orgId = await idOf(org);
    const reader = await user();
    await api("PUT", `/repos/${org}/${repo.name}/collaborators/${reader.handle}`, owner.token, {
      permission: "pull",
    });
    const account = env.ORG.getByName(orgId);
    const handedOver = await account.releaseRepo("trf_x", repo.id);
    expect(handedOver.collaborators.map((c) => c.principalId)).toEqual([reader.principalId]);
    // Again: the same answer, though nothing is left here.
    expect((await account.releaseRepo("trf_x", repo.id)).collaborators).toEqual(
      handedOver.collaborators,
    );
    const late = await account.setCollaborator(
      { principalId: owner.principalId },
      repo.id,
      { id: reader.principalId, handle: reader.handle },
      "admin",
    );
    expect(late).toMatchObject({ ok: false });
  });

  it("are refused while the repository is still being generated, or when its access list would overflow", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const org = await newOrg(owner);
    const orgId = await idOf(org);
    const stub = env.REPO.getByName(repo.id);
    await runInDurableObject(stub, (_: RepoDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO generation (id, template_id, started_at) VALUES (1, 'rep_x', 1)",
      );
    });
    expect(await transfer(owner, repo, { new_owner: org })).toMatchObject({
      status: 409,
      body: { code: "repo_generating" },
    });
    expect(await frozen(repo.id)).toBe(false);
    await runInDurableObject(stub, (_: RepoDO, state) => {
      state.storage.sql.exec("DELETE FROM generation");
    });
    // An organization whose members fill a repository's access list takes no outside collaborator.
    await runInDurableObject(env.ORG.getByName(orgId), (_: unknown, state) => {
      for (let i = 0; i < 9_999; i++)
        state.storage.sql.exec(
          "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 1)",
          `usr_filler${i}`,
          `filler${i}`,
        );
    });
    const outside = await user();
    await api(
      "PUT",
      `/repos/${owner.handle}/${repo.name}/collaborators/${outside.handle}`,
      owner.token,
      {
        permission: "pull",
      },
    );
    expect(await transfer(owner, repo, { new_owner: org })).toMatchObject({
      status: 422,
      body: { code: "too_many_collaborators" },
    });
  });
});

describe("a restore", () => {
  it("to before a transfer takes the owner the directory names, in a generation past the fence", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const org = await newOrg(owner);
    const orgId = await idOf(org);
    expect((await transfer(owner, repo, { new_owner: org })).body.state).toBe("transferred");
    const stub = env.REPO.getByName(repo.id);
    // The object restored to before the transfer: its old owner and generation; the
    // runbook allocated the next epoch first.
    await runInDurableObject(stub, (_: RepoDO, state) => {
      state.storage.sql.exec(
        "UPDATE repo_meta SET org_id = ?1, owner_id = ?1, owner_gen = 1",
        owner.principalId,
      );
    });
    await allocateEpoch(env.DIRECTORY, repo.id);
    await runInDurableObject(stub, (_: RepoDO, state) => state.abort("restore")).catch(() => {});
    // A new instance, as after a restore.
    const restored = env.REPO.getByName(repo.id);
    await restored.checkEpoch();
    const fence = await env.ORG_READ.prepare(
      "SELECT owner_gen FROM source_owner WHERE source_id = ?",
    )
      .bind(repo.id)
      .first<{ owner_gen: number }>();
    const account = await runInDurableObject(restored, (r: RepoDO) => r.events.account());
    expect(account).toMatchObject({ accountId: orgId, ownerId: orgId });
    expect(account?.ownerGen).toBeGreaterThanOrEqual(fence?.owner_gen ?? Number.POSITIVE_INFINITY);
    // Its former owner's account answers for it no more: the organization's does.
    const branches = await api("GET", `/repos/${org}/${repo.name}/branches`, owner.token);
    expect(branches.status).toBe(200);
  });
});

describe("a restore, further", () => {
  /** The object as restored to `meta` (before transfers), in a new epoch and instance. */
  async function restore(repoId: string, meta: string, ...args: unknown[]) {
    await runInDurableObject(env.REPO.getByName(repoId), (_: RepoDO, state) => {
      state.storage.sql.exec(meta, ...args);
    });
    await allocateEpoch(env.DIRECTORY, repoId);
    await runInDurableObject(env.REPO.getByName(repoId), (_: RepoDO, state) =>
      state.abort("restore"),
    ).catch(() => {});
    await env.REPO.getByName(repoId).checkEpoch();
    return runInDurableObject(env.REPO.getByName(repoId), (_: RepoDO, state) =>
      state.storage.sql
        .exec<{
          org_id: string;
          owner_gen: number;
          transfer_id: string | null;
          transfer_to: string | null;
          write_frozen: number;
        }>("SELECT org_id, owner_gen, transfer_id, transfer_to, write_frozen FROM repo_meta")
        .one(),
    );
  }

  const fenceOf = async (repoId: string) =>
    (
      await env.ORG_READ.prepare("SELECT owner_gen FROM source_owner WHERE source_id = ?")
        .bind(repoId)
        .first<{ owner_gen: number }>()
    )?.owner_gen ?? 0;

  it("to before transfers that brought it back to its owner still takes the fence's generation", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const org = await newOrg(owner);
    expect((await transfer(owner, repo, { new_owner: org })).body.state).toBe("transferred");
    const back = { ...repo, owner: org };
    expect((await transfer(owner, back, { new_owner: owner.handle })).body.state).toBe(
      "transferred",
    );
    const fence = await fenceOf(repo.id);
    expect(fence).toBeGreaterThan(1);
    const meta = await restore(repo.id, "UPDATE repo_meta SET owner_gen = 1");
    expect(meta).toMatchObject({ org_id: owner.principalId, transfer_id: null });
    expect(meta.owner_gen).toBeGreaterThanOrEqual(fence);
  });

  it("during a transfer rejoins it, frozen, and the transfer then lands it", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const org = await newOrg(owner);
    const orgId = await idOf(org);
    expect((await transfer(owner, repo, { new_owner: org })).body.state).toBe("transferred");
    // As if its last step had not run yet when the object was restored to before it began.
    const { transfer_id: transferId } = (await env.DIRECTORY.prepare(
      "UPDATE repo_transfers SET step = 'repo', lease_id = NULL, lease_until = NULL WHERE repo_id = ? RETURNING transfer_id",
    )
      .bind(repo.id)
      .first<{ transfer_id: string }>()) as { transfer_id: string };
    const meta = await restore(
      repo.id,
      "DELETE FROM ended_transfers; UPDATE repo_meta SET org_id = ?1, owner_id = ?1, owner_gen = 1, transfer_id = NULL, transfer_to = NULL",
      owner.principalId,
    );
    expect(meta).toMatchObject({
      org_id: owner.principalId,
      transfer_id: transferId,
      transfer_to: orgId,
      write_frozen: 1,
    });
    expect(await advanceTransfer(env, repo.id)).toMatchObject({ state: "transferred" });
    const landed = await runInDurableObject(env.REPO.getByName(repo.id), (r: RepoDO) =>
      r.events.account(),
    );
    expect(landed).toMatchObject({ accountId: orgId });
    expect(landed?.ownerGen).toBeGreaterThanOrEqual(await fenceOf(repo.id));
  });
});

describe("repository transfers in flight", () => {
  it("hold the new account's storage for each, so two at once never overrun it", async () => {
    const owner = await user();
    const [one, two] = [
      await pushedRepo(owner, "/user/repos"),
      await pushedRepo(owner, "/user/repos"),
    ];
    const used = await quota("/user/quota", owner.token);
    const each = used / 2;
    const org = await newOrg(owner);
    // Room for one of them, not both.
    expect(
      (
        await api("PUT", `/admin/accounts/${org}/quota`, admin.token, {
          max_storage_bytes: Math.floor(each * 1.5),
        })
      ).status,
    ).toBe(200);
    const results = await Promise.all(
      [one, two].map((repo) => transfer(owner, repo as Repo, { new_owner: org })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(results.find((r) => r.status === 403)?.body.code).toBe("quota_exceeded");
    expect(await quota(`/orgs/${org}/quota`, owner.token)).toBe(each);
    // Nothing is left held for the one called off.
    const status = await json<{ reserved_bytes: number }>(
      api("GET", `/orgs/${org}/quota`, owner.token),
    );
    expect(status.body.reserved_bytes).toBe(0);
  });

  it("hold room in the new account for what the repository still owes the old one", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const used = await quota("/user/quota", owner.token);
    const owed = 50;
    const stub = env.REPO.getByName(repo.id);
    // A committed upload its account was not told of yet (a lost confirmation).
    await runInDurableObject(stub, (_: RepoDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO storage_owed (upload_id, bytes, owed_at) VALUES ('owed', ?, ?)",
        owed,
        Date.now(),
      );
    });
    const org = await newOrg(owner);
    const limit = (bytes: number) =>
      api("PUT", `/admin/accounts/${org}/quota`, admin.token, { max_storage_bytes: bytes });
    expect((await limit(used + owed - 1)).status).toBe(200);
    expect(await transfer(owner, repo, { new_owner: org })).toMatchObject({
      status: 403,
      body: { code: "quota_exceeded" },
    });
    expect((await limit(used + owed)).status).toBe(200);
    expect((await transfer(owner, repo, { new_owner: org })).body.state).toBe("transferred");
    // Landed, the owed bytes stay held until the new account is told of them: nothing
    // else can take that room meanwhile.
    const status = async () =>
      (
        await json<{ storage_bytes: number; reserved_bytes: number }>(
          api("GET", `/orgs/${org}/quota`, owner.token),
        )
      ).body;
    expect(await status()).toMatchObject({ storage_bytes: used, reserved_bytes: owed });
    // Told: within what it held.
    await runInDurableObject(stub, async (r: RepoDO, state) => {
      state.storage.sql.exec("UPDATE jobs SET next_run_at = 1 WHERE kind = 'storage_confirm'");
      await r.alarm();
    });
    expect(await status()).toMatchObject({ storage_bytes: used + owed, reserved_bytes: 0 });
  });

  it("count an arriving collaborator who stops being a member", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const org = await newOrg(owner);
    const orgId = await idOf(org);
    await runInDurableObject(env.ORG.getByName(orgId), (_: unknown, state) => {
      for (let i = 0; i < 9_998; i++)
        state.storage.sql.exec(
          "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 1)",
          `usr_swap${i}`,
          `swap${i}`,
        );
    });
    // The owner, 9,998 members and a collaborator of the arriving repository: 10,000.
    const both = await user();
    const membership = (who: Who, method: "PUT" | "DELETE") =>
      api(
        method,
        `/orgs/${org}/memberships/${who.handle}`,
        owner.token,
        method === "PUT" ? {} : undefined,
      ).then((r) => r.status);
    expect(await membership(both, "PUT")).toBe(200);
    expect(
      await env.ORG.getByName(orgId).reserveArrival({
        transferId: "trf_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        accountId: orgId,
        repoId: repo.id,
        usageBytes: 0,
        collaborators: [{ principalId: both.principalId }],
      }),
    ).toBe("ok");
    // No longer a member, it arrives from outside: a new member would make 10,001.
    expect(await membership(both, "DELETE")).toBe(200);
    expect(await membership(await user(), "PUT")).toBe(409);
  });

  it("hold an arrival's room until it ends, and make no room again for one adopted", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const org = await newOrg(owner);
    const orgId = await idOf(org);
    expect(
      (await api("PUT", `/admin/accounts/${org}/quota`, admin.token, { max_storage_bytes: 100 }))
        .status,
    ).toBe(200);
    const target = env.ORG.getByName(orgId);
    const arrive = (transferId: string) =>
      target.reserveArrival({
        transferId,
        accountId: orgId,
        repoId: repo.id,
        usageBytes: 80,
        collaborators: [],
      });
    const first = "trf_01ARZ3NDEKTSV4RRFFQ69G5FB0";
    const second = "trf_01ARZ3NDEKTSV4RRFFQ69G5FB1";
    expect(await arrive(first)).toBe("ok");
    // Held, however long the transfer takes: no room for another.
    expect(await arrive(second)).toBe("quota_exceeded");
    expect(await arrive(first)).toBe("ok");
    expect((await target.quotaStatus()).reservedBytes).toBe(80);
    // Adopted, a late runner asking again makes no room.
    await target.adoptRepo(first, repo.id, { collaborators: [], usageBytes: 80 });
    expect(await arrive(first)).toBe("ok");
    expect(await target.quotaStatus()).toMatchObject({ usedBytes: 80, reservedBytes: 0 });
    // Called off, likewise.
    await target.releaseArrival(second);
    expect(await arrive(second)).toBe("ok");
    expect((await target.quotaStatus()).reservedBytes).toBe(0);
  });

  it("count a repository on its way in against members added meanwhile", async () => {
    const owner = await user();
    const repo = await pushedRepo(owner, "/user/repos");
    const org = await newOrg(owner);
    const orgId = await idOf(org);
    // The organization's owner and 9,997 members: 9,998.
    await runInDurableObject(env.ORG.getByName(orgId), (_: unknown, state) => {
      for (let i = 0; i < 9_997; i++)
        state.storage.sql.exec(
          "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 1)",
          `usr_arrival${i}`,
          `arrival${i}`,
        );
    });
    const outside = await user();
    // The repository is on its way in with one outside collaborator: 9,999.
    expect(
      await env.ORG.getByName(orgId).reserveArrival({
        transferId: "trf_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        accountId: orgId,
        repoId: repo.id,
        usageBytes: 0,
        collaborators: [{ principalId: outside.principalId }],
      }),
    ).toBe("ok");
    const join = async () => {
      const member = await user();
      return api("PUT", `/orgs/${org}/memberships/${member.handle}`, owner.token, {}).then(
        (r) => r.status,
      );
    };
    // One more member fills it to 10,000; the next would take it past.
    expect(await join()).toBe(200);
    expect(await join()).toBe(409);
  });
});

it("count a receiving user once in its access list, before its account is recorded", async () => {
  const receiver = uniqueId("usr");
  const others = Array.from({ length: 9_999 }, (_, i) => ({ principalId: `usr_other${i}` }));
  const account = env.ORG.getByName(receiver);
  expect(await account.canAdopt(receiver, [...others, { principalId: receiver }])).toBe(true);
  expect(await account.canAdopt(receiver, [...others, { principalId: "usr_one_more" }])).toBe(
    false,
  );
});

async function idOf(handle: string): Promise<string> {
  return (
    await env.DIRECTORY.prepare("SELECT id FROM principals WHERE handle = ?")
      .bind(handle)
      .first<{ id: string }>()
  )?.id as string;
}

/** A transfer job of `repo` to `to`, interrupted at `step`; returns its id. */
async function pendingTransfer(
  repo: Repo,
  from: string,
  to: string,
  step: string,
): Promise<string> {
  const transferId = uniqueId("trf");
  await env.DIRECTORY.prepare(
    `INSERT INTO repo_transfers (repo_id, transfer_id, from_owner, from_name, to_owner, to_name,
       step, requested_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
  )
    .bind(repo.id, transferId, from, repo.name, to, repo.name, step, from)
    .run();
  return transferId;
}

/** Whether the repository's object takes no change now. */
function frozen(repoId: string): Promise<boolean> {
  return runInDurableObject(
    env.REPO.getByName(repoId),
    (_: RepoDO, state) =>
      state.storage.sql
        .exec<{ write_frozen: number }>("SELECT write_frozen FROM repo_meta WHERE id = 1")
        .one().write_frozen === 1,
  );
}
