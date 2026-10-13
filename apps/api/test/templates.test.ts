// Template repositories and stars. A template's default branch becomes the
// first commit of a repository generated from it, which shares nothing with
// the template; a star is a user's mark on a repository it can read.

import { env } from "cloudflare:workers";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("browseFixtures");
const newId = createIdFactory(Date.now, secureRandomBytes);

type Repo = {
  id: string;
  name: string;
  owner: string;
  fork: boolean;
  is_template: boolean;
  stargazers_count: number;
  parent_id: string | null;
};

let owner: Who;
let template: Repo;
let path: string;

/** A repository `who` creates through the API, with the fixture's refs pushed. */
async function pushedRepo(who: Who): Promise<Repo> {
  const created = await json<Repo>(api("POST", "/user/repos", who.token, { name: uniqueId("t") }));
  expect(created.status).toBe(201);
  const git = await scopedToken(who.principalId, [], "git");
  const reply = await postPush(
    {
      repo: {
        id: created.body.id,
        name: created.body.name,
        stub: env.REPO.getByName(created.body.id),
      },
      owner: { principalId: who.principalId, token: git },
      path: `/${who.handle}/${created.body.name}.git`,
    },
    pushBody(
      fx.refs.map((r) => ({ old: ZERO, new: r.oid, ref: r.name })),
      { pack: fx.packHex },
    ),
  );
  expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
  return created.body;
}

const generate = (from: string, token: string, body: Record<string, unknown>) =>
  json<Repo & { code?: string }>(api("POST", `${from}/generate`, token, body));

async function readerOf(repoPath: string): Promise<Who> {
  const reader = await user();
  const res = await api("PUT", `${repoPath}/collaborators/${reader.handle}`, owner.token, {
    permission: "pull",
  });
  expect(res.status).toBe(200);
  return reader;
}

beforeAll(async () => {
  owner = await user();
  template = await pushedRepo(owner);
  path = `/repos/${owner.handle}/${template.name}`;
});

