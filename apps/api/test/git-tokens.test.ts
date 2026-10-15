// Short-lived git tokens a caller mints for itself (`POST /user/git-tokens`):
// stock git takes them where it takes no OAuth token, so an agent acting for
// a user under a grant pushes with one. A git token keeps the caller's
// identity, grant and act chain, narrows its scopes to git's, never outlives
// the caller's token, and stops when the grant is revoked.

import { env, exports } from "cloudflare:workers";
import { D1TokenStore } from "@fyrden/adapters-cloudflare/auth";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, inject, it } from "vitest";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE } from "../src/oauth/exchange.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");

const newId = createIdFactory(() => Date.now(), secureRandomBytes);

/** A personal access token of `principalId` with `scopes`, living `minutes`. */
async function mintedFor(principalId: string, scopes: string[], minutes: number) {
  const store = new D1TokenStore(env.DIRECTORY, {
    clock: () => Date.now(),
    newId,
    randomBytes: secureRandomBytes,
  });
  return store.mint({
    principalId,
    type: "pat",
    scopes,
    ttlMs: minutes * 60_000,
    audit: { actorId: principalId },
  });
}

type GitToken = { id: string; token: string; type: string; scopes: string[]; expires_at: number };

async function repoOf(owner: Who) {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
  );
  expect(made.status).toBe(201);
  return made.body;
}

/** A push of `fx.c2` to a new branch of `repo`, as git sends it with `token`. */
function push(owner: Who, repo: { id: string; name: string }, token: string, branch: string) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: { principalId: owner.principalId, token },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  return postPush(
    target,
    pushBody([{ old: ZERO, new: fx.c2, ref: `refs/heads/${branch}` }], { pack: fx.packC2 }),
  );
}

/** An agent of `owner` acting for it under a grant over `repo` with `scopes`. */
async function delegatedAgent(owner: Who, repo: { name: string }, scopes: string[]) {
  const agent = await json<{ handle: string }>(
    api("POST", "/agents", owner.token, { handle: uniqueId("bot").slice(0, 39) }),
  );
  const agentToken = await json<{ id: string; token: string }>(
    api("POST", `/agents/${agent.body.handle}/tokens`, owner.token, {}),
  );
  const granted = await json<{ id: string }>(
    api("POST", "/grants", owner.token, {
      agent: agent.body.handle,
      scopes,
      repositories: [`${owner.handle}/${repo.name}`],
    }),
  );
  expect(granted.status).toBe(201);
  const res = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      subject_token: agentToken.body.token,
      subject_token_type: ACCESS_TOKEN_TYPE,
      grant_id: granted.body.id,
    }).toString(),
  });
  expect(res.status).toBe(200);
  const { access_token } = await res.json<{ access_token: string }>();
  return {
    token: access_token,
    grantId: granted.body.id,
    agent: agent.body.handle,
    agentToken: agentToken.body,
  };
}

