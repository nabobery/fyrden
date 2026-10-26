// The feed's readers authorized fresh: the credential on the directory's
// primary before anything of the feed is read, and each repository's role
// confirmed by its account's object beside the repository's cached
// snapshot, so a lost invalidation, a revocation or a newly required DPoP
// proof shows at once, and a fresh denial hides without forgetting.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import { MAX_READER_PRINCIPALS, MAX_READER_REPOS } from "../src/do/OrgDO.js";
import { FreshAccess } from "../src/feed/access.js";
import { encodeFeedCursor } from "../src/feed/operations.js";
import { findReposById } from "../src/repos/directory.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { entry } from "./helpers/feed.js";

type FeedOut = {
  items: { item_key: string; epoch: number; version: number }[];
  next_cursor: string;
};
type SyncOut = { items: { item_key: string }[]; complete: boolean };

let admin: Who;
beforeAll(async () => {
  admin = await user(true);
});

async function ok<T = Record<string, unknown>>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
  return (answer.status === 204 ? {} : await answer.json()) as T;
}

/** An organization owned by `owner`, and a private repository of it. */
async function orgRepo(
  owner: Who,
): Promise<{ org: { login: string; id: string }; repoId: string; path: string }> {
  const login = uniqueId("org").slice(0, 39);
  const made = await ok<{ id: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  const repo = await ok<{ id: string; name: string }>(
    api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("r") }),
  );
  return { org: { login, id: made.id }, repoId: repo.id, path: `/repos/${login}/${repo.name}` };
}

/** An item for `who` about `repoId`'s first pull request (one it may read is shown). */
const deliver = (who: string, repoId: string, version = 1) =>
  env.USER.getByName(who).applyFeed([entry({ repoId, version, principal: who })]);

const list = (who: Who) => json<FeedOut>(api("GET", "/feed", who.token));

/** Calls MCP tool `name` with `token`; the response's text. */
async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await exports.default.fetch("https://fyrden.test/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "fyrden-test", version: "0.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return res.text();
}
const sync = (who: Who) => json<SyncOut>(api("GET", "/feed/sync", who.token));

/**
 * Changes the account's own records as `change` does and gives them a new
 * ACL version, without telling the repository (its invalidation lost): the
 * repository's snapshot still says what it said.
 */
const quietly = (orgId: string, change: (sql: SqlStorage) => void) =>
  runInDurableObject(env.ORG.getByName(orgId), (_: OrgDO, state) => {
    change(state.storage.sql);
    state.storage.sql.exec("UPDATE org_meta SET acl_version = acl_version + 1");
  });

/**
 * `principal` (an agent: the API adds users only) given `role` on the
 * account's repository directly, the repository told.
 */
async function collaborator(
  orgId: string,
  repoId: string,
  principal: { id: string; handle: string },
) {
  const { epoch, version } = await runInDurableObject(
    env.ORG.getByName(orgId),
    (_: OrgDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO collaborators (repo_id, principal_id, handle, role, added_at) VALUES (?, ?, ?, 'read', 0)",
        repoId,
        principal.id,
        principal.handle,
      );
      state.storage.sql.exec("UPDATE org_meta SET acl_version = acl_version + 1");
      return state.storage.sql
        .exec<{ epoch: number; version: number }>(
          "SELECT epoch_gen AS epoch, acl_version AS version FROM org_meta",
        )
        .one();
    },
  );
  await env.REPO.getByName(repoId).invalidateAcl(orgId, epoch, version);
}