describe("templates", () => {
  it("generate nothing until the repository is marked as one", async () => {
    // Other cases mark the shared template; start from an unmarked one.
    await api("PATCH", path, owner.token, { is_template: false });
    const before = await generate(path, owner.token, { name: uniqueId("gen") });
    expect(before).toMatchObject({ status: 422, body: { code: "not_a_template" } });
    const marked = await json<Repo>(api("PATCH", path, owner.token, { is_template: true }));
    expect(marked.body).toMatchObject({ is_template: true, fork: false });
    expect((await json<Repo>(api("GET", path, owner.token))).body.is_template).toBe(true);
  });

  it("generate a repository holding the default branch's tree, with a history of its own", async () => {
    await api("PATCH", path, owner.token, { is_template: true });
    const reader = await readerOf(path);
    const name = uniqueId("gen");
    const made = await generate(path, reader.token, { name });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      name,
      owner: reader.handle,
      fork: false,
      parent_id: null,
      is_template: false,
      stargazers_count: 0,
    });
    const at = `/repos/${reader.handle}/${name}`;
    // Every tree and file of main, with its mode: executables, symlinks, the submodule.
    const tree = await json<{ tree: { path: string; mode: string; type: string; sha: string }[] }>(
      api("GET", `${at}/git/trees/main?recursive=1`, reader.token),
    );
    expect(tree.status).toBe(200);
    expect(tree.body.tree.map((e) => [e.path, e.mode, e.type, e.sha])).toEqual(
      fx.trees.recursive.map((e) => [e.path, e.mode, e.type, e.sha]),
    );
    const commits = await json<{
      commits: { sha: string; parents: unknown[]; commit: { message: string } }[];
    }>(api("GET", `${at}/commits`, reader.token));
    expect(commits.body.commits).toHaveLength(1);
    expect(commits.body.commits[0]).toMatchObject({
      parents: [],
      commit: { message: "Initial commit" },
    });
    // No longer pending: it takes writes like any repository.
    const written = await api("PUT", `${at}/contents/after.txt`, reader.token, {
      message: "after",
      content: btoa("after"),
    });
    expect(written.status).toBe(200);
    // Its own network: none of the template's commits are there.
    const mainHead = fx.mainSteps.at(-1)?.commit as string;
    expect((await api("GET", `${at}/commits/${mainHead}`, reader.token)).status).toBe(404);
  });

  it("refuse a caller who cannot read the template, a taken name and a token that cannot write", async () => {
    await api("PATCH", path, owner.token, { is_template: true });
    const stranger = await user();
    expect(await generate(path, stranger.token, { name: uniqueId("gen") })).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
    const reader = await readerOf(path);
    const taken = uniqueId("gen");
    expect((await api("POST", "/user/repos", reader.token, { name: taken })).status).toBe(201);
    expect(await generate(path, reader.token, { name: taken })).toMatchObject({
      status: 409,
      body: { code: "name_taken" },
    });
    // A token limited to repositories, or without contents:write, cannot make the first commit.
    const limited = await scopedToken(reader.principalId, [], "pat", [template.id]);
    const createOnly = await scopedToken(reader.principalId, ["repos:create", "contents:read"]);
    for (const token of [limited, createOnly]) {
      const name = uniqueId("gen");
      expect(await generate(path, token, { name })).toMatchObject({
        status: 403,
        body: { code: "missing_permission" },
      });
      expect((await api("GET", `/repos/${reader.handle}/${name}`, reader.token)).status).toBe(404);
    }
  });

  it("leave no repository behind when the commit is refused", async () => {
    await api("PATCH", path, owner.token, { is_template: true });
    const reader = await readerOf(path);
    const name = uniqueId("gen");
    // The template is empty: there is no default branch to copy.
    const empty = await json<Repo>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("e") }),
    );
    const emptyPath = `/repos/${owner.handle}/${empty.body.name}`;
    await api("PATCH", emptyPath, owner.token, { is_template: true });
    await api("PUT", `${emptyPath}/collaborators/${reader.handle}`, owner.token, {
      permission: "pull",
    });
    const made = await generate(emptyPath, reader.token, { name });
    expect(made.status).toBe(409);
    expect(made.body.code).toBe("repo_empty");
    expect((await api("GET", `/repos/${reader.handle}/${name}`, reader.token)).status).toBe(404);
    // The name is free again.
    expect((await api("POST", "/user/repos", reader.token, { name })).status).toBe(201);
  });

  it("take no other write while the generation is pending", async () => {
    const id = newId("rep");
    const stub = env.REPO.getByName(id);
    // Generated from a template whose object has no repository: the generation fails.
    expect(
      await stub.initGitStorage(newId("net"), "refs/heads/main", undefined, newId("rep")),
    ).toEqual({ ok: true });
    const writer = {
      principal: owner.principalId,
      tokenId: "tok_x",
      repoId: id,
      committer: { name: "a", email: "a@b" },
      message: "m",
    };
    expect(
      await stub.writeFiles({ ...writer, changes: [{ path: "a", content: new Uint8Array(1) }] }),
    ).toMatchObject({ ok: false, code: "repo_not_found" });
    expect(await stub.beginPush({ principal: owner.principalId, tokenId: "tok_x" })).toMatchObject({
      ok: false,
    });
    expect(await stub.generateFrom(writer)).toMatchObject({ ok: false, code: "repo_not_found" });
    // Still pending: still refused.
    expect(await stub.beginPush({ principal: owner.principalId, tokenId: "tok_x" })).toMatchObject({
      ok: false,
    });
  });

  it("generate into an organization only for a member who can write there", async () => {
    await api("PATCH", path, owner.token, { is_template: true });
    const admin = await user(true);
    const login = uniqueId("org").slice(0, 39);
    const org = await api("POST", "/admin/organizations", admin.token, {
      login,
      admin: owner.handle,
    });
    expect(org.status).toBe(201);
    const made = await generate(path, owner.token, { name: uniqueId("gen"), owner: login });
    expect(made).toMatchObject({ status: 201, body: { owner: login, fork: false } });
    // A member gets the organization's base role (read): it could not write the first commit.
    const member = await user();
    await api("PUT", `/orgs/${login}/memberships/${member.handle}`, owner.token, {});
    await api("PUT", `${path}/collaborators/${member.handle}`, owner.token, { permission: "pull" });
    expect(
      await generate(path, member.token, { name: uniqueId("gen"), owner: login }),
    ).toMatchObject({ status: 403, body: { code: "missing_permission" } });
    // Another user's account is no organization.
    expect(
      await generate(path, owner.token, { name: uniqueId("gen"), owner: member.handle }),
    ).toMatchObject({ status: 404, body: { code: "org_not_found" } });
  });

  it("can be unmarked, by an administrator only", async () => {
    await api("PATCH", path, owner.token, { is_template: true });
    const reader = await readerOf(path);
    expect((await api("PATCH", path, reader.token, { is_template: false })).status).toBe(404);
    // A refused update changes nothing, the flag included.
    const refused = await json<{ code: string }>(
      api("PATCH", path, owner.token, { is_template: false, default_branch: "missing" }),
    );
    expect(refused).toMatchObject({ status: 422, body: { code: "branch_not_found" } });
    expect((await json<Repo>(api("GET", path, owner.token))).body.is_template).toBe(true);
    const unmarked = await json<Repo>(api("PATCH", path, owner.token, { is_template: false }));
    expect(unmarked.body.is_template).toBe(false);
    expect(await generate(path, reader.token, { name: uniqueId("gen") })).toMatchObject({
      status: 422,
      body: { code: "not_a_template" },
    });
  });
});

