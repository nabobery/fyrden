// Suspending users (GitHub Enterprise's `PUT/DELETE /users/{username}/suspended`):
// the user cannot sign in and none of their tokens work while suspended; their
// sessions and OAuth tokens are revoked for good, their other tokens work again
// once unsuspended; their repositories stay their collaborators'. Each change
// is one transaction, recorded with its generation.
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { suspendUserOperation } from "../src/accounts/lifecycle.js";
import { passkeyHooks } from "../src/auth/login.js";
import { authorizeHooks } from "../src/oauth/authorize.js";
import { issueHooks } from "../src/oauth/issue.js";
import { SESSION_COOKIE, startSession } from "../src/oauth/session.js";
import type { OpContext } from "../src/ops/execute.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { authenticator } from "./helpers/authenticator.js";
import { ORIGIN } from "./helpers/git-http.js";
import { code, form, REDIRECT, registered, testSession, tokens, whoami } from "./helpers/oauth.js";

let admin: Who;
let target: Who;

beforeEach(async () => {
  admin = await user(true);
  target = await user();
});

const suspend = (who: Who, by = admin, reason?: string) =>
  api("PUT", `/users/${who.handle}/suspended`, by.token, reason ? { reason } : {});
const unsuspend = (who: Who, by = admin) =>
  api("DELETE", `/users/${who.handle}/suspended`, by.token);

const lifecycle = (id: string) =>
  env.DIRECTORY.prepare(
    `SELECT lifecycle, lifecycle_gen, disabled_at IS NOT NULL AS disabled, suspended_by,
       suspended_reason FROM principals WHERE id = ?`,
  )
    .bind(id)
    .first<{
      lifecycle: string;
      lifecycle_gen: number;
      disabled: number;
      suspended_by: string | null;
      suspended_reason: string | null;
    }>();
const journal = async (id: string) =>
  (
    await env.DIRECTORY.prepare(
      "SELECT gen, from_state, to_state, actor_id FROM principal_lifecycle WHERE principal_id = ? ORDER BY gen",
    )
      .bind(id)
      .all()
  ).results;
const audits = async (id: string) =>
  (
    await env.DIRECTORY.prepare(
      "SELECT action, actor_id, details FROM audit_log WHERE target_id = ? AND action LIKE 'user.%' ORDER BY seq",
    )
      .bind(id)
      .all()
  ).results;

