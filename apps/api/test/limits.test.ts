import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { generateToken, secureRandomBytes } from "@fyrden/domain";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { principalWithToken } from "./helpers/principals.js";
import { logs } from "./setup/log-capture.js";

const deny = { limit: vi.fn(async () => ({ success: false })) };
const allow = { limit: vi.fn(async () => ({ success: true })) };

/** Runs the app against `env` with some bindings replaced, counting D1 statements. */
async function call(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  const statements: string[] = [];
  const directory = new Proxy(env.DIRECTORY, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          statements.push(query);
          return target.prepare(query);
        };
      }
      if (prop === "withSession") return (...args: [string?]) => target.withSession(...args);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ctx = createExecutionContext();
  const res = await createApp().fetch(
    new Request(`https://fyrden.test${path}`, init),
    { ...env, DIRECTORY: directory, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, statements };
}

const mcpCall = (
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): RequestInit => ({
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

describe("rate limits", () => {
  it("limits authentication attempts per client before any token lookup", async () => {
    const { res, statements } = await call(
      "/api/user",
      {
        headers: {
          // A checksum-valid but unknown token: without the limiter it would reach D1.
          Authorization: `Bearer ${generateToken("pat", secureRandomBytes)}`,
          "CF-Connecting-IP": "203.0.113.7",
        },
      },
      { RATE_LIMIT_AUTH: deny as unknown as RateLimit },
    );
    expect(res.status).toBe(429);
    expect(statements).toEqual([]);
    expect(deny.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
  });

  it("applies the operation's rate limit on REST and MCP alike", async () => {
    const { token } = await principalWithToken();
    const limited = { RATE_LIMIT_READ: deny as unknown as RateLimit };
    const rest = await call(
      "/api/user",
      { headers: { Authorization: `Bearer ${token}` } },
      limited,
    );
    expect(rest.res.status).toBe(429);
    expect(rest.res.headers.get("Retry-After")).toBe("60");

    const mcp = await call(
      "/mcp",
      mcpCall(token, "tools/call", { name: "whoami", arguments: {} }),
      limited,
    );
    const text = await mcp.res.text();
    expect(text).toContain('"isError":true');
    expect(text).toContain("rate_limited");
    expect(text).not.toContain("structuredContent");
  });

  it("runs concurrent health checks with the same request id without false failures", async () => {
    const init = { headers: { "X-Request-Id": "same-id" } };
    const overrides = { RATE_LIMIT_HEALTHZ: allow as unknown as RateLimit };
    const [a, b] = await Promise.all([
      call("/healthz", init, overrides),
      call("/healthz", init, overrides),
    ]);
    expect([a.res.status, b.res.status]).toEqual([200, 200]);
  });
});

describe("MCP authentication", () => {
  it("verifies MCP reads from the isolate cache once warm", async () => {
    const { token } = await principalWithToken("agent");
    await call("/mcp", mcpCall(token, "tools/list"));
    const second = await call("/mcp", mcpCall(token, "tools/list"));
    expect(second.res.status).toBe(200);
    expect(second.statements.filter((q) => q.includes("FROM tokens"))).toEqual([]);
  });
});

describe("request logging", () => {
  it("carries the authenticated principal on the completion line", async () => {
    const { token, principalId } = await principalWithToken();
    await call("/api/user", {
      headers: { Authorization: `Bearer ${token}`, "X-Request-Id": "req-principal-1" },
    });
    const done = logs
      .entries()
      .find((e) => e.msg === "request" && e.requestId === "req-principal-1");
    expect(done).toMatchObject({
      principalId,
      principalType: "user",
      route: "/api/user",
      status: 200,
    });
  });
});
