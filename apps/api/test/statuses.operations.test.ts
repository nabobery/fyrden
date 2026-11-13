// The commit statuses operations over REST and MCP: posting one on a
// commit, a ref's statuses newest first, and its combined status; who may
// post and read them; and the routes they share with reading a commit.
import { env, exports } from "cloudflare:workers";
import { MemoryWaitTimeoutError } from "@fyrden/adapters-cloudflare/git";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { RepoBrowse } from "../src/do/repo/browse.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

let owner: Who;
let repo: { id: string; name: string };
let path: string;
let sha: string;

type Status = {
  id: number;
  state: string;
  context: string;
  description: string | null;
  target_url: string | null;
  created_at: number;
  updated_at: number;
  creator: { id: string };
};
type Combined = {
  state: string;
  sha: string;
  total_count: number;
  statuses: Status[];
  next_cursor: string | null;
};

const stub = () => env.REPO.getByName(repo.id);
const commitOn = async (branch: string, content: string) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, {
      branch,
      message: "change",
      changes: [{ path: "a.txt", content }],
    }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};
async function branchAt(name: string, at: string) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: ZERO, new: at, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}
async function collaborator(permission: "pull" | "push"): Promise<Who> {
  const who = await user();
  const set = await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, {
    permission,
  });
  expect(set.status).toBe(200);
  return who;
}
const post = (body: Record<string, unknown>, token = owner.token, at = sha) =>
  json<Status & { code?: string }>(api("POST", `${path}/statuses/${at}`, token, body));
const list = (ref: string, query = "", token = owner.token) =>
  json<{ statuses: Status[]; next_cursor: string | null; code?: string }>(
    api("GET", `${path}/commits/${ref}/statuses${query}`, token),
  );
const combined = (ref: string, query = "", token = owner.token) =>
  json<Combined & { code?: string }>(api("GET", `${path}/commits/${ref}/status${query}`, token));
const statusRows = () =>
  inRepo(stub(), (r: RepoDO) =>
    r.git.context.storage.sql.exec("SELECT id FROM commit_statuses").toArray(),
  );

/** Calls MCP tool `name` with `token`; its structured result. */
async function callTool(token: string, name: string, args: Record<string, unknown>) {
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
  const text = await res.text();
  const body = JSON.parse(text.startsWith("{") ? text : (text.split("data: ")[1] ?? "{}")) as {
    result?: { structuredContent?: unknown; isError?: boolean };
  };
  return body.result;
}

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  sha = await commitOn("main", "one\n");
});

