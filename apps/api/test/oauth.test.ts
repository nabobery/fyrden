// The authorization server: discovery, client registration, the code flow
// with PKCE and consent, audience-bound access tokens, single-use refresh
// rotation (exactly one of concurrent uses wins; reuse revokes the family),
// and revocation.

import { env } from "cloudflare:workers";
import { hashToken } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { reapOAuth } from "../src/oauth/reaper.js";
import { ORIGIN } from "./helpers/git-http.js";
import {
  call,
  code,
  form,
  pkce,
  REDIRECT,
  registered,
  signedIn,
  tokens,
  whoami,
} from "./helpers/oauth.js";

describe("discovery", () => {
  it("serves the authorization server's and each resource's metadata, linked from a 401", async () => {
    const meta = await (await call("/.well-known/oauth-authorization-server")).json();
    expect(meta).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    const prm = await (await call("/.well-known/oauth-protected-resource/mcp")).json();
    expect(prm).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const unauthenticated = await call("/mcp", { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});

describe("client registration", () => {
  it("takes public clients with loopback, https or private-use redirect URIs only", async () => {
    const register = (body: unknown) =>
      call("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const native = await register({ redirect_uris: ["com.example.app:/cb"] });
    expect(native.status).toBe(201);
    // It is told what it gets: both grants, whatever it asked for.
    expect(await native.json()).toMatchObject({
      grant_types: ["authorization_code", "refresh_token"],
    });
    for (const bad of [
      { redirect_uris: ["http://evil.example/cb"] },
      { redirect_uris: ["https://ok.example/cb#frag"] },
      { redirect_uris: [] },
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" },
    ])
      expect((await register(bad)).status).toBe(400);
  });
});

describe("the authorization code flow", () => {
  it("issues tokens bound to the resource after the user consents", async () => {
    const clientId = await registered();
    const { cookie, userId } = await signedIn();
    const { back, verifier } = await code(clientId, cookie, { resource: `${ORIGIN}/api` });
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("s1");
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
    const redeem = () =>
      form("/oauth/token", {
        grant_type: "authorization_code",
        code: back.searchParams.get("code") ?? "",
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      });
    const res = await redeem();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json<{ access_token: string; refresh_token: string; scope: string }>();
    expect(body.scope).toBe("metadata:read contents:read");
    const me = await whoami(body.access_token);
    expect(await me.json()).toMatchObject({ id: userId, type: "user", token: { type: "oat" } });
    // Bound to the API: the MCP server refuses it.
    const atMcp = await call("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${body.access_token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(atMcp.status).toBe(401);
    // Redeemed again: refused, and what it issued is revoked.
    expect(await (await redeem()).json()).toMatchObject({ error: "invalid_grant" });
    expect(
      (
        await call("/api/user/repos", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${body.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: uniqueId("x") }),
        })
      ).status,
    ).toBe(401);
  });

  it("refuses without S256 PKCE, the right verifier, a resource here or a signed-in user", async () => {
    const clientId = await registered();
    const { cookie } = await signedIn();
    const { challenge } = await pkce();
    const authorize = (params: Record<string, string>, headers: Record<string, string> = {}) =>
      call(
        `/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "metadata:read",
          resource: `${ORIGIN}/mcp`,
          ...params,
        })}`,
        { headers: { Cookie: cookie, ...headers } },
      );
    const plain = await authorize({ code_challenge_method: "plain" });
    expect(new URL(plain.headers.get("Location") ?? "").searchParams.get("error")).toBe(
      "invalid_request",
    );
    const elsewhere = await authorize({ resource: "https://other.example/mcp" });
    expect(new URL(elsewhere.headers.get("Location") ?? "").searchParams.get("error")).toBe(
      "invalid_target",
    );
    // A loopback one on another port is the same (RFC 8252 §7.3).
    expect((await authorize({ redirect_uri: "http://127.0.0.1:50123/callback" })).status).toBe(200);
    // An unregistered redirect URI is never redirected to.
    expect((await authorize({ redirect_uri: "http://127.0.0.1:9/evil" })).status).toBe(400);
    expect((await authorize({}, { Cookie: "" })).status).toBe(401);
    // A wrong verifier.
    const { back } = await code(clientId, cookie);
    const wrong = await form("/oauth/token", {
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: (await pkce()).verifier,
    });
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("names the client on the consent page as text, never as markup", async () => {
    const res = await call("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: '<img src=x onerror="alert(1)">',
        redirect_uris: [REDIRECT],
      }),
    });
    const { client_id } = await res.json<{ client_id: string }>();
    const { cookie } = await signedIn();
    const { challenge } = await pkce();
    const consent = await call(
      `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "metadata:read",
        resource: `${ORIGIN}/mcp`,
      })}`,
      { headers: { Cookie: cookie } },
    );
    const html = await consent.text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(consent.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("sends the user's refusal back, and takes no answer from another origin", async () => {
    const clientId = await registered();
    const { cookie } = await signedIn();
    const { back } = await code(clientId, cookie, { decision: "deny" });
    expect(back.searchParams.get("error")).toBe("access_denied");
    const crossSite = await form(
      "/oauth/authorize",
      { request_id: "x", decision: "allow" },
      { Cookie: cookie, Origin: "https://evil.example" },
    );
    expect(crossSite.status).toBe(400);
  });
});

describe("races", () => {
  it("let one of concurrent redemptions of a code win, and revoke what it got", async () => {
    const clientId = await registered();
    const { cookie } = await signedIn();
    const { back, verifier } = await code(clientId, cookie, { resource: `${ORIGIN}/api` });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        form("/oauth/token", {
          grant_type: "authorization_code",
          code: back.searchParams.get("code") ?? "",
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }),
      ),
    );
    const won = results.filter((r) => r.status === 200);
    expect(won).toHaveLength(1);
    const { access_token } = await (won[0] as Response).json<{ access_token: string }>();
    const write = await call("/api/user/repos", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: uniqueId("x") }),
    });
    expect(write.status).toBe(401);
  });

  it("take one answer to a consent page", async () => {
    const clientId = await registered();
    const { cookie } = await signedIn();
    const { challenge } = await pkce();
    const consent = await call(
      `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "metadata:read",
        resource: `${ORIGIN}/api`,
      })}`,
      { headers: { Cookie: cookie } },
    );
    const requestId = /name="request_id" value="([^"]+)"/.exec(await consent.text())?.[1] ?? "";
    const answers = await Promise.all(
      ["allow", "deny", "allow", "deny"].map((decision) =>
        form(
          "/oauth/authorize",
          { request_id: requestId, decision },
          { Cookie: cookie, Origin: ORIGIN },
        ),
      ),
    );
    expect(answers.filter((a) => a.status === 303)).toHaveLength(1);
  });
});

