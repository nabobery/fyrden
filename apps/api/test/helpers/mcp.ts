import { exports } from "cloudflare:workers";
import { ORIGIN } from "./git-http.js";

/** A tool's answer: the error flag, its text, and its structured content when it has one. */
export interface ToolAnswer {
  readonly isError: boolean;
  readonly text: string;
  readonly structured?: Record<string, unknown>;
}

/** Calls MCP tool `name` with `args` as the holder of `token` (2026-07-28, stateless). */
export async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const res = await exports.default.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "fyrden-test", version: "0.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const body = await res.text();
  if (res.status !== 200) throw new Error(`MCP ${res.status}: ${body}`);
  // Streamable HTTP may answer with JSON or a single SSE event.
  const message = JSON.parse(
    body.startsWith("{")
      ? body
      : (body
          .split("\n")
          .find((l) => l.startsWith("data: "))
          ?.slice(6) ?? ""),
  ) as {
    result?: {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: Record<string, unknown>;
    };
  };
  if (!message.result) throw new Error(`MCP error: ${body}`);
  return {
    isError: message.result.isError ?? false,
    text: message.result.content.map((c) => c.text).join("\n"),
    ...(message.result.structuredContent && { structured: message.result.structuredContent }),
  };
}
