import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { principalWithToken, scopedToken } from "./helpers/principals.js";

const ORIGIN = "https://fyrden.test";

const api = (path: string, token: string, body?: unknown) =>
  exports.default.fetch(`${ORIGIN}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

type Page = {
  repos: { id: string; name: string; default_branch: string }[];
  next_cursor: string | null;
};

async function create(token: string, name: string): Promise<string> {
  const res = await api("/user/repos", token, { name });
  expect(res.status).toBe(201);
  return (await res.json<{ id: string }>()).id;
}

async function list(token: string, query = ""): Promise<Page> {
  const res = await api(`/user/repos${query}`, token);
  expect(res.status).toBe(200);
  return res.json<Page>();
}

describe("repos.list", () => {
  it("lists your repositories by name, ignoring case, a page at a time", async () => {
    const owner = await principalWithToken("user", "pat");
    for (const name of ["delta", "Alpha", "charlie", "bravo", "echo"])
      await create(owner.token, name);
    const first = await list(owner.token, "?per_page=2");
    expect(first.repos.map((r) => r.name)).toEqual(["Alpha", "bravo"]);
    const second = await list(owner.token, `?per_page=2&cursor=${first.next_cursor}`);
    expect(second.repos.map((r) => r.name)).toEqual(["charlie", "delta"]);
    const third = await list(owner.token, `?per_page=2&cursor=${second.next_cursor}`);
    expect(third).toEqual({
      repos: [expect.objectContaining({ name: "echo" })],
      next_cursor: null,
    });
    // A repository created a moment ago is listed at once.
    expect((await list(owner.token)).repos).toHaveLength(5);
  });

  it("lists only your own repositories", async () => {
    const owner = await principalWithToken("user", "pat");
    const other = await principalWithToken("user", "pat");
    await create(owner.token, "mine");
    expect((await list(other.token)).repos).toEqual([]);
    const agent = await principalWithToken("agent", "pat");
    expect((await list(agent.token)).repos).toEqual([]);
  });

  it("shows a scoped token only what it may see", async () => {
    const owner = await principalWithToken("user", "pat");
    const a = await create(owner.token, "scoped-a");
    await create(owner.token, "scoped-b");
    const noMetadata = await scopedToken(owner.principalId, ["repos:create"]);
    const refused = await api("/user/repos", noMetadata);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ missing_permission: "metadata:read" });
    const onlyA = await scopedToken(owner.principalId, [], "pat", [a]);
    expect((await list(onlyA)).repos.map((r) => r.name)).toEqual(["scoped-a"]);
  });

  it("never reveals a repository the token may not see, in a page or its cursor", async () => {
    const owner = await principalWithToken("user", "pat");
    const allowed = await create(owner.token, "allowed");
    await create(owner.token, "secret-project");
    const zzz = await create(owner.token, "zzz");
    const token = await scopedToken(owner.principalId, [], "pat", [allowed, zzz]);
    const first = await list(token, "?per_page=1");
    expect(first.repos.map((r) => r.name)).toEqual(["allowed"]);
    expect(atob(first.next_cursor ?? "")).toBe("allowed");
    const second = await list(token, `?per_page=1&cursor=${first.next_cursor}`);
    expect(second).toEqual({
      repos: [expect.objectContaining({ name: "zzz" })],
      next_cursor: null,
    });
  });

  it("takes the default branch from the read model once the repository is projected", async () => {
    const owner = await principalWithToken("user", "pat");
    const id = await create(owner.token, "projected");
    expect((await list(owner.token)).repos[0]?.default_branch).toBe("main");
    await env.ORG_READ.prepare(
      `INSERT INTO repos (repo_id, owner_id, name, visibility, default_branch, created_at, deleted,
         epoch_gen, version, owner_gen, updated_seq, updated_at)
       VALUES (?, ?, 'projected', 'private', 'refs/heads/trunk', 0, 0, 1, 2, 1, 2, 0)`,
    )
      .bind(id, owner.principalId)
      .run();
    expect((await list(owner.token)).repos[0]?.default_branch).toBe("trunk");
  });

  it.each([
    ["a cursor this API did not return", "?cursor=!!!"],
    ["a cursor for no name", `?cursor=${btoa("..")}`],
    ["a page size of 0", "?per_page=0"],
    ["a page size over 100", "?per_page=101"],
  ])("refuses %s", async (_, query) => {
    const owner = await principalWithToken("user", "pat");
    const res = await api(`/user/repos${query}`, owner.token);
    expect(res.status).toBe(422);
  });
});
