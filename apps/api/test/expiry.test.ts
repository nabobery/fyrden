// Repository expiry: a repository may name the time it is deleted at, and
// the cron deletes it once that time has passed, through the ordinary
// deletion.

import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MAX_REPO_TTL_MS } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { markDeletions } from "../src/repos/deletion.js";
import { api, json, user, type Who } from "./helpers/api.js";

type Repo = { id: string; name: string; expires_at: number | null; code?: string };

const HOUR = 60 * 60 * 1000;

let owner: Who;

beforeAll(async () => {
  owner = await user();
});

const create = (body: Record<string, unknown>) =>
  json<Repo>(api("POST", "/user/repos", owner.token, { name: uniqueId("x"), ...body }));

const runCron = () => worker.scheduled?.(createScheduledController({ cron: "*/5 * * * *" }), env);

describe("repository expiry", () => {
  it("is set at creation, shown, and refused in the past or beyond a year", async () => {
    const at = Date.now() + HOUR;
    expect((await create({ expires_at: at })).body).toMatchObject({ expires_at: at });
    expect((await create({})).body.expires_at).toBeNull();
    for (const bad of [0, -1, Date.now() - 1, Date.now() + MAX_REPO_TTL_MS + HOUR])
      expect(await create({ expires_at: bad })).toMatchObject({
        status: 422,
        body: { code: "invalid_expiry" },
      });
  });

  it("is set on a fork, which does not take its parent's", async () => {
    const parent = (await create({ expires_at: Date.now() + HOUR })).body;
    const at = Date.now() + 3 * HOUR;
    const fork = await json<Repo>(
      api("POST", `/repos/${owner.handle}/${parent.name}/forks`, owner.token, {
        name: uniqueId("f"),
        expires_at: at,
      }),
    );
    expect(fork).toMatchObject({ status: 201, body: { expires_at: at } });
    const plain = await json<Repo>(
      api("POST", `/repos/${owner.handle}/${parent.name}/forks`, owner.token, {
        name: uniqueId("f"),
      }),
    );
    expect(plain.body.expires_at).toBeNull();
  });

  it("is changed and cleared by an update; an invalid one changes nothing", async () => {
    const repo = (await create({})).body;
    const path = `/repos/${owner.handle}/${repo.name}`;
    const at = Date.now() + 2 * HOUR;
    expect(
      (await json<Repo>(api("PATCH", path, owner.token, { expires_at: at }))).body,
    ).toMatchObject({ expires_at: at });
    const renamed = uniqueId("renamed");
    const refused = await json<Repo>(
      api("PATCH", path, owner.token, { name: renamed, expires_at: Date.now() - 1 }),
    );
    expect(refused).toMatchObject({ status: 422, body: { code: "invalid_expiry" } });
    expect((await json<Repo>(api("GET", path, owner.token))).body).toMatchObject({
      name: repo.name,
      expires_at: at,
    });
    expect(
      (await json<Repo>(api("PATCH", path, owner.token, { expires_at: null }))).body.expires_at,
    ).toBeNull();
    // With a rename in the same update, the answer has the new name.
    const moved = await json<Repo>(
      api("PATCH", path, owner.token, { name: renamed, expires_at: at }),
    );
    expect(moved.body).toMatchObject({ name: renamed, expires_at: at });
    const audit = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'repo.settings'",
    )
      .bind(repo.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(3);
  });

  it("deletes a repository once its time has passed, in one cron run, and keeps the others", async () => {
    const soon = (await create({ expires_at: Date.now() + HOUR })).body;
    const later = (await create({ expires_at: Date.now() + HOUR })).body;
    // Its time has passed (the clock cannot be moved forward here).
    await env.DIRECTORY.prepare("UPDATE repos SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, soon.id)
      .run();
    await runCron();
    expect((await api("GET", `/repos/${owner.handle}/${soon.name}`, owner.token)).status).toBe(404);
    expect((await api("GET", `/repos/${owner.handle}/${later.name}`, owner.token)).status).toBe(
      200,
    );
    const row = await env.DIRECTORY.prepare(
      `SELECT r.state, a.actor_id FROM repos r
       JOIN audit_log a ON a.target_id = r.id AND a.action = 'repo.expire' WHERE r.id = ?`,
    )
      .bind(soon.id)
      .first<{ state: string; actor_id: string | null }>();
    expect(row).toEqual({ state: "deleted", actor_id: null });
    // Run again: nothing more happens to it.
    await runCron();
    const audits = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'repo.expire'",
    )
      .bind(soon.id)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it("keeps a repository whose expiry was cleared or extended after the cron found it", async () => {
    for (const change of [null, Date.now() + HOUR]) {
      const repo = (await create({ expires_at: Date.now() + HOUR })).body;
      const path = `/repos/${owner.handle}/${repo.name}`;
      await env.DIRECTORY.prepare("UPDATE repos SET expires_at = ? WHERE id = ?")
        .bind(Date.now() - 1, repo.id)
        .run();
      // Found expired by the cron's query; then the owner clears or extends it.
      const found = { id: repo.id, ownerHandle: owner.handle, name: repo.name };
      expect((await api("PATCH", path, owner.token, { expires_at: change })).status).toBe(200);
      const marked = await markDeletions(env, [found], { actorId: null, expiredBy: Date.now() });
      expect(marked.size).toBe(0);
      expect((await api("GET", path, owner.token)).status).toBe(200);
      const audits = await env.DIRECTORY.prepare(
        "SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'repo.expire'",
      )
        .bind(repo.id)
        .first<{ n: number }>();
      expect(audits?.n).toBe(0);
    }
  });
});