describe("a feed read after access was lost without the repository told", () => {
  it("hides the item from list, sync and ack at once, and forgets nothing for it", async () => {
    const [owner, alice] = [await user(), await user()];
    const { org, repoId, path } = await orgRepo(owner);
    await ok(
      api("PUT", `${path}/collaborators/${alice.handle}`, owner.token, { permission: "pull" }),
    );
    await deliver(alice.principalId, repoId);
    // Seen while it may be read (the repository's snapshot pulled).
    const before = await list(alice);
    expect(before.body.items).toHaveLength(1);
    const key = before.body.items[0]?.item_key as string;
    await quietly(org.id, (sql) =>
      sql.exec("DELETE FROM collaborators WHERE principal_id = ?", alice.principalId),
    );
    expect((await list(alice)).body.items).toEqual([]);
    expect((await sync(alice)).body.items).toEqual([]);
    const acked = await json(
      api("POST", "/feed/ack", alice.token, { item_key: key, epoch: 1, version: 1 }),
    );
    expect(acked.status).toBe(404);
    // Hidden, not forgotten: the repository's own check never said so.
    const held = await runInDurableObject(
      env.USER.getByName(alice.principalId),
      (_: unknown, state) =>
        state.storage.sql.exec("SELECT count(*) AS n FROM feed_items").one().n as number,
    );
    expect(held).toBe(1);
  });

  it("hides it from an agent whose owner lost access", async () => {
    const owner = await user();
    const { org, repoId, path } = await orgRepo(owner);
    const bob = await user();
    await ok(
      api("PUT", `${path}/collaborators/${bob.handle}`, owner.token, { permission: "pull" }),
    );
    const agent = await ok<{ id: string; handle: string }>(
      api("POST", "/agents", bob.token, { handle: uniqueId("bot").slice(0, 39) }),
    );
    await collaborator(org.id, repoId, agent);
    const own = await ok<{ token: string }>(
      api("POST", `/agents/${agent.handle}/tokens`, bob.token, { scopes: ["pull_requests:read"] }),
    );
    const asAgent = { principalId: agent.id, token: own.token, handle: agent.handle };
    await deliver(agent.id, repoId);
    expect((await list(asAgent)).body.items).toHaveLength(1);
    // The agent keeps its own role; its owner, the ceiling, loses its.
    await quietly(org.id, (sql) =>
      sql.exec("DELETE FROM collaborators WHERE principal_id = ?", bob.principalId),
    );
    expect((await list(asAgent)).body.items).toEqual([]);
  });
});

describe("a feed read by its own account's repositories and agents", () => {
  it("reads a user's repository before the user's account was ever recorded", async () => {
    const someone = await user();
    const repo = await ok<{ id: string }>(
      api("POST", "/user/repos", someone.token, { name: uniqueId("mine") }),
    );
    await deliver(someone.principalId, repo.id);
    const listed = await list(someone);
    expect(listed.body.items).toHaveLength(1);
    expect((await sync(someone)).body.items).toHaveLength(1);
    const key = listed.body.items[0]?.item_key as string;
    expect(
      (await json(api("POST", "/feed/ack", someone.token, { item_key: key, epoch: 1, version: 1 })))
        .status,
    ).toBe(200);
  });

  it("lets an organization's agent read its organization's private repository, capped by it", async () => {
    const owner = await user();
    const { org, repoId } = await orgRepo(owner);
    // Another organization's repository, where the agent has a role of its own.
    const elsewhere = await orgRepo(await user());
    const agent = await ok<{ id: string; handle: string }>(
      api("POST", "/agents", owner.token, { handle: uniqueId("bot").slice(0, 39), org: org.login }),
    );
    await collaborator(org.id, repoId, agent);
    const own = await ok<{ token: string }>(
      api("POST", `/agents/${agent.handle}/tokens`, owner.token, {
        scopes: ["pull_requests:read"],
      }),
    );
    await collaborator(elsewhere.org.id, elsewhere.repoId, agent);
    await deliver(agent.id, repoId);
    await deliver(agent.id, elsewhere.repoId, 2);
    const asAgent = { principalId: agent.id, token: own.token, handle: agent.handle };
    // Its organization's, only: its organization, the ceiling, has no role on the other's.
    const listed = await list(asAgent);
    expect(listed.body.items.map((i) => i.item_key.split(":")[0])).toEqual([repoId]);
  });
});

