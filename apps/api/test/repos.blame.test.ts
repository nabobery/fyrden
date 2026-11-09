// GET /repos/{owner}/{repo}/blame over HTTP: pages a continuation names, a
// window, and each refusal as a problem document, the busy one with its wait.

import { env, exports } from "cloudflare:workers";
import { UNRESOLVED_REASONS as CONTRACT_REASONS } from "@fyrden/api-contract";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { UNRESOLVED_REASONS } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, inject, it } from "vitest";
import { BLAME_SHARE_BYTES } from "../src/do/repo/blame.js";
import { api, handleOf, json } from "./helpers/api.js";
import { createRepo } from "./helpers/git-http.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("blameFixtures");
const newId = createIdFactory(Date.now, secureRandomBytes);

type Range =
  | { start_line: number; line_count: number; commit: string; source_start_line: number }
  | { start_line: number; line_count: number; unresolved: string };
type Answer = {
  commit: string;
  lines: number;
  state: string;
  ranges: Range[];
  next_continuation: string | null;
};

async function pushedRepo() {
  const target = await pushTarget();
  const reply = await postPush(
    target,
    pushBody([{ old: ZERO, new: fx.tip, ref: "refs/heads/main" }], { pack: fx.pack }),
  );
  expect(reply.report).toContain("ok refs/heads/main\n");
  const token = await scopedToken(target.owner.principalId, []);
  const path = `/repos/${handleOf(target.owner.principalId)}/${target.repo.name}`;
  return { token, path, stub: target.repo.stub };
}

const get = (path: string, token: string, query: Record<string, string | number>) =>
  json<Answer & { code?: string; retry_after?: number }>(
    api(
      "GET",
      `${path}/blame?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`,
      token,
    ),
  );

/** Each line's commit and source line, or its reason, from every page. */
function lines(pages: Answer[]): string[] {
  const out = new Array<string>(pages.at(-1)?.lines ?? 0).fill("?");
  for (const page of pages)
    for (const r of page.ranges)
      out.fill(
        "unresolved" in r ? r.unresolved : `${r.commit}@${r.source_start_line}`,
        r.start_line - 1,
        r.start_line - 1 + r.line_count,
      );
  return out;
}

const fromGit = (path: string) => (fx.blames[path] ?? []).map((g) => `${g.commit}@${g.line}`);

/** Holds the repository object's memory: what a running blame request holds. */
let held: { release(): void } | undefined;

