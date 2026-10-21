// An account object retiring principals being deleted: their memberships,
// team memberships and collaborator grants go, a page at a time, never the
// last owner of a published organization; and from then on, in that object,
// nothing adds them back, nor does any object once their deletion began.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { accountHooks, type OrgDO } from "../src/do/OrgDO.js";
import { api, json, user, type Who } from "./helpers/api.js";

let admin: Who;

beforeAll(async () => {
  admin = await user(true);
});

afterEach(() => {
  delete accountHooks.afterLifecycleRead;
});

const markDeleting = (principalId: string) =>
  env.DIRECTORY.prepare(
    `UPDATE principals SET lifecycle = 'deleting', disabled_at = ?2,
       lifecycle_gen = lifecycle_gen + 1 WHERE id = ?1`,
  )
    .bind(principalId, Date.now())
    .run()
    .then(() => {});

async function newOrg(owner: Who) {
  const login = uniqueId("org").slice(0, 39);
  const made = await json<{ id: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  expect(made.status).toBe(201);
  return { login, id: made.body.id, stub: env.ORG.getByName(made.body.id) };
}

const ok = async (res: Promise<Response>) => expect((await res).status).toBeLessThan(300);

/** `who` a member of `org`, on team `team` there, and a collaborator on one of its repositories. */
async function everywhere(org: { login: string }, owner: Who, who: Who) {
  await ok(
    api("PUT", `/orgs/${org.login}/memberships/${who.handle}`, owner.token, { role: "member" }),
  );
  const team = uniqueId("team").slice(0, 30);
  await ok(api("POST", `/orgs/${org.login}/teams`, owner.token, { name: team }));
  await ok(
    api("PUT", `/orgs/${org.login}/teams/${team}/memberships/${who.handle}`, owner.token, {}),
  );
  const repo = (
    await json<{ name: string }>(
      api("POST", `/orgs/${org.login}/repos`, owner.token, { name: uniqueId("r") }),
    )
  ).body;
  await ok(
    api("PUT", `/repos/${org.login}/${repo.name}/collaborators/${who.handle}`, owner.token, {
      permission: "push",
    }),
  );
  return { team, repo };
}

/** What `principalId` holds in the account object. */
const held = (stub: DurableObjectStub<OrgDO>, principalId: string) =>
  runInDurableObject(stub, (_: OrgDO, state) => {
    const n = (table: string) =>
      state.storage.sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n FROM ${table} WHERE principal_id = ?`,
          principalId,
        )
        .one().n;
    return { members: n("members"), teams: n("team_members"), collaborators: n("collaborators") };
  });

const retire = (
  stub: DurableObjectStub<OrgDO>,
  ids: string[],
  options: { ownerCheck?: boolean; budget?: number } = {},
) =>
  stub.retirePrincipals({
    ids,
    jobId: "job_test",
    actor: { principalId: admin.principalId },
    ownerCheck: options.ownerCheck ?? true,
    budget: options.budget ?? 500,
  });

describe("retiring principals in an account", () => {
  it("removes their memberships, team memberships and grants, and bumps the access version once", async () => {
    const owner = await user();
    const gone = await user();
    const org = await newOrg(owner);
    await everywhere(org, owner, gone);
    expect(await held(org.stub, gone.principalId)).toEqual({
      members: 1,
      teams: 1,
      collaborators: 1,
    });
    const before = await org.stub.aclVersion();
    expect(await retire(org.stub, [gone.principalId])).toMatchObject({ state: "done", removed: 3 });
    expect(await held(org.stub, gone.principalId)).toEqual({
      members: 0,
      teams: 0,
      collaborators: 0,
    });
    expect(await org.stub.aclVersion()).toBe(before + 1);
    // Again: nothing left, nothing bumped.
    expect(await retire(org.stub, [gone.principalId])).toMatchObject({ state: "done", removed: 0 });
    expect(await org.stub.aclVersion()).toBe(before + 1);
  });

  it("delivers its audit row from the alarm", async () => {
    const owner = await user();
    const gone = await user();
    const org = await newOrg(owner);
    await everywhere(org, owner, gone);
    // Deliver what the setup audited, then start from no alarm.
    await runDurableObjectAlarm(org.stub);
    await runInDurableObject(org.stub, (_: OrgDO, state) => state.storage.deleteAlarm());
    await retire(org.stub, [gone.principalId]);
    await runDurableObjectAlarm(org.stub);
    const row = await env.DIRECTORY.prepare(
      "SELECT actor_id, details FROM audit_log WHERE target_id = ? AND action = 'principal.retire'",
    )
      .bind(org.id)
      .first<{ actor_id: string; details: string }>();
    expect(row?.actor_id).toBe(admin.principalId);
    expect(JSON.parse(row?.details ?? "{}")).toMatchObject({
      principals: [gone.principalId],
      job: "job_test",
      removed: 3,
    });
  });

  it("goes a page at a time within its budget", async () => {
    const owner = await user();
    const gone = await user();
    const org = await newOrg(owner);
    await everywhere(org, owner, gone);
    expect(await retire(org.stub, [gone.principalId], { budget: 2 })).toMatchObject({
      state: "more",
      removed: 2,
    });
    expect(await retire(org.stub, [gone.principalId], { budget: 2 })).toMatchObject({
      state: "done",
      removed: 1,
    });
  });

  it("removes no more rows of one kind than its budget", async () => {
    const owner = await user();
    const gone = await user();
    for (let i = 0; i < 3; i++) {
      const repo = (
        await json<{ name: string }>(
          api("POST", "/user/repos", owner.token, { name: uniqueId("granted") }),
        )
      ).body;
      await ok(
        api(
          "PUT",
          `/repos/${owner.handle}/${repo.name}/collaborators/${gone.handle}`,
          owner.token,
          {
            permission: "pull",
          },
        ),
      );
    }
    const account = env.ORG.getByName(owner.principalId);
    expect(await retire(account, [gone.principalId], { budget: 2 })).toMatchObject({
      state: "more",
      removed: 2,
    });
    expect((await held(account, gone.principalId)).collaborators).toBe(1);
    expect(await retire(account, [gone.principalId], { budget: 2 })).toMatchObject({
      state: "done",
      removed: 1,
    });
  });

  it("never removes an organization's last owner, unless it was never published", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    expect(await retire(org.stub, [owner.principalId])).toMatchObject({ state: "sole_owner" });
    expect((await held(org.stub, owner.principalId)).members).toBe(1);
    // Nor all its owners at once.
    const second = await user();
    await ok(
      api("PUT", `/orgs/${org.login}/memberships/${second.handle}`, owner.token, { role: "admin" }),
    );
    expect(await retire(org.stub, [owner.principalId, second.principalId])).toMatchObject({
      state: "sole_owner",
    });
    expect((await held(org.stub, second.principalId)).members).toBe(1);
    // With another owner (whatever its state), it goes.
    const other = await user();
    await ok(
      api("PUT", `/orgs/${org.login}/memberships/${other.handle}`, owner.token, { role: "admin" }),
    );
    await markDeleting(other.principalId);
    expect(await retire(org.stub, [owner.principalId])).toMatchObject({
      state: "done",
      removed: 1,
    });
    // An object whose organization was never published has no one to keep.
    const orphan = await newOrg(await user());
    const sole = (
      await runInDurableObject(orphan.stub, (_: OrgDO, state) =>
        state.storage.sql.exec<{ p: string }>("SELECT principal_id AS p FROM members").one(),
      )
    ).p;
    expect(await retire(orphan.stub, [sole], { ownerCheck: false })).toMatchObject({
      state: "done",
      removed: 1,
    });
  });

  it("adds none of them back in that object, even an addition already past its checks", async () => {
    const owner = await user();
    const gone = await user();
    const org = await newOrg(owner);
    // The addition read the user's state (active), then the retirement landed.
    accountHooks.afterLifecycleRead = (account) =>
      account
        .retirePrincipals({
          ids: [gone.principalId],
          jobId: "job_test",
          actor: { principalId: admin.principalId },
          ownerCheck: true,
          budget: 500,
        })
        .then(() => {});
    expect(
      await org.stub.setMember(
        { principalId: owner.principalId },
        { id: gone.principalId, handle: gone.handle },
        "member",
      ),
    ).toMatchObject({ ok: false, code: "principal_gone" });
    expect(await held(org.stub, gone.principalId)).toMatchObject({ members: 0 });
  });

  it("adds no one being deleted, in any object, nor makes them an organization's first owner", async () => {
    const owner = await user();
    const gone = await user();
    const org = await newOrg(owner);
    const { team, repo } = await everywhere(org, owner, await user());
    await markDeleting(gone.principalId);
    const actor = { principalId: owner.principalId };
    const who = { id: gone.principalId, handle: gone.handle };
    expect(await org.stub.setMember(actor, who, "member")).toMatchObject({
      code: "principal_gone",
    });
    expect(await org.stub.setTeamMember(actor, team, gone.principalId)).toMatchObject({
      code: "principal_gone",
    });
    const repoId = (
      await env.DIRECTORY.prepare("SELECT id FROM repos WHERE name = ?")
        .bind(repo.name)
        .first<{ id: string }>()
    )?.id as string;
    expect(await org.stub.setCollaborator(actor, repoId, who, "write")).toMatchObject({
      code: "principal_gone",
    });
    expect(await held(org.stub, gone.principalId)).toEqual({
      members: 0,
      teams: 0,
      collaborators: 0,
    });
    const fresh = env.ORG.getByName(`org_${uniqueId("x").replace(/[^a-z0-9]/g, "")}`);
    expect(
      await fresh.init({
        accountId: "org_fresh",
        kind: "org",
        owner: who,
        epochGen: 1,
      }),
    ).toMatchObject({ ok: false, code: "owner_gone" });
  });

  it("takes in a repository's collaborators whatever their number, but none being deleted", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    // More collaborators than one lifecycle read takes; one of them being deleted.
    const ids = Array.from(
      { length: 95 },
      (_, i) => `usr_${uniqueId(`c${i}`).replace(/[^a-z0-9]/gi, "")}`,
    );
    await env.DIRECTORY.batch(
      ids.map((id) =>
        env.DIRECTORY.prepare(
          "INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'user', ?, 0)",
        ).bind(id, id.toLowerCase().replace("_", "-").slice(0, 39)),
      ),
    );
    await markDeleting(ids[92] as string);
    const repoId = `rep_${uniqueId("arriving").replace(/[^a-z0-9]/gi, "")}`;
    await org.stub.adoptRepo(`trf_${uniqueId("t")}`, repoId, {
      collaborators: ids.map((principalId) => ({ principalId, handle: principalId, role: "read" })),
      usageBytes: 0,
    });
    const taken = await runInDurableObject(org.stub, (_: OrgDO, state) =>
      state.storage.sql
        .exec<{ p: string }>(
          "SELECT principal_id AS p FROM collaborators WHERE repo_id = ?",
          repoId,
        )
        .toArray()
        .map((r) => r.p),
    );
    expect(taken.length).toBe(94);
    expect(taken).not.toContain(ids[92]);
  });

  it("hands no collaborator being deleted to the account a repository moves to", async () => {
    const owner = await user();
    const gone = await user();
    const kept = await user();
    const repo = (
      await json<{ id: string; name: string }>(
        api("POST", "/user/repos", owner.token, { name: uniqueId("moving") }),
      )
    ).body;
    for (const who of [gone, kept])
      await ok(
        api("PUT", `/repos/${owner.handle}/${repo.name}/collaborators/${who.handle}`, owner.token, {
          permission: "push",
        }),
      );
    const org = await newOrg(owner);
    await markDeleting(gone.principalId);
    const moved = await json<{ state: string }>(
      api("POST", `/repos/${owner.handle}/${repo.name}/transfer`, owner.token, {
        new_owner: org.login,
      }),
    );
    expect(moved.body.state).toBe("transferred");
    expect((await held(org.stub, gone.principalId)).collaborators).toBe(0);
    expect((await held(org.stub, kept.principalId)).collaborators).toBe(1);
  });
});
