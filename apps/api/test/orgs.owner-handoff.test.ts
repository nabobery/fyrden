// An instance administrator making a user an organization's owner, as GitHub
// Enterprise's `ghe-org-admin-promote` does: what lets a user deletion that
// waits on an organization they solely own go on.
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { api, json, user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";

let admin: Who;

beforeAll(async () => {
  admin = await user(true);
});

async function newOrg(owner: Who) {
  const login = uniqueId("org").slice(0, 39);
  const made = await json<{ id: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  expect(made.status).toBe(201);
  return { login, id: made.body.id, stub: env.ORG.getByName(made.body.id) };
}

const handOver = (org: string, to: Who, by = admin) =>
  api("PUT", `/admin/organizations/${org}/owners/${to.handle}`, by.token);

const audited = async (orgId: string) =>
  (
    await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'org.owner_handoff'",
    )
      .bind(orgId)
      .first<{ n: number }>()
  )?.n;

describe("an administrator handing an organization to a new owner", () => {
  it("makes a user an owner of an organization they are not in, once", async () => {
    const alice = await user();
    const bob = await user();
    const org = await newOrg(alice);
    const res = await handOver(org.login, bob);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await org.stub.accountRole(bob.principalId)).toBe("owner");
    await org.stub.deliverAudit();
    expect(await audited(org.id)).toBe(1);
    // Again: nothing more.
    expect((await handOver(org.login, bob)).status).toBe(204);
    await org.stub.deliverAudit();
    expect(await audited(org.id)).toBe(1);
    // Alice is no longer its only owner: her retirement may remove her.
    expect(
      await org.stub.retirePrincipals({
        ids: [alice.principalId],
        jobId: "job_test",
        actor: { principalId: admin.principalId },
        ownerCheck: true,
        budget: 500,
      }),
    ).toMatchObject({ state: "done", removed: 1 });
  });

  it("replays a repeated request with the same key, with no body, and audits the administrator", async () => {
    const alice = await user();
    const bob = await user();
    const org = await newOrg(alice);
    const key = crypto.randomUUID();
    const send = () =>
      exports.default.fetch(`${ORIGIN}/api/admin/organizations/${org.login}/owners/${bob.handle}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${admin.token}`, "Idempotency-Key": key },
      });
    expect((await send()).status).toBe(204);
    const version = await org.stub.aclVersion();
    const again = await send();
    expect(again.status).toBe(204);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await again.text()).toBe("");
    expect(await org.stub.aclVersion()).toBe(version);
    await org.stub.deliverAudit();
    const row = await env.DIRECTORY.prepare(
      "SELECT actor_id, details FROM audit_log WHERE target_id = ? AND action = 'org.owner_handoff'",
    )
      .bind(org.id)
      .first<{ actor_id: string; details: string }>();
    expect(row?.actor_id).toBe(admin.principalId);
    expect(JSON.parse(row?.details ?? "{}")).toMatchObject({ user: bob.principalId });
  });

  it("promotes a member to owner", async () => {
    const alice = await user();
    const bob = await user();
    const org = await newOrg(alice);
    expect(
      (
        await api("PUT", `/orgs/${org.login}/memberships/${bob.handle}`, alice.token, {
          role: "member",
        })
      ).status,
    ).toBe(200);
    expect((await handOver(org.login, bob)).status).toBe(204);
    expect(await org.stub.accountRole(bob.principalId)).toBe("owner");
  });

  it("is for instance administrators only, of organizations and users that exist", async () => {
    const alice = await user();
    const bob = await user();
    const org = await newOrg(alice);
    expect((await handOver(org.login, bob, alice)).status).toBe(403);
    expect(await json(handOver(uniqueId("none").slice(0, 30), bob))).toMatchObject({
      status: 404,
      body: { code: "org_not_found" },
    });
    expect(await json(handOver(alice.handle, bob))).toMatchObject({
      status: 404,
      body: { code: "org_not_found" },
    });
    await env.DIRECTORY.prepare(
      `UPDATE principals SET lifecycle = 'deleting', disabled_at = 1,
         lifecycle_gen = lifecycle_gen + 1 WHERE id = ?`,
    )
      .bind(bob.principalId)
      .run();
    expect(await json(handOver(org.login, bob))).toMatchObject({
      status: 404,
      body: { code: "user_not_found" },
    });
    expect(await org.stub.accountRole(bob.principalId)).toBeNull();
    // The organization's object refuses them itself (a deletion begun after the Worker's check).
    expect(
      await org.stub.handOwnership(
        { principalId: admin.principalId },
        { id: bob.principalId, handle: bob.handle },
      ),
    ).toMatchObject({ ok: false, code: "principal_gone" });
    // And a user's own account is no organization.
    expect(
      await env.ORG.getByName(alice.principalId).handOwnership(
        { principalId: admin.principalId },
        { id: alice.principalId, handle: alice.handle },
      ),
    ).toMatchObject({ ok: false });
  });
});
