import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { teamSlug } from "../src/accounts/grants.js";
import { MAX_SNAPSHOT_ENTRIES, type OrgDO } from "../src/do/OrgDO.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";

const ORIGIN = "https://fyrden.test";

type Who = { principalId: string; token: string; handle: string };

async function who(admin = false): Promise<Who> {
  const p = await principalWithToken("user", "pat", { admin });
  return { ...p, handle: p.principalId.toLowerCase().replace("_", "-") };
}

function api(method: string, path: string, token: string, body?: unknown) {
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

async function outcome(res: Response): Promise<{ status: number; code?: string }> {
  if (res.ok) return { status: res.status };
  return { status: res.status, code: (await res.json<{ code: string }>()).code };
}

let admin: Who;

beforeAll(async () => {
  admin = await who(true);
});

/** `user`'s role on the repository, as its object decides it for a write. */
async function roleOf(repoId: string, user: Who) {
  return env.REPO.getByName(repoId).roleOf(user.principalId, "write");
}

async function userRepo(owner: Who) {
  const res = await api("POST", "/user/repos", owner.token, { name: uniqueId("collab") });
  expect(res.status).toBe(201);
  return res.json<{ id: string; name: string; full_name: string }>();
}

async function org(owner: Who, members: Who[] = []) {
  const login = uniqueId("team").slice(0, 39);
  const res = await api("POST", "/admin/organizations", admin.token, {
    login,
    admin: owner.handle,
  });
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: string }>();
  for (const m of members)
    expect(
      (await api("PUT", `/orgs/${login}/memberships/${m.handle}`, owner.token, {})).status,
    ).toBe(200);
  const repoRes = await api("POST", `/orgs/${login}/repos`, owner.token, { name: "app" });
  expect(repoRes.status).toBe(201);
  const repo = await repoRes.json<{ id: string }>();
  return { login, id, repo };
}

