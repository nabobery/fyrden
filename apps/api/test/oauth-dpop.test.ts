// DPoP (RFC 9449): a token issued against a proof is bound to the key and
// taken only with a fresh proof by it, never as a bearer token; proofs are
// not replayable; an organization can require its agents' API tokens to be
// bound. And clients known by a client ID metadata document.

import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, describe, expect, it } from "vitest";
import { clientById, metadataNetwork } from "../src/oauth/clients.js";
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
    // A signature changed after signing, a wrong or missing `ath`, or another method: refused.
    for (const dpop of [
      await key.proof("GET", WHOAMI_URL, token, {}, { corrupt: true }),
      await key.proof("GET", WHOAMI_URL, token, { ath: "x".repeat(43) }),
      await key.proof("GET", WHOAMI_URL),
      await key.proof("POST", WHOAMI_URL, token),
    ])
      expect(
        (await call("/api/user", { headers: { Authorization: `DPoP ${token}`, DPoP: dpop } }))
          .status,
      ).toBe(401);
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

  it("bind a bearer family's next refresh token to the key that refreshed it", async () => {
    const { key, clientId, params } = await boundTokens();
    const first = await (await form("/oauth/token", params)).json<{
      token_type: string;
      refresh_token: string;
    }>();
    expect(first.token_type).toBe("Bearer");
    // Refreshed with a proof: from here on the family is bound to that key (RFC 9449 §5).
    const refresh = (token: string) => ({
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: clientId,
    });
    const bound = await (
      await form("/oauth/token", refresh(first.refresh_token), {
        DPoP: await key.proof("POST", TOKEN_URL),
      })
    ).json<{ token_type: string; refresh_token: string }>();
    expect(bound.token_type).toBe("DPoP");
    // Without a proof, or with another key's: refused, and nothing is used up.
    expect(await (await form("/oauth/token", refresh(bound.refresh_token))).json()).toMatchObject({
      error: "invalid_dpop_proof",
    });
    expect(
      await (
        await form("/oauth/token", refresh(bound.refresh_token), {
          DPoP: await (await dpopKey()).proof("POST", TOKEN_URL),
        })
      ).json(),
    ).toMatchObject({ error: "invalid_dpop_proof" });
    // With its key: taken.
    const again = await form("/oauth/token", refresh(bound.refresh_token), {
      DPoP: await key.proof("POST", TOKEN_URL),
    });
    expect(await again.json()).toMatchObject({ token_type: "DPoP" });
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
    // A git token too: it is exempt only where git uses it, and git cannot send a proof.
    const gitToken = (
      await json<{ token: string }>(
        api("POST", `/agents/${made.body.handle}/tokens`, owner.token, { type: "git" }),
      )
    ).body.token;
    expect((await api("GET", "/user", gitToken)).status).toBe(401);
    expect((await api("POST", "/grants", gitToken, { agent: made.body.handle })).status).toBe(401);
    // Over git (protocol v2, so the request is authenticated): taken, then the
    // repository is not found; a made-up token is not taken.
    const overGit = (token: string) =>
      call(`/${login}/missing.git/info/refs?service=git-upload-pack`, {
        headers: {
          Authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
          "Git-Protocol": "version=2",
        },
      });
    expect((await overGit(gitToken)).status).toBe(404);
    expect((await overGit(`fyrden_git_${"x".repeat(43)}`)).status).toBe(401);
    // Chunked uploads are git's too (`fyrden push --chunked` sends the git token there):
    // taken, then the repository is not found; the agent's own token is still refused.
    const upload = (token: string) =>
      api("POST", `/repos/${login}/missing/uploads`, token, {
        size: 32,
        ref_updates: [{ ref: "refs/heads/main", old: null, new: "a".repeat(40) }],
      });
    expect((await upload(gitToken)).status).toBe(404);
    expect((await upload(agentToken)).status).toBe(401);
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

  it("are fetched with the deployment's own hosts refused, the configured ones included", async () => {
    let ownHosts: readonly string[] = [];
    metadataNetwork.fetch = async (url, _init, policy) => {
      ownHosts = policy.ownHosts ?? [];
      return Response.json({ client_id: url, redirect_uris: [REDIRECT] });
    };
    const configured = { ...env, FYRDEN_OWN_HOSTS: "api.example.com, git.example.com" } as Env;
    await clientById(
      configured,
      `https://client.example/${uniqueId("app")}/oauth.json`,
      "web.example.com",
    );
    expect(ownHosts).toEqual(
      expect.arrayContaining(["web.example.com", "api.example.com", "git.example.com"]),
    );
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
