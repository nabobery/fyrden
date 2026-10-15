// File writes through the REST API: one file (GitHub's contents API) or
// several in one commit, made by the repository's object and committed
// through the push path (compare-and-set on the branch, the token checked
// again at the commit point).

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { writeFiles } from "../src/do/repo/file-writes.js";
import { RepoPush } from "../src/git/push/repo-push.js";
import { agentFor } from "./helpers/agents.js";
import { api, user } from "./helpers/api.js";
import { createRepo, ORIGIN, type TestRepo } from "./helpers/git-http.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

type Who = { principalId: string; token: string };

let owner: Who;
let repo: TestRepo;
let base: string;

beforeEach(async () => {
  owner = await principalWithToken("user", "pat");
  repo = await createRepo(owner.principalId);
  base = `/repos/${owner.principalId.toLowerCase().replace("_", "-")}/${repo.name}`;
});

function call(method: string, path: string, body?: unknown, token = owner.token) {
  return exports.default.fetch(`${ORIGIN}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method !== "GET" && {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function json<T = Record<string, unknown>>(res: Response | Promise<Response>) {
  const r = await res;
  return { status: r.status, body: await r.json<T>() };
}

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const text = (base64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

async function readFile(path: string, ref?: string) {
  const res = await json<{ content: string; sha: string }>(
    call("GET", `${base}/contents/${path}${ref ? `?ref=${ref}` : ""}`),
  );
  return res.status === 200 ? { text: text(res.body.content), sha: res.body.sha } : res.status;
}

describe("one file", () => {
  it("creates the first commit of an empty repository, then updates and deletes the file", async () => {
    const created = await json<{
      content: { sha: string; path: string; size: number };
      commit: {
        sha: string;
        parents: unknown[];
        commit: {
          message: string;
          author: { name: string; email: string };
          committer: { name: string; email: string };
        };
      };
    }>(
      call("PUT", `${base}/contents/docs/hello.md`, {
        message: "Add hello",
        content: b64("hello\n"),
      }),
    );
    expect(created.status).toBe(200);
    expect(created.body.content).toMatchObject({ path: "docs/hello.md", size: 6 });
    expect(created.body.commit.parents).toEqual([]);
    expect(created.body.commit.commit.message).toBe("Add hello");
    // The caller authors, with a no-reply address; the platform, which signs, commits.
    expect(created.body.commit.commit.author.email).toBe(
      `${owner.principalId}@users.noreply.fyrden.test`,
    );
    expect(created.body.commit.commit.committer).toMatchObject({
      name: "Fyrden",
      email: "noreply@fyrden.test",
    });
    expect(await readFile("docs/hello.md")).toEqual({
      text: "hello\n",
      sha: created.body.content.sha,
    });
    // The branch moved there, as a push would move it.
    const branch = await json<{ commit: { sha: string } }>(call("GET", `${base}/branches/main`));
    expect(branch.body.commit.sha).toBe(created.body.commit.sha);

    // Without `sha`, an existing file is not overwritten; with the wrong one neither.
    expect(
      (
        await json(
          call("PUT", `${base}/contents/docs/hello.md`, { message: "x", content: b64("x") }),
        )
      ).body,
    ).toMatchObject({ code: "sha_mismatch" });
    expect(
      (
        await json(
          call("PUT", `${base}/contents/docs/hello.md`, {
            message: "x",
            content: b64("x"),
            sha: "0".repeat(40),
          }),
        )
      ).status,
    ).toBe(409);
    const updated = await json<{ commit: { sha: string; parents: { sha: string }[] } }>(
      call("PUT", `${base}/contents/docs/hello.md`, {
        message: "Change hello",
        content: b64("hello, world\n"),
        sha: created.body.content.sha,
      }),
    );
    expect(updated.body.commit.parents).toEqual([{ sha: created.body.commit.sha }]);
    expect(await readFile("docs/hello.md")).toMatchObject({ text: "hello, world\n" });
    expect(await readFile("docs/hello.md", created.body.commit.sha)).toMatchObject({
      text: "hello\n",
    });

    const current = (await readFile("docs/hello.md")) as { sha: string };
    const deleted = await json<{ content: null }>(
      call("DELETE", `${base}/contents/docs/hello.md`, {
        message: "Remove hello",
        sha: current.sha,
      }),
    );
    expect(deleted.body.content).toBeNull();
    expect(await readFile("docs/hello.md")).toBe(404);
    // The empty directory went with it.
    expect((await json(call("GET", `${base}/contents/docs`))).status).toBe(404);
  });

  it("takes base64 as GitHub does, and refuses what is not base64", async () => {
    for (const bad of ["%%%", "a=", "a==", "aa=", "aaaa==", "a"])
      expect(
        (await json(call("PUT", `${base}/contents/a.txt`, { message: "x", content: bad }))).body,
        bad,
      ).toMatchObject({ code: "invalid_input" });
    // Line breaks and missing padding are fine.
    await json(call("PUT", `${base}/contents/a.txt`, { message: "x", content: "aGVs\nbG8" }));
    expect(await readFile("a.txt")).toMatchObject({ text: "hello" });
  });

  it("refuses more content than a write carries before decoding it", async () => {
    // Base64 for 4,200,000 bytes: past the limit once decoded.
    const over = "a".repeat(5_600_000);
    expect(
      (await json(call("PUT", `${base}/contents/big.txt`, { message: "x", content: over }))).body,
    ).toMatchObject({ code: "too_large" });
    expect(
      (
        await json(
          call("POST", `${base}/file-commits`, {
            message: "x",
            changes: [
              { path: "a.txt", content: "a".repeat(3 * 1024 * 1024) },
              { path: "b.txt", content: "b".repeat(2 * 1024 * 1024) },
            ],
          }),
        )
      ).body,
    ).toMatchObject({ code: "too_large" });
  });

  it("refuses a request body over the limit before reading it all", async () => {
    const res = await call("POST", `${base}/file-commits`, {
      message: "x",
      changes: [{ path: "a.txt", content: "a".repeat(9 * 1024 * 1024) }],
    });
    expect(await json(res)).toMatchObject({ status: 413, body: { code: "body_too_large" } });
  });

  it("refuses bad content, bad paths and unknown branches", async () => {
    expect(
      (await json(call("PUT", `${base}/contents/a.txt`, { message: "x", content: "%%%" }))).body,
    ).toMatchObject({ code: "invalid_input" });
    expect(
      (await json(call("PUT", `${base}/contents/.git/config`, { message: "x", content: b64("x") })))
        .body,
    ).toMatchObject({ code: "invalid_path" });
    await json(call("PUT", `${base}/contents/a.txt`, { message: "first", content: b64("a") }));
    expect(
      (
        await json(
          call("PUT", `${base}/contents/b.txt`, {
            message: "x",
            content: b64("b"),
            branch: "nope",
          }),
        )
      ).body,
    ).toMatchObject({ code: "branch_not_found" });
    // A path through a file.
    expect(
      (await json(call("PUT", `${base}/contents/a.txt/b`, { message: "x", content: b64("b") })))
        .status,
    ).toBe(422);
  });
});

describe("several files", () => {
  it("writes and deletes files as one commit, on the head it was built on", async () => {
    const first = await json<{ commit: { sha: string } }>(
      call("POST", `${base}/file-commits`, {
        message: "Start",
        changes: [
          { path: "README.md", content: "# Repo\n" },
          { path: "src/a.ts", content: "export {};\n" },
          { path: "bin/run", content: b64("#!/bin/sh\n"), encoding: "base64", mode: "executable" },
        ],
      }),
    );
    expect(first.status).toBe(201);
    const second = await json<{
      commit: { sha: string; parents: { sha: string }[] };
      files: unknown[];
    }>(
      call("POST", `${base}/file-commits`, {
        message: "Change",
        expected_head: first.body.commit.sha,
        changes: [
          { path: "src/a.ts", delete: true },
          { path: "src/b/c.ts", content: "export const c = 1;\n" },
          { path: "README.md", content: "# Repo\n\nMore.\n" },
        ],
      }),
    );
    expect(second.status).toBe(201);
    expect(second.body.commit.parents).toEqual([{ sha: first.body.commit.sha }]);
    const tree = await json<{ tree: { path: string; mode: string; type: string }[] }>(
      call("GET", `${base}/git/trees/main?recursive=1`),
    );
    expect(tree.body.tree.map((e) => `${e.mode} ${e.path}`)).toEqual([
      "100644 README.md",
      "040000 bin",
      "100755 bin/run",
      "040000 src",
      "040000 src/b",
      "100644 src/b/c.ts",
    ]);
    const log = await json<{ commits: { sha: string }[] }>(call("GET", `${base}/commits`));
    expect(log.body.commits.map((c) => c.sha)).toEqual([
      second.body.commit.sha,
      first.body.commit.sha,
    ]);

    // A stale expected head, and a commit that changes nothing.
    expect(
      (
        await json(
          call("POST", `${base}/file-commits`, {
            message: "Stale",
            expected_head: first.body.commit.sha,
            changes: [{ path: "x.txt", content: "x" }],
          }),
        )
      ).body,
    ).toMatchObject({ code: "head_moved" });
    expect(
      (
        await json(
          call("POST", `${base}/file-commits`, {
            message: "Same",
            changes: [{ path: "README.md", content: "# Repo\n\nMore.\n" }],
          }),
        )
      ).body,
    ).toMatchObject({ code: "no_change" });
  });

  it("commits on the head it was built on: a branch moved meanwhile answers head_moved", async () => {
    await json(call("PUT", `${base}/contents/a.txt`, { message: "first", content: b64("a") }));
    expect(await raceWrites()).toMatchObject({ ok: false, status: 409, code: "head_moved" });
    // The competing write landed; the late one did not.
    expect(await readFile("y.txt")).toMatchObject({ text: "y.txt" });
    expect(await readFile("x.txt")).toBe(404);
  });

  it("answers a race for the first commit of an empty repository with head_moved", async () => {
    expect(await raceWrites()).toMatchObject({ ok: false, status: 409, code: "head_moved" });
    expect(await readFile("y.txt")).toMatchObject({ text: "y.txt" });
  });
});

describe("memory", () => {
  it("holds none of the write's memory while its pack is indexed, and none after", async () => {
    await json(
      call("POST", `${base}/file-commits`, {
        message: "nested",
        changes: [{ path: "a/b/c.txt", content: "c" }],
      }),
    );
    const token = await env.DIRECTORY.prepare("SELECT id FROM tokens WHERE principal_id = ?")
      .bind(owner.principalId)
      .first<{ id: string }>();
    const seen = await inRepo(repo.stub, async (object) => {
      const push = new RepoPush(object.git, object.git.context.metrics, createLogger({}));
      const baseline = object.git.memory.stats().reservedBytes;
      const atIndex: number[] = [];
      const watching = new Proxy(push, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (property !== "status")
            return typeof value === "function" ? value.bind(target) : value;
          return (...args: Parameters<RepoPush["status"]>) => {
            atIndex.push(object.git.memory.stats().reservedBytes);
            return target.status(...args);
          };
        },
      });
      const result = await writeFiles(
        {
          git: object.git,
          push: watching,
          db: env.DIRECTORY,
          memoryBlocks: createClockBlockCache(),
          metrics: object.git.context.metrics,
          writerRole: async () => "admin" as const,
        },
        {
          principal: owner.principalId,
          tokenId: token?.id as string,
          repoId: repo.id,
          committer: { name: "me", email: "me@fyrden.test" },
          message: "deeper",
          changes: [{ path: "a/b/d.txt", content: new TextEncoder().encode("d") }],
        },
      );
      return { ok: result.ok, baseline, atIndex, after: object.git.memory.stats().reservedBytes };
    });
    expect(seen.ok).toBe(true);
    expect(seen.atIndex.length).toBeGreaterThan(0);
    for (const reserved of seen.atIndex) expect(reserved).toBe(seen.baseline);
    expect(seen.after).toBe(seen.baseline);
  });
});

/**
 * Writes x.txt, landing a write of y.txt (built on the same head) just
 * before x.txt's commit: what the write of x.txt answers.
 */
async function raceWrites() {
  const token = await env.DIRECTORY.prepare("SELECT id FROM tokens WHERE principal_id = ?")
    .bind(owner.principalId)
    .first<{ id: string }>();
  const write = (path: string) => ({
    principal: owner.principalId,
    tokenId: token?.id as string,
    repoId: repo.id,
    committer: { name: "racer", email: "racer@fyrden.test" },
    message: path,
    changes: [{ path, content: new TextEncoder().encode(path) }],
  });
  return inRepo(repo.stub, async (object) => {
    const push = new RepoPush(object.git, object.git.context.metrics, createLogger({}));
    const deps = {
      git: object.git,
      push,
      db: env.DIRECTORY,
      memoryBlocks: createClockBlockCache(),
      metrics: object.git.context.metrics,
      writerRole: async () => "admin" as const,
    };
    let raced = false;
    const racing = new Proxy(push, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property !== "finalize")
          return typeof value === "function" ? value.bind(target) : value;
        return async (...args: Parameters<RepoPush["finalize"]>) => {
          if (!raced) {
            raced = true;
            const other = await writeFiles(deps, write("y.txt"));
            if (!other.ok) throw new Error(`the competing write failed: ${other.error}`);
          }
          return target.finalize(...args);
        };
      },
    });
    return writeFiles({ ...deps, push: racing }, write("x.txt"));
  });
}

describe("identity", () => {
  it("makes an agent acting for a user the author, naming the user as co-author", async () => {
    const person = await user();
    const name = uniqueId("r");
    expect((await api("POST", "/user/repos", person.token, { name })).status).toBe(201);
    const agent = await agentFor(person, ["contents:write"]);
    const written = await api(
      "PUT",
      `/repos/${person.handle}/${name}/contents/a.txt`,
      agent.delegated,
      {
        message: "Add a",
        content: btoa("a"),
      },
    );
    expect(written.status).toBe(200);
    const { commit } = (await written.json()) as {
      commit: {
        commit: {
          message: string;
          author: { name: string; email: string };
          committer: { name: string };
        };
      };
    };
    expect(commit.commit.author.email).toBe(`${agent.id}@users.noreply.fyrden.test`);
    expect(commit.commit.committer.name).toBe("Fyrden");
    expect(commit.commit.message).toBe(
      `Add a\n\nCo-authored-by: ${person.handle} <${person.principalId}@users.noreply.fyrden.test>\n`,
    );
  });

  it("refuses a blank message before adding the trailer that would hide it", async () => {
    const person = await user();
    const name = uniqueId("r");
    await api("POST", "/user/repos", person.token, { name });
    const agent = await agentFor(person, ["contents:write"]);
    const written = await api(
      "PUT",
      `/repos/${person.handle}/${name}/contents/a.txt`,
      agent.delegated,
      {
        message: "   \r\n",
        content: btoa("a"),
      },
    );
    expect(written.status).toBe(422);
  });

  it("refuses a message with a NUL", async () => {
    const written = await json<{ code: string }>(
      call("PUT", `${base}/contents/nul.txt`, { message: "Add\u0000", content: b64("a") }),
    );
    expect(written).toMatchObject({ status: 422, body: { code: "invalid_input" } });
  });
});

describe("access", () => {
  it("needs contents:write on the repository", async () => {
    const reader = await scopedToken(owner.principalId, ["contents:read"], "pat");
    expect(
      (
        await json(
          call("PUT", `${base}/contents/a.txt`, { message: "x", content: b64("a") }, reader),
        )
      ).body,
    ).toMatchObject({ code: "missing_permission" });
    const stranger = await principalWithToken("user", "pat");
    expect(
      (
        await json(
          call(
            "PUT",
            `${base}/contents/a.txt`,
            { message: "x", content: b64("a") },
            stranger.token,
          ),
        )
      ).body,
    ).toMatchObject({ code: "repo_not_found" });
  });

  it("refuses a write whose token is revoked after the request was checked", async () => {
    await json(call("PUT", `${base}/contents/a.txt`, { message: "first", content: b64("a") }));
    const before = await json<{ commit: { sha: string } }>(call("GET", `${base}/branches/main`));
    // The repository's object gets the write only after the token is revoked.
    const revokeFirst = new Proxy(env.REPO, {
      get(target, property) {
        if (property !== "getByName") return Reflect.get(target, property);
        return (name: string) => {
          const stub = target.getByName(name);
          return new Proxy(stub, {
            get(s, p) {
              if (p !== "writeFiles") return Reflect.get(s, p);
              return async (...args: Parameters<RepoDO["writeFiles"]>) => {
                await env.DIRECTORY.prepare(
                  "UPDATE tokens SET revoked_at = ? WHERE principal_id = ?",
                )
                  .bind(Date.now(), owner.principalId)
                  .run();
                return s.writeFiles(...args);
              };
            },
          });
        };
      },
    });
    const ctx = createExecutionContext();
    const res = await createApp().fetch(
      new Request(`${ORIGIN}/api${base}/contents/b.txt`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ message: "late", content: b64("b") }),
      }),
      { ...env, REPO: revokeFirst },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await json(res)).toMatchObject({ status: 403, body: { code: "token_revoked" } });
    // The branch did not move.
    const after = await env.REPO.getByName(repo.id).browseBranch("main");
    expect(after.ok && after.value.commit.sha).toBe(before.body.commit.sha);
  });
});
