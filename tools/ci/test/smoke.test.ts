import { API_RPC_VERSION } from "@fyrden/api-contract";
import { describe, expect, it } from "vitest";
import { apiChecks, EXPECTED_RPC_VERSION, runSmoke, webChecks } from "../src/smoke.ts";

const healthy = {
  ok: true,
  checks: { d1: { ok: true, ms: 3 }, durableObject: { ok: true, ms: 1 }, r2: { ok: true, ms: 5 } },
};

function fakeFetch(
  routes: Record<string, unknown>,
  html = "<p>API RPC version <!-- -->1</p>",
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://web.test/") return new Response(html);
    if (url in routes) return Response.json(routes[url]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const routes = (health: unknown) => ({
  "https://api.test/healthz": health,
  "https://web.test/healthz": health,
  "https://api.test/api/openapi.json": { openapi: "3.1.1" },
});

const all = (f: typeof fetch) => [
  ...apiChecks("https://api.test", f),
  ...webChecks("https://web.test/", f),
];

describe("smoke", () => {
  it("passes against a healthy deployment", async () => {
    const results = await runSmoke(all(fakeFetch(routes(healthy))));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(4);
  });

  it.each([
    [
      "a failing check",
      { ...healthy, ok: false, checks: { ...healthy.checks, d1: { ok: false, ms: 1 } } },
    ],
    ["an empty check map", { ok: true, checks: {} }],
    [
      "a missing Durable Object check",
      { ok: true, checks: { d1: healthy.checks.d1, r2: healthy.checks.r2 } },
    ],
  ])("fails the health checks on %s", async (_, health) => {
    const results = await runSmoke(all(fakeFetch(routes(health))));
    expect(results.filter((r) => r.name.includes("healthz")).every((r) => !r.ok)).toBe(true);
  });

  it("warns about overdue effects without failing", async () => {
    const degraded = {
      ...healthy,
      checks: { ...healthy.checks, effects: { ok: false, ms: 2, overdueS: 1800 } },
    };
    const results = await runSmoke(all(fakeFetch(routes(degraded))));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.filter((r) => r.warning).map((r) => [r.name, r.warning])).toEqual([
      ["api healthz", "effects overdue by 1800 s"],
      ["web healthz through the binding", "effects overdue by 1800 s"],
    ]);
  });

  it("warns about an effect that failed for good without failing", async () => {
    const degraded = {
      ...healthy,
      checks: { ...healthy.checks, effects: { ok: false, ms: 2, overdueS: 0, failed: true } },
    };
    const results = await runSmoke(all(fakeFetch(routes(degraded))));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.filter((r) => r.warning).map((r) => r.warning)).toEqual([
      "an effect failed for good lately",
      "an effect failed for good lately",
    ]);
  });

  it("does not warn when effects are on time, or not reported", async () => {
    const onTime = {
      ...healthy,
      checks: { ...healthy.checks, effects: { ok: true, ms: 2, overdueS: 0, failed: false } },
    };
    for (const health of [onTime, healthy]) {
      const results = await runSmoke(all(fakeFetch(routes(health))));
      expect(results.filter((r) => !r.ok || r.warning)).toEqual([]);
    }
  });

  it("expects the same RPC version the API contract declares", () => {
    expect(EXPECTED_RPC_VERSION).toBe(API_RPC_VERSION);
  });

  it.each([
    "<p>Error</p>",
    "<p>API RPC version undefined</p>",
    "<p>API RPC version 0</p>",
    "<p>API RPC version 999</p>",
    "<p>API RPC version 1garbage</p>",
  ])("fails the web check when the page shows %s", async (html) => {
    const results = await runSmoke(all(fakeFetch(routes(healthy), html)));
    expect(results.find((r) => r.name.startsWith("web renders"))?.ok).toBe(false);
  });
});
