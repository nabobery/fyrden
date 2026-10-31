// The search operations, over REST and MCP alike: a scoped query's
// results hydrated (rows, people's handles, the repository as the directory
// has it now), private and kept by no cache, refusals too; what the
// caller's token allows (issues and pull requests apart); a principal's
// searches rate limited across its tokens; its credential checked on the
// primary for every search; a page past 1 MiB refused whole.

import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { SEARCH_RESERVE } from "../src/search/operations.js";
import { reconcileSource } from "../src/search/reconcile.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { untilThrottled } from "./helpers/rate-limits.js";

let admin: Who;
beforeAll(async () => {
  admin = await user(true);
  expect((await api("PUT", "/admin/search/indexing", admin.token, { enabled: true })).status).toBe(
    200,
  );
});

/** A term no other test's documents hold. */
const term = () => `q${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

interface Made {
  readonly owner: Who;
  readonly repo: { id: string; name: string; full_name: string };
}

/** A repository of a new user's, with `issues` (titles and bodies), reconciled into search. */
async function searchable(issues: readonly { title: string; body?: string }[]): Promise<Made> {
  const owner = await user();
  const repo = (
    await json<{ id: string; name: string; full_name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  for (const issue of issues)
    expect((await api("POST", `/repos/${repo.full_name}/issues`, owner.token, issue)).status).toBe(
      201,
    );
  for (let i = 0; i < 20; i++)
    if ((await reconcileSource(env, { repoId: repo.id, shard: "default" })) === "done")
      return { owner, repo };
  throw new Error("not reconciled");
}

const search = (token: string, kind: "issues" | "repositories", q: string, more = "") =>
  api("GET", `/search/${kind}?q=${encodeURIComponent(q)}${more}`, token);

/** Calls MCP tool `name` with `token`; its structured result, or its error's text. */
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
    result?: { structuredContent?: unknown; isError?: boolean; content?: { text: string }[] };
  };
  return body.result;
}

describe("search.issues", () => {
  it("answers a scope's matches, hydrated, private and kept by no cache, over REST and MCP alike", async () => {
    const t = term();
    const { owner, repo } = await searchable([
      { title: `Crash in ${t}`, body: "It breaks." },
      { title: "Unrelated" },
    ]);
    const res = await search(owner.token, "issues", `repo:${repo.full_name} ${t}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as {
      total_count: number;
      incomplete_results: boolean;
      items: Record<string, unknown>[];
    };
    expect(body).toMatchObject({ total_count: 1, incomplete_results: false });
    expect(body.items).toEqual([
      expect.objectContaining({
        number: 1,
        title: `Crash in ${t}`,
        body: "It breaks.",
        state: "open",
        user: { id: owner.principalId, login: owner.handle },
        assignees: [],
        labels: [],
        milestone: null,
        repository: {
          id: repo.id,
          owner: { login: owner.handle },
          name: repo.name,
          full_name: repo.full_name,
        },
      }),
    ]);
    // No rank, source or other internals.
    expect(Object.keys(body.items[0] ?? {})).not.toContain("rank");
    const tool = await callTool(owner.token, "search_issues", { q: `repo:${repo.full_name} ${t}` });
    expect(tool?.structuredContent).toEqual(body);
  });

  it("is refused, kept by no cache too, for a query it cannot answer", async () => {
    const someone = await user();
    const t = term();
    for (const [q, code] of [
      [t, "search_scope_required"],
      [`user:${someone.handle} "unclosed`, "invalid_search_query"],
      [`user:${someone.handle} is:open`, "search_text_required"],
      [`repo:${someone.handle}/missing ${t}`, "repo_not_found"],
    ] as const) {
      const res = await search(someone.token, "issues", q);
      expect(((await res.json()) as { code: string }).code, q).toBe(code);
      expect(res.headers.get("Cache-Control"), q).toBe("private, no-store");
    }
    // Refused before it runs, unauthenticated, all the same.
    const anonymous = await exports.default.fetch(
      `https://fyrden.test/api/search/issues?q=${encodeURIComponent(t)}`,
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("Cache-Control")).toBe("private, no-store");
    // Past the results it counts.
    const deep = await search(
      someone.token,
      "issues",
      `user:${someone.handle} ${t}`,
      "&page=11&per_page=100",
    );
    expect(deep.status).toBe(422);
  });

  it("answers what the token allows: issues and pull requests apart", async () => {
    const t = term();
    const { owner, repo } = await searchable([{ title: t }]);
    const q = `repo:${repo.full_name} ${t}`;
    const pullsOnly = await scopedToken(owner.principalId, ["pull_requests:read"]);
    const res = await json<{ items: unknown[] }>(search(pullsOnly, "issues", q));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    const issuesOnly = await scopedToken(owner.principalId, ["issues:read"]);
    expect(
      (await json<{ items: unknown[] }>(search(issuesOnly, "issues", q))).body.items,
    ).toHaveLength(1);
  });

  it("is rate limited a principal, whichever of its tokens searches", async () => {
    const someone = await user();
    const other = await scopedToken(someone.principalId, ["issues:read"]);
    const q = `user:${someone.handle} ${term()}`;
    const { passed, throttled } = await untilThrottled(
      (i) => search(i % 2 === 0 ? someone.token : other, "issues", q),
      10,
    );
    expect(passed.every((s) => s === 200)).toBe(true);
    expect(throttled?.status).toBe(429);
    const problem = (await throttled?.json()) as { code: string };
    expect(problem.code).toBe("search_rate_limited");
    expect(throttled?.headers.get("Retry-After")).toBe("60");
  });

  it("checks its credential on the primary for every search", async () => {
    const someone = await user();
    const q = `user:${someone.handle} ${term()}`;
    // Read, so cached; then revoked: the next search is refused.
    expect((await search(someone.token, "issues", q)).status).toBe(200);
    expect((await api("GET", "/user", someone.token)).status).toBe(200);
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE principal_id = ?")
      .bind(Date.now(), someone.principalId)
      .run();
    // An ordinary read still goes on the cached credential; a search never does.
    expect((await api("GET", "/user", someone.token)).status).toBe(200);
    expect((await search(someone.token, "issues", q)).status).toBe(401);
  });

  it("refuses a page past 1 MiB whole, and answers a smaller one", async () => {
    const t = term();
    // Twenty of the longest bodies: more than 1 MiB together, less than half.
    const { owner, repo } = await searchable(
      Array.from({ length: 20 }, (_, i) => ({
        title: `${t} ${i}`,
        body: `"${"x".repeat(65_534)}`,
      })),
    );
    const q = `repo:${repo.full_name} ${t}`;
    const spent = async () =>
      (
        await env.ORG_READ.prepare(
          "SELECT interactive_reads AS n FROM search_budget WHERE day = CAST(unixepoch() / 86400 AS INTEGER)",
        ).first<{ n: number }>()
      )?.n ?? 0;
    const before = await spent();
    const whole = await search(owner.token, "issues", q, "&per_page=20");
    expect(whole.status).toBe(422);
    expect(((await whole.json()) as { code: string }).code).toBe("page_too_large");
    // Settled at what it read, not its whole reservation.
    expect((await spent()) - before).toBeLessThan(SEARCH_RESERVE.issues);
    const half = await json<{ items: unknown[]; total_count: number }>(
      search(owner.token, "issues", q, "&per_page=10"),
    );
    expect(half.status).toBe(200);
    expect(half.body).toMatchObject({ total_count: 20 });
    expect(half.body.items).toHaveLength(10);
  });
});

describe("search.repositories", () => {
  it("answers the repositories of a scope whose metadata the caller may read", async () => {
    const { owner, repo } = await searchable([]);
    const res = await search(owner.token, "repositories", `user:${owner.handle} ${repo.name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toEqual([
      expect.objectContaining({
        id: repo.id,
        owner: { id: owner.principalId, login: owner.handle },
        name: repo.name,
        full_name: repo.full_name,
        visibility: "private",
        default_branch: "main",
      }),
    ]);
    const stranger = await user();
    const theirs = await json<{ items: unknown[] }>(
      search(stranger.token, "repositories", `user:${owner.handle} ${repo.name}`),
    );
    expect(theirs.body.items).toEqual([]);
  });
});
