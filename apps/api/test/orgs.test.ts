import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { principalWithToken } from "./helpers/principals.js";

const ORIGIN = "https://fyrden.test";

type Who = { principalId: string; token: string; handle: string };

async function who(type: "user" | "agent" = "user", admin = false): Promise<Who> {
  const p = await principalWithToken(type, "pat", { admin });
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
  admin = await who("user", true);
});

/** A new organization with `owner` as its first owner. */
async function newOrg(owner: Who): Promise<{ id: string; login: string }> {
  const login = uniqueId("org").slice(0, 39);
  const res = await api("POST", "/admin/organizations", admin.token, {
    login,
    admin: owner.handle,
  });
  expect(res.status).toBe(201);
  return res.json<{ id: string; login: string }>();
}

const setRole = (org: string, user: Who, role: string | undefined, token: string) =>
  api("PUT", `/orgs/${org}/memberships/${user.handle}`, token, role ? { role } : {});

async function members(org: string, token: string) {
  const res = await api("GET", `/orgs/${org}/members?per_page=100`, token);
  if (!res.ok) return outcome(res);
  return (await res.json<{ members: { login: string; role: string }[] }>()).members
    .map((m) => `${m.login}:${m.role}`)
    .sort();
}

describe("organizations", () => {
  it("are created by an instance administrator with a first owner", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    expect(org).toMatchObject({ id: expect.stringMatching(/^org_/), login: org.login });
    const row = await env.DIRECTORY.prepare("SELECT type, handle FROM principals WHERE id = ?")
      .bind(org.id)
      .first();
    expect(row).toEqual({ type: "org", handle: org.login });
    expect(await env.ORG.getByName(org.id).accountRole(owner.principalId)).toBe("owner");
    expect(await members(org.login, owner.token)).toEqual([`${owner.handle}:admin`]);
  });

  it("refuse a taken handle, an unknown first owner and a caller who is not an administrator", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const again = await api("POST", "/admin/organizations", admin.token, {
      login: org.login.toUpperCase(),
      admin: owner.handle,
    });
    expect(await outcome(again)).toEqual({ status: 409, code: "handle_taken" });
    const reserved = await api("POST", "/admin/organizations", admin.token, {
      login: "oauth",
      admin: owner.handle,
    });
    expect(await outcome(reserved)).toEqual({ status: 422, code: "invalid_input" });
    const asUser = await api("POST", "/admin/organizations", owner.token, {
      login: uniqueId("org").slice(0, 39),
      admin: owner.handle,
    });
    expect(asUser.status).toBe(403);
    const unknown = await api("POST", "/admin/organizations", admin.token, {
      login: uniqueId("org").slice(0, 39),
      admin: "no-such-user",
    });
    expect(await outcome(unknown)).toEqual({ status: 404, code: "user_not_found" });
  });
});