describe("refresh tokens", () => {
  it("rotate once; a reused one revokes its family", async () => {
    const clientId = await registered();
    const { cookie } = await signedIn();
    const first = await tokens(clientId, cookie, `${ORIGIN}/api`);
    const refresh = (token: string, scope?: string) =>
      form("/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: clientId,
        ...(scope !== undefined && { scope }),
      });
    const second = await refresh(first.refresh_token, "metadata:read");
    expect(second.status).toBe(200);
    const rotated = await second.json<{
      access_token: string;
      refresh_token: string;
      scope: string;
    }>();
    expect(rotated.scope).toBe("metadata:read");
    expect((await whoami(rotated.access_token)).status).toBe(200);
    // Wider than first granted: refused.
    expect(await (await refresh(rotated.refresh_token, "contents:write")).json()).toMatchObject({
      error: "invalid_scope",
    });
    // The first one again: the whole family goes.
    expect(await (await refresh(first.refresh_token)).json()).toMatchObject({
      error: "invalid_grant",
    });
    expect(await (await refresh(rotated.refresh_token)).json()).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("issue no access token past the family's end", async () => {
    const clientId = await registered();
    const { cookie } = await signedIn();
    const first = await tokens(clientId, cookie, `${ORIGIN}/api`);
    // The family ends in ten minutes: refreshing now gets ten minutes, not an hour.
    const end = Date.now() + 10 * 60 * 1000;
    await env.DIRECTORY.prepare(
      "UPDATE refresh_tokens SET family_expires_at = ?, expires_at = ? WHERE client_id = ?",
    )
      .bind(end, end, clientId)
      .run();
    const refreshed = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const body = await refreshed.json<{ access_token: string; expires_in: number }>();
    // What was left of the family when the answer was made, not an hour.
    expect(body.expires_in).toBeLessThanOrEqual(600);
    expect(body.expires_in).toBeGreaterThanOrEqual(Math.floor((end - Date.now()) / 1000));
    const stored = await env.DIRECTORY.prepare(
      "SELECT expires_at AS at FROM tokens WHERE token_hash = ?",
    )
      .bind(await hashToken(body.access_token))
      .first<{ at: number }>();
    expect(stored?.at).toBe(end);
  });

  it("let exactly one of concurrent uses win", async () => {
    const clientId = await registered();
    const { cookie } = await signedIn();
    const { refresh_token } = await tokens(clientId, cookie, `${ORIGIN}/api`);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        form("/oauth/token", { grant_type: "refresh_token", refresh_token, client_id: clientId }),
      ),
    );
    const won = results.filter((r) => r.status === 200);
    expect(won).toHaveLength(1);
    // The others were reuse: what the winner got is revoked with its family.
    const { access_token } = await (won[0] as Response).json<{ access_token: string }>();
    const write = await call("/api/user/repos", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: uniqueId("x") }),
    });
    expect(write.status).toBe(401);
  });

  it("are revoked with their family at the revocation endpoint", async () => {
    const clientId = await registered();
    const { cookie } = await signedIn();
    const issued = await tokens(clientId, cookie, `${ORIGIN}/api`);
    expect(
      (await form("/oauth/revoke", { token: issued.refresh_token, client_id: clientId })).status,
    ).toBe(200);
    const after = await call("/api/user/repos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: uniqueId("x") }),
    });
    expect(after.status).toBe(401);
  });

  it("are audited when revoked: who, which family or token, never the token itself", async () => {
    const clientId = await registered();
    const { cookie } = await signedIn();
    const family = await tokens(clientId, cookie, `${ORIGIN}/api`);
    const other = await tokens(clientId, cookie, `${ORIGIN}/api`);
    await form("/oauth/revoke", { token: family.refresh_token, client_id: clientId });
    await form("/oauth/revoke", { token: other.access_token, client_id: clientId });
    // Unknown and already revoked: the same answer, no audit row.
    await form("/oauth/revoke", { token: "fyrden_ort_nothing", client_id: clientId });
    await form("/oauth/revoke", { token: other.access_token, client_id: clientId });
    const { results } = await env.DIRECTORY.prepare(
      `SELECT actor_id, target_id, details, request_id FROM audit_log
       WHERE action = 'token.revoke' AND json_extract(details, '$.client_id') = ?
       ORDER BY json_extract(details, '$.kind')`,
    )
      .bind(clientId)
      .all<{ actor_id: string; target_id: string; details: string; request_id: string | null }>();
    const owner = await env.DIRECTORY.prepare(
      "SELECT user_id, family_id FROM refresh_tokens WHERE client_id = ? AND revoked_at IS NOT NULL LIMIT 1",
    )
      .bind(clientId)
      .first<{ user_id: string; family_id: string }>();
    expect(results).toHaveLength(2);
    expect(results.map((r) => JSON.parse(r.details).kind)).toEqual([
      "access_token",
      "refresh_family",
    ]);
    // Who revoked whose: the tokens' user, the token's id or the family's.
    for (const row of results) {
      expect(row.actor_id).toBe(owner?.user_id);
      expect(row.request_id).toBeTruthy();
    }
    expect(results[0]?.target_id).toMatch(/^tok_/);
    expect(results[1]?.target_id).toBe(owner?.family_id);
    const text = JSON.stringify(results);
    for (const secret of [family.refresh_token, family.access_token, other.access_token])
      expect(text).not.toContain(secret);
  });
});

