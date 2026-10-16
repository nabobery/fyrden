// An account tells, with an event, when a change of access leaves
// principals unable to read some of its repositories, so their activity
// feeds forget what they held of them.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
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

  it("are told for every repository but those still shared when a member leaves", async () => {
    const owner = await user();
    const dev = await user();
    const login = uniqueId("org").slice(0, 39);
    const created = await api("POST", "/admin/organizations", admin.token, {
      login,
      admin: owner.handle,
    });
    const { id } = await created.json<{ id: string }>();
    await api("PUT", `/orgs/${login}/memberships/${dev.handle}`, owner.token, {});
    const shared = await (
      await api("POST", `/orgs/${login}/repos`, owner.token, { name: "shared" })
    ).json<{ id: string }>();
    await api("PUT", `/repos/${login}/shared/collaborators/${dev.handle}`, owner.token, {
      permission: "pull",
    });
    expect(
      (await api("DELETE", `/orgs/${login}/memberships/${dev.handle}`, owner.token)).status,
    ).toBe(200);
    const revoked = (await events(id)).filter((e) => e.type === "access.revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.data).toMatchObject({
      principals: [dev.principalId],
      all_except: [shared.id],
    });
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
