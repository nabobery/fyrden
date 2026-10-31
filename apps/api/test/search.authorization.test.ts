// Which repositories a search may read: its scope (repo:, org:, user:,
// intersecting) resolved on the directory's primary, at most a thousand of
// an owner's, and the caller's role on each as its account's object has it
// now, its ceilings and its token's limits applied. No scope, too broad a
// scope, or an answer that could not be had is a refusal, never a smaller
// result; a named repository the caller may read nothing of is not found.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { D1TokenStore } from "@fyrden/adapters-cloudflare/auth";
import { createMetrics } from "@fyrden/adapters-cloudflare/obs";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import { type OpContext, OperationError } from "../src/ops/execute.js";
import { authorizeScope, SEARCH_SCOPE } from "../src/search/authorization.js";
import { parseSearchQuery } from "../src/search/parser.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";

const newId = createIdFactory(Date.now, secureRandomBytes);

let admin: Who;
beforeAll(async () => {
  admin = await user(true);
});

/** The operation context a request with `token` has, its credential verified on the primary. */
async function contextOf(token: string, using: Env = env): Promise<OpContext> {
  const verified = await new D1TokenStore(env.DIRECTORY, {
    clock: Date.now,
    newId,
    randomBytes: secureRandomBytes,
  }).verify(token, "write");
  if (!verified.ok) throw new Error(`token not verified: ${verified.reason}`);
  return {
    env: using,
    auth: verified.record,
    metrics: createMetrics(env.METRICS),
  } as unknown as OpContext;
}

async function repoOf(
  owner: Who,
  path = "/user/repos",
): Promise<{ id: string; full_name: string }> {
  const res = await json<{ id: string; full_name: string }>(
    api("POST", path, owner.token, { name: uniqueId("r") }),
  );
  expect(res.status).toBe(201);
  return res.body;
}

const scope = async (token: string, q: string, using?: Env) =>
  (await authorizeScope(await contextOf(token, using), parseSearchQuery(q, "issues"))).map((r) => ({
    name: r.entry.name,
    metadata: r.metadata,
    issues: r.issues,
    pulls: r.pulls,
  }));

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return (error as OperationError).code;
  }
  throw new Error("not refused");
}

const nameOf = (full: string) => full.split("/")[1] as string;

