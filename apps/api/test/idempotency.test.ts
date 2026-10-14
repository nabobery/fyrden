// Idempotent REST writes: a retry with the same Idempotency-Key gets the
// first answer and changes nothing again; the key cannot be reused for
// another request; secrets are never replayed.

import { createScheduledController } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { IDEMPOTENCY_POLICY } from "../src/rest/idempotency.js";
import { user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";

let owner: Who;
let tokenId: string;

beforeAll(async () => {
  owner = await user();
  const row = await env.DIRECTORY.prepare("SELECT id FROM tokens WHERE principal_id = ?")
    .bind(owner.principalId)
    .first<{ id: string }>();
  tokenId = row?.id as string;
});

async function send(
  method: string,
  path: string,
  body: unknown,
  key: string | undefined,
  token = owner.token,
) {
  const res = await exports.default.fetch(`${ORIGIN}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(key !== undefined && { "Idempotency-Key": key }),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    replayed: res.headers.get("Idempotent-Replayed"),
    body: await res.json<Record<string, unknown>>(),
  };
}

const repoCount = async (who: Who) =>
  (
    await env.DIRECTORY.prepare("SELECT count(*) AS n FROM repos WHERE owner_id = ?")
      .bind(who.principalId)
      .first<{ n: number }>()
  )?.n ?? 0;

describe("Idempotency-Key", () => {
  it("replays a create's answer and makes nothing twice", async () => {
    const key = crypto.randomUUID();
    const name = uniqueId("i");
    const first = await send("POST", "/user/repos", { name }, key);
    const before = await repoCount(owner);
    const again = await send("POST", "/user/repos", { name }, key);
    expect(first.status).toBe(201);
    expect(again).toEqual({ status: 201, replayed: "true", body: first.body });
    expect(await repoCount(owner)).toBe(before);
    // Without a key, every request runs.
    expect((await send("POST", "/user/repos", { name }, undefined)).status).toBe(409);
  });

  it("refuses the key for another request or another operation", async () => {
    const key = crypto.randomUUID();
    expect((await send("POST", "/user/repos", { name: uniqueId("i") }, key)).status).toBe(201);
    expect(await send("POST", "/user/repos", { name: uniqueId("i") }, key)).toMatchObject({
      status: 422,
      body: { code: "idempotency_key_reused" },
    });
    expect(
      await send("POST", "/user/ssh_signing_keys", { title: "t", key: "nonsense" }, key),
    ).toMatchObject({ status: 422, body: { code: "idempotency_key_reused" } });
  });

  it("replays an update and a refusal, and applies neither twice", async () => {
    const repo = (await send("POST", "/user/repos", { name: uniqueId("i") }, undefined)).body;
    const path = `/repos/${owner.handle}/${repo.name as string}`;
    const key = crypto.randomUUID();
    const renamed = uniqueId("renamed");
    const first = await send("PATCH", path, { name: renamed }, key);
    expect(first.status).toBe(200);
    // Run again, the rename would find the old name a redirect: replayed instead.
    const again = await send("PATCH", path, { name: renamed }, key);
    expect(again).toEqual({ status: 200, replayed: "true", body: first.body });
    const renames = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'repo.rename'",
    )
      .bind(repo.id as string)
      .first<{ n: number }>();
    expect(renames?.n).toBe(1);
    const taken = crypto.randomUUID();
    const refused = await send("POST", "/user/repos", { name: renamed }, taken);
    expect(refused.status).toBe(409);
    expect(await send("POST", "/user/repos", { name: renamed }, taken)).toEqual({
      ...refused,
      replayed: "true",
    });
  });

  it("does not keep refusals a retry may get differently", async () => {
    const key = crypto.randomUUID();
    const readOnly = await scopedToken(owner.principalId, ["metadata:read"]);
    const name = uniqueId("i");
    expect((await send("POST", "/user/repos", { name }, key, readOnly)).status).toBe(403);
    expect((await send("POST", "/user/repos", { name }, key)).status).toBe(201);
    // Keys are the token's: another token of the same user with the key runs as itself.
    expect((await send("POST", "/user/repos", { name }, key, readOnly)).status).toBe(403);
  });

  it("refuses while the first request runs, and never runs one whose outcome is unknown", async () => {
    const body = { name: uniqueId("i") };
    const { requestHash } = await import("../src/rest/idempotency.js");
    const hash = await requestHash("repos.create", body);
    const row = (key: string, state: string, startedAt: number) =>
      env.DIRECTORY.prepare(
        `INSERT INTO idempotency_keys (token_id, key, claim_id, op_id, request_hash, state,
           started_at, expires_at)
         VALUES (?, ?, 'other', 'repos.create', ?, ?, ?, ?)`,
      )
        .bind(tokenId, key, hash, state, startedAt, Date.now() + IDEMPOTENCY_POLICY.ttlMs)
        .run();
    const running = crypto.randomUUID();
    await row(running, "running", Date.now());
    expect(await send("POST", "/user/repos", body, running)).toMatchObject({
      status: 409,
      body: { code: "idempotency_key_in_use" },
    });
    const stale = crypto.randomUUID();
    await row(stale, "running", Date.now() - IDEMPOTENCY_POLICY.runningMaxMs - 1);
    const unknown = crypto.randomUUID();
    await row(unknown, "done", Date.now());
    for (const key of [stale, unknown])
      expect(await send("POST", "/user/repos", body, key)).toMatchObject({
        status: 409,
        body: { code: "idempotent_outcome_unknown" },
      });
  });

  it("does not keep an upload's completion while it is still indexing", async () => {
    const { outcomeOf } = await import("../src/rest/idempotency.js");
    const { registry } = await import("@fyrden/api-contract");
    const complete = registry.find((op) => op.id === "uploads.complete");
    if (!complete) throw new Error("no uploads.complete");
    expect(outcomeOf(complete, { ok: true, output: { state: "indexing" } })).toEqual({
      kind: "forget",
    });
    expect(outcomeOf(complete, { ok: true, output: { state: "committed" } })).toMatchObject({
      kind: "answer",
    });
  });

  it("never replays a secret: the token made is named, not shown", async () => {
    const admin = await user(true);
    const target = await user();
    const key = crypto.randomUUID();
    const body = { type: "pat" };
    const path = `/admin/users/${target.principalId}/tokens`;
    const first = await send("POST", path, body, key, admin.token);
    expect(first.status).toBe(201);
    expect(first.body.token).toEqual(expect.any(String));
    const again = await send("POST", path, body, key, admin.token);
    expect(again).toMatchObject({ status: 409, body: { code: "secret_already_disclosed" } });
    expect(JSON.stringify(again.body)).toContain(first.body.id as string);
    expect(JSON.stringify(again.body)).not.toContain(first.body.token as string);
    const stored = await env.DIRECTORY.prepare(
      "SELECT response FROM idempotency_keys WHERE key = ?",
    )
      .bind(key)
      .first<{ response: string | null }>();
    expect(stored?.response).toBeNull();
  });

  it("refuses a malformed key, and forgets expired ones", async () => {
    expect(await send("POST", "/user/repos", { name: uniqueId("i") }, "has space")).toMatchObject({
      status: 422,
      body: { code: "invalid_idempotency_key" },
    });
    const key = crypto.randomUUID();
    expect((await send("POST", "/user/repos", { name: uniqueId("i") }, key)).status).toBe(201);
    await env.DIRECTORY.prepare("UPDATE idempotency_keys SET expires_at = 1 WHERE key = ?")
      .bind(key)
      .run();
    // An expired key is free for a new request.
    expect((await send("POST", "/user/repos", { name: uniqueId("i") }, key)).status).toBe(201);
    await env.DIRECTORY.prepare("UPDATE idempotency_keys SET expires_at = 1 WHERE key = ?")
      .bind(key)
      .run();
    await worker.scheduled?.(createScheduledController({ cron: "*/5 * * * *" }), env);
    const left = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM idempotency_keys WHERE key = ?",
    )
      .bind(key)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
