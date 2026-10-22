// Deleting a user through the API (GitHub Enterprise's `DELETE /admin/users/
// {username}`, answered 202 with where the deletion is; asked again, by the
// released handle or the user's id, it answers the same), and the
// deletions' health.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { D1TokenStore } from "@fyrden/adapters-cloudflare/auth";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { deleteUserOperation } from "../src/accounts/deletion.js";
import { runDeletionSlice } from "../src/accounts/deletion-runner.js";
import { deepHealth } from "../src/health.js";
import type { OpContext } from "../src/ops/execute.js";
import { advanceDeletions } from "../src/repos/deletion.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";

type Deletion = {
  id: string;
  state: string;
  step: string;
  blocked: string | null;
  created_at: number;
  updated_at: number;
};

let admin: Who;

beforeAll(async () => {
  admin = await user(true);
});

const remove = (handle: string, by = admin) =>
  json<Deletion & { code?: string }>(api("DELETE", `/admin/users/${handle}`, by.token));
/** Where `id`'s deletion is: asked again, by the id. */
const status = (id: string, by = admin) => remove(id, by);

async function runToEnd(userId: string) {
  for (let i = 0; i < 60; i++) {
    const { body } = await status(userId);
    if (body.step === "done") return;
    await env.DIRECTORY.prepare("UPDATE user_deletions SET next_attempt_at = 0 WHERE user_id = ?")
      .bind(userId)
      .run();
    await advanceDeletions(env, { limit: 100 });
    await runDeletionSlice(env, userId);
  }
}

describe("DELETE /admin/users/{username}", () => {
  it("begins the deletion, answering 202 with where it is, and sets its runner going", async () => {
    const alice = await user();
    const res = await remove(alice.handle);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      id: alice.principalId,
      state: "deleting",
      step: "repositories",
      blocked: null,
    });
    // From now on she can do nothing.
    expect((await api("POST", "/user/tokens", alice.token, { type: "pat" })).status).toBe(401);
    const alarm = await runInDurableObject(env.DELETION.getByName(alice.principalId), (_, s) =>
      s.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
  });

  it("answers the same deletion when asked again, by the released handle", async () => {
    const bob = await user();
    const first = await remove(bob.handle);
    expect(first.status).toBe(202);
    const again = await remove(bob.handle);
    expect(again).toMatchObject({ status: 202, body: { id: bob.principalId, state: "deleting" } });
    expect(again.body.created_at).toBe(first.body.created_at);
  });

  it("is followed by the user's id to the end", async () => {
    const carol = await user();
    await json(api("POST", "/user/repos", carol.token, { name: uniqueId("r") }));
    expect((await remove(carol.handle)).status).toBe(202);
    await runToEnd(carol.principalId);
    expect(await status(carol.principalId)).toMatchObject({
      status: 202,
      body: { id: carol.principalId, state: "deleted", step: "done", blocked: null },
    });
  });

  it("refuses yourself, a caller who is not an administrator, and a name that is no user", async () => {
    const dave = await user();
    expect(await remove(admin.handle)).toMatchObject({
      status: 422,
      body: { code: "cannot_delete_self" },
    });
    expect((await remove(admin.handle, dave)).status).toBe(403);
    expect(
      await remove(
        uniqueId("nobody")
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 30),
      ),
    ).toMatchObject({
      status: 404,
      body: { code: "user_not_found" },
    });
    const org = uniqueId("org").slice(0, 39);
    expect(
      (await api("POST", "/admin/organizations", admin.token, { login: org, admin: dave.handle }))
        .status,
    ).toBe(201);
    expect(await remove(org)).toMatchObject({ status: 404, body: { code: "user_not_found" } });
  });

  it("deletes a suspended user", async () => {
    const gina = await user();
    expect((await api("PUT", `/users/${gina.handle}/suspended`, admin.token, {})).status).toBe(204);
    expect(await remove(gina.handle)).toMatchObject({
      status: 202,
      body: { id: gina.principalId, state: "deleting" },
    });
  });

  it("never deletes the last active administrator", async () => {
    const other = await user(true);
    // These two are the instance's only administrators (this file's earlier ones step down).
    await env.DIRECTORY.prepare(
      "UPDATE principals SET is_instance_admin = 0 WHERE is_instance_admin = 1 AND id NOT IN (?, ?)",
    )
      .bind(admin.principalId, other.principalId)
      .run();
    // `other`'s request was checked before `admin` deleted them, and lands after.
    const checked = await new D1TokenStore(env.DIRECTORY, {
      clock: () => Date.now(),
      newId: createIdFactory(() => Date.now(), secureRandomBytes),
      randomBytes: secureRandomBytes,
    }).verify(other.token, "write");
    if (!checked.ok) throw new Error(`the token is refused: ${checked.reason}`);
    expect((await remove(other.handle)).status).toBe(202);
    const stale = { env, auth: checked.record, metrics: { count() {} } } as unknown as OpContext;
    await expect(deleteUserOperation(stale, { username: admin.handle })).rejects.toMatchObject({
      code: "last_admin",
    });
  });

  it("is an MCP tool", async () => {
    const erin = await user();
    const call = (name: string, args: Record<string, unknown>) =>
      exports.default
        .fetch(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${admin.token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        })
        .then((r) => r.text());
    expect(await call("delete_user", { username: erin.handle })).toContain(erin.principalId);
    expect(await call("delete_user", { username: erin.principalId })).toContain("deleting");
  });
});

describe("the deletions' health", () => {
  it("reports a deletion waiting on an organization its user solely owns", async () => {
    const frank = await user();
    const org = uniqueId("org").slice(0, 39);
    expect(
      (await api("POST", "/admin/organizations", admin.token, { login: org, admin: frank.handle }))
        .status,
    ).toBe(201);
    expect((await remove(frank.handle)).status).toBe(202);
    for (let i = 0; i < 10; i++) {
      if ((await status(frank.principalId)).body.blocked) break;
      await env.DIRECTORY.prepare("UPDATE user_deletions SET next_attempt_at = 0 WHERE user_id = ?")
        .bind(frank.principalId)
        .run();
      await advanceDeletions(env, { limit: 100 });
      await runDeletionSlice(env, frank.principalId);
    }
    expect((await status(frank.principalId)).body.blocked).toMatch(/^sole_owner:org_/);
    const health = await deepHealth(env, {}, { count() {} });
    expect(health.rateLimited === false && health.report.checks.deletions).toMatchObject({
      ok: false,
      blocked: true,
    });
  });
});
