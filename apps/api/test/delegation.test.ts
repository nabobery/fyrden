// Agents and delegation: an owner makes agents and mints their tokens; a
// user lets an agent act for it under a grant, which the agent exchanges
// for a delegated token (RFC 8693) whose act chain names it; an agent may
// pass a narrower grant down one hop; revoking a grant ends every token
// under it; an agent never exceeds its owner.

import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { recordedAccount } from "../src/accounts/grants.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE } from "../src/oauth/token.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";

type Agent = { id: string; handle: string; owner: string; disabled: boolean };
type Grant = { id: string; agent_id: string; depth: number; root_id: string; scopes: string[] };
type Whoami = {
  id: string;
  type: string;
  act: { id: string; handle: string | null }[];
  token: { type: string; grant_id: string | null; scopes: string[] };
};

let admin: Who;

beforeAll(async () => {
  admin = await user(true);
});

async function agentOf(owner: Who, org?: string): Promise<Agent & { token: string }> {
  const made = await json<Agent>(
    api("POST", "/agents", owner.token, { handle: uniqueId("bot").slice(0, 39), org }),
  );
  expect(made.status).toBe(201);
  const minted = await json<{ token: string }>(
    api("POST", `/agents/${made.body.handle}/tokens`, owner.token, {}),
  );
  expect(minted.status).toBe(201);
  return { ...made.body, token: minted.body.token };
}

const grant = (who: Who | { token: string }, body: Record<string, unknown>) =>
  json<Grant & { code?: string }>(api("POST", "/grants", who.token, body));

function exchange(params: Record<string, string>) {
  return exports.default.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

async function delegated(agentToken: string, grantId: string, scope?: string) {
  const res = await exchange({
    grant_type: TOKEN_EXCHANGE,
    subject_token: agentToken,
    subject_token_type: ACCESS_TOKEN_TYPE,
    grant_id: grantId,
    ...(scope !== undefined && { scope }),
  });
  return {
    status: res.status,
    body: await res.json<{ access_token: string; error?: string; scope: string }>(),
  };
}

async function repoOf(owner: Who): Promise<{ id: string; name: string; path: string }> {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
  );
  expect(made.status).toBe(201);
  return { ...made.body, path: `/repos/${owner.handle}/${made.body.name}` };
}

describe("agents", () => {
  it("are made and listed by their owner, act with their own tokens, and stop when disabled", async () => {
    const owner = await user();
    const agent = await agentOf(owner);
    expect(agent.owner).toBe(owner.handle);
    const me = await json<Whoami>(api("GET", "/user", agent.token));
    expect(me.body).toMatchObject({ id: agent.id, type: "agent", act: [] });
    const listed = await json<{ agents: Agent[] }>(api("GET", "/agents", owner.token));
    expect(listed.body.agents.map((a) => a.id)).toEqual([agent.id]);
    // Someone else sees none of it.
    const other = await user();
    expect((await api("GET", `/agents/${agent.handle}`, other.token)).status).toBe(404);
    // An agent makes no agents.
    expect((await api("POST", "/agents", agent.token, { handle: uniqueId("x") })).status).toBe(403);
    expect((await json(api("DELETE", `/agents/${agent.handle}`, owner.token))).body).toMatchObject({
      disabled: true,
    });
    // At once for writes (reads may use a cached answer for 30 s).
    expect((await api("POST", "/grants", agent.token, {})).status).toBe(401);
  });

  it("act with their own roles, never exceeding their owner's", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const agent = await agentOf(owner);
    // No role of its own yet.
    expect((await api("GET", repo.path, agent.token)).status).toBe(404);
    // Agents are not collaborators through the API yet: granted in the account's object.
    const collaborate = async (a: Agent) => {
      const account = await recordedAccount(env, { id: owner.principalId, handle: owner.handle });
      const granted = await account.setCollaborator(
        { principalId: owner.principalId },
        repo.id,
        { id: a.id, handle: a.handle },
        "read",
      );
      if (!granted.ok) throw new Error(granted.error);
      await env.REPO.getByName(repo.id).invalidateAcl(
        owner.principalId,
        granted.epochGen,
        granted.version,
      );
    };
    await collaborate(agent);
    expect((await api("GET", repo.path, agent.token)).status).toBe(200);
    // An agent of someone with no access to the repository reads nothing of it, collaborator or not.
    const stranger = await agentOf(await user());
    await collaborate(stranger);
    expect((await api("GET", repo.path, stranger.token)).status).toBe(404);
  });
});