describe("suspending a user", () => {
  it("answers 204 with no body, records the change once, and is idempotent", async () => {
    const res = await suspend(target, admin, "compromised laptop");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await lifecycle(target.principalId)).toEqual({
      lifecycle: "suspended",
      lifecycle_gen: 1,
      disabled: 1,
      suspended_by: admin.principalId,
      suspended_reason: "compromised laptop",
    });
    // Suspended again: nothing more.
    expect((await suspend(target)).status).toBe(204);
    expect(await journal(target.principalId)).toEqual([
      { gen: 1, from_state: "active", to_state: "suspended", actor_id: admin.principalId },
    ]);
    expect(await audits(target.principalId)).toEqual([
      {
        action: "user.suspend",
        actor_id: admin.principalId,
        details: JSON.stringify({ reason: "compromised laptop" }),
      },
    ]);
  });

  it("answers two simultaneous suspensions alike, recording the one change", async () => {
    const ctx = {
      env,
      auth: { principalId: admin.principalId, act: [] },
      metrics: { count() {} },
      requestId: "twice",
    } as unknown as OpContext;
    // Both read the user active before either writes.
    expect(
      await Promise.all([
        suspendUserOperation(ctx, { username: target.handle }),
        suspendUserOperation(ctx, { username: target.handle }),
      ]),
    ).toEqual([null, null]);
    expect(await journal(target.principalId)).toHaveLength(1);
    expect(await audits(target.principalId)).toHaveLength(1);
  });

  it("replays a repeated request with the same key, still with no body", async () => {
    const key = crypto.randomUUID();
    const send = () =>
      exports.default.fetch(`${ORIGIN}/api/users/${target.handle}/suspended`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${admin.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: "{}",
      });
    expect((await send()).status).toBe(204);
    const again = await send();
    expect(again.status).toBe(204);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await again.text()).toBe("");
  });

  it("stops the user's tokens until unsuspended, and their sessions and OAuth tokens for good", async () => {
    const session = await testSession(target.principalId);
    const clientId = await registered();
    const cookie = `${SESSION_COOKIE}=${session.cookie}`;
    const oauth = await tokens(clientId, cookie);
    // A code given before the suspension, not yet redeemed.
    const pending = await code(clientId, cookie);
    expect((await whoami(target.token)).status).toBe(200);

    expect((await suspend(target)).status).toBe(204);
    expect((await api("POST", "/user/repos", target.token, { name: uniqueId("r") })).status).toBe(
      401,
    );
    expect((await whoami(oauth.access_token)).status).toBe(401);
    const refreshed = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: oauth.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(400);
    const redeemed = await form("/oauth/token", {
      grant_type: "authorization_code",
      code: pending.back.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: pending.verifier,
      resource: `${ORIGIN}/mcp`,
    });
    expect(redeemed.status).toBe(400);
    const sessionCall = await exports.default.fetch(`${ORIGIN}/auth/session`, {
      headers: { Cookie: cookie },
    });
    expect(sessionCall.status).toBe(401);

    expect((await unsuspend(target)).status).toBe(204);
    // The personal access token works again; the session, the OAuth tokens and the code do not.
    expect((await whoami(target.token)).status).toBe(200);
    expect((await whoami(oauth.access_token)).status).toBe(401);
    expect(
      (await exports.default.fetch(`${ORIGIN}/auth/session`, { headers: { Cookie: cookie } }))
        .status,
    ).toBe(401);
    expect(await journal(target.principalId)).toMatchObject([
      { gen: 1, to_state: "suspended" },
      { gen: 2, from_state: "suspended", to_state: "active" },
    ]);
  });

  it("refuses a session authenticated before a suspension, even once it is lifted", async () => {
    const at = (await lifecycle(target.principalId))?.lifecycle_gen ?? -1;
    expect((await suspend(target)).status).toBe(204);
    expect((await unsuspend(target)).status).toBe(204);
    expect(await startSession(env, target.principalId, at, { via: "test" })).toBeUndefined();
    expect(await startSession(env, target.principalId, at + 2, { via: "test" })).toBeDefined();
  });

  it("refuses signing in with a suspended user's token", async () => {
    expect((await suspend(target)).status).toBe(204);
    const res = await exports.default.fetch(`${ORIGIN}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ token: target.token }),
    });
    expect(res.status).toBe(401);
  });

  it("keeps a suspended owner's repositories available to their collaborators", async () => {
    const name = uniqueId("r");
    expect((await api("POST", "/user/repos", target.token, { name })).status).toBe(201);
    const helper = await user();
    expect(
      (
        await api(
          "PUT",
          `/repos/${target.handle}/${name}/collaborators/${helper.handle}`,
          target.token,
          {
            permission: "push",
          },
        )
      ).status,
    ).toBe(200);
    expect((await suspend(target)).status).toBe(204);
    expect((await api("GET", `/repos/${target.handle}/${name}`, helper.token)).status).toBe(200);
    // The owner, though, can change nothing (reads stop within the token cache's 30 seconds).
    expect(
      (await api("PATCH", `/repos/${target.handle}/${name}`, target.token, { description: "x" }))
        .status,
    ).toBe(401);
  });

  it("refuses yourself, a caller who is not an administrator, and a name that is no user", async () => {
    expect((await json(suspend(admin, admin))).body).toMatchObject({ code: "cannot_suspend_self" });
    expect((await suspend(target, await user())).status).toBe(403);
    expect((await api("PUT", "/users/no-such-user/suspended", admin.token, {})).status).toBe(404);
    expect((await unsuspend(target)).status).toBe(204);
    expect(await journal(target.principalId)).toEqual([]);
  });

  it("never leaves the instance without an active administrator", async () => {
    const other = await user(true);
    // These two are the instance's only administrators (this file's earlier ones step down).
    await env.DIRECTORY.prepare(
      "UPDATE principals SET is_instance_admin = 0 WHERE is_instance_admin = 1 AND id NOT IN (?, ?)",
    )
      .bind(admin.principalId, other.principalId)
      .run();
    // Each suspends the other at the same moment, both past their authentication: the first
    // to commit wins, and the other's change, made as an administrator suspended meanwhile,
    // would leave none active.
    expect((await suspend(other, admin)).status).toBe(204);
    const stale = {
      env,
      auth: { principalId: other.principalId, act: [] },
      metrics: { count() {} },
      requestId: "race",
    } as unknown as OpContext;
    await expect(suspendUserOperation(stale, { username: admin.handle })).rejects.toMatchObject({
      code: "last_admin",
    });
    expect((await lifecycle(admin.principalId))?.lifecycle).toBe("active");
  });
});

describe("the suspension operations", () => {
  it("are MCP tools answering a short text", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/mcp`, {
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
        params: { name: "suspend_user", arguments: { username: target.handle } },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Done.");
    expect(text).not.toContain("structuredContent");
    expect((await lifecycle(target.principalId))?.lifecycle).toBe("suspended");
  });
});

