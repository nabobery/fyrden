// An account tells, with an event, when a change of access leaves
// principals unable to read some of its repositories, so their activity
// feeds forget what they held of them.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { HELD_REPOS } from "../src/repos/directory.js";
import { api, user, type Who } from "./helpers/api.js";

let admin: Who;
beforeAll(async () => {
  admin = await user(true);
});

/** The account's events waiting in its outbox. */
const events = (accountId: string) =>
  runInDurableObject(env.ORG.getByName(accountId), (_instance, state) =>
    state.storage.sql
      .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
      .toArray()
      .map((row) => JSON.parse(row.event) as DomainEvent),
  );

/** An organization of `owner` with `dev` a member. */
async function orgWithMember() {
  const owner = await user();
  const dev = await user();
  const login = uniqueId("org").slice(0, 39);
  const created = await api("POST", "/admin/organizations", admin.token, {
    login,
    admin: owner.handle,
  });
  const { id } = await created.json<{ id: string }>();
  await api("PUT", `/orgs/${login}/memberships/${dev.handle}`, owner.token, {});
  return { id, login, owner, dev };
}

/** A private repository of `ownerId` in the directory only. */
async function directoryRepo(ownerId: string): Promise<string> {
  const id = uniqueId("rep_");
  await env.DIRECTORY.prepare(
    `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'default', 'private', 0, 0)`,
  )
    .bind(id, ownerId, id.toLowerCase(), uniqueId("net"))
    .run();
  return id;
}

describe("access revocations", () => {
  it("are told when a collaborator is removed, not when a role only changes", async () => {
    const owner = await user();
    const bob = await user();
    const made = await api("POST", "/user/repos", owner.token, { name: uniqueId("r") });
    const repo = await made.json<{ id: string; full_name: string }>();
    const collaborator = `/repos/${repo.full_name}/collaborators/${bob.handle}`;
    await api("PUT", collaborator, owner.token, { permission: "push" });
    await api("PUT", collaborator, owner.token, { permission: "pull" });
    expect(await events(owner.principalId)).toEqual([]);
    expect((await api("DELETE", collaborator, owner.token)).status).toBe(200);
    const [revoked] = await events(owner.principalId);
    expect(revoked).toMatchObject({
      type: "access.revoked",
      id: { sourceId: owner.principalId, sourceSeq: 1 },
      actor: owner.principalId,
      data: { principals: [bob.principalId], repos: [repo.id] },
    });
    expect(revoked?.data?.acl_version).toBeGreaterThan(0);
  });

  it("name, when a member leaves, every repository the organization holds then but those still shared", async () => {
    const { id, login, owner, dev } = await orgWithMember();
    const made = async (name: string) =>
      (await api("POST", `/orgs/${login}/repos`, owner.token, { name })).json<{ id: string }>();
    await made("shared");
    const other = await made("other");
    // One moving away to another account, not released yet: still the organization's to purge.
    const moving = await directoryRepo(owner.principalId);
    await env.DIRECTORY.prepare(
      `INSERT INTO repo_transfers (repo_id, transfer_id, from_owner, from_name, to_owner, to_name,
         step, created_at, updated_at)
       VALUES (?, ?, ?, 'old', ?, 'new', 'grants', 0, 0)`,
    )
      .bind(moving, uniqueId("trf"), id, owner.principalId)
      .run();
    await api("PUT", `/repos/${login}/shared/collaborators/${dev.handle}`, owner.token, {
      permission: "pull",
    });
    expect(
      (await api("DELETE", `/orgs/${login}/memberships/${dev.handle}`, owner.token)).status,
    ).toBe(200);
    const revoked = (await events(id)).filter((e) => e.type === "access.revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.data).toMatchObject({ principals: [dev.principalId] });
    const named = (revoked[0]?.data ?? {}) as { repos?: string[] };
    expect([...(named.repos ?? [])].sort()).toEqual([other.id, moving].sort());
  });

  it("name them in events of at most 100 repositories each", async () => {
    const { id, login, owner, dev } = await orgWithMember();
    const held = await Promise.all(Array.from({ length: 250 }, () => directoryRepo(id)));
    expect(
      (await api("DELETE", `/orgs/${login}/memberships/${dev.handle}`, owner.token)).status,
    ).toBe(200);
    const revoked = (await events(id)).filter((e) => e.type === "access.revoked");
    const named = revoked.map((e) => (e.data as { repos: string[] }).repos);
    expect(named.map((repos) => repos.length)).toEqual([100, 100, 50]);
    expect(named.flat().sort()).toEqual([...held].sort());
    expect(new Set(revoked.map((e) => e.data?.acl_version)).size).toBe(1);
  });

  it("find the organization's repositories and those moving away by index, not by a scan", async () => {
    const { results } = await env.DIRECTORY.prepare(`EXPLAIN QUERY PLAN ${HELD_REPOS}`)
      .bind(uniqueId("org"))
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail);
    expect(plan.filter((detail) => detail.startsWith("SCAN"))).toEqual([]);
    expect(plan.join("\n")).toContain("repo_transfers_leaving");
  });
});

describe("a repository released for a transfer", () => {
  it("tells that those who read it here, but do not go with it, no longer do", async () => {
    const owner = await user();
    const dev = await user();
    const guest = await user();
    const login = uniqueId("org").slice(0, 39);
    const created = await api("POST", "/admin/organizations", admin.token, {
      login,
      admin: owner.handle,
    });
    const { id } = await created.json<{ id: string }>();
    await api("PUT", `/orgs/${login}/memberships/${dev.handle}`, owner.token, {});
    const repo = await (
      await api("POST", `/orgs/${login}/repos`, owner.token, { name: "moving" })
    ).json<{ id: string }>();
    await api("PUT", `/repos/${login}/moving/collaborators/${guest.handle}`, owner.token, {
      permission: "pull",
    });
    const org = env.ORG.getByName(id);
    await org.releaseRepo(`transfer-${uniqueId("t")}`, repo.id);
    const revoked = (await events(id)).filter((e) => e.type === "access.revoked");
    expect(revoked).toHaveLength(1);
    const data = revoked[0]?.data as { principals: string[]; repos: string[] };
    expect(data.repos).toEqual([repo.id]);
    expect(data.principals).toEqual(expect.arrayContaining([owner.principalId, dev.principalId]));
    // Its collaborator goes with it.
    expect(data.principals).not.toContain(guest.principalId);
  });
});