describe("a feed read by a credential changed since it was cached", () => {
  // Each case its own credential, cached by a read and then revoked: a refusal drops it from the
  // cache, so a later call of the same credential would be refused before the operation.
  const revokedAfterRead = async (news: boolean) => {
    const someone = await user();
    const repo = await ok<{ id: string }>(
      api("POST", "/user/repos", someone.token, { name: uniqueId("mine") }),
    );
    expect((await list(someone)).status).toBe(200);
    expect(await callTool(someone.token, "get_feed")).not.toContain("invalid_token");
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE principal_id = ?")
      .bind(Date.now(), someone.principalId)
      .run();
    if (news) await deliver(someone.principalId, repo.id);
    return someone;
  };

  it("is refused once the token is revoked, whether the feed is quiet, has news or the cursor expired", async () => {
    for (const news of [false, true]) {
      expect((await list(await revokedAfterRead(news))).status, `list ${news}`).toBe(401);
      expect((await sync(await revokedAfterRead(news))).status, `sync ${news}`).toBe(401);
    }
    // A cursor of another epoch (expired for any feed).
    const expired = encodeFeedCursor("gone", "0".repeat(32));
    const someone = await revokedAfterRead(false);
    expect((await json(api("GET", `/feed?since=${expired}`, someone.token))).status).toBe(401);
  });

  it("is refused through MCP too, whether the feed is quiet or has news", async () => {
    for (const news of [false, true])
      for (const tool of ["get_feed", "sync_feed"])
        expect(
          await callTool((await revokedAfterRead(news)).token, tool),
          `${tool} ${news}`,
        ).toContain("invalid_token");
    // An expired cursor too.
    const expired = encodeFeedCursor("gone", "0".repeat(32));
    expect(
      await callTool((await revokedAfterRead(false)).token, "get_feed", { since: expired }),
    ).toContain("invalid_token");
  });

  /** An agent's bearer token, cached by a read, whose owner then requires DPoP. */
  const dpopRequiredAfterRead = async () => {
    const owner = await user();
    const agent = await ok<{ id: string; handle: string }>(
      api("POST", "/agents", owner.token, { handle: uniqueId("bot").slice(0, 39) }),
    );
    const own = await ok<{ token: string }>(
      api("POST", `/agents/${agent.handle}/tokens`, owner.token, {}),
    );
    expect((await json(api("GET", "/feed", own.token))).status).toBe(200);
    expect(await callTool(own.token, "get_feed")).not.toContain("invalid_dpop_proof");
    await env.DIRECTORY.prepare("UPDATE principals SET require_dpop = 1 WHERE id = ?")
      .bind(owner.principalId)
      .run();
    return own.token;
  };

  it("is refused once the owner requires DPoP of an agent holding a bearer token", async () => {
    const refused = await json<{ code?: string }>(
      api("GET", "/feed", await dpopRequiredAfterRead()),
    );
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("invalid_dpop_proof");
    const synced = await json<{ code?: string }>(
      api("GET", "/feed/sync", await dpopRequiredAfterRead()),
    );
    expect(synced.body.code).toBe("invalid_dpop_proof");
    for (const tool of ["get_feed", "sync_feed"])
      expect(await callTool(await dpopRequiredAfterRead(), tool), tool).toContain(
        "invalid_dpop_proof",
      );
  });
});

describe("the account's confirmation of feed readers", () => {
  it("refuses more repositories or principals than it reads at once", async () => {
    const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    // Asked of the object itself (an RPC refusal would also surface as an unhandled rejection).
    const refused = await runInDurableObject(
      env.ORG.getByName(`usr_${uniqueId("x")}`),
      async (org: OrgDO) => {
        const refusal = (call: Promise<unknown>) =>
          call.then(
            () => "answered",
            (error: Error) => error.message,
          );
        return [
          await refusal(org.confirmReaders(ids(MAX_READER_REPOS + 1, "rep_"), ["usr_a"])),
          await refusal(org.confirmReaders(["rep_a"], ids(MAX_READER_PRINCIPALS + 1, "usr_"))),
          await refusal(org.confirmReaders(ids(MAX_READER_REPOS, "rep_"), ["usr_a"])),
        ];
      },
    );
    expect(refused).toEqual([
      `more than ${MAX_READER_REPOS} repositories to confirm`,
      `more than ${MAX_READER_PRINCIPALS} principals to confirm`,
      "answered",
    ]);
  });

  it("answers a repository it released as held by no one", async () => {
    const owner = await user();
    const { org, repoId } = await orgRepo(owner);
    await runInDurableObject(env.ORG.getByName(org.id), (_: OrgDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO released_repos (repo_id, transfer_id, released_at) VALUES (?, 'tr_x', 0)",
        repoId,
      );
    });
    const answer = await env.ORG.getByName(org.id).confirmReaders([repoId], [owner.principalId]);
    expect(answer.repos[repoId]).toEqual({ held: false, roles: {} });
    // So no one reads it through this account any more, the account itself (which administers
    // what it holds) included.
    const metrics = { count() {}, gauge() {}, timing() {} } as never;
    const record = { principalId: org.id, grantId: null } as never;
    const decided = await new FreshAccess({ env, metrics }, record).decide(
      await findReposById(env, [repoId]),
    );
    expect(decided.get(repoId)).toEqual({ held: false, role: null, accountId: org.id });
  });
});