describe("statuses.create", () => {
  it("posts a status on a commit, as GitHub shapes it", async () => {
    const made = await post({
      state: "failure",
      context: "ci/build",
      description: "2 tests failed",
      target_url: "https://ci.example/1",
    });
    expect(made.status).toBe(201);
    expect(made.body).toEqual({
      id: expect.any(Number),
      state: "failure",
      context: "ci/build",
      description: "2 tests failed",
      target_url: "https://ci.example/1",
      created_at: expect.any(Number),
      updated_at: made.body.created_at,
      creator: { id: owner.principalId },
    });
  });

  it("takes GitHub's defaults: the context `default`, no description or link", async () => {
    const made = await post({ state: "pending" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      context: "default",
      description: null,
      target_url: null,
    });
  });

  it("refuses a commit the repository does not have, and a state GitHub has not", async () => {
    expect((await post({ state: "success" }, owner.token, "f".repeat(40))).body.code).toBe(
      "commit_not_found",
    );
    expect((await post({ state: "neutral" })).status).toBe(422);
    expect((await post({ state: "success", target_url: "javascript:alert(1)" })).status).toBe(422);
    expect((await post({ state: "success", description: "d".repeat(141) })).status).toBe(422);
    expect(await statusRows()).toEqual([]);
  });

  it("answers a repeated Idempotency-Key with the first status, adding none", async () => {
    const send = () =>
      exports.default.fetch(`https://fyrden.test/api${path}/statuses/${sha}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "once",
        },
        body: JSON.stringify({ state: "success", context: "c" }),
      });
    const first = await json<Status>(send());
    const again = await json<Status>(send());
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    expect(await statusRows()).toHaveLength(1);
  });
});

describe("who may post and read", () => {
  it("takes `statuses:write`, which `contents:write` does not give, and gives no contents", async () => {
    const contents = await scopedToken(owner.principalId, ["contents:write"]);
    const refused = await post({ state: "success" }, contents);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("missing_permission");
    expect((await list(sha, "", contents)).status).toBe(403);

    const statuses = await scopedToken(owner.principalId, ["statuses:write"]);
    expect((await post({ state: "success" }, statuses)).status).toBe(201);
    expect((await list(sha, "", statuses)).status).toBe(200);
    expect((await api("GET", `${path}/commits/${sha}`, statuses)).status).toBe(403);
  });

  it("lets a reader read statuses but not post one, as if the repository were not there", async () => {
    const reader = await collaborator("pull");
    const refused = await post({ state: "success" }, reader.token);
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe("repo_not_found");
    await post({ state: "success" });
    expect((await list(sha, "", reader.token)).body.statuses).toHaveLength(1);
    expect((await combined(sha, "", reader.token)).body.state).toBe("success");
  });

  it("names the writer that posted it as the creator", async () => {
    const writer = await collaborator("push");
    const made = await post({ state: "success" }, writer.token);
    expect(made.body.creator).toEqual({ id: writer.principalId });
  });
});

describe("statuses.list", () => {
  it("lists a ref's statuses newest first, a page at a time", async () => {
    for (const state of ["pending", "failure", "success"]) await post({ state });
    const first = await list("main", "?per_page=2");
    expect(first.status).toBe(200);
    expect(first.body.statuses.map((s) => s.state)).toEqual(["success", "failure"]);
    expect(first.body.next_cursor).not.toBeNull();
    const second = await list(
      "main",
      `?per_page=2&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`,
    );
    expect(second.body.statuses.map((s) => s.state)).toEqual(["pending"]);
    expect(second.body.next_cursor).toBeNull();
    expect((await list(sha, "?cursor=nonsense")).body.code).toBe("invalid_cursor");
  });

  it("names a commit by SHA, branch, percent-encoded branch with a slash, or full ref name", async () => {
    await branchAt("feature/status", sha);
    await post({ state: "success" });
    for (const ref of [sha, "main", "feature%2Fstatus", "refs%2Fheads%2Fmain"])
      expect((await list(ref)).body.statuses, ref).toHaveLength(1);
    expect((await list("nowhere")).status).toBe(404);
  });
});

describe("statuses.combined", () => {
  it("is pending with no statuses", async () => {
    expect((await combined("main")).body).toMatchObject({
      state: "pending",
      sha,
      total_count: 0,
      statuses: [],
      next_cursor: null,
    });
  });

  it("takes each context's latest status, whoever posted it, and rolls them up as GitHub does", async () => {
    const writer = await collaborator("push");
    await post({ state: "failure", context: "build" });
    await post({ state: "success", context: "BUILD" }, writer.token);
    await post({ state: "success", context: "lint" });
    const green = await combined("main");
    expect(green.body.state).toBe("success");
    expect(green.body.total_count).toBe(2);
    expect(green.body.statuses.map((s) => [s.context, s.state])).toEqual([
      ["BUILD", "success"],
      ["lint", "success"],
    ]);
    await post({ state: "pending", context: "deploy" });
    expect((await combined("main")).body.state).toBe("pending");
    await post({ state: "error", context: "lint" });
    expect((await combined("main")).body.state).toBe("failure");
  });

  it("pages contexts past the Basic Multilingual Plane without losing one", async () => {
    // U+FF41 sorts before U+1F600 by UTF-8 bytes and after it by UTF-16 units.
    for (const context of ["\uff41", "\u{1f600}", "z"]) await post({ state: "success", context });
    const seen: string[] = [];
    let cursor = "";
    for (;;) {
      const page = await combined(
        "main",
        `?per_page=1${cursor && `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      seen.push(...page.body.statuses.map((s) => s.context));
      if (page.body.next_cursor === null) break;
      cursor = page.body.next_cursor;
    }
    expect(seen.sort()).toEqual(["\uff41", "\u{1f600}", "z"].sort());
  });

  it("pages the contexts in name order, with the state over all of them", async () => {
    for (const context of ["c", "a", "b"]) await post({ state: "success", context });
    await post({ state: "failure", context: "c" });
    const first = await combined("main", "?per_page=2");
    expect(first.body.state).toBe("failure");
    expect(first.body.total_count).toBe(3);
    expect(first.body.statuses.map((s) => s.context)).toEqual(["a", "b"]);
    const second = await combined(
      "main",
      `?per_page=2&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`,
    );
    expect(second.body.statuses.map((s) => s.context)).toEqual(["c"]);
    expect(second.body.next_cursor).toBeNull();
  });
});

describe("reading under pressure", () => {
  it("answers busy, not an error, when resolving the ref finds no working memory", async () => {
    for (const method of ["listStatuses", "combinedStatus"] as const) {
      const answer = await inRepo(stub(), async (r: RepoDO) => {
        const resolve = RepoBrowse.prototype.resolveTree;
        RepoBrowse.prototype.resolveTree = () => {
          throw new MemoryWaitTimeoutError(1024, 60_000);
        };
        try {
          return await r[method]("main", null, 30);
        } finally {
          RepoBrowse.prototype.resolveTree = resolve;
        }
      });
      expect(answer, method).toMatchObject({ ok: false, status: 409, code: "busy" });
    }
  });
});

describe("the commit routes", () => {
  it("still read a commit on a branch whose name ends in /status or /statuses, encoded", async () => {
    await branchAt("feature/status", sha);
    await branchAt("feature/statuses", sha);
    for (const ref of ["feature%2Fstatus", "feature%2Fstatuses"]) {
      const commit = await json<{ sha: string }>(api("GET", `${path}/commits/${ref}`, owner.token));
      expect(commit.status, ref).toBe(200);
      expect(commit.body.sha).toBe(sha);
    }
  });
});

describe("over MCP", () => {
  it("posts and reads the same statuses", async () => {
    const made = await callTool(owner.token, "create_commit_status", {
      owner: owner.handle,
      repo: repo.name,
      sha,
      state: "failure",
      context: "ci/build",
    });
    expect(made?.isError).toBeFalsy();
    expect(made?.structuredContent).toMatchObject({ state: "failure", context: "ci/build" });
    const listed = await callTool(owner.token, "list_commit_statuses", {
      owner: owner.handle,
      repo: repo.name,
      ref: "main",
    });
    expect(listed?.structuredContent).toMatchObject({ statuses: [{ state: "failure" }] });
    const rolled = await callTool(owner.token, "get_combined_status", {
      owner: owner.handle,
      repo: repo.name,
      ref: sha,
    });
    expect(rolled?.structuredContent).toMatchObject({ state: "failure", total_count: 1 });
  });
});
