// GitHub's CODEOWNERS errors: the file a pull request onto a branch, tag or
// commit would read, parsed on its own, its errors in line order with the
// file's path; 404 without a ref or a file; whole-file errors without
// reading the body; quoted lines and owners cut, and the answer bounded in
// bytes; reads, built bytes and memory bounded; the same through MCP.
import { env, exports } from "cloudflare:workers";
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { MAX_CODEOWNERS_BYTES } from "@fyrden/domain";
import { ReaderWorkSpent } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { RepoBrowse } from "../src/do/repo/browse.js";
import { CODEOWNERS_ERRORS_POLICY, codeOwnersErrors } from "../src/do/repo/code-owners-errors.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

let owner: Who;
let repo: { id: string; name: string };
let path: string;

type ErrorView = {
  line: number;
  column: number;
  kind: string;
  source: string;
  suggestion: string | null;
  message: string;
  path: string;
};
type Answer = { errors: ErrorView[]; truncated?: boolean };

const stub = () => env.REPO.getByName(repo.id);

async function ok<T = Record<string, unknown>>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
  return (await answer.json()) as T;
}

/** Writes `files` (null deletes; `{ base64 }` binary) on `main` as one commit; its sha. */
async function commit(files: Record<string, string | null | { base64: string }>): Promise<string> {
  return (
    await ok<{ commit: { sha: string } }>(
      api("POST", `${path}/file-commits`, owner.token, {
        branch: "main",
        message: "change",
        changes: Object.entries(files).map(([p, content]) =>
          content === null
            ? { path: p, delete: true }
            : typeof content === "string"
              ? { path: p, content }
              : { path: p, content: content.base64, encoding: "base64" },
        ),
      }),
    )
  ).commit.sha;
}

/** Points `ref` (a full ref name) at `sha` by a push. */
async function refAt(ref: string, sha: string): Promise<void> {
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
    pushBody([{ old: ZERO, new: sha, ref }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok ${ref}\n`);
}

const errorsAt = (ref?: string, token = owner.token) =>
  json<Answer & { code?: string }>(
    api(
      "GET",
      `${path}/codeowners/errors${ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`}`,
      token,
    ),
  );

/** Calls MCP tool `name` as the owner; the response's text. */
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await exports.default.fetch("https://fyrden.test/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${owner.token}`,
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
  expect(res.status).toBe(200);
  return res.text();
}

beforeEach(async () => {
  owner = await user();
  repo = await ok<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("r"), auto_init: true }),
  );
  path = `/repos/${owner.handle}/${repo.name}`;
});

