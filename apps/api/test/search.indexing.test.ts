// Turning search indexing on and off: the deployment setting that lets
// events project and repairs run, set by an instance administrator.
import { env } from "cloudflare:workers";
import { createMetrics } from "@fyrden/adapters-cloudflare/obs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD } from "../src/events/read-model.js";
import type { OpContext, OperationError } from "../src/ops/execute.js";
import { pauseReadModel, resumeReadModel } from "../src/read-model/maintenance.js";
import { setSearchIndexingOperation } from "../src/search/backfill.js";
import { searchIndexing, searchIndexingState } from "../src/search/repairs.js";
import { api, user } from "./helpers/api.js";

const put = (token: string, enabled: unknown) =>
  api("PUT", "/admin/search/indexing", token, { enabled });

describe("search indexing", () => {
  it("is turned on and off by an instance administrator, the same answer again changing nothing", async () => {
    const admin = await user(true);
    for (const enabled of [true, true, false, false, true]) {
      const res = await put(admin.token, enabled);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled });
      expect(await searchIndexing(env)).toBe(enabled);
    }
    // The state it is in, asked again, writes nothing (its time stays).
    await env.DIRECTORY.prepare(
      "UPDATE deployment_settings SET updated_at = 7 WHERE name = 'search_indexing'",
    ).run();
    expect((await put(admin.token, true)).status).toBe(200);
    const kept = await env.DIRECTORY.prepare(
      "SELECT updated_at FROM deployment_settings WHERE name = 'search_indexing'",
    ).first<{ updated_at: number }>();
    expect(kept?.updated_at).toBe(7);
    // On, a backfill is taken; off, refused.
    expect((await api("POST", "/admin/search/backfill", admin.token, {})).status).toBe(200);
    await put(admin.token, false);
    expect((await api("POST", "/admin/search/backfill", admin.token, {})).status).toBe(409);
  });

  it("raises its generation once for each change of state, never for the state it is in", async () => {
    const admin = await user(true);
    await put(admin.token, false);
    const before = (await searchIndexingState(env)).gen;
    for (const enabled of [true, true, false, false, true])
      expect((await put(admin.token, enabled)).status).toBe(200);
    expect(await searchIndexingState(env)).toEqual({ on: true, gen: before + 3 });
  });

  it("is not turned on while the read model is under maintenance, and is turned off", async () => {
    const admin = await user(true);
    await put(admin.token, false);
    const before = await searchIndexingState(env);
    for (let step = 0; step < 5; step++)
      if ((await pauseReadModel(env, DEFAULT_ORG_SHARD)).phase === "paused") break;
    try {
      const res = await put(admin.token, true);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("search_not_ready");
      expect(await searchIndexingState(env)).toEqual(before);
      // Turning it off needs nothing of the read model.
      expect((await put(admin.token, false)).status).toBe(200);
    } finally {
      await resumeReadModel(env, DEFAULT_ORG_SHARD);
    }
    expect((await put(admin.token, true)).status).toBe(200);
  });

  it("is not turned on when the read model is paused, or recovered, after it was found ready", async () => {
    const admin = await user(true);
    await put(admin.token, false);
    const before = await searchIndexingState(env);
    const ctx = (directory: D1Database) =>
      ({
        env: new Proxy(env, { get: (t, p) => (p === "DIRECTORY" ? directory : Reflect.get(t, p)) }),
        metrics: createMetrics(env.METRICS),
      }) as unknown as OpContext;
    // Something changes just before the batch that turns it on.
    const changing = (change: () => Promise<unknown>) =>
      new Proxy(env.DIRECTORY, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== "batch") return typeof value === "function" ? value.bind(target) : value;
          return async (statements: D1PreparedStatement[]) => {
            if (statements.length === 3) await change();
            return target.batch(statements);
          };
        },
      });
    const refused = async (change: () => Promise<unknown>) => {
      try {
        await setSearchIndexingOperation(ctx(changing(change)), { enabled: true });
      } catch (error) {
        return (error as OperationError).code;
      }
      return "turned on";
    };
    try {
      expect(
        await refused(async () => {
          for (let step = 0; step < 5; step++)
            if ((await pauseReadModel(env, DEFAULT_ORG_SHARD)).phase === "paused") break;
        }),
      ).toBe("search_not_ready");
    } finally {
      await resumeReadModel(env, DEFAULT_ORG_SHARD);
    }
    const recovering = () =>
      env.DIRECTORY.prepare(
        `INSERT INTO read_model_recoveries (shard, recovery_id, generation, stage, started_at,
           updated_at) VALUES (?, 'rec_test', 1, 'importing', 0, 0)`,
      )
        .bind(DEFAULT_ORG_SHARD)
        .run();
    try {
      expect(await refused(recovering)).toBe("search_not_ready");
      // And while it is under way, found so from the start.
      expect((await put(admin.token, true)).status).toBe(409);
    } finally {
      await env.DIRECTORY.prepare(
        "DELETE FROM read_model_recoveries WHERE recovery_id = 'rec_test'",
      ).run();
    }
    expect(await searchIndexingState(env)).toEqual(before);
  });

  it("is for instance administrators only, and takes a boolean", async () => {
    const admin = await user(true);
    await put(admin.token, false);
    const someone = await user();
    expect((await put(someone.token, true)).status).toBe(403);
    expect((await put(admin.token, "on")).status).toBe(422);
    expect(await searchIndexing(env)).toBe(false);
  });
});
