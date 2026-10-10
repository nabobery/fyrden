import { env, exports } from "cloudflare:workers";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { describe, expect, it } from "vitest";
import { deepHealth } from "../src/health.js";

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
      checks: Record<string, { ok: boolean; ms: number }>;
    }>();
    expect(body.ok).toBe(true);
    expect(body.requestId).toBe("req-healthz-1");
    expect(Object.keys(body.checks).sort()).toEqual(["d1", "durableObject", "r2"]);
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

  it("leaves no probe object behind in R2", async () => {
    await exports.default.fetch("https://fyrden.test/healthz");
    const listed = await env.ASSETS.list({ prefix: "_healthz/" });
    expect(listed.objects).toHaveLength(0);
  });
});

describe("bindings", () => {
  it("binds every R2 bucket, including fyrden-assets", async () => {
    for (const bucket of [env.GIT, env.CI, env.SEARCH, env.ASSETS]) {
      await bucket.put("binding-check", "x");
      expect(await (await bucket.get("binding-check"))?.text()).toBe("x");
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