describe("memberships", () => {
  it("are added, changed and removed by owners, and in force at once", async () => {
    const owner = await who();
    const alice = await who();
    const org = await newOrg(owner);
    expect(await (await setRole(org.login, alice, undefined, owner.token)).json()).toEqual({
      org: org.login,
      user: alice.handle,
      role: "member",
      state: "active",
    });
    expect(await members(org.login, alice.token)).toEqual(
      [`${owner.handle}:admin`, `${alice.handle}:member`].sort(),
    );
    // A member may not change memberships.
    const bob = await who();
    expect(await outcome(await setRole(org.login, bob, "member", alice.token))).toEqual({
      status: 403,
      code: "forbidden",
    });
    expect((await setRole(org.login, alice, "admin", owner.token)).status).toBe(200);
    expect(await env.ORG.getByName(org.id).accountRole(alice.principalId)).toBe("owner");

    const versionBefore = await env.ORG.getByName(org.id).aclVersion();
    const removed = await api(
      "DELETE",
      `/orgs/${org.login}/memberships/${alice.handle}`,
      owner.token,
    );
    expect(await removed.json()).toEqual({ org: org.login, user: alice.handle, state: "removed" });
    // In force when the call returned.
    expect(await env.ORG.getByName(org.id).accountRole(alice.principalId)).toBeNull();
    expect(await env.ORG.getByName(org.id).aclVersion()).toBe(versionBefore + 1);
    expect(await members(org.login, alice.token)).toEqual({ status: 404, code: "org_not_found" });
    // Removing again changes nothing and still answers.
    const again = await api(
      "DELETE",
      `/orgs/${org.login}/memberships/${alice.handle}`,
      owner.token,
    );
    expect(again.status).toBe(200);

    // Each change's audit row reaches the directory (a removal of no member writes none).
    await env.ORG.getByName(org.id).deliverAudit();
    const audit = await env.DIRECTORY.prepare(
      "SELECT action, actor_id FROM audit_log WHERE target_id = ? ORDER BY seq",
    )
      .bind(org.id)
      .all<{ action: string; actor_id: string }>();
    expect(audit.results).toEqual([
      { action: "org.create", actor_id: admin.principalId },
      { action: "org.member.set", actor_id: owner.principalId },
      { action: "org.member.set", actor_id: owner.principalId },
      { action: "org.member.remove", actor_id: owner.principalId },
    ]);
  });

  it("are changed only by a caller who is an owner when the change is made", async () => {
    const owner = await who();
    const bob = await who();
    const org = await newOrg(owner);
    expect((await setRole(org.login, bob, "admin", owner.token)).status).toBe(200);
    // Bob passed the API's check, then lost the role before his change reached the object.
    expect((await setRole(org.login, bob, "member", owner.token)).status).toBe(200);
    const stub = env.ORG.getByName(org.id);
    expect(
      await stub.setMember(
        { principalId: bob.principalId },
        { id: bob.principalId, handle: bob.handle },
        "owner",
      ),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await stub.removeMember({ principalId: bob.principalId }, owner.principalId),
    ).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await stub.accountRole(bob.principalId)).toBe("member");
  });

  it("can remove a disabled user", async () => {
    const owner = await who();
    const gone = await who();
    const org = await newOrg(owner);
    expect((await setRole(org.login, gone, "member", owner.token)).status).toBe(200);
    await env.DIRECTORY.prepare("UPDATE principals SET disabled_at = 1 WHERE id = ?")
      .bind(gone.principalId)
      .run();
    // Not addable again, but removable.
    expect(await outcome(await setRole(org.login, gone, "admin", owner.token))).toEqual({
      status: 404,
      code: "user_not_found",
    });
    const removed = await api(
      "DELETE",
      `/orgs/${org.login}/memberships/${gone.handle}`,
      owner.token,
    );
    expect(removed.status).toBe(200);
    expect(await env.ORG.getByName(org.id).accountRole(gone.principalId)).toBeNull();
  });

  it("deliver their audit rows from the alarm when the request did not", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const stub = env.ORG.getByName(org.id);
    const carol = await who();
    expect(
      await stub.setMember(
        { principalId: owner.principalId },
        { id: carol.principalId, handle: carol.handle },
        "member",
      ),
    ).toMatchObject({ ok: true, changed: true });
    const count = async () =>
      (
        await env.DIRECTORY.prepare(
          "SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'org.member.set'",
        )
          .bind(org.id)
          .first<{ n: number }>()
      )?.n;
    expect(await count()).toBe(0);
    // A later change keeps the delivery already due rather than pushing it back.
    const due = await runInDurableObject(stub, (_: unknown, state) => state.storage.getAlarm());
    const soon = Date.now() + 10_000;
    await runInDurableObject(stub, (_: unknown, state) => state.storage.setAlarm(soon));
    const dave = await who();
    await stub.setMember(
      { principalId: owner.principalId },
      { id: dave.principalId, handle: dave.handle },
      "member",
    );
    expect(await runInDurableObject(stub, (_: unknown, state) => state.storage.getAlarm())).toBe(
      soon,
    );
    expect(due).not.toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await count()).toBe(2);
  });

  it("keep the last owner", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    expect(await outcome(await setRole(org.login, owner, "member", owner.token))).toEqual({
      status: 409,
      code: "last_owner",
    });
    const leave = await api(
      "DELETE",
      `/orgs/${org.login}/memberships/${owner.handle}`,
      owner.token,
    );
    expect(await outcome(leave)).toEqual({ status: 409, code: "last_owner" });
    // With a second owner, the first may step down.
    const second = await who();
    expect((await setRole(org.login, second, "admin", owner.token)).status).toBe(200);
    expect((await setRole(org.login, owner, "member", owner.token)).status).toBe(200);
  });

  it("answer an organization the caller is not in, or a user's handle, as not found", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const stranger = await who();
    expect(await members(org.login, stranger.token)).toEqual({
      status: 404,
      code: "org_not_found",
    });
    expect(await members(owner.handle, owner.token)).toEqual({
      status: 404,
      code: "org_not_found",
    });
    expect(await outcome(await setRole(org.login, stranger, "member", stranger.token))).toEqual({
      status: 404,
      code: "org_not_found",
    });
  });

  it("are only for users, and only users manage them", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const agent = await who("agent");
    expect(await outcome(await setRole(org.login, agent, "member", owner.token))).toEqual({
      status: 404,
      code: "user_not_found",
    });
    expect((await setRole(org.login, owner, "admin", agent.token)).status).toBe(403);
  });

  it("are listed a page at a time", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    for (let i = 0; i < 3; i++)
      expect((await setRole(org.login, await who(), "member", owner.token)).status).toBe(200);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await api(
        "GET",
        `/orgs/${org.login}/members?per_page=2${cursor ? `&cursor=${cursor}` : ""}`,
        owner.token,
      );
      const page = await res.json<{ members: { login: string }[]; next_cursor: string | null }>();
      seen.push(...page.members.map((m) => m.login));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });
});