describe("work under way when a user is suspended", () => {
  /** Suspends and unsuspends the target: what work paused across both must not survive. */
  const cycle = async () => {
    expect((await suspend(target)).status).toBe(204);
    expect((await unsuspend(target)).status).toBe(204);
  };
  const count = async (sql: string) =>
    (await env.DIRECTORY.prepare(sql).bind(target.principalId).first<{ n: number }>())?.n;

  it("redeems no code whose redemption began before the suspension", async () => {
    const clientId = await registered();
    const { cookie } = {
      cookie: `${SESSION_COOKIE}=${(await testSession(target.principalId)).cookie}`,
    };
    const pending = await code(clientId, cookie);
    const before = await count(
      "SELECT count(*) AS n FROM tokens WHERE principal_id = ? AND type = 'oat'",
    );
    issueHooks.beforeClaim = cycle;
    try {
      const redeemed = await form("/oauth/token", {
        grant_type: "authorization_code",
        code: pending.back.searchParams.get("code") ?? "",
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: pending.verifier,
        resource: `${ORIGIN}/mcp`,
      });
      expect(redeemed.status).toBe(400);
    } finally {
      delete issueHooks.beforeClaim;
    }
    expect(
      await count("SELECT count(*) AS n FROM tokens WHERE principal_id = ? AND type = 'oat'"),
    ).toBe(before);
  });

  it("records no authorization request, and no consent, begun before the suspension", async () => {
    const clientId = await registered();
    const cookie = `${SESSION_COOKIE}=${(await testSession(target.principalId)).cookie}`;
    authorizeHooks.beforeWrite = cycle;
    try {
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        scope: "metadata:read",
        resource: `${ORIGIN}/mcp`,
      });
      const consent = await exports.default.fetch(`${ORIGIN}/oauth/authorize?${query}`, {
        headers: { Cookie: cookie },
      });
      expect(consent.status).toBe(401);
    } finally {
      delete authorizeHooks.beforeWrite;
    }
    expect(await count("SELECT count(*) AS n FROM oauth_requests WHERE user_id = ?")).toBe(0);

    // A consent page shown before the suspension, answered across it: no code.
    const again = `${SESSION_COOKIE}=${(await testSession(target.principalId)).cookie}`;
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      scope: "metadata:read",
      resource: `${ORIGIN}/mcp`,
    });
    const page = await exports.default.fetch(`${ORIGIN}/oauth/authorize?${query}`, {
      headers: { Cookie: again },
    });
    const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    authorizeHooks.beforeWrite = cycle;
    try {
      const answer = await form(
        "/oauth/authorize",
        { request_id: requestId, decision: "allow" },
        { Cookie: again, Origin: ORIGIN },
      );
      expect(answer.status).not.toBe(303);
    } finally {
      delete authorizeHooks.beforeWrite;
    }
    expect(
      await count(
        "SELECT count(*) AS n FROM oauth_requests WHERE user_id = ? AND code_hash IS NOT NULL",
      ),
    ).toBe(0);
  });

  it("adds no passkey whose registration began before the suspension", async () => {
    const cookie = `${SESSION_COOKIE}=${(await testSession(target.principalId)).cookie}`;
    const post = (path: string, body: unknown) =>
      exports.default.fetch(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
        body: JSON.stringify(body),
      });
    const key = await authenticator();
    const options = await (await post("/auth/passkeys/registration-options", {})).json<{
      challenge_id: string;
      publicKey: Parameters<typeof key.register>[0];
    }>();
    const credential = await key.register(options.publicKey, ORIGIN);
    passkeyHooks.beforeInsert = cycle;
    try {
      const added = await post("/auth/passkeys/registration", {
        challenge_id: options.challenge_id,
        credential,
      });
      expect(added.status).toBe(401);
    } finally {
      delete passkeyHooks.beforeInsert;
    }
    expect(await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ?")).toBe(0);
  });
});
