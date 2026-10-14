import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { mcpTools, registry } from "@fyrden/api-contract";
import {
  createMcpHandler,
  McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { withConvertedJsonSchema } from "../src/mcp/mount.js";
import { api, user } from "./helpers/api.js";
import { createRepo } from "./helpers/git-http.js";
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
      // The tool or resource the request names (2026-07-28 routes on it).
      ...(typeof params.name === "string" && { "Mcp-Name": params.name }),
      ...(typeof params.uri === "string" && { "Mcp-Name": params.uri }),
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

  it("converts each tool's schemas once per isolate, and still validates with them", async () => {
    const tool = (name: string) => {
      const found = registry.find((o) => o.mcp && o.mcp.tool === name);
      if (!found) throw new Error(`no ${name} tool`);
      return found;
    };
    const op = tool("whoami");
    const schema = withConvertedJsonSchema(op.input);
    expect(withConvertedJsonSchema(op.input)).toBe(schema);
    const options = { target: "draft-2020-12" } as const;
    const first = schema["~standard"].jsonSchema.input(options);
    expect(schema["~standard"].jsonSchema.input(options)).toBe(first);
    expect(first).toEqual(op.input["~standard"].jsonSchema.input(options));
    // Shared by every request: frozen, so no request can change another's.
    expect(Object.isFrozen(first)).toBe(true);
    const checked = await withConvertedJsonSchema(tool("get_repo").input)["~standard"].validate({
      owner: 1,
    });
    expect(checked.issues?.length).toBeGreaterThan(0);
    // And the listing is the same on every request.
    const again = async () =>
      JSON.stringify(await result<{ tools: unknown[] }>(await rpc("tools/list")));
    expect(await again()).toBe(await again());
  });

  it("lists tools without converting a schema again, across servers (the SDK uses the memo)", async () => {
    const conversions = { input: 0, output: 0 };
    const counting: StandardSchemaWithJSON = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value }),
        jsonSchema: {
          input: () => {
            conversions.input++;
            return { type: "object", properties: {} };
          },
          output: () => {
            conversions.output++;
            return { type: "object", properties: {} };
          },
        },
      },
    };
    const schema = withConvertedJsonSchema(counting);
    // One server per request, as the endpoint builds them.
    const list = async () => {
      const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
      server.registerTool("t", { inputSchema: schema, outputSchema: schema }, () => ({
        content: [],
        structuredContent: {},
      }));
      const res = await createMcpHandler(() => server).fetch(
        new Request("https://fyrden.test/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/list",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      );
      return result<{ tools: { name: string }[] }>(res);
    };
    expect((await list()).tools.map((t) => t.name)).toEqual(["t"]);
    expect((await list()).tools.map((t) => t.name)).toEqual(["t"]);
    expect(conversions).toEqual({ input: 1, output: 1 });
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

describe("MCP origins", () => {
  it("refuse a browser request from another site (DNS rebinding), not a native client's", async () => {
    const send = (origin?: string) =>
      exports.default.fetch("https://fyrden.test/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(origin !== undefined && { Origin: origin }),
        },
        body: "{}",
      });
    expect((await send("http://evil.example.com")).status).toBe(403);
    expect((await send("http://127.0.0.1:6274")).status).not.toBe(403);
    expect((await send()).status).not.toBe(403);
  });
});

describe("MCP resources", () => {
  it("serve a repository's files through the same authorization as the tools", async () => {
    const owner = await user();
    const name = `r${Date.now()}`;
    await api("POST", "/user/repos", owner.token, { name });
    await api("PUT", `/repos/${owner.handle}/${name}/contents/docs/hello.md`, owner.token, {
      message: "add",
      content: btoa("# Hello\n"),
    });
    const as = `Bearer ${owner.token}`;
    const templates = await result<{ resourceTemplates: { uriTemplate: string }[] }>(
      await rpc("resources/templates/list", {}, as),
    );
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toContain(
      "fyrden://repos/{owner}/{repo}/files/{+path}",
    );
    const uri = `fyrden://repos/${owner.handle}/${name}/files/docs/hello.md`;
    const read = await result<{ contents: { uri: string; text?: string; mimeType: string }[] }>(
      await rpc("resources/read", { uri }, as),
    );
    expect(read.contents).toEqual([{ uri, mimeType: "text/plain", text: "# Hello\n" }]);
    // Someone else's: not found, as over REST.
    const stranger = await user();
    const hidden = await (await rpc("resources/read", { uri }, `Bearer ${stranger.token}`)).text();
    expect(hidden).toContain("Resource not found");
  });
});

describe("large tool calls", () => {
  it("takes a file write whose JSON is over the SDK's default 4 MiB", async () => {
    const user = await principalWithToken("user", "pat");
    const repo = await createRepo(user.principalId);
    // 3,200,000 bytes of content: about 4.3 MB of JSON once base64.
    const content = btoa("x".repeat(3_200_000));
    const res = await rpc(
      "tools/call",
      {
        name: "create_or_update_file",
        arguments: {
          owner: user.principalId.toLowerCase().replace("_", "-"),
          repo: repo.name,
          path: "big.txt",
          message: "big",
          content,
        },
      },
      `Bearer ${user.token}`,
    );
    expect(res.status).toBe(200);
    const call = await result<{
      isError?: boolean;
      content: { text: string }[];
      structuredContent: { content: { size: number } };
    }>(res);
    expect(call.isError ?? false, call.content[0]?.text).toBe(false);
    expect(call.structuredContent.content.size).toBe(3_200_000);
  });
});