describe("pruning", () => {
  it("keeps a family's used refresh tokens while the family lives", async () => {
    const clientId = await registered();
    const { cookie } = await signedIn();
    const first = await tokens(clientId, cookie, `${ORIGIN}/api`);
    const rotated = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(rotated.status).toBe(200);
    // The used one expired long ago; its successor lives.
    await env.DIRECTORY.prepare(
      "UPDATE refresh_tokens SET expires_at = ? WHERE client_id = ? AND used_at IS NOT NULL",
    )
      .bind(Date.now() - 2 * 24 * 60 * 60 * 1000, clientId)
      .run();
    await reapOAuth(env, { now: Date.now() });
    expect(
      await (
        await form("/oauth/token", {
          grant_type: "refresh_token",
          refresh_token: first.refresh_token,
          client_id: clientId,
        })
      ).json(),
    ).toMatchObject({ error: "invalid_grant" });
    // Recognized as reuse: the live successor went with its family.
    const { refresh_token } = await rotated.json<{ refresh_token: string }>();
    expect(
      await (
        await form("/oauth/token", {
          grant_type: "refresh_token",
          refresh_token,
          client_id: clientId,
        })
      ).json(),
    ).toMatchObject({ error: "invalid_grant" });
  });

  it("drops expired requests, refresh tokens and sessions, and registrations nobody used", async () => {
    const clientId = await registered();
    const { cookie } = await signedIn();
    await tokens(clientId, cookie);
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    for (const sql of [
      "UPDATE oauth_requests SET expires_at = ?1, code_expires_at = ?1 WHERE client_id = ?2",
      "UPDATE refresh_tokens SET expires_at = ?1, family_expires_at = ?1 WHERE client_id = ?2",
      "UPDATE oauth_clients SET created_at = ?1, last_used_at = NULL WHERE client_id = ?2",
    ])
      await env.DIRECTORY.prepare(sql).bind(old, clientId).run();
    expect(await reapOAuth(env, { now: Date.now() })).toBeGreaterThanOrEqual(3);
    for (const table of ["oauth_requests", "refresh_tokens", "oauth_clients"]) {
      const left = await env.DIRECTORY.prepare(
        `SELECT count(*) AS n FROM ${table} WHERE client_id = ?`,
      )
        .bind(clientId)
        .first<{ n: number }>();
      expect(left?.n, table).toBe(0);
    }
  });
});
