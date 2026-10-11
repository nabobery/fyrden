import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { basic } from "./helpers/git-http.js";
import { principalWithToken } from "./helpers/principals.js";

const ORIGIN = "https://fyrden.test";
let user: { principalId: string; token: string };
let handle: string;

beforeAll(async () => {
  user = await principalWithToken("user", "pat");
  handle = user.principalId.toLowerCase().replace("_", "-");
});

function createRepo(name: unknown, token = user.token) {
  return exports.default.fetch(`${ORIGIN}/api/user/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ name }),
  });
}

const getRepo = (owner: string, name: string, token = user.token) =>
  exports.default.fetch(`${ORIGIN}/api/repos/${owner}/${name}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

describe("repos.create", () => {
  it("creates an empty private repository owned by the caller", async () => {
    const name = uniqueId("Widgets.v2_x-");
    const res = await createRepo(name);
    expect(res.status).toBe(201);
    const repo = await res.json<Record<string, unknown>>();
    expect(repo).toEqual({
      id: expect.stringMatching(/^rep_[0-9A-Z]{26}$/),
      owner: handle,
      name,
      full_name: `${handle}/${name}`,
      visibility: "private",
      default_branch: "main",
      created_at: expect.any(Number),
    });

    const row = await env.DIRECTORY.prepare(
      "SELECT owner_id, network_id, org_shard, visibility, state FROM repos WHERE id = ?",
    )
      .bind(repo.id)
      .first();
    expect(row).toEqual({
      owner_id: user.principalId,
      network_id: expect.stringMatching(/^net_[0-9A-Z]{26}$/),
      org_shard: "default",
      visibility: "private",
      state: "active",
    });
    const audit = await env.DIRECTORY.prepare(
      "SELECT actor_id, action FROM audit_log WHERE target_id = ?",
    )
      .bind(repo.id)
      .first();
    expect(audit).toEqual({ actor_id: user.principalId, action: "repo.create" });
  });

  it("initializes git storage: the new repository answers ls-refs with an unborn HEAD", async () => {
    const name = uniqueId("fresh");
    expect((await createRepo(name)).status).toBe(201);
    const body = "0014command=ls-refs\n0017object-format=sha1\n0001000csymrefs\n000bunborn\n0000";
    const res = await exports.default.fetch(`${ORIGIN}/${handle}/${name}.git/git-upload-pack`, {
      method: "POST",
      headers: {
        Authorization: basic(user.token),
        "Content-Type": "application/x-git-upload-pack-request",
        "Git-Protocol": "version=2",
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("002eunborn HEAD symref-target:refs/heads/main\n0000");
  });

  it.each([".", "..", "a.git", "a.GIT", "", "a b", "a/b", "café", "x".repeat(101)])(
    "rejects the name %j",
    async (name) => {
      const res = await createRepo(name);
      expect(res.status).toBe(422);
    },
  );

  it("accepts names GitHub accepts", async () => {
    for (const name of [
      uniqueId("x").slice(0, 100),
      `.${uniqueId("dot")}`,
      `${uniqueId("a")}.gitx`,
    ]) {
      expect((await createRepo(name)).status, name).toBe(201);
    }
    expect((await createRepo("x".repeat(100))).status).toBe(201);
  });

  it("refuses a second repository with the same name, ignoring case", async () => {
    const name = uniqueId("dup");
    expect((await createRepo(name)).status).toBe(201);
    const again = await createRepo(name.toUpperCase());
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "name_taken" });
  });

  it("lets two users use the same name", async () => {
    const name = uniqueId("shared");
    const someone = await principalWithToken("user", "pat");
    expect((await createRepo(name)).status).toBe(201);
    expect((await createRepo(name, someone.token)).status).toBe(201);
  });

  it("is for users only", async () => {
    const agent = await principalWithToken("agent", "pat");
    const res = await createRepo(uniqueId("agent"), agent.token);
    expect(res.status).toBe(403);
  });
});

describe("repos.get", () => {
  it("returns the caller's repository, ignoring case", async () => {
    const name = uniqueId("Mine");
    const created = await (await createRepo(name)).json<{ id: string }>();
    const res = await getRepo(handle.toUpperCase(), name.toLowerCase());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: created.id, name, owner: handle });
  });

  it("answers 404 alike for a missing repository and one the caller cannot see", async () => {
    const name = uniqueId("private");
    expect((await createRepo(name)).status).toBe(201);
    const someone = await principalWithToken("user", "pat");
    const hidden = await getRepo(handle, name, someone.token);
    const missing = await getRepo(handle, uniqueId("missing"), someone.token);
    for (const res of [hidden, missing]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "repo_not_found" });
    }
  });
});
