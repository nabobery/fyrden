// Agents and delegation: an owner makes agents and mints their tokens; a
// user lets an agent act for it under a grant, which the agent exchanges
// for a delegated token (RFC 8693) whose act chain names it; an agent may
// pass a narrower grant down one hop; revoking a grant ends every token
// under it; an agent never exceeds its owner.

import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { recordedAccount } from "../src/accounts/grants.js";
import { createApp } from "../src/app.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE } from "../src/oauth/exchange.js";
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

  it("have their tokens listed and revoked one at a time by their owner", async () => {
    const owner = await user();
    const agent = await agentOf(owner);
    const second = await json<{ id: string; token: string }>(
      api("POST", `/agents/${agent.handle}/tokens`, owner.token, { type: "git" }),
    );
    const listed = await json<{ tokens: { id: string; type: string; revoked: boolean }[] }>(
      api("GET", `/agents/${agent.handle}/tokens`, owner.token),
    );
    expect(listed.status).toBe(200);
    expect(listed.body.tokens).toHaveLength(2);
    expect(listed.body.tokens.map((t) => t.type).sort()).toEqual(["git", "pat"]);
    // Someone else: not found, for listing and revoking alike.
    const other = await user();
    expect((await api("GET", `/agents/${agent.handle}/tokens`, other.token)).status).toBe(404);
    expect(
      (await api("DELETE", `/agents/${agent.handle}/tokens/${second.body.id}`, other.token)).status,
    ).toBe(404);
    // Another agent's token through this agent: not found either.
    const another = await agentOf(owner);
    const anothers = await json<{ tokens: { id: string }[] }>(
      api("GET", `/agents/${another.handle}/tokens`, owner.token),
    );
    const foreign = anothers.body.tokens[0]?.id ?? "";
    expect(
      (await api("DELETE", `/agents/${agent.handle}/tokens/${foreign}`, owner.token)).status,
    ).toBe(404);
    // The leaked one stops on its next write; the other keeps working.
    const pat = listed.body.tokens.find((t) => t.type === "pat")?.id ?? "";
    expect(
      await json(api("DELETE", `/agents/${agent.handle}/tokens/${pat}`, owner.token)),
    ).toMatchObject({ status: 200, body: { id: pat, revoked: true } });
    expect((await api("POST", "/grants", agent.token, {})).status).toBe(401);
    // The same agent's other token still authenticates for a write.
    expect((await api("POST", "/grants", second.body.token, {})).status).not.toBe(401);
    const after = await json<{ tokens: { id: string; revoked: boolean }[] }>(
      api("GET", `/agents/${agent.handle}/tokens`, owner.token),
    );
    expect(after.body.tokens.find((t) => t.id === pat)?.revoked).toBe(true);
    expect(after.body.tokens.find((t) => t.id === second.body.id)?.revoked).toBe(false);
    // Audited, with who revoked it.
    const audit = await env.DIRECTORY.prepare(
      "SELECT actor_id FROM audit_log WHERE action = 'token.revoke' AND target_id = ?",
    )
      .bind(pat)
      .first<{ actor_id: string }>();
    expect(audit?.actor_id).toBe(owner.principalId);
  });

  it("have their tokens managed only by their owner's full rights, never by an agent", async () => {
    const owner = await user();
    const agent = await agentOf(owner);
    const path = `/agents/${agent.handle}/tokens`;
    const [tokenId] = (
      await json<{ tokens: { id: string }[] }>(api("GET", path, owner.token))
    ).body.tokens.map((t) => t.id);
    // Read access lists, not revokes.
    const reader = await scopedToken(owner.principalId, ["agents:read"]);
    expect((await api("GET", path, reader)).status).toBe(200);
    expect((await api("DELETE", `${path}/${tokenId}`, reader)).status).toBe(403);
    // An agent manages no tokens, as itself or acting for its owner.
    expect((await api("GET", path, agent.token)).status).toBe(403);
    const granted = await grant(owner, { agent: agent.handle, scopes: ["agents:read"] });
    const acting = await delegated(agent.token, granted.body.id);
    expect((await api("GET", path, acting.body.access_token)).status).toBe(403);
    // A user's own token through an agent's path: not found.
    const mine = await json<{ id: string }>(
      api("POST", "/user/tokens", owner.token, { scopes: ["metadata:read"] }),
    );
    expect(await json(api("DELETE", `${path}/${mine.body.id}`, owner.token))).toMatchObject({
      status: 404,
      body: { code: "token_not_found" },
    });
    // An organization's agent: its owners, not its members.
    const login = uniqueId("org").slice(0, 39);
    await api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle });
    const member = await user();
    expect(
      await json(api("PUT", `/orgs/${login}/memberships/${member.handle}`, owner.token, {})),
    ).toMatchObject({ status: 200, body: { role: "member" } });
    const orgAgent = await agentOf(owner, login);
    const orgPath = `/agents/${orgAgent.handle}/tokens`;
    expect((await api("GET", orgPath, owner.token)).status).toBe(200);
    expect((await api("GET", orgPath, member.token)).status).toBe(404);
    const [orgTokenId] = (
      await json<{ tokens: { id: string }[] }>(api("GET", orgPath, owner.token))
    ).body.tokens.map((t) => t.id);
    expect((await api("DELETE", `${orgPath}/${orgTokenId}`, member.token)).status).toBe(404);
    expect((await api("DELETE", `${orgPath}/${orgTokenId}`, owner.token)).status).toBe(200);
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

