import { makeProblem, mcpAnnotations, type OperationDef, registry } from "@fyrden/api-contract";
import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import { MAX_JSON_BODY_BYTES, readBoundedBody } from "../http/body.js";
import { problem } from "../http/problem.js";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";
import { executeOperation, type OpContext } from "../ops/execute.js";
import { API_VERSION, opContext, operationHandler } from "../rest/mount.js";

export const MCP_PATH = "/mcp";

/**
 * Runs a tool. The SDK turns an exception thrown by a tool into an error
 * result carrying the raw message, past Hono's onError, so unexpected errors
 * are caught here: logged through the redacting logger, answered generically.
 */
async function runTool(op: OperationDef, ctx: OpContext, args: unknown): Promise<CallToolResult> {
  try {
    return toolResult(await executeOperation(op, operationHandler(op), ctx, args));
  } catch (error) {
    ctx.log.error("unhandled error", { error, operation: op.id });
    return toolResult({
      ok: false,
      problem: makeProblem({
        status: 500,
        code: "internal_error",
        detail: "An unexpected error occurred.",
        requestId: ctx.requestId,
      }),
    });
  }
}

function toolResult(result: Awaited<ReturnType<typeof executeOperation>>): CallToolResult {
  if (!result.ok) {
    // Same problem document as REST, so agents see one error shape.
    return { isError: true, content: [{ type: "text", text: JSON.stringify(result.problem) }] };
  }
  const output = result.output as Record<string, unknown>;
  return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
}

/** One MCP server per request (stateless Streamable HTTP), with a tool per registry operation. */
function buildServer(ctx: OpContext): McpServer {
  const server = new McpServer({ name: "fyrden", version: API_VERSION });
  for (const op of registry as readonly OperationDef[]) {
    if (!op.mcp) continue;
    server.registerTool(
      op.mcp.tool,
      {
        title: op.mcp.title,
        description: op.mcp.description,
        inputSchema: op.input,
        outputSchema: op.output,
        annotations: mcpAnnotations(op),
      },
      (args: unknown) => runTool(op, ctx, args),
    );
  }
  return server;
}

/**
 * MCP over Streamable HTTP at /mcp. Authentication runs first, in the same
 * middleware as REST; a 401 points clients at the resource's metadata
 * (RFC 9728), and an access token issued for another resource is refused.
 */
export function mountMcp(app: Hono<{ Bindings: Env; Variables: AuthVariables }>): void {
  // Read-mode verification: tools/list and read tools use the isolate cache;
  // the executor re-verifies on the D1 primary before any write tool runs.
  app.all(MCP_PATH, requireAuth("read", "mcp"), async (c) => {
    const ctx = opContext(c);
    const auth = c.get("auth");
    // The SDK buffers and parses the whole body: bound it first, as REST does.
    const body = await readBoundedBody(c.req.raw, MAX_JSON_BODY_BYTES);
    if (!body)
      return problem(
        c,
        413,
        "body_too_large",
        `The request body is larger than ${MAX_JSON_BODY_BYTES} bytes.`,
      );
    const request = new Request(c.req.raw, {
      ...(c.req.method !== "GET" && c.req.method !== "HEAD" && { body }),
    });
    const handler = createMcpHandler(() => buildServer(ctx), {
      maxRequestBodySize: MAX_JSON_BODY_BYTES,
    });
    return handler.fetch(request, {
      // The token id, not the token: the SDK never needs the secret.
      authInfo: {
        token: auth.id,
        clientId: auth.principalId,
        scopes: auth.scopes,
        expiresAt: Math.floor(auth.expiresAt / 1000),
      },
    });
  });
}
