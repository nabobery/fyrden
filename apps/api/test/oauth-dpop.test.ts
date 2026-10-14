// DPoP (RFC 9449): a token issued against a proof is bound to the key and
// taken only with a fresh proof by it, never as a bearer token; proofs are
// not replayable; an organization can require its agents' API tokens to be
// bound. And clients known by a client ID metadata document.

import { exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it } from "vitest";
import { metadataNetwork } from "../src/oauth/clients.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE } from "../src/oauth/exchange.js";
import { api, json, user } from "./helpers/api.js";
import { dpopKey } from "./helpers/dpop.js";
import { ORIGIN } from "./helpers/git-http.js";
import { call, code, form, REDIRECT, registered, signedIn } from "./helpers/oauth.js";

const TOKEN_URL = `${ORIGIN}/oauth/token`;
const WHOAMI_URL = `${ORIGIN}/api/user`;

async function boundTokens(options: { bindCode?: boolean } = {}) {
  const key = await dpopKey();
  const clientId = await registered();
  const { cookie } = await signedIn();
  const { back, verifier } = await code(clientId, cookie, {
    resource: `${ORIGIN}/api`,
    ...(options.bindCode && { dpopJkt: key.jkt }),
  });
  const params = {
    grant_type: "authorization_code",
    code: back.searchParams.get("code") ?? "",
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  };
  return { key, clientId, params };
}

const asDpop = async (key: Awaited<ReturnType<typeof dpopKey>>, token: string) =>
  call("/api/user", {
    headers: { Authorization: `DPoP ${token}`, DPoP: await key.proof("GET", WHOAMI_URL, token) },
  });

describe("DPoP-bound tokens", () => {
  it("are issued against a proof and taken only with a fresh proof by the same key", async () => {
    const { key, clientId, params } = await boundTokens();
    const res = await form("/oauth/token", params, { DPoP: await key.proof("POST", TOKEN_URL) });
    const body = await res.json<{
      token_type: string;
      access_token: string;
      refresh_token: string;
    }>();
    expect(body.token_type).toBe("DPoP");
    const token = body.access_token;
    // As a bearer token: refused.
    expect(
      (await call("/api/user", { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
    // With a proof: taken.
    expect((await asDpop(key, token)).status).toBe(200);
    // The same proof again, another key's, or one for another URL: refused.
    const proof = await key.proof("GET", WHOAMI_URL, token);
    const headers = { Authorization: `DPoP ${token}`, DPoP: proof };
    expect((await call("/api/user", { headers })).status).toBe(200);
    expect((await call("/api/user", { headers })).status).toBe(401);
    expect((await asDpop(await dpopKey(), token)).status).toBe(401);
    const elsewhere = await call("/api/user", {
      headers: {
        Authorization: `DPoP ${token}`,
        DPoP: await key.proof("GET", `${ORIGIN}/api/user/repos`, token),
      },
    });
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.headers.get("WWW-Authenticate")).toContain("invalid_dpop_proof");
    // A bound family refreshes only with a proof by its key.
    const refresh = {
      grant_type: "refresh_token",
      refresh_token: body.refresh_token,
      client_id: clientId,
    };
    expect(await (await form("/oauth/token", refresh)).json()).toMatchObject({
      error: "invalid_dpop_proof",
    });
    const refreshed = await form("/oauth/token", refresh, {
      DPoP: await key.proof("POST", TOKEN_URL),
    });
    expect(await refreshed.json()).toMatchObject({ token_type: "DPoP" });
  });

  it("are refused for a code bound to another key, and a stale proof", async () => {
    const { params } = await boundTokens({ bindCode: true });
    const other = await dpopKey();
    expect(
      await (
        await form("/oauth/token", params, { DPoP: await other.proof("POST", TOKEN_URL) })
      ).json(),
    ).toMatchObject({ error: "invalid_dpop_proof" });
    const stale = await dpopKey();
    const old = await stale.proof("POST", TOKEN_URL, undefined, {
      iat: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(await (await form("/oauth/token", params, { DPoP: old })).json()).toMatchObject({
      error: "invalid_dpop_proof",
    });
  });
});

describe("an organization's DPoP policy", () => {
  it("takes its agents' API tokens only DPoP-bound", async () => {
    const admin = await user(true);
    const owner = await user();
    const login = uniqueId("org").slice(0, 39);
    await api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle });
    expect(
      await json(api("PATCH", `/orgs/${login}`, owner.token, { require_dpop: true })),
    ).toMatchObject({ status: 200, body: { require_dpop: true } });
    const made = await json<{ handle: string }>(
      api("POST", "/agents", owner.token, { handle: uniqueId("bot").slice(0, 39), org: login }),
    );
    const minted = await json<{ token: string }>(
      api("POST", `/agents/${made.body.handle}/tokens`, owner.token, {}),
    );
    const agentToken = minted.body.token;
    // Its own token is refused at the API (it cannot be bound)...
    expect((await api("GET", "/user", agentToken)).status).toBe(401);
    // ...and a delegated one is issued only against a proof.
    const granted = await json<{ id: string }>(
      api("POST", "/grants", owner.token, { agent: made.body.handle, scopes: ["metadata:read"] }),
    );
    const exchange = (headers: Record<string, string> = {}) =>
      form(
        "/oauth/token",
        {
          grant_type: TOKEN_EXCHANGE,
          subject_token: agentToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
          grant_id: granted.body.id,
        },
        headers,
      );
    expect(await (await exchange()).json()).toMatchObject({ error: "invalid_dpop_proof" });
    const key = await dpopKey();
    const bound = await (await exchange({ DPoP: await key.proof("POST", TOKEN_URL) })).json<{
      access_token: string;
      token_type: string;
    }>();
    expect(bound.token_type).toBe("DPoP");
    expect((await asDpop(key, bound.access_token)).status).toBe(200);
  });
});

describe("client ID metadata documents", () => {
  const original = metadataNetwork.fetch;
  afterEach(() => {
    metadataNetwork.fetch = original;
  });

  it("name a client by its document's URL, which must name itself", async () => {
    const clientId = `https://client.example/${uniqueId("app")}/oauth.json`;
    let fetched = 0;
    metadataNetwork.fetch = async (url) => {
      fetched++;
      return Response.json({
        client_id: url,
        client_name: "Document client",
        redirect_uris: [REDIRECT],
      });
    };
    const { cookie } = await signedIn();
    const { back } = await code(clientId, cookie);
    expect(back.searchParams.get("code")).toBeTruthy();
    // Kept: a second request fetches nothing.
    await code(clientId, cookie);
    expect(fetched).toBe(1);
    // One that names another client, or is not https with a path, is not a client.
    const liar = `https://client.example/${uniqueId("liar")}/oauth.json`;
    metadataNetwork.fetch = async () =>
      Response.json({ client_id: "https://other.example/x", redirect_uris: [REDIRECT] });
    const refused = await call(
      `/oauth/authorize?${new URLSearchParams({ client_id: liar, redirect_uri: REDIRECT })}`,
      { headers: { Cookie: cookie } },
    );
    expect(refused.status).toBe(400);
  });

  it("are advertised", async () => {
    const meta = await (
      await exports.default.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)
    ).json();
    expect(meta).toMatchObject({
      client_id_metadata_document_supported: true,
      dpop_signing_alg_values_supported: ["ES256", "EdDSA"],
    });
  });
});
