// What the web UI's server relies on: a signed-in user's session as a
// credential (only with the header no cross-site page can send), the API
// served over the service binding, and a user's own tokens.

import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/oauth/session.js";
import { ApiRpc } from "../src/rpc.js";
import { api, json, user } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { testSession } from "./helpers/oauth.js";
import { scopedToken } from "./helpers/principals.js";

async function sessionCookie(userId: string): Promise<string> {
  const { cookie } = await testSession(userId);
  return `${SESSION_COOKIE}=${cookie}`;
}

const withSession = (path: string, cookie: string, init: RequestInit = {}) =>
  exports.default.fetch(`${ORIGIN}/api${path}`, {
    ...init,
    headers: { Cookie: cookie, "X-Fyrden-Session": "1", ...(init.headers ?? {}) },
  });

describe("a session as a credential", () => {
  it("is taken with the session header only, with the user's full rights", async () => {
    const who = await user();
    const cookie = await sessionCookie(who.principalId);
    const me = await withSession("/user", cookie);
    expect(await me.json()).toMatchObject({ id: who.principalId, token: { type: "ses" } });
    const made = await withSession("/user/repos", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ name: uniqueId("r") }),
    });
    expect(made.status).toBe(201);
    // A file write, whose commit rechecks the session (not a token).
    const { name } = (await made.json()) as { name: string };
    const written = await withSession(`/repos/${who.handle}/${name}/contents/a.txt`, cookie, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ message: "add", content: btoa("a") }),
    });
    expect(written.status, await written.clone().text()).toBe(200);
    // The cookie alone (what a cross-site form sends) is no credential.
    const bare = await exports.default.fetch(`${ORIGIN}/api/user`, { headers: { Cookie: cookie } });
    expect(bare.status).toBe(401);
    // Signed out: refused at once.
    await env.DIRECTORY.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ?")
      .bind(Date.now(), who.principalId)
      .run();
    expect((await withSession("/user", cookie)).status).toBe(401);
  });
});

describe("the service binding", () => {
  it("serves the API's HTTP paths", async () => {
    const who = await user();
    const rpc = new ApiRpc(createExecutionContext(), env);
    const res = await rpc.fetch(
      new Request(`${ORIGIN}/api/user`, { headers: { Authorization: `Bearer ${who.token}` } }),
    );
    expect(await res.json()).toMatchObject({ id: who.principalId });
  });
});

describe("a user's own tokens", () => {
  it("are created never wider than the caller's, listed, used and revoked", async () => {
    const who = await user();
    const made = await json<{ id: string; token: string; scopes: string[] }>(
      api("POST", "/user/tokens", who.token, { type: "pat", scopes: ["metadata:read"] }),
    );
    expect(made).toMatchObject({ status: 201, body: { scopes: ["metadata:read"] } });
    expect((await api("GET", "/user", made.body.token)).status).toBe(200);
    const listed = await json<{ tokens: { id: string; revoked: boolean }[] }>(
      api("GET", "/user/tokens", who.token),
    );
    expect(listed.body.tokens.map((t) => t.id)).toContain(made.body.id);
    // A narrow token mints nothing wider.
    const narrow = await scopedToken(who.principalId, ["tokens:write"]);
    expect(
      await json(api("POST", "/user/tokens", narrow, { scopes: ["contents:write"] })),
    ).toMatchObject({ status: 403, body: { code: "scope_exceeds_token" } });
    // Someone else's is not found; one's own is revoked, at once for writes.
    const other = await user();
    expect((await api("DELETE", `/user/tokens/${made.body.id}`, other.token)).status).toBe(404);
    expect((await api("DELETE", `/user/tokens/${made.body.id}`, who.token)).status).toBe(200);
    expect(
      (await api("POST", "/user/repos", made.body.token, { name: uniqueId("x") })).status,
    ).toBe(401);
  });
});