describe("GET /repos/{owner}/{repo}/blame", () => {
  it("names the engine's reasons for an unresolved line, all of them, in its order", () => {
    expect(CONTRACT_REASONS).toEqual(UNRESOLVED_REASONS);
  });

  it("blames a file to the end, page by page, as git does", async () => {
    const { token, path } = await pushedRepo();
    const pages: Answer[] = [];
    let continuation: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await get(path, token, {
        path: "f.txt",
        per_page: 1,
        ...(continuation && { continuation }),
      });
      expect(page.status).toBe(200);
      pages.push(page.body);
      if (page.body.next_continuation === null) break;
      continuation = page.body.next_continuation;
    }
    expect(lines(pages)).toEqual(fromGit("f.txt"));
    expect(pages.at(-1)).toMatchObject({ commit: fx.tip, state: "complete" });
  });

  it("gives a window's ranges in line order, with no continuation", async () => {
    const { token, path } = await pushedRepo();
    const window = await get(path, token, { path: "f.txt", line_start: 2, line_end: 4 });
    expect(window.status).toBe(200);
    expect(window.body.next_continuation).toBeNull();
    expect(lines([{ ...window.body, lines: 6 }]).slice(1, 4)).toEqual(fromGit("f.txt").slice(1, 4));
  });

  it("answers each refusal as a problem document with its code", async () => {
    const { token, path } = await pushedRepo();
    const cases: [Record<string, string | number>, number, string][] = [
      [{ path: "nope.txt" }, 404, "path_not_found"],
      [{ path: "dir" }, 404, "path_not_found"],
      [{ path: "f.txt", ref: "no-such-branch" }, 404, "ref_not_found"],
      [{ path: "a//b" }, 422, "invalid_path"],
      [{ path: "f.txt", continuation: "nope" }, 422, "invalid_continuation"],
      [
        { path: "f.txt", continuation: "nope", line_start: 1, line_end: 2 },
        422,
        "invalid_continuation",
      ],
      [{ path: "f.txt", line_start: 5, line_end: 4 }, 422, "invalid_input"],
      [{ path: "f.txt", line_start: 1 }, 422, "invalid_input"],
      [{ path: "f.txt", per_page: 5001 }, 422, "invalid_input"],
    ];
    for (const [query, status, code] of cases) {
      const res = await get(path, token, query);
      expect([query, res.status, res.body.code]).toEqual([query, status, code]);
    }
    const owner = await principalWithToken("user");
    const empty = await createRepo(owner.principalId);
    const res = await get(`/repos/${handleOf(owner.principalId)}/${empty.name}`, owner.token, {
      path: "f.txt",
    });
    expect([res.status, res.body.code]).toEqual([409, "repo_empty"]);
  });

  it("answers repo_not_found when the repository's object holds no repository", async () => {
    const owner = await principalWithToken("user");
    const id = newId("rep");
    const name = uniqueId("gone");
    const now = Date.now();
    // A directory row whose object never got its storage: the object refuses reads.
    await env.DIRECTORY.prepare(
      `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'default', 'private', ?, ?)`,
    )
      .bind(id, owner.principalId, name, newId("net"), now, now)
      .run();
    const res = await get(`/repos/${handleOf(owner.principalId)}/${name}`, owner.token, {
      path: "f.txt",
    });
    expect([res.status, res.body.code]).toEqual([404, "repo_not_found"]);
  });

  it("answers 503 blame_busy with retry_after and Retry-After while another blame holds the object", async () => {
    const { token, path, stub } = await pushedRepo();
    await inRepo(stub, async (repo) => {
      held = await repo.git.memory.begin(BLAME_SHARE_BYTES);
    });
    try {
      const res = await api("GET", `${path}/blame?path=f.txt`, token);
      const body = await res.json<{ code: string; retry_after: number }>();
      expect({
        status: res.status,
        code: body.code,
        retryAfter: body.retry_after,
        header: res.headers.get("Retry-After"),
      }).toEqual({ status: 503, code: "blame_busy", retryAfter: 1, header: "1" });
    } finally {
      await inRepo(stub, () => {
        held?.release();
        held = undefined;
      });
    }
    const after = await get(path, token, { path: "f.txt" });
    expect(after.status).toBe(200);
  });
});

/** One MCP request as the owner; the response's text. */
async function mcp(
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<string> {
  const res = await exports.default.fetch("https://fyrden.test/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(typeof params.name === "string" && { "Mcp-Name": params.name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "fyrden-test", version: "0.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

describe("the get_blame MCP tool", () => {
  it("is listed read-only, telling an agent to page to the end and how to wait", async () => {
    const { token } = await pushedRepo();
    const listed = JSON.parse(await mcp(token, "tools/list", {})) as {
      result: {
        tools: { name: string; description: string; annotations?: { readOnlyHint?: boolean } }[];
      };
    };
    const tool = listed.result.tools.find((t) => t.name === "get_blame");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    for (const phrase of ["next_continuation", "unresolved", "retry_after"])
      expect([phrase, tool?.description.includes(phrase)]).toEqual([phrase, true]);
  });

  it("answers a blame, and blame_busy with its wait while another blame holds the object", async () => {
    const { token, path, stub } = await pushedRepo();
    const [, owner, repo] = path.split("/").slice(1);
    const call = () =>
      mcp(token, "tools/call", { name: "get_blame", arguments: { owner, repo, path: "f.txt" } });
    const answered = await call();
    expect(answered).toContain(fx.tip);
    expect(answered).toContain("ranges");
    await inRepo(stub, async (r) => {
      held = await r.git.memory.begin(BLAME_SHARE_BYTES);
    });
    try {
      const busy = await call();
      expect(busy).toContain("blame_busy");
      expect(busy).toContain("retry_after");
    } finally {
      await inRepo(stub, () => {
        held?.release();
        held = undefined;
      });
    }
  });
});
