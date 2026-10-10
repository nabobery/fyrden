import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { mcpTools, registry } from "@fyrden/api-contract";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { principalWithToken } from "./helpers/principals.js";
import { logs } from "./setup/log-capture.js";

let token = "";
let principalId = "";

beforeAll(async () => {
  ({ token, principalId } = await principalWithToken("agent"));
});

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const worker: Fetch = (url, init) => exports.default.fetch(url, init);

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  auth = `Bearer ${token}`,
  fetcher: Fetch = worker,
) {
  return fetcher("https://fyrden.test/mcp", {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(typeof params.name === "string" && { "Mcp-Name": params.name }),
    },
    // 2026-07-28 is stateless: every request carries its own envelope in _meta.
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
}

async function result<T>(res: Response): Promise<T> {
  const text = await res.text();
  // Streamable HTTP may answer with JSON or a single SSE event.
  const json = text.startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((l) => l.startsWith("data: "))
        ?.slice(6) ?? "");
  const message = JSON.parse(json) as { result?: T; error?: unknown };
  if (!message.result) throw new Error(`MCP error: ${json}`);
  return message.result;
}

describe("MCP endpoint", () => {
  it("requires authentication", async () => {
    const res = await rpc("tools/list", {}, "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("lists one tool per MCP-exposed operation, with the registry's schemas", async () => {
    const res = await rpc("tools/list");
    expect(res.status).toBe(200);
    const { tools } = await result<{ tools: Record<string, unknown>[] }>(res);
    const expected = mcpTools(registry);
    expect(tools.map((t) => t.name)).toEqual(expected.map((t) => t.name));
    // Everything the registry declares is advertised unchanged.
    for (const want of expected) {
      const tool = tools.find((t) => t.name === want.name);
      expect(tool).toMatchObject({
        title: want.title,
        description: want.description,
        annotations: want.annotations,
        inputSchema: want.inputSchema,
        outputSchema: want.outputSchema,
      });
    }
  });

  it("answers a tool that throws with a generic error and logs it redacted", async () => {
    const leaked = `fyrden_pat_${"T".repeat(36)}`;
    // A storage binding that fails with a message carrying a credential.
    const failing = {
      ...env,
      RATE_LIMIT_READ: {
        limit: async () => {
          throw new Error(`rate limiter failed for ${leaked}`);
        },
      },
    } as unknown as Env;
    const app = createApp();
    const ctx = createExecutionContext();
    const res = await rpc("tools/call", { name: "whoami", arguments: {} }, undefined, (url, init) =>
      Promise.resolve(app.request(url, init, failing, ctx)),
    );
    await waitOnExecutionContext(ctx);
    const call = await result<{ isError?: boolean; content: { text: string }[] }>(res);
    expect(call.isError).toBe(true);
    const text = call.content.map((c) => c.text).join("\n");
    expect(JSON.parse(text)).toMatchObject({ status: 500, code: "internal_error" });
    expect(text).not.toContain("rate limiter failed");
    expect(logs.entries().find((e) => e.msg === "unhandled error")).toMatchObject({
      operation: "meta.whoami",
    });
    // The shared log capture also fails the test if the credential was logged.
  });

  it("calls whoami and returns structured content", async () => {
    const res = await rpc("tools/call", { name: "whoami", arguments: {} });
    const call = await result<{
      structuredContent: { id: string; type: string };
      isError?: boolean;
    }>(res);
    expect(call.isError ?? false).toBe(false);
    expect(call.structuredContent).toMatchObject({ id: principalId, type: "agent" });
  });
});
