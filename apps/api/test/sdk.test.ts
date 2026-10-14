// The SDK against this API: a repository's life through typed calls.

import { env, exports } from "cloudflare:workers";
import { FyrdenClient, FyrdenError } from "@fyrden/sdk";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, inject, it } from "vitest";
import { user } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");

const client = (token: string) =>
  new FyrdenClient({
    baseUrl: `${ORIGIN}/api`,
    token,
    fetch: (url, init) => exports.default.fetch(new Request(url, init)),
  });

describe("the SDK", () => {
  it("creates, pushes with a git token, writes, browses, forks and deletes a repository", async () => {
    const me = await user();
    const api = client(me.token);
    const whoami = await api.call("meta.whoami", {});
    expect(whoami.id).toBe(me.principalId);
    const repo = await api.call("repos.create", { name: uniqueId("sdk") });
    // A git token, minted through the SDK, pushes the first commits.
    const admin = client((await user(true)).token);
    const git = await admin.call("admin.tokens.create", { user_id: me.principalId, type: "git" });
    const pushed = await postPush(
      {
        repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
        owner: { principalId: me.principalId, token: git.token },
        path: `/${repo.owner}/${repo.name}.git`,
      },
      pushBody([{ old: ZERO, new: fx.c2, ref: "refs/heads/main" }], { pack: fx.packC2 }),
    );
    expect(pushed.report).toContain("ok refs/heads/main\n");
    const commits: string[] = [];
    for await (const c of api.paginate("repos.commits.list", {
      owner: repo.owner,
      repo: repo.name,
      per_page: 1,
    }))
      commits.push(c.sha);
    expect(commits).toEqual([fx.c2, fx.c1]);
    const written = await api.call("repos.contents.put", {
      owner: repo.owner,
      repo: repo.name,
      path: "docs/hello world.md",
      message: "hello",
      content: btoa("hi"),
    });
    expect(written.commit.commit.verification.verified).toBe(true);
    const file = await api.call("repos.contents.get", {
      owner: repo.owner,
      repo: repo.name,
      path: "docs/hello world.md",
    });
    expect(file).toMatchObject({ type: "file", path: "docs/hello world.md" });
    const fork = await api.call("repos.fork", {
      owner: repo.owner,
      repo: repo.name,
      name: uniqueId("fork"),
    });
    const forks: string[] = [];
    for await (const f of api.paginate("repos.forks.list", {
      owner: repo.owner,
      repo: repo.name,
      per_page: 1,
    }))
      forks.push(f.name);
    expect(forks).toEqual([fork.name]);
    expect((await api.call("repos.delete", { owner: repo.owner, repo: repo.name })).state).toMatch(
      /deleting|deleted/,
    );
    const missing = await api
      .call("repos.get", { owner: repo.owner, repo: repo.name })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(FyrdenError);
    expect(missing).toMatchObject({ status: 404, code: "repo_not_found" });
  });
});