describe("CODEOWNERS errors", () => {
  it("lists the errors of the file a pull request would read, in GitHub's shape", async () => {
    await commit({
      ".github/CODEOWNERS": `# owners\n* @${owner.handle}\n***/*.rb @${owner.handle}\n/x/ not-an-owner\n`,
      // Passed over: the first location holding a regular file has authority.
      CODEOWNERS: "/y/ also-not-an-owner\n",
    });
    const got = await errorsAt();
    expect(got.status).toBe(200);
    expect(got.body.truncated).toBeUndefined();
    expect(got.body.errors).toEqual([
      expect.objectContaining({
        line: 3,
        column: 1,
        kind: "Invalid pattern",
        source: `***/*.rb @${owner.handle}`,
        suggestion: "Use `**`.",
        path: ".github/CODEOWNERS",
      }),
      expect.objectContaining({
        line: 4,
        column: 5,
        kind: "Invalid owner",
        source: "/x/ not-an-owner",
        suggestion: null,
        path: ".github/CODEOWNERS",
      }),
    ]);
    expect(got.body.errors[1]?.message).toContain("not-an-owner is not an owner");
  });

  it("reads a branch, a tag or a commit, and the default branch without one", async () => {
    const first = await commit({ CODEOWNERS: "/a/ bad\n" });
    await refAt("refs/heads/old", first);
    await refAt("refs/tags/v1", first);
    await commit({ CODEOWNERS: `* @${owner.handle}\n` });
    expect((await errorsAt()).body.errors).toEqual([]);
    for (const ref of ["old", "v1", first])
      expect((await errorsAt(ref)).body.errors.map((e) => e.line)).toEqual([1]);
  });

  it("answers 404 for a ref naming no commit, for no file, and for an empty repository", async () => {
    await commit({ "a.txt": "a\n" });
    expect((await errorsAt()).status).toBe(404);
    expect((await errorsAt("no-such-branch")).status).toBe(404);
    expect((await errorsAt("0".repeat(40))).status).toBe(404);
    repo = await ok<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("empty") }),
    );
    path = `/repos/${owner.handle}/${repo.name}`;
    expect((await errorsAt()).body).toMatchObject({ code: "not_found" });
  });

  it("answers a whole-file error for a file too large, its body unread, and for one not UTF-8", async () => {
    await commit({
      ".github/CODEOWNERS": { base64: btoa("x".repeat(MAX_CODEOWNERS_BYTES)) },
    });
    // Reading its body would build far more than the reader may: only its header is read.
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnersErrorsPolicy = { ...r.codeOwnersErrorsPolicy, maxBuiltBytes: 512 * 1024 };
    });
    const big = await errorsAt();
    expect(big.body.errors).toEqual([
      expect.objectContaining({ line: 0, column: 0, kind: "File too large", source: "" }),
    ]);
    await commit({ ".github/CODEOWNERS": { base64: btoa("\xff\xfe /a/ x\n") } });
    expect((await errorsAt()).body.errors).toEqual([
      expect.objectContaining({ line: 0, kind: "Invalid encoding" }),
    ]);
  });

  it("cuts quoted lines and owners, and stops at the answer's bytes, marked truncated", async () => {
    const owner2 = "x".repeat(5_000);
    await commit({ CODEOWNERS: `/a/ ${owner2}\n` });
    const cut = (await errorsAt()).body.errors[0];
    expect(cut?.source.length).toBe(1_025);
    expect(cut?.source.endsWith("…")).toBe(true);
    expect(cut?.message.length).toBeLessThan(400);
    // Many invalid lines, each quoting a long control-character owner (escaped in JSON).
    const lines = Array.from({ length: 900 }, (_, i) => `/p${i}/ ${"\u0001".repeat(1_100)}`);
    await commit({ CODEOWNERS: `${lines.join("\n")}\n` });
    const res = await api("GET", `${path}/codeowners/errors`, owner.token);
    const text = await res.text();
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1024 * 1024);
    const answer = JSON.parse(text) as Answer;
    expect(answer.truncated).toBe(true);
    expect(answer.errors.length).toBeGreaterThan(0);
    expect(answer.errors.length).toBeLessThan(900);
  });

  it("answers 422 past its reads' built bytes, and 409 while the object's memory is held", async () => {
    await commit({ CODEOWNERS: `* @${owner.handle}\n/x/ bad\n` });
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnersErrorsPolicy = { ...r.codeOwnersErrorsPolicy, maxBuiltBytes: 16 };
    });
    expect((await errorsAt()).body).toMatchObject({ code: "too_expensive" });
    // A parse needing more than the object's whole memory: never, refused as too expensive.
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnersErrorsPolicy = {
        ...r.codeOwnersErrorsPolicy,
        maxBuiltBytes: 64 * 1024 * 1024,
        fileMemoryPerByte: 2 ** 40,
      };
    });
    expect((await errorsAt()).body).toMatchObject({ code: "too_expensive" });
    // Memory other work holds now (the reader open already): busy, to try again.
    const busy = await inRepo(stub(), async ({ git }: RepoDO) => {
      const b = new RepoBrowse({ git, memoryBlocks: createClockBlockCache() });
      await b.reader();
      const stats = git.memory.stats();
      const hog = git.memory.tryReserve(stats.totalBytes - stats.reservedBytes);
      try {
        return await codeOwnersErrors(b, git.memory, undefined, CODEOWNERS_ERRORS_POLICY);
      } finally {
        hog?.release();
        b.close();
      }
    });
    expect(busy).toMatchObject({ ok: false, status: 409, code: "busy" });
  });

  it("answers 422 when peeling a ref spends the reader's budget, as the rest does", async () => {
    const spending = {
      resolveTree: async () => {
        throw new ReaderWorkSpent(16);
      },
    } as unknown as RepoBrowse;
    const answer = await codeOwnersErrors(
      spending,
      { tryReserve: () => undefined },
      "v1",
      CODEOWNERS_ERRORS_POLICY,
    );
    expect(answer).toMatchObject({ ok: false, status: 422, code: "too_expensive" });
  });

  it("bounds the bytes built across finding the file and reading it: a large blob past what is left", async () => {
    // Finding the file builds a few small trees; its 600 KB body would pass what they leave.
    await commit({ CODEOWNERS: `${"# comment line\n".repeat(40_000)}/x/ bad\n` });
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnersErrorsPolicy = { ...r.codeOwnersErrorsPolicy, maxBuiltBytes: 100 * 1024 };
    });
    expect((await errorsAt()).body).toMatchObject({ code: "too_expensive" });
  });

  it("answers busy through REST and MCP while the object's memory is held by other work", async () => {
    await commit({ CODEOWNERS: `${"/a/ @nobody\n".repeat(20_000)}` });
    // Held between the requests: what is left opens a reader but cannot hold the parse.
    await inRepo(stub(), (r: RepoDO) => {
      const stats = r.git.memory.stats();
      (r as unknown as { hog?: { release(): void } | undefined }).hog = r.git.memory.tryReserve(
        stats.totalBytes - stats.reservedBytes - 8 * 1024 * 1024,
      );
    });
    try {
      const rest = await errorsAt();
      expect(rest).toMatchObject({ status: 409, body: { code: "busy" } });
      const mcp = await callTool("get_codeowners_errors", { owner: owner.handle, repo: repo.name });
      expect(mcp).toContain("busy");
    } finally {
      await inRepo(stub(), (r: RepoDO) => {
        (r as unknown as { hog?: { release(): void } }).hog?.release();
      });
    }
  });

  it("needs contents:read", async () => {
    await commit({ CODEOWNERS: "/x/ bad\n" });
    const narrow = await scopedToken(owner.principalId, ["metadata:read"]);
    expect((await errorsAt(undefined, narrow)).status).toBeGreaterThanOrEqual(403);
  });

  it("answers the same through MCP", async () => {
    await commit({ CODEOWNERS: "/x/ bad\n" });
    const body = await callTool("get_codeowners_errors", { owner: owner.handle, repo: repo.name });

    expect(body).toContain("Invalid owner");
    expect(body).toContain('"path":"CODEOWNERS"');
  });
});