describe("what a delegated token changes in a repository", () => {
  it("names the agents acting and the request, in its audit rows and its events", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const agent = await agentOf(owner);
    const made = await grant(owner, {
      agent: agent.handle,
      scopes: ["contents:write", "administration:write"],
    });
    const token = (await delegated(agent.token, made.body.id)).body.access_token;
    const wrote = await api("PUT", `${repo.path}/contents/notes.md`, token, {
      message: "Add notes",
      content: btoa("notes"),
    });
    expect(wrote.status).toBe(200);
    const fileRequest = wrote.headers.get("X-Request-Id");
    expect(fileRequest).toBeTruthy();
    const updated = await api("PATCH", repo.path, token, { description: "by an agent" });
    expect(updated.status).toBe(200);
    const settingsRequest = updated.headers.get("X-Request-Id");
    expect(settingsRequest).toBeTruthy();
    const recorded = await runInDurableObject(env.REPO.getByName(repo.id), (_, state) => ({
      audit: state.storage.sql
        .exec<{
          action: string;
          actor_id: string;
          act_chain: string | null;
          request_id: string | null;
        }>(
          "SELECT action, actor_id, act_chain, request_id FROM audit_log WHERE action IN ('refs.update', 'repo.update') ORDER BY seq",
        )
        .toArray(),
      events: state.storage.sql
        .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
        .toArray()
        .map((r) => JSON.parse(r.event) as { type: string; actor: string; actChain: string[] }),
    }));
    expect(recorded.audit).toEqual([
      {
        action: "refs.update",
        actor_id: owner.principalId,
        act_chain: JSON.stringify([agent.id]),
        request_id: fileRequest,
      },
      {
        action: "repo.update",
        actor_id: owner.principalId,
        act_chain: JSON.stringify([agent.id]),
        request_id: settingsRequest,
      },
    ]);
    const acted = recorded.events.filter((e) => e.type !== "repo.created");
    expect(acted.length).toBeGreaterThan(0);
    for (const event of acted) expect(event.actChain).toEqual([agent.id]);
  });
});

describe("a delegated deletion", () => {
  it("reaches the repository naming the agents acting and the request", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const agent = await agentOf(owner);
    const made = await grant(owner, { agent: agent.handle, scopes: ["administration:write"] });
    const token = (await delegated(agent.token, made.body.id)).body.access_token;
    // What the deletion job hands the repository, and what the repository records.
    let handed: unknown;
    let recorded: unknown;
    const REPO = new Proxy(env.REPO, {
      get(target, property) {
        if (property !== "getByName") {
          const value = (target as unknown as Record<PropertyKey, unknown>)[property];
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (name: string) =>
          new Proxy(target.getByName(name), {
            get(stub, method) {
              if (method === "prepareDeletion")
                return async (...args: Parameters<RepoDO["prepareDeletion"]>) => {
                  handed = args[0];
                  const prepared = await stub.prepareDeletion(...args);
                  recorded = await runInDurableObject(stub, (_: RepoDO, state) =>
                    state.storage.sql
                      .exec(
                        "SELECT act_chain, request_id FROM audit_log WHERE action = 'repo.delete'",
                      )
                      .one(),
                  );
                  return prepared;
                };
              const value: unknown = Reflect.get(stub, method);
              return typeof value === "function"
                ? (...args: unknown[]) => Reflect.apply(value, stub, args)
                : value;
            },
          });
      },
    });
    const ctx = createExecutionContext();
    const res = await createApp().request(
      `${ORIGIN}/api${repo.path}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
      },
      { ...env, REPO },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const requestId = res.headers.get("X-Request-Id");
    expect(requestId).toBeTruthy();
    expect(handed).toEqual({ principal: owner.principalId, actChain: [agent.id], requestId });
    expect(recorded).toEqual({ act_chain: JSON.stringify([agent.id]), request_id: requestId });
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
