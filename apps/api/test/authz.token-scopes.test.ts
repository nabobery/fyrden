import { exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { basic, createRepo, gitFetch, type TestRepo } from "./helpers/git-http.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");

// A token's scopes narrow what its principal may do, through REST and git
// alike; a token without scopes acts with the principal's full rights.

const ORIGIN = "https://fyrden.test";
let owner: { principalId: string; token: string };
let handle: string;
let repo: TestRepo;

beforeAll(async () => {
  owner = await principalWithToken("user", "pat");
  handle = owner.principalId.toLowerCase().replace("_", "-");
  repo = await createRepo(owner.principalId);
});

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

const infoRefs = (service: "git-upload-pack" | "git-receive-pack", token: string) =>
  gitFetch(`/${handle}/${repo.name}/info/refs?service=${service}`, {
    headers: { "Git-Protocol": "version=2", Authorization: basic(token) },
  });

async function expectMissing(res: Response, permission: string) {
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({
    code: "missing_permission",
    missing_permission: permission,
  });
}

describe("token scopes", () => {
  it("leave a token without scopes its owner's full rights", async () => {
    expect((await api(`/repos/${handle}/${repo.name}`, owner.token)).status).toBe(200);
    expect((await infoRefs("git-upload-pack", owner.token)).status).toBe(200);
    expect((await infoRefs("git-receive-pack", owner.token)).status).toBe(200);
  });

  it("let metadata:read see the repository but not clone it", async () => {
    const token = await scopedToken(owner.principalId, ["metadata:read"]);
    expect((await api(`/repos/${handle}/${repo.name}`, token)).status).toBe(200);
    // git hides what the token may not read, like a missing repository.
    expect((await infoRefs("git-upload-pack", token)).status).toBe(404);
    await expectMissing(await api(`/repos/${handle}/${repo.name}/import`, token), "contents:read");
  });

  it("let contents:read clone but not push", async () => {
    const token = await scopedToken(owner.principalId, ["contents:read"]);
    expect((await api(`/repos/${handle}/${repo.name}`, token)).status).toBe(200);
    expect((await infoRefs("git-upload-pack", token)).status).toBe(200);
    expect((await infoRefs("git-receive-pack", token)).status).toBe(404);
    await expectMissing(
      await api(`/repos/${handle}/${repo.name}/uploads`, token, { size: 1, parts: 1 }),
      "contents:write",
    );
  });

  it("let contents:write push, through the re-authorization at the commit point", async () => {
    const token = await scopedToken(owner.principalId, ["contents:write"]);
    expect((await infoRefs("git-receive-pack", token)).status).toBe(200);

    const target = await pushTarget();
    const gitToken = await scopedToken(target.owner.principalId, ["contents:write"], "git");
    const reply = await postPush(
      target,
      pushBody([{ old: ZERO, new: fx.c2, ref: "refs/heads/main" }], { pack: fx.packC2 }),
      { token: gitToken },
    );
    expect(reply.status).toBe(200);
    expect(reply.report).toContain("ok refs/heads/main\n");
  });

  it("refuse a chunked part upload to a token that may only read", async () => {
    const token = await scopedToken(owner.principalId, ["contents:read"]);
    const res = await gitFetch(`/${handle}/${repo.name}.git/uploads/${"0".repeat(26)}/parts/1`, {
      method: "PUT",
      headers: { Authorization: basic(token), "Content-Length": "1" },
      body: new Uint8Array([0]),
    });
    expect(res.status).toBe(404);
  });

  it("let repos:create create repositories and nothing else", async () => {
    const token = await scopedToken(owner.principalId, ["repos:create"]);
    expect((await api("/user/repos", token, { name: uniqueId("scoped") })).status).toBe(201);
    await expectMissing(await api(`/repos/${handle}/${repo.name}`, token), "metadata:read");
    expect((await infoRefs("git-upload-pack", token)).status).toBe(404);
  });

  it("grant nothing for a scope the permission table does not know", async () => {
    const token = await scopedToken(owner.principalId, ["repo"]);
    expect((await api("/user", token)).status).toBe(200);
    await expectMissing(await api(`/repos/${handle}/${repo.name}`, token), "metadata:read");
    expect((await infoRefs("git-upload-pack", token)).status).toBe(404);
  });

  it("never add to the principal's rights", async () => {
    const other = await principalWithToken("user", "pat");
    const token = await scopedToken(other.principalId, ["contents:write", "metadata:read"]);
    expect((await api(`/repos/${handle}/${repo.name}`, token)).status).toBe(404);
    expect((await infoRefs("git-upload-pack", token)).status).toBe(404);
  });
});