describe("stars", () => {
  const star = (repoPath: string, token: string, method = "PUT") =>
    json<{ repo: string; starred: boolean; code?: string }>(
      api(method, `/user/starred/${repoPath}`, token),
    );
  const count = async (repoPath: string, token: string) =>
    (await json<Repo>(api("GET", `/repos/${repoPath}`, token))).body.stargazers_count;

  it("count each user once, and only users who can read the repository star it", async () => {
    const repo = await json<Repo>(api("POST", "/user/repos", owner.token, { name: uniqueId("s") }));
    const at = `${owner.handle}/${repo.body.name}`;
    expect(await star(at, owner.token)).toEqual({
      status: 200,
      body: { repo: at, starred: true },
    });
    expect((await star(at, owner.token)).status).toBe(200);
    expect(await count(at, owner.token)).toBe(1);
    const stranger = await user();
    expect(await star(at, stranger.token)).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
    const reader = await readerOf(`/repos/${at}`);
    await star(at, reader.token);
    expect(await count(at, owner.token)).toBe(2);
    expect(await star(at, reader.token, "DELETE")).toEqual({
      status: 200,
      body: { repo: at, starred: false },
    });
    expect((await star(at, reader.token, "DELETE")).status).toBe(200);
    expect(await count(at, owner.token)).toBe(1);
  });

  it("are listed newest first, a page at a time, without repositories the caller lost", async () => {
    const fan = await user();
    const repos: Repo[] = [];
    for (let i = 0; i < 3; i++) {
      const repo = await json<Repo>(
        api("POST", "/user/repos", owner.token, { name: uniqueId("s") }),
      );
      repos.push(repo.body);
      await api(
        "PUT",
        `/repos/${owner.handle}/${repo.body.name}/collaborators/${fan.handle}`,
        owner.token,
        {
          permission: "pull",
        },
      );
      await star(`${owner.handle}/${repo.body.name}`, fan.token);
    }
    // Starred at the same millisecond, they are ordered by id: set it so.
    await env.DIRECTORY.prepare("UPDATE stars SET created_at = 1000 WHERE user_id = ?")
      .bind(fan.principalId)
      .run();
    const expected = repos
      .map((r) => r.id)
      .sort()
      .reverse();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ per_page: "1" });
      if (cursor) query.set("cursor", cursor);
      const page = await json<{
        repos: (Repo & { starred_at: number })[];
        next_cursor: string | null;
      }>(api("GET", `/user/starred?${query}`, fan.token));
      expect(page.status).toBe(200);
      for (const r of page.body.repos) {
        expect(r.starred_at).toBe(1000);
        expect(r.stargazers_count).toBe(1);
      }
      seen.push(...page.body.repos.map((r) => r.id));
      cursor = page.body.next_cursor;
    } while (cursor && seen.length < 10);
    expect(seen).toEqual(expected);

    // Access taken away: the star stays, but is not shown.
    const lost = repos[0] as Repo;
    await api(
      "DELETE",
      `/repos/${owner.handle}/${lost.name}/collaborators/${fan.handle}`,
      owner.token,
    );
    const after = await json<{ repos: Repo[] }>(api("GET", "/user/starred", fan.token));
    expect(after.body.repos.map((r) => r.id)).toEqual(expected.filter((id) => id !== lost.id));
    // A token limited to one repository lists that one only.
    const kept = repos[1] as Repo;
    const limited = await scopedToken(fan.principalId, [], "pat", [kept.id]);
    const one = await json<{ repos: Repo[]; next_cursor: string | null }>(
      api("GET", "/user/starred", limited),
    );
    expect(one.body).toEqual({
      repos: [expect.objectContaining({ id: kept.id })],
      next_cursor: null,
    });
    expect((await json(api("GET", "/user/starred?cursor=AAAA", fan.token))).body).toMatchObject({
      code: "invalid_cursor",
    });
  });

  it("need the starring permissions, and go with their repository", async () => {
    const repo = await json<Repo>(api("POST", "/user/repos", owner.token, { name: uniqueId("s") }));
    const at = `${owner.handle}/${repo.body.name}`;
    const readOnly = await scopedToken(owner.principalId, ["metadata:read", "starring:read"]);
    expect(await star(at, readOnly)).toMatchObject({
      status: 403,
      body: { code: "missing_permission" },
    });
    expect((await api("GET", "/user/starred", readOnly)).status).toBe(200);
    const starrer = await scopedToken(owner.principalId, ["metadata:read", "starring:write"]);
    expect((await star(at, starrer)).status).toBe(200);
    // Deleting the repository deletes its stars.
    expect((await api("DELETE", `/repos/${at}`, owner.token)).status).toBe(200);
    const left = await env.DIRECTORY.prepare("SELECT count(*) AS n FROM stars WHERE repo_id = ?")
      .bind(repo.body.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