describe("delegation grants", () => {
  it("let an agent act for the user within the grant, named in the act chain", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const elsewhere = await repoOf(owner);
    const agent = await agentOf(owner);
    const made = await grant(owner, {
      agent: agent.handle,
      scopes: ["contents:read"],
      repositories: [`${owner.handle}/${repo.name}`],
    });
    expect(made).toMatchObject({ status: 201, body: { depth: 1, scopes: ["contents:read"] } });
    const exchanged = await delegated(agent.token, made.body.id);
    expect(exchanged.status).toBe(200);
    const token = exchanged.body.access_token;
    expect(token.startsWith("fyrden_oat_")).toBe(true);
    const me = await json<Whoami>(api("GET", "/user", token));
    expect(me.body).toMatchObject({
      id: owner.principalId,
      type: "user",
      act: [{ id: agent.id, handle: agent.handle }],
      token: { type: "oat", grant_id: made.body.id, scopes: ["contents:read"] },
    });
    // Within the grant: this repository, reading; not another, not writing.
    expect((await api("GET", `${repo.path}/branches`, token)).status).toBe(200);
    expect((await api("GET", elsewhere.path, token)).status).toBe(404);
    expect(
      (
        await api("PUT", `${repo.path}/contents/a.txt`, token, {
          message: "m",
          content: btoa("a"),
        })
      ).status,
    ).toBe(403);
    // Nor anything only users do, nor grants of its own.
    expect((await api("POST", "/user/repos", token, { name: uniqueId("x") })).status).toBe(403);
    expect(
      (await grant({ token }, { agent: agent.handle, scopes: ["contents:read"] })).status,
    ).toBe(403);
    // The audit names the agent and its chain.
    const audit = await env.DIRECTORY.prepare(
      "SELECT actor_id, act_chain FROM audit_log WHERE action = 'token.mint' AND actor_id = ?",
    )
      .bind(agent.id)
      .first<{ actor_id: string; act_chain: string }>();
    expect(JSON.parse(audit?.act_chain ?? "[]")).toEqual([agent.id]);
  });

  it("are refused beyond the grant, the agent's token or the user's token", async () => {
    const owner = await user();
    const agent = await agentOf(owner);
    const made = await grant(owner, { agent: agent.handle, scopes: ["metadata:read"] });
    expect((await delegated(agent.token, made.body.id, "contents:write")).body.error).toBe(
      "invalid_scope",
    );
    // Not the grant's agent, not an agent's token, not a token exchange.
    const other = await agentOf(owner);
    expect((await delegated(other.token, made.body.id)).body.error).toBe("invalid_grant");
    expect((await delegated(owner.token, made.body.id)).body.error).toBe("invalid_grant");
    const wrong = await exchange({ grant_type: "client_credentials" });
    expect(await wrong.json()).toMatchObject({ error: "unsupported_grant_type" });
    // A narrow user token hands out no more than it holds.
    const narrow = { ...owner, token: await scopedToken(owner.principalId, ["grants:write"]) };
    expect(await grant(narrow, { agent: agent.handle, scopes: ["contents:write"] })).toMatchObject({
      status: 403,
      body: { code: "scope_exceeds_token" },
    });
  });

  it("pass down one hop to another agent of the owner, narrower, and no further", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const first = await agentOf(owner);
    const second = await agentOf(owner);
    const root = await grant(owner, { agent: first.handle, scopes: ["contents:read"] });
    const sub = await grant(first, {
      agent: second.handle,
      scopes: ["metadata:read"],
      parent: root.body.id,
    });
    expect(sub).toMatchObject({ status: 201, body: { depth: 2, root_id: root.body.id } });
    const token = (await delegated(second.token, sub.body.id)).body.access_token;
    const me = await json<Whoami>(api("GET", "/user", token));
    expect(me.body.act.map((a) => a.id)).toEqual([second.id, first.id]);
    expect((await api("GET", repo.path, token)).status).toBe(200);
    // Wider than its parent, to another owner's agent, or a hop further: refused.
    expect(
      (
        await grant(first, {
          agent: second.handle,
          scopes: ["contents:write"],
          parent: root.body.id,
        })
      ).body.code,
    ).toBe("scope_exceeds_parent");
    const foreign = await agentOf(await user());
    expect(
      (
        await grant(first, {
          agent: foreign.handle,
          scopes: ["metadata:read"],
          parent: root.body.id,
        })
      ).body.code,
    ).toBe("invalid_agent");
    expect(
      (await grant(second, { agent: first.handle, scopes: ["metadata:read"], parent: sub.body.id }))
        .body.code,
    ).toBe("too_deep");
    // Revoking the user's grant ends the sub-agent's token at its next write check.
    expect((await api("DELETE", `/grants/${root.body.id}`, owner.token)).status).toBe(200);
    expect((await delegated(second.token, sub.body.id)).body.error).toBe("invalid_grant");
    expect((await api("POST", `${repo.path}/rulesets`, token, {})).status).toBe(401);
  });

  it("cap an agent of an organization by the organization's own rights", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const orgLogin = uniqueId("org").slice(0, 39);
    expect(
      (
        await api("POST", "/admin/organizations", admin.token, {
          login: orgLogin,
          admin: owner.handle,
        })
      ).status,
    ).toBe(201);
    const orgAgent = await agentOf(owner, orgLogin);
    const made = await grant(owner, { agent: orgAgent.handle, scopes: ["metadata:read"] });
    const token = (await delegated(orgAgent.token, made.body.id)).body.access_token;
    // The user's own repository: the organization has no role there, so its agent reads nothing.
    expect((await api("GET", repo.path, token)).status).toBe(404);
  });

  it("make rulesets for agents apply to an agent acting for its user", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const put = (token: string, file: string) =>
      api("PUT", `${repo.path}/contents/${file}`, token, { message: "m", content: btoa(file) });
    expect((await put(owner.token, "first.txt")).status).toBe(200);
    expect(
      (
        await api("POST", `${repo.path}/rulesets`, owner.token, {
          name: "agents use PRs",
          enforcement: "active",
          actor_types: ["agent"],
          conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
          rules: [{ type: "pull_request" }],
        })
      ).status,
    ).toBe(201);
    const agent = await agentOf(owner);
    const made = await grant(owner, { agent: agent.handle, scopes: ["contents:write"] });
    const token = (await delegated(agent.token, made.body.id)).body.access_token;
    expect(await json(put(token, "by-agent.txt"))).toMatchObject({
      status: 409,
      body: { code: "ruleset_violation" },
    });
    expect((await put(owner.token, "by-user.txt")).status).toBe(200);
  });

  it("cap an agent of another owner by that owner's role, in rulesets' bypasses and listings", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const hidden = await repoOf(owner);
    const put = (token: string, file: string) =>
      api("PUT", `${repo.path}/contents/${file}`, token, { message: "m", content: btoa(file) });
    expect((await put(owner.token, "first.txt")).status).toBe(200);
    // Admins bypass the agents' rule; the user is an admin, the agent's owner a writer.
    expect(
      (
        await api("POST", `${repo.path}/rulesets`, owner.token, {
          name: "agents use PRs",
          enforcement: "active",
          actor_types: ["agent"],
          bypass_actors: [{ actor_type: "RepositoryRole", actor_id: "admin" }],
          conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
          rules: [{ type: "pull_request" }],
        })
      ).status,
    ).toBe(201);
    const writer = await user();
    await api("PUT", `${repo.path}/collaborators/${writer.handle}`, owner.token, {
      permission: "push",
    });
    const agent = await agentOf(writer);
    const made = await grant(owner, { agent: agent.handle, scopes: ["contents:write"] });
    const token = (await delegated(agent.token, made.body.id)).body.access_token;
    expect(await json(put(token, "by-agent.txt"))).toMatchObject({
      status: 409,
      body: { code: "ruleset_violation" },
    });
    // It lists what its owner may see of the user's repositories, not the others, a page at a
    // time without a cursor naming one it may not see.
    const listed = await json<{ repos: { id: string }[]; next_cursor: string | null }>(
      api("GET", "/user/repos?per_page=1", token),
    );
    expect(listed.body).toEqual({
      repos: [expect.objectContaining({ id: repo.id })],
      next_cursor: null,
    });
    expect(hidden.id).not.toBe(repo.id);
  });

  it("last no longer than the token that makes them", async () => {
    const owner = await user();
    const agent = await agentOf(owner);
    const short = await scopedToken(owner.principalId, []);
    const hour = Date.now() + 60 * 60 * 1000;
    await env.DIRECTORY.prepare(
      `UPDATE tokens SET expires_at = ? WHERE id = (SELECT id FROM tokens WHERE principal_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1)`,
    )
      .bind(hour, owner.principalId)
      .run();
    const made = await grant(
      { token: short },
      { agent: agent.handle, scopes: ["metadata:read"], expires_in_days: 30 },
    );
    expect(made.status).toBe(201);
    expect((made.body as unknown as { expires_at: number }).expires_at).toBeLessThanOrEqual(hour);
  });

  it("are never wider than the token that mints an agent's token", async () => {
    const owner = await user();
    const agent = await agentOf(owner);
    const narrow = await scopedToken(owner.principalId, ["agents:write"]);
    const minted = await json<{ scopes: string[]; code?: string }>(
      api("POST", `/agents/${agent.handle}/tokens`, narrow, {}),
    );
    expect(minted).toMatchObject({ status: 201, body: { scopes: ["agents:write"] } });
    expect(
      await json(
        api("POST", `/agents/${agent.handle}/tokens`, narrow, { scopes: ["contents:write"] }),
      ),
    ).toMatchObject({ status: 403, body: { code: "scope_exceeds_token" } });
  });

  it("record the act chain on what a delegated token changes in the directory", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const agent = await agentOf(owner);
    const made = await grant(owner, { agent: agent.handle, scopes: ["administration:write"] });
    const token = (await delegated(agent.token, made.body.id)).body.access_token;
    const renamed = uniqueId("renamed");
    expect((await api("PATCH", repo.path, token, { name: renamed })).status).toBe(200);
    const row = await env.DIRECTORY.prepare(
      "SELECT actor_id, act_chain FROM audit_log WHERE action = 'repo.rename' AND target_id = ?",
    )
      .bind(repo.id)
      .first<{ actor_id: string; act_chain: string }>();
    expect(row?.actor_id).toBe(owner.principalId);
    expect(JSON.parse(row?.act_chain ?? "null")).toEqual([agent.id]);
    // Administering for the user, it still changes nobody's access.
    expect(
      (
        await json(
          api("PUT", `/repos/${owner.handle}/${renamed}/collaborators/${admin.handle}`, token, {
            permission: "pull",
          }),
        )
      ).body,
    ).toMatchObject({ code: "delegated_token" });
  });
});

describe("the token endpoint", () => {
  it("refuses an oversized body before reading it all", async () => {
    const res = await exchange({ grant_type: TOKEN_EXCHANGE, padding: "x".repeat(32 * 1024) });
    expect(res.status).toBe(413);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("takes an API access token for a chunked upload's parts", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const agent = await agentOf(owner);
    const made = await grant(owner, { agent: agent.handle, scopes: ["contents:write"] });
    const token = (await delegated(agent.token, made.body.id)).body.access_token;
    const res = await exports.default.fetch(
      `${ORIGIN}/${owner.handle}/${repo.name}.git/uploads/01ARZ3NDEKTSV4RRFFQ69G5FAV/parts/1`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Length": "1" },
        body: "x",
      },
    );
    // Past authentication: the made-up session is not found.
    expect(res.status).toBe(404);
  });
});
