// The authorization server as a client and a signed-in user drive it.
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { SESSION_COOKIE, startSession } from "../../src/oauth/session.js";
import { user } from "./api.js";
import { ORIGIN } from "./git-http.js";

export const REDIRECT = "http://127.0.0.1:8765/callback";

// Redirects are the answers under test: never followed.
export const call = (path: string, init?: RequestInit) =>
  exports.default.fetch(`${ORIGIN}${path}`, { redirect: "manual", ...init });

export const form = (
  path: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  call(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });

export async function registered(): Promise<string> {
  const res = await call("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test client", redirect_uris: [REDIRECT] }),
  });
  expect(res.status).toBe(201);
  return (await res.json<{ client_id: string }>()).client_id;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  return { verifier, challenge };
}

/** A signed-in user's cookie header. */
export async function signedIn(): Promise<{ cookie: string; userId: string }> {
  const who = await user();
  const session = await startSession(env, who.principalId, { via: "test" });
  return { cookie: `${SESSION_COOKIE}=${session.cookie}`, userId: who.principalId };
}

/** Runs the code flow up to the code: consent page, then the user's answer. */
export async function code(
  clientId: string,
  cookie: string,
  options: { resource?: string; scope?: string; decision?: string; dpopJkt?: string } = {},
) {
  const { verifier, challenge } = await pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: options.scope ?? "metadata:read contents:read",
    resource: options.resource ?? `${ORIGIN}/mcp`,
    state: "s1",
    ...(options.dpopJkt !== undefined && { dpop_jkt: options.dpopJkt }),
  });
  const consent = await call(`/oauth/authorize?${query}`, { headers: { Cookie: cookie } });
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const answer = await form(
    "/oauth/authorize",
    { request_id: requestId, decision: options.decision ?? "allow" },
    { Cookie: cookie, Origin: ORIGIN },
  );
  expect(answer.status).toBe(303);
  const back = new URL(answer.headers.get("Location") ?? "");
  return { back, verifier };
}

export async function tokens(clientId: string, cookie: string, resource = `${ORIGIN}/mcp`) {
  const { back, verifier } = await code(clientId, cookie, { resource });
  const res = await form("/oauth/token", {
    grant_type: "authorization_code",
    code: back.searchParams.get("code") ?? "",
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource,
  });
  expect(res.status).toBe(200);
  return res.json<{ access_token: string; refresh_token: string; scope: string }>();
}

export const whoami = (token: string) =>
  call("/api/user", { headers: { Authorization: `Bearer ${token}` } });