describe("collaborators", () => {
  it("get a role on a user's repository, in force when the call returns, both ways", async () => {
    const owner = await who();
    const bob = await who();
    const repo = await userRepo(owner);
    const path = `/repos/${repo.full_name}/collaborators/${bob.handle}`;
    expect(await roleOf(repo.id, bob)).toBeNull();
    const added = await api("PUT", path, owner.token, { permission: "push" });
    expect(await added.json()).toEqual({
      repo: repo.full_name,
      user: bob.handle,
      permission: "push",
    });
    expect(await roleOf(repo.id, bob)).toBe("write");
    expect((await api("GET", `/repos/${repo.full_name}`, bob.token)).status).toBe(200);
    // A writer is no administrator.
    expect(
      (await api("PATCH", `/repos/${repo.full_name}`, bob.token, { description: "x" })).status,
    ).toBe(404);
    const list = await api("GET", `/repos/${repo.full_name}/collaborators`, bob.token);
    expect((await list.json<{ collaborators: unknown[] }>()).collaborators).toEqual([
      { id: bob.principalId, login: bob.handle, permission: "push" },
    ]);
    // The user's account object was recorded for it.
    expect(await env.ORG.getByName((await whoOwns(repo.id)) as string).isRecorded()).toBe(true);

    expect((await api("DELETE", path, owner.token)).status).toBe(200);
    expect(await roleOf(repo.id, bob)).toBeNull();
    expect((await api("GET", `/repos/${repo.full_name}`, bob.token)).status).toBe(404);
    // Removing again answers all the same.
    expect((await api("DELETE", path, owner.token)).status).toBe(200);
  });

  it("are refused past the snapshot's limit, and the owner can still remove them", async () => {
    const owner = await who();
    const bob = await who();
    const repo = await userRepo(owner);
    const accountId = (await whoOwns(repo.id)) as string;
    // Recorded through the API, then filled to the limit (the owner is one).
    await api("PUT", `/repos/${repo.full_name}/collaborators/${bob.handle}`, owner.token, {
      permission: "pull",
    });
    const stub = env.ORG.getByName(accountId);
    await runInDurableObject(stub, (_: OrgDO, state) => {
      for (let i = 0; i < MAX_SNAPSHOT_ENTRIES - 2; i++)
        state.storage.sql.exec(
          "INSERT INTO collaborators (repo_id, principal_id, handle, role, added_at) VALUES (?, ?, ?, 'read', 0)",
          repo.id,
          `usr_filler${i}`,
          `filler-${i}`,
        );
    });
    expect(Object.keys((await stub.snapshotFor(repo.id)).roles)).toHaveLength(MAX_SNAPSHOT_ENTRIES);
    const carol = await who();
    expect(
      await outcome(
        await api("PUT", `/repos/${repo.full_name}/collaborators/${carol.handle}`, owner.token, {
          permission: "pull",
        }),
      ),
    ).toEqual({ status: 409, code: "too_many" });
    // Undone: nothing was added, and changing an existing collaborator's role still works.
    expect(await roleOf(repo.id, carol)).toBeNull();
    expect(
      (
        await api("PUT", `/repos/${repo.full_name}/collaborators/${bob.handle}`, owner.token, {
          permission: "push",
        })
      ).status,
    ).toBe(200);
    expect(await roleOf(repo.id, bob)).toBe("write");
    expect(
      (await api("DELETE", `/repos/${repo.full_name}/collaborators/${bob.handle}`, owner.token))
        .status,
    ).toBe(200);
    expect(await roleOf(repo.id, bob)).toBeNull();
  });

  it("past the snapshot's limit are not added to an organization, and nothing is recorded", async () => {
    const owner = await who();
    const dev = await who();
    const { login, id } = await org(owner);
    const stub = env.ORG.getByName(id);
    await runInDurableObject(stub, (_: OrgDO, state) => {
      for (let i = 0; i < MAX_SNAPSHOT_ENTRIES - 1; i++)
        state.storage.sql.exec(
          "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 0)",
          `usr_filler${i}`,
          `filler-${i}`,
        );
    });
    const audit = () =>
      runInDurableObject(stub, (_: OrgDO, state) =>
        state.storage.sql.exec("SELECT count(*) AS n FROM pending_audit").one(),
      );
    const before = { version: await stub.aclVersion(), audit: await audit() };
    expect(
      await outcome(await api("PUT", `/orgs/${login}/memberships/${dev.handle}`, owner.token, {})),
    ).toEqual({ status: 409, code: "too_many" });
    expect(await stub.accountRole(dev.principalId)).toBeNull();
    expect({ version: await stub.aclVersion(), audit: await audit() }).toEqual(before);
  });

  it("are not recorded again for a repository deleted meanwhile", async () => {
    const owner = await who();
    const bob = await who();
    const repo = await userRepo(owner);
    const accountId = (await whoOwns(repo.id)) as string;
    await api("PUT", `/repos/${repo.full_name}/collaborators/${bob.handle}`, owner.token, {
      permission: "push",
    });
    const stub = env.ORG.getByName(accountId);
    // The deletion's clean-up reaches the account first; the grant was already on its way.
    await stub.forgetRepo(repo.id);
    expect(await stub.collaborators(repo.id, "", 10)).toEqual([]);
    expect(
      await stub.setCollaborator(
        { principalId: owner.principalId },
        repo.id,
        { id: bob.principalId, handle: bob.handle },
        "admin",
      ),
    ).toMatchObject({ ok: false, code: "repo_gone" });
    expect(await stub.collaborators(repo.id, "", 10)).toEqual([]);
  });

  it("are added only by an administrator of the repository", async () => {
    const owner = await who();
    const bob = await who();
    const carol = await who();
    const repo = await userRepo(owner);
    await api("PUT", `/repos/${repo.full_name}/collaborators/${bob.handle}`, owner.token, {
      permission: "maintain",
    });
    // A maintainer cannot add collaborators: the API answers as if there were no repository.
    const byBob = await api(
      "PUT",
      `/repos/${repo.full_name}/collaborators/${carol.handle}`,
      bob.token,
      {
        permission: "admin",
      },
    );
    expect(byBob.status).toBe(404);
    // Nor through the account object directly.
    const stub = env.ORG.getByName(owner.principalId);
    expect(
      await stub.setCollaborator(
        { principalId: bob.principalId },
        repo.id,
        { id: carol.principalId, handle: carol.handle },
        "admin",
      ),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("give outside collaborators a role on an organization's repository", async () => {
    const owner = await who();
    const outsider = await who();
    const { login, repo } = await org(owner);
    const res = await api(
      "PUT",
      `/repos/${login}/app/collaborators/${outsider.handle}`,
      owner.token,
      { permission: "triage" },
    );
    expect(res.status).toBe(200);
    expect(await roleOf(repo.id, outsider)).toBe("triage");
  });
});

describe("teams", () => {
  it("give their members their role on a repository, the strongest role winning", async () => {
    const owner = await who();
    const dev = await who();
    const { login, repo } = await org(owner, [dev]);
    expect(await roleOf(repo.id, dev)).toBe("read");

    const created = await api("POST", `/orgs/${login}/teams`, owner.token, { name: "Core Devs!" });
    expect(await created.json()).toEqual({ slug: "core-devs", name: "Core Devs!" });
    expect(
      (
        await api("PUT", `/orgs/${login}/teams/core-devs/repos/${login}/app`, owner.token, {
          permission: "maintain",
        })
      ).status,
    ).toBe(200);
    // Not on the team yet.
    expect(await roleOf(repo.id, dev)).toBe("read");
    const join = await api(
      "PUT",
      `/orgs/${login}/teams/core-devs/memberships/${dev.handle}`,
      owner.token,
    );
    expect(await join.json()).toEqual({ team: "core-devs", user: dev.handle, state: "active" });
    expect(await roleOf(repo.id, dev)).toBe("maintain");

    expect(
      (await api("DELETE", `/orgs/${login}/teams/core-devs/repos/${login}/app`, owner.token))
        .status,
    ).toBe(200);
    expect(await roleOf(repo.id, dev)).toBe("read");

    const teams = await api("GET", `/orgs/${login}/teams`, dev.token);
    expect((await teams.json<{ teams: unknown[] }>()).teams).toEqual([
      { slug: "core-devs", name: "Core Devs!" },
    ]);
  });

  it("take only members of the organization, and lose those who leave it", async () => {
    const owner = await who();
    const dev = await who();
    const outsider = await who();
    const { login, repo } = await org(owner, [dev]);
    await api("POST", `/orgs/${login}/teams`, owner.token, { name: "ops" });
    await api("PUT", `/orgs/${login}/teams/ops/repos/${login}/app`, owner.token, {
      permission: "admin",
    });
    expect(
      await outcome(
        await api("PUT", `/orgs/${login}/teams/ops/memberships/${outsider.handle}`, owner.token),
      ),
    ).toEqual({ status: 422, code: "not_a_member" });
    await api("PUT", `/orgs/${login}/teams/ops/memberships/${dev.handle}`, owner.token);
    expect(await roleOf(repo.id, dev)).toBe("admin");
    // Leaving the organization leaves its teams, at once.
    expect(
      (await api("DELETE", `/orgs/${login}/memberships/${dev.handle}`, owner.token)).status,
    ).toBe(200);
    expect(await roleOf(repo.id, dev)).toBeNull();
    // Rejoining does not bring the team back.
    await api("PUT", `/orgs/${login}/memberships/${dev.handle}`, owner.token, {});
    expect(await roleOf(repo.id, dev)).toBe("read");
  });

  it("are managed by owners only, on the organization's own repositories", async () => {
    const owner = await who();
    const dev = await who();
    const { login } = await org(owner, [dev]);
    expect(
      await outcome(await api("POST", `/orgs/${login}/teams`, dev.token, { name: "x" })),
    ).toEqual({
      status: 403,
      code: "forbidden",
    });
    await api("POST", `/orgs/${login}/teams`, owner.token, { name: "x" });
    expect(
      await outcome(await api("POST", `/orgs/${login}/teams`, owner.token, { name: "X" })),
    ).toEqual({ status: 409, code: "team_taken" });
    // Another account's repository is not one the team can be given.
    const other = await who();
    const theirs = await userRepo(other);
    expect(
      await outcome(
        await api("PUT", `/orgs/${login}/teams/x/repos/${theirs.full_name}`, owner.token, {
          permission: "pull",
        }),
      ),
    ).toEqual({ status: 404, code: "repo_not_found" });
    expect(
      await outcome(
        await api("PUT", `/orgs/${login}/teams/missing/memberships/${dev.handle}`, owner.token),
      ),
    ).toEqual({ status: 404, code: "team_not_found" });
  });

  it("give each member the strongest of the roles its teams have, however many members they have", async () => {
    const owner = await who();
    const dev = await who();
    const { login, id, repo } = await org(owner, [dev]);
    for (const name of ["readers-a", "readers-b", "admins"])
      await api("POST", `/orgs/${login}/teams`, owner.token, { name });
    for (const [team, permission] of [
      ["readers-a", "pull"],
      ["readers-b", "pull"],
      ["admins", "admin"],
    ])
      await api("PUT", `/orgs/${login}/teams/${team}/repos/${login}/app`, owner.token, {
        permission,
      });
    for (const team of ["readers-a", "readers-b", "admins"])
      await api("PUT", `/orgs/${login}/teams/${team}/memberships/${dev.handle}`, owner.token);
    // Enough members in both reading teams that their grants outnumber the snapshot's limit.
    const filler = Math.ceil(MAX_SNAPSHOT_ENTRIES / 2) + 100;
    await runInDurableObject(env.ORG.getByName(id), (_: OrgDO, state) => {
      const sql = state.storage.sql;
      for (let i = 0; i < filler; i++) {
        sql.exec(
          "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 0)",
          `usr_filler${i}`,
          `filler-${i}`,
        );
        sql.exec(
          `INSERT INTO team_members (team_id, principal_id, added_at)
           SELECT team_id, ?, 0 FROM teams WHERE slug IN ('readers-a', 'readers-b')`,
          `usr_filler${i}`,
        );
      }
    });
    const snapshot = await env.ORG.getByName(id).snapshotFor(repo.id);
    expect(snapshot.roles[dev.principalId]).toBe("admin");
    expect(snapshot.roles[owner.principalId]).toBe("admin");
    expect(Object.keys(snapshot.roles)).toHaveLength(filler + 2);
  });

  it("refuse a repository the token is not restricted to", async () => {
    const owner = await who();
    const { login, id, repo } = await org(owner);
    const other = await api("POST", `/orgs/${login}/repos`, owner.token, { name: "other" });
    expect(other.status).toBe(201);
    await api("POST", `/orgs/${login}/teams`, owner.token, { name: "ops" });
    const token = await scopedToken(owner.principalId, [], "pat", [repo.id]);
    for (const [method, body] of [
      ["PUT", { permission: "admin" }],
      ["DELETE", undefined],
    ] as const)
      expect(
        await outcome(
          await api(method, `/orgs/${login}/teams/ops/repos/${login}/other`, token, body),
        ),
      ).toEqual({ status: 404, code: "repo_not_found" });
    expect(
      (
        await api("PUT", `/orgs/${login}/teams/ops/repos/${login}/app`, token, {
          permission: "admin",
        })
      ).status,
    ).toBe(200);
    // Nothing was granted on the other repository.
    const otherId = (await other.json<{ id: string }>()).id;
    const roles = await runInDurableObject(env.ORG.getByName(id), (_: OrgDO, state) =>
      state.storage.sql
        .exec("SELECT repo_id FROM team_repos")
        .toArray()
        .map((r) => r.repo_id),
    );
    expect(roles).toEqual([repo.id]);
    expect(roles).not.toContain(otherId);
  });

  it("are not given a repository deleted meanwhile", async () => {
    const owner = await who();
    const { login, id, repo } = await org(owner);
    await api("POST", `/orgs/${login}/teams`, owner.token, { name: "ops" });
    const stub = env.ORG.getByName(id);
    await stub.forgetRepo(repo.id);
    expect(
      await stub.setTeamRepo({ principalId: owner.principalId }, "ops", repo.id, "write"),
    ).toMatchObject({ ok: false, code: "repo_gone" });
  });

  it("have slugs made from their names", () => {
    expect(teamSlug("Core Devs!")).toBe("core-devs");
    expect(teamSlug("  --A__B--  ")).toBe("a-b");
    expect(teamSlug("!!!")).toBe("");
  });
});

async function whoOwns(repoId: string): Promise<string | undefined> {
  const row = await env.DIRECTORY.prepare("SELECT owner_id FROM repos WHERE id = ?")
    .bind(repoId)
    .first<{ owner_id: string }>();
  return row?.owner_id;
}

describe("a repository's owner kind", () => {
  it("is a user's or an organization's, as each repository read alone says", async () => {
    const owner = await who();
    const mine = await userRepo(owner);
    const theirs = await org(owner);
    const read = async (fullName: string) =>
      (await (await api("GET", `/repos/${fullName}`, owner.token)).json<{ owner_type?: string }>())
        .owner_type;
    expect(await read(mine.full_name)).toBe("User");
    expect(await read(`${theirs.login}/app`)).toBe("Organization");
  });
});
