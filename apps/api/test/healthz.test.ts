import { env, exports } from "cloudflare:workers";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import {
  deepHealth,
  EFFECTS_FAILED_MS,
  EFFECTS_OVERDUE_MS,
  OLDEST_PENDING_EFFECT,
  RECENTLY_FAILED_EFFECT,
} from "../src/health.js";
import { READ_MODEL_PROTOCOL } from "../src/read-model/executor.js";

describe("GET /healthz", () => {
  it("round-trips D1, a RepoDO and R2 and returns the request id", async () => {
    const res = await exports.default.fetch("https://fyrden.test/healthz", {
      headers: { "X-Request-Id": "req-healthz-1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("req-healthz-1");
    const body = await res.json<{
      ok: boolean;
      requestId: string;
      readModel: { protocol: number };
      checks: Record<string, { ok: boolean; ms: number }>;
    }>();
    expect(body.ok).toBe(true);
    expect(body.requestId).toBe("req-healthz-1");
    // The read model's write protocol this deployment serves (a deploy verifies it).
    expect(body.readModel).toEqual({ protocol: READ_MODEL_PROTOCOL });
    expect(Object.keys(body.checks).sort()).toEqual([
      "d1",
      "deletions",
      "durableObject",
      "effects",
      "r2",
    ]);
    for (const check of Object.values(body.checks)) {
      expect(check.ok).toBe(true);
      expect(check.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("counts the D1, Durable Object and R2 operations it makes", async () => {
    const counted: string[] = [];
    const metrics: Metrics = {
      count: (name, dims) => counted.push(`${name} ${Object.values(dims)}`),
    };
    const result = await deepHealth(env, {}, metrics);
    expect(result.rateLimited).toBe(false);
    expect(counted.sort()).toEqual([
      "d1.query directory,healthz",
      "d1.query directory,healthz_deletions",
      "d1.query org,healthz_effects",
      "do.request RepoDO,healthProbe",
      "r2.class_a fyrden-assets,put",
      "r2.class_b fyrden-assets,get",
    ]);
  });

  it("does not count an R2 read it never made when the write fails", async () => {
    const counted: string[] = [];
    const metrics: Metrics = { count: (name) => counted.push(name) };
    const failingR2 = {
      ...env,
      ASSETS: {
        put: async () => {
          throw new Error("R2 unavailable");
        },
        get: async () => {
          throw new Error("get must not be called");
        },
        delete: async () => {},
      },
    } as unknown as Env;
    const result = await deepHealth(failingR2, {}, metrics);
    expect(result.rateLimited === false && result.report.checks.r2.ok).toBe(false);
    expect(counted).toContain("r2.class_a");
    expect(counted).not.toContain("r2.class_b");
  });

  it("reports effects overdue past the threshold as degraded, without failing the check", async () => {
    const id = uniqueId("effect");
    await env.ORG_READ.prepare(
      `INSERT INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at)
       VALUES (?, 'webhooks', 'hooks', '{}', ?, 0)`,
    )
      .bind(id, Date.now() - EFFECTS_OVERDUE_MS - 60_000)
      .run();
    try {
      const res = await exports.default.fetch("https://fyrden.test/healthz");
      expect(res.status).toBe(200);
      const body = await res.json<{ ok: boolean; checks: { effects: Record<string, unknown> } }>();
      expect(body.ok).toBe(true);
      // Only how late, and whether one failed: no counts or ids on a public endpoint.
      expect(Object.keys(body.checks.effects).sort()).toEqual(["failed", "ms", "ok", "overdueS"]);
      expect(body.checks.effects.ok).toBe(false);
      expect(body.checks.effects.overdueS).toBeGreaterThanOrEqual(EFFECTS_OVERDUE_MS / 1000 + 60);
    } finally {
      await env.ORG_READ.prepare("DELETE FROM effects WHERE effect_id = ?").bind(id).run();
    }
  });

  it("reports effects as ok when the oldest pending one is not due yet", async () => {
    const id = uniqueId("effect");
    await env.ORG_READ.prepare(
      `INSERT INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at)
       VALUES (?, 'webhooks', 'hooks', '{}', ?, 0)`,
    )
      .bind(id, Date.now() + 60 * 60_000)
      .run();
    try {
      const result = await deepHealth(env, {}, { count: () => {} });
      expect(result.rateLimited === false && result.report.checks.effects).toMatchObject({
        ok: true,
        overdueS: 0,
        failed: false,
      });
    } finally {
      await env.ORG_READ.prepare("DELETE FROM effects WHERE effect_id = ?").bind(id).run();
    }
  });

  it("reports an effect that failed for good lately as degraded, without failing the check", async () => {
    const id = uniqueId("effect");
    await env.ORG_READ.prepare(
      `INSERT INTO effects (effect_id, sink, target, payload, state, attempts, next_attempt_at,
         last_error, created_at)
       VALUES (?, 'webhooks', 'hooks', '{}', 'failed', 20, ?, 'D1 overloaded', 0)`,
    )
      .bind(id, Date.now() - 60_000)
      .run();
    try {
      const res = await exports.default.fetch("https://fyrden.test/healthz");
      const body = await res.json<{ ok: boolean; checks: { effects: Record<string, unknown> } }>();
      expect(body.ok).toBe(true);
      expect(body.checks.effects).toMatchObject({ ok: false, overdueS: 0, failed: true });
    } finally {
      await env.ORG_READ.prepare("DELETE FROM effects WHERE effect_id = ?").bind(id).run();
    }
  });

  it("does not report an effect ended because its source went, or one that failed long ago", async () => {
    const invalidated = uniqueId("effect");
    const old = uniqueId("effect");
    await env.ORG_READ.prepare(
      `INSERT INTO effects (effect_id, sink, target, payload, state, attempts, next_attempt_at,
         last_error, created_at)
       VALUES (?1, 'webhooks', 'hooks', '{}', 'failed', 1, ?3,
           'invalidated: its source was deleted', 0),
         (?2, 'webhooks', 'hooks', '{}', 'failed', 20, ?4, 'D1 overloaded', 0)`,
    )
      .bind(invalidated, old, Date.now(), Date.now() - EFFECTS_FAILED_MS - 60_000)
      .run();
    try {
      const result = await deepHealth(env, {}, { count: () => {} });
      expect(result.rateLimited === false && result.report.checks.effects).toMatchObject({
        ok: true,
        failed: false,
      });
    } finally {
      await env.ORG_READ.prepare("DELETE FROM effects WHERE effect_id IN (?, ?)")
        .bind(invalidated, old)
        .run();
    }
  });

  it("finds a recently failed effect through an index of failures alone, not invalidations", async () => {
    const { results } = await env.ORG_READ.prepare(`EXPLAIN QUERY PLAN ${RECENTLY_FAILED_EFFECT}`)
      .bind(0)
      .all<{ detail: string }>();
    expect(results.map((r) => r.detail).join("\n")).toMatch(
      /USING (COVERING )?INDEX effects_failed_reportable\b/,
    );
  });

  it("finds the oldest pending effect through the due index", async () => {
    const { results } = await env.ORG_READ.prepare(
      `EXPLAIN QUERY PLAN ${OLDEST_PENDING_EFFECT}`,
    ).all<{ detail: string }>();
    expect(results.map((r) => r.detail).join("\n")).toMatch(
      /USING (COVERING )?INDEX effects_due_order\b/,
    );
  });

  it("leaves no probe object behind in R2", async () => {
    await exports.default.fetch("https://fyrden.test/healthz");
    const listed = await env.ASSETS.list({ prefix: "_healthz/" });
    expect(listed.objects).toHaveLength(0);
  });
});

describe("bindings", () => {
  it("binds every R2 bucket, including fyrden-assets", async () => {
    for (const bucket of [env.GIT, env.CI, env.SEARCH, env.ASSETS]) {
      const key = uniqueId("binding-check");
      await bucket.put(key, "x");
      expect(await (await bucket.get(key))?.text()).toBe("x");
    }
  });

  it("binds every Durable Object namespace", () => {
    for (const ns of [env.REPO, env.NETWORK, env.ORG, env.USER, env.RUN]) {
      expect(ns.idFromName("x").toString()).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("binds both D1 databases and every queue producer", async () => {
    for (const db of [env.DIRECTORY, env.ORG_READ]) {
      expect(await db.prepare("SELECT 2 AS two").first("two")).toBe(2);
    }
    for (const queue of [env.EVENTS, env.WEBHOOKS, env.CI_DISPATCH, env.INDEXING]) {
      expect(typeof queue.send).toBe("function");
    }
  });
});