describe("git tokens", () => {
  it("let a delegated agent push with stock git until the grant is revoked", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const agent = await delegatedAgent(owner, repo, ["contents:write"]);
    // The OAuth token itself is not git's.
    expect((await push(owner, repo, agent.token, "oauth")).status).toBe(403);
    const minted = await json<GitToken>(api("POST", "/user/git-tokens", agent.token, {}));
    expect(minted.status).toBe(201);
    expect(minted.body).toMatchObject({ type: "git", scopes: ["contents:write"] });
    expect(minted.body.token.startsWith("fyrden_git_")).toBe(true);
    // Its identity is the delegated token's: the user, with the agent acting.
    const me = await json<{ id: string; act: unknown[]; token: { grant_id: string } }>(
      api("GET", "/user", minted.body.token),
    );
    expect(me.body).toMatchObject({ id: owner.principalId, token: { grant_id: agent.grantId } });
    expect(me.body.act).toHaveLength(1);
    const pushed = await push(owner, repo, minted.body.token, "agent");
    expect(pushed.report).toContain("ok refs/heads/agent\n");
    // Revoking the grant stops the git token at the next write.
    expect((await api("DELETE", `/grants/${agent.grantId}`, owner.token)).status).toBe(200);
    const after = await push(owner, repo, minted.body.token, "after");
    expect(after.status).toBe(401);
  });

  it("stop, with the delegated token, when the agent's own token they came from is revoked", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const agent = await delegatedAgent(owner, repo, ["contents:write"]);
    const minted = await json<GitToken>(api("POST", "/user/git-tokens", agent.token, {}));
    expect(minted.status).toBe(201);
    expect((await push(owner, repo, minted.body.token, "before")).report).toContain(
      "ok refs/heads/before\n",
    );
    const revoked = await api(
      "DELETE",
      `/agents/${agent.agent}/tokens/${agent.agentToken.id}`,
      owner.token,
    );
    expect(revoked.status).toBe(200);
    // The next write with either token is refused.
    expect((await push(owner, repo, minted.body.token, "after")).status).toBe(401);
    expect((await api("POST", "/user/git-tokens", agent.token, {})).status).toBe(401);
  });

  it("are refused as the subject of a token exchange", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const agent = await delegatedAgent(owner, repo, ["contents:write"]);
    // The agent's own git token, minted with its own token.
    const own = await json<GitToken>(api("POST", "/user/git-tokens", agent.agentToken.token, {}));
    expect(own.status).toBe(201);
    const res = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: own.body.token,
        subject_token_type: ACCESS_TOKEN_TYPE,
        grant_id: agent.grantId,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("narrow the scopes to git's and never outlive the token minting them", async () => {
    const owner = await user();
    // A source that expires in ten minutes: an hour asked for, ten given.
    const short = await mintedFor(owner.principalId, ["repos:create", "contents:read"], 10);
    const minted = await json<GitToken>(
      api("POST", "/user/git-tokens", short.token, { expires_in_minutes: 60 }),
    );
    expect(minted.status).toBe(201);
    expect(minted.body.scopes).toEqual(["contents:read"]);
    expect(minted.body.expires_at).toBe(short.expiresAt);
    const wide = await scopedToken(owner.principalId, ["repos:create", "contents:read"], "pat");
    // A caller with nothing git uses gets none.
    const none = await scopedToken(owner.principalId, ["repos:create"], "pat");
    expect((await api("POST", "/user/git-tokens", none, {})).status).toBe(403);
    // At most an hour.
    expect((await api("POST", "/user/git-tokens", wide, { expires_in_minutes: 61 })).status).toBe(
      422,
    );
  });

  it("stop with the token they were minted from, and mint no more themselves", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const source = await mintedFor(owner.principalId, ["contents:write"], 60);
    const minted = await json<GitToken>(api("POST", "/user/git-tokens", source.token, {}));
    expect(minted.status).toBe(201);
    expect((await push(owner, repo, minted.body.token, "before")).report).toContain(
      "ok refs/heads/before\n",
    );
    // A git token makes no other token (its own lineage stays one step).
    expect((await api("POST", "/user/git-tokens", minted.body.token, {})).status).toBe(403);
    expect((await api("DELETE", `/user/tokens/${source.id}`, owner.token)).status).toBe(200);
    expect((await push(owner, repo, minted.body.token, "after")).status).toBe(401);
  });

  it("are listed, and revoked, with the user's tokens, a delegated one naming its grant", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const agent = await delegatedAgent(owner, repo, ["contents:write"]);
    const minted = await json<GitToken>(api("POST", "/user/git-tokens", agent.token, {}));
    const listed = await json<{ tokens: { id: string; grant_id: string | null }[] }>(
      api("GET", "/user/tokens", owner.token),
    );
    expect(listed.body.tokens.find((t) => t.id === minted.body.id)).toMatchObject({
      grant_id: agent.grantId,
    });
    expect((await api("DELETE", `/user/tokens/${minted.body.id}`, owner.token)).status).toBe(200);
    expect((await push(owner, repo, minted.body.token, "revoked")).status).toBe(401);
  });

  it("are minted over MCP as a tool", async () => {
    const owner = await user();
    const res = await exports.default.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "create_git_token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_git_token",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "fyrden-test", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).toContain("fyrden_git_");
  });
});
