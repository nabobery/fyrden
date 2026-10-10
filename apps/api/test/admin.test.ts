import { env, exports } from "cloudflare:workers";
import { mentionsToken } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { principalWithToken } from "./helpers/principals.js";
import { logs } from "./setup/log-capture.js";

let adminToken = "";
let userToken = "";
let agentId = "";

beforeAll(async () => {
  ({ token: adminToken } = await principalWithToken("user", "pat", { admin: true }));
  ({ token: userToken } = await principalWithToken("user"));
  ({ principalId: agentId } = await principalWithToken("agent"));
});

const call = (path: string, token: string, body?: unknown, method = "POST") =>
  exports.default.fetch(`https://fyrden.test/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

// Handles are unique per file's D1 database; derive them from unique ids.
const freshHandle = () =>
  uniqueId("h")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 30);

describe("admin.users.create", () => {
  it("creates a user and records who did it", async () => {
    const handle = freshHandle();
    const res = await call("/admin/users", adminToken, { handle });
    expect(res.status).toBe(201);
    const user = await res.json<{ id: string; handle: string; type: string }>();
    expect(user).toMatchObject({ handle, type: "user" });
    expect(user.id).toMatch(/^usr_/);
    const audit = await env.DIRECTORY.prepare(
      "SELECT action, actor_id FROM audit_log WHERE target_id = ?",
    )
      .bind(user.id)
      .first<{ action: string; actor_id: string }>();
    expect(audit?.action).toBe("user.create");
  });

  it("refuses a handle that is taken, ignoring case", async () => {
    const handle = freshHandle();
    expect((await call("/admin/users", adminToken, { handle })).status).toBe(201);
    const res = await call("/admin/users", adminToken, { handle: handle.toUpperCase() });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "handle_taken" });
  });

  it.each(["", "-lead", "trail-", "two--hyphens", "x".repeat(40), "space here"])(
    "rejects the invalid handle %j",
    async (handle) => {
      const res = await call("/admin/users", adminToken, { handle });
      expect(res.status).toBe(422);
    },
  );

  it("is for instance administrators only", async () => {
    const res = await call("/admin/users", userToken, { handle: freshHandle() });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "missing_permission",
      missing_permission: "instance:admin",
    });
  });
});

describe("admin.tokens.create", () => {
  async function newUser(): Promise<string> {
    const res = await call("/admin/users", adminToken, { handle: freshHandle() });
    return (await res.json<{ id: string }>()).id;
  }

  it("mints a token that authenticates as the new user, shown once and never logged", async () => {
    const userId = await newUser();
    const res = await call(`/admin/users/${userId}/tokens`, adminToken, {
      scopes: ["repo"],
      expires_in_days: 7,
    });
    expect(res.status).toBe(201);
    const minted = await res.json<{ token: string; id: string; expires_at: number }>();
    expect(minted.token).toMatch(/^fyrden_pat_/);
    expect(minted.expires_at - Date.now()).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);

    const me = await call("/user", minted.token, undefined, "GET");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: userId, token: { scopes: ["repo"] } });

    // Hash-only storage, and the secret never reaches a log line.
    const stored = await env.DIRECTORY.prepare("SELECT * FROM tokens WHERE id = ?")
      .bind(minted.id)
      .first();
    expect(JSON.stringify(stored)).not.toContain(minted.token);
    expect(logs.lines.filter(mentionsToken)).toEqual([]);
  });

  it.each([
    ["malformed JSON", "{broken", 400, "invalid_json"],
    ["truncated JSON", '{"expires_in_days":1', 400, "invalid_json"],
    ["null", "null", 422, "invalid_input"],
    ["an array", "[]", 422, "invalid_input"],
    ["a boolean", "false", 422, "invalid_input"],
  ])("rejects %s as the body and mints nothing", async (_, body, status, code) => {
    const userId = await newUser();
    const res = await exports.default.fetch(
      `https://fyrden.test/api/admin/users/${userId}/tokens`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body,
      },
    );
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
    const minted = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM tokens WHERE principal_id = ?",
    )
      .bind(userId)
      .first<{ n: number }>();
    expect(minted?.n).toBe(0);
  });

  it("accepts an empty body, using every default", async () => {
    const userId = await newUser();
    const res = await exports.default.fetch(
      `https://fyrden.test/api/admin/users/${userId}/tokens`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ type: "pat", scopes: [] });
  });

  it("mints git tokens too", async () => {
    const res = await call(`/admin/users/${await newUser()}/tokens`, adminToken, { type: "git" });
    expect(res.status).toBe(201);
    expect((await res.json<{ token: string }>()).token).toMatch(/^fyrden_git_/);
  });

  it.each([
    ["an unknown id", () => "usr_doesnotexist"],
    ["an agent", () => agentId],
  ])("answers 404 for %s", async (_, id) => {
    const res = await call(`/admin/users/${id()}/tokens`, adminToken, {});
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "user_not_found" });
  });

  it("refuses a disabled user", async () => {
    const userId = await newUser();
    await env.DIRECTORY.prepare("UPDATE principals SET disabled_at = 1 WHERE id = ?")
      .bind(userId)
      .run();
    const res = await call(`/admin/users/${userId}/tokens`, adminToken, {});
    expect(res.status).toBe(409);
  });

  it.each([{ expires_in_days: 0 }, { expires_in_days: 366 }, { type: "job" }, { scopes: [""] }])(
    "rejects %j",
    async (body) => {
      const res = await call(`/admin/users/${await newUser()}/tokens`, adminToken, body);
      expect(res.status).toBe(422);
    },
  );

  it("is for instance administrators only", async () => {
    const res = await call("/admin/users/usr_x/tokens", userToken, {});
    expect(res.status).toBe(403);
  });
});