/** An organization `owner` administers, and a repository of it. */
async function orgRepoOf(
  owner: Who,
): Promise<{ orgId: string; repo: { id: string; full_name: string } }> {
  const login = uniqueId("org").slice(0, 39);
  const made = await json<{ id: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  return { orgId: made.body.id, repo: await repoOf(owner, `/orgs/${login}/repos`) };
}

/** `principal` (an agent: the API adds users only) given read on the account's repository directly. */
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
const all = { metadata: true, issues: true, pulls: true };

describe("a search's scope", () => {
  it("is required", async () => {
    const someone = await user();
    expect(await refusal(scope(someone.token, "crash is:open"))).toBe("search_scope_required");
  });

  it("holds an owner's repositories its owner may read, and none of a stranger's", async () => {
    const owner = await user();
    const [a, b] = [await repoOf(owner), await repoOf(owner)];
    expect(
      (await scope(owner.token, `user:${owner.handle}`)).sort((x, y) =>
        x.name.localeCompare(y.name),
      ),
    ).toEqual([nameOf(a.full_name), nameOf(b.full_name)].sort().map((name) => ({ name, ...all })));
    const stranger = await user();
    expect(await scope(stranger.token, `user:${owner.handle}`)).toEqual([]);
    // Named, it is not found to them, as any repository they may not read.
    expect(await refusal(scope(stranger.token, `repo:${a.full_name}`))).toBe("repo_not_found");
    expect(await refusal(scope(owner.token, `repo:${owner.handle}/missing`))).toBe(
      "repo_not_found",
    );
  });

  it("holds a collaborator's repository alone of its owner's, and an organization's to its members", async () => {
    const owner = await user();
    const [shared] = [await repoOf(owner), await repoOf(owner)];
    const bob = await user();
    expect(
      (
        await api("PUT", `/repos/${shared?.full_name}/collaborators/${bob.handle}`, owner.token, {
          permission: "pull",
        })
      ).status,
    ).toBeLessThan(300);
    expect(await scope(bob.token, `user:${owner.handle}`)).toEqual([
      { name: nameOf(shared?.full_name ?? ""), ...all },
    ]);
    const login = uniqueId("org").slice(0, 39);
    expect(
      (await api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }))
        .status,
    ).toBeLessThan(300);
    const orgRepo = await repoOf(owner, `/orgs/${login}/repos`);
    expect(await scope(owner.token, `org:${login}`)).toEqual([
      { name: nameOf(orgRepo.full_name), ...all },
    ]);
    // An organization's handle is no user's.
    expect(await scope(owner.token, `user:${login}`)).toEqual([]);
  });

  it("holds what the token allows: its scopes, and its repositories alone", async () => {
    const owner = await user();
    const [a, b] = [await repoOf(owner), await repoOf(owner)];
    const issuesOnly = await scopedToken(owner.principalId, ["issues:read"]);
    expect(await scope(issuesOnly, `repo:${a.full_name}`)).toEqual([
      // (Any read of a repository's reads its metadata too.)
      { name: nameOf(a.full_name), metadata: true, issues: true, pulls: false },
    ]);
    const onlyB = await scopedToken(owner.principalId, [], "pat", [b.id]);
    expect(await scope(onlyB, `user:${owner.handle}`)).toEqual([
      { name: nameOf(b.full_name), ...all },
    ]);
  });

  it("holds what an agent's owner may read, no more", async () => {
    const owner = await user();
    const { orgId, repo } = await orgRepoOf(owner);
    const bob = await user();
    expect(
      (
        await api("PUT", `/repos/${repo.full_name}/collaborators/${bob.handle}`, owner.token, {
          permission: "pull",
        })
      ).status,
    ).toBeLessThan(300);
    // Agents given a role on it themselves: one of bob's (who reads it), one of a stranger's.
    const agentOf = async (who: Who) => {
      const agent = (
        await json<{ id: string; handle: string }>(
          api("POST", "/agents", who.token, { handle: uniqueId("bot").slice(0, 39) }),
        )
      ).body;
      await collaborator(orgId, repo.id, agent);
      return (
        await json<{ token: string }>(
          api("POST", `/agents/${agent.handle}/tokens`, who.token, { scopes: [] }),
        )
      ).body.token;
    };
    expect(await scope(await agentOf(bob), `repo:${repo.full_name}`)).toEqual([
      { name: nameOf(repo.full_name), ...all },
    ]);
    // The stranger, its ceiling, reads nothing of it: neither does its agent.
    expect(await refusal(scope(await agentOf(await user()), `repo:${repo.full_name}`))).toBe(
      "repo_not_found",
    );
  });

  it("intersects its qualifiers", async () => {
    const owner = await user();
    const [a, b] = [await repoOf(owner), await repoOf(owner)];
    expect(await scope(owner.token, `repo:${a.full_name} repo:${b.full_name}`)).toEqual([]);
    expect(await scope(owner.token, `repo:${a.full_name} repo:${a.full_name}`)).toHaveLength(1);
    const other = await user();
    expect(await scope(owner.token, `repo:${a.full_name} user:${other.handle}`)).toEqual([]);
    expect(await scope(owner.token, `user:${owner.handle} user:${other.handle}`)).toEqual([]);
  });

  it("tells no one of a repository they may not read through an intersection", async () => {
    const [alice, bob] = [await user(), await user()];
    const secret = await repoOf(alice);
    const mine = await repoOf(bob);
    // As a missing one: not found, whatever it is intersected with.
    for (const q of [
      `user:${bob.handle} repo:${secret.full_name}`,
      `repo:${mine.full_name} repo:${secret.full_name}`,
      `user:${bob.handle} repo:${alice.handle}/missing`,
      `repo:${mine.full_name} repo:${alice.handle}/missing`,
    ])
      expect(await refusal(scope(bob.token, q)), q).toBe("repo_not_found");
    // A token limited to other repositories reads none of a named one.
    const other = await repoOf(alice);
    const limited = await scopedToken(alice.principalId, [], "pat", [other.id]);
    expect(await refusal(scope(limited, `user:${alice.handle} repo:${secret.full_name}`))).toBe(
      "repo_not_found",
    );
  });

  it("is refused, not answered, when the directory could not be read", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const context = await contextOf(owner.token);
    const failing = new Proxy(env.DIRECTORY, {
      get(target, prop) {
        if (prop === "withSession")
          return () => ({
            prepare: () => {
              throw new Error("D1 unavailable");
            },
          });
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const broken = {
      ...context,
      env: new Proxy(env, {
        get: (t, p) => (p === "DIRECTORY" ? failing : Reflect.get(t, p)),
      }),
    } as OpContext;
    for (const q of [`user:${owner.handle}`, `repo:${repo.full_name}`, `org:${owner.handle}`])
      expect(await refusal(authorizeScope(broken, parseSearchQuery(q, "issues"))), q).toBe(
        "search_authorization_unavailable",
      );
  });

  it("is refused when an owner's holds more than a search may", async () => {
    const owner = await user();
    await env.DIRECTORY.prepare(
      `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at,
         updated_at)
       WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < ?2)
       SELECT 'rep_many' || ?1 || v, ?1, 'r' || v, 'net_many' || ?1 || v, 'default', 'private', 1, 1
       FROM n`,
    )
      .bind(owner.principalId, SEARCH_SCOPE.repositories + 1)
      .run();
    expect(await refusal(scope(owner.token, `user:${owner.handle}`))).toBe(
      "search_scope_too_broad",
    );
  });

  it("is refused when who may read could not be decided", async () => {
    const owner = await user();
    const repo = await repoOf(owner);
    const failing = new Proxy(env, {
      get: (target, prop) =>
        prop === "ORG"
          ? {
              getByName: () => ({
                confirmReaders: () => Promise.reject(new Error("unavailable")),
              }),
            }
          : Reflect.get(target, prop),
    });
    expect(await refusal(scope(owner.token, `repo:${repo.full_name}`, failing))).toBe(
      "search_authorization_unavailable",
    );
  });
});
