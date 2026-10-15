// Repositories agents create: an agent acting for a user under a grant
// creates them in the user's namespace, with an expiry unless it gives one
// (scratch repositories clean themselves up), and within a limit of its own
// besides the user's quota. An agent with its own token creates none.

import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DEFAULT_ORG_SHARD } from "../src/events/read-model.js";
import { AGENT_REPO_DEFAULTS } from "../src/repos/agent-limits.js";
import { heldBack, newRepoStatements } from "../src/repos/directory.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";

const newId = createIdFactory(() => Date.now(), secureRandomBytes);

type Repo = { id: string; name: string; owner: string; expires_at: number | null };

/** `POST /api/user/repos` with Worker variables of the test's own. */
async function createWith(token: string, body: unknown, vars: Record<string, string>) {
  const ctx = createExecutionContext();
  const res = await createApp().fetch(
    new Request(`${ORIGIN}/api/user/repos`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    }),
    { ...env, ...vars },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: await res.json<Repo & { code?: string; detail?: string }>() };
}

describe("repositories agents create", () => {
  it("are the user's when the agent acts for it, and expire unless it says when", async () => {
    const owner = await user();
    const agent = await agentFor(owner, ["repos:create", "contents:write"]);
    const before = Date.now();
    const made = await json<Repo>(
      api("POST", "/user/repos", agent.delegated, { name: uniqueId("scratch") }),
    );
    expect(made.status).toBe(201);
    expect(made.body.owner).toBe(owner.handle);
    expect(made.body.expires_at).toBeGreaterThanOrEqual(before + AGENT_REPO_DEFAULTS.ttlMs);
    expect(made.body.expires_at).toBeLessThanOrEqual(Date.now() + AGENT_REPO_DEFAULTS.ttlMs);
    // The audit names the agent, acting for the user.
    const audit = await env.DIRECTORY.prepare(
      "SELECT actor_id FROM audit_log WHERE action = 'repo.create' AND target_id = ?",
    )
      .bind(made.body.id)
      .first<{ actor_id: string }>();
    expect(audit?.actor_id).toBe(agent.id);
    // An expiry it gives is kept; a user's own repositories have none unless asked.
    const at = Date.now() + 3 * 24 * 60 * 60 * 1000;
    const kept = await json<Repo>(
      api("POST", "/user/repos", agent.delegated, { name: uniqueId("kept"), expires_at: at }),
    );
    expect(kept.body.expires_at).toBe(at);
    const mine = await json<Repo>(api("POST", "/user/repos", owner.token, { name: uniqueId("m") }));
    expect(mine.body.expires_at).toBeNull();
  });

  it("stay scratch: the agent may move the expiry, not clear it; the user may", async () => {
    const owner = await user();
    const agent = await agentFor(owner, ["repos:create", "administration:write"]);
    const made = await json<Repo>(
      api("POST", "/user/repos", agent.delegated, { name: uniqueId("s") }),
    );
    const path = `/repos/${owner.handle}/${made.body.name}`;
    const later = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(
      (await json<Repo>(api("PATCH", path, agent.delegated, { expires_at: later }))).body,
    ).toMatchObject({ expires_at: later });
    expect((await api("PATCH", path, agent.delegated, { expires_at: null })).status).toBe(403);
    expect(
      (await json<Repo>(api("PATCH", path, owner.token, { expires_at: null }))).body,
    ).toMatchObject({ expires_at: null });
  });

  it("need the grant to allow it, and an agent's own token makes none", async () => {
    const owner = await user();
    const agent = await agentFor(owner, ["contents:write"]);
    expect(
      (await api("POST", "/user/repos", agent.delegated, { name: uniqueId("no") })).status,
    ).toBe(403);
    const own = await json<{ code: string; detail: string }>(
      api("POST", "/user/repos", agent.own, { name: uniqueId("own") }),
    );
    expect(own.status).toBe(403);
    // Nor a grant limited to repositories: its token could never reach the new one.
    const parent = await json<Repo>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("p") }),
    );
    const limited = await agentFor(
      owner,
      ["repos:create", "contents:read"],
      [`${owner.handle}/${parent.body.name}`],
    );
    expect(
      (await api("POST", "/user/repos", limited.delegated, { name: uniqueId("l") })).status,
    ).toBe(403);
    expect(
      (
        await api("POST", `/repos/${owner.handle}/${parent.body.name}/forks`, limited.delegated, {
          name: uniqueId("lf"),
        })
      ).status,
    ).toBe(403);
    expect(own.body.detail).toContain("grant");
  });

  it("are forked the same way: the user's, expiring; the agent's own token cannot see the parent", async () => {
    const owner = await user();
    const parent = await json<Repo>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("p") }),
    );
    // A branch for the fork to take, so its first commit is recorded.
    expect(
      (
        await api("PUT", `/repos/${owner.handle}/${parent.body.name}/contents/a.txt`, owner.token, {
          message: "a",
          content: btoa("a"),
        })
      ).status,
    ).toBe(200);
    const agent = await agentFor(owner, ["repos:create", "contents:read"]);
    const fork = await json<Repo>(
      api("POST", `/repos/${owner.handle}/${parent.body.name}/forks`, agent.delegated, {
        name: uniqueId("f"),
      }),
    );
    expect(fork.status).toBe(201);
    expect(fork.body.owner).toBe(owner.handle);
    expect(fork.body.expires_at).toBeGreaterThan(Date.now());
    // Its first commit names the agent, acting for the user under the grant.
    const audit = await runInDurableObject(env.REPO.getByName(fork.body.id), (_, state) =>
      state.storage.sql
        .exec("SELECT actor_id, act_chain, grant_id FROM audit_log WHERE action = 'refs.update'")
        .toArray(),
    );
    expect(audit).toEqual([
      {
        actor_id: owner.principalId,
        act_chain: JSON.stringify([agent.id]),
        grant_id: agent.grantId,
      },
    ]);
    expect(
      (
        await api("POST", `/repos/${owner.handle}/${parent.body.name}/forks`, agent.own, {
          name: uniqueId("g"),
        })
      ).status,
    ).toBe(404);
  });

  it("count against a limit of the agent's own", async () => {
    const owner = await user();
    const agent = await agentFor(owner, ["repos:create"]);
    const vars = { QUOTA_AGENT_MAX_REPOS: "2" };
    for (let i = 0; i < 2; i++)
      expect((await createWith(agent.delegated, { name: uniqueId("a") }, vars)).status).toBe(201);
    const third = await createWith(agent.delegated, { name: uniqueId("a") }, vars);
    expect(third.status).toBe(403);
    expect(third.body.code).toBe("quota_exceeded");
    expect(third.body.detail).toContain("agent");
    // The user's own are not the agent's.
    expect((await createWith(owner.token, { name: uniqueId("u") }, vars)).status).toBe(201);
  });

  it("hold the agent's limit in the batch that publishes, whatever was checked before", async () => {
    // As two creates racing past the check before it: both reach the batch.
    const owner = await user();
    const agentId = newId("agt");
    const db = env.DIRECTORY;
    const publish = (name: string) =>
      db
        .batch(
          newRepoStatements(
            db,
            {
              id: newId("rep"),
              ownerId: owner.principalId,
              name,
              networkId: newId("net"),
              orgShard: DEFAULT_ORG_SHARD,
              visibility: "private",
              parentId: null,
              expiresAt: null,
              now: Date.now(),
              createdBy: { agentId, maxRepos: 1 },
            },
            { actorId: agentId, action: "repo.create", details: {} },
            1_000,
          ),
        )
        .then((results) => heldBack(results, 1));
    expect(await publish(uniqueId("a"))).toBeUndefined();
    expect(await publish(uniqueId("b"))).toBe("agent_quota_exceeded");
  });
});
