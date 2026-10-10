import { makeProblem, mcpAnnotations, type OperationDef, registry } from "@fyrden/api-contract";
import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Hono } from "hono";
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
 * middleware as REST; OAuth discovery for MCP clients is not built yet.
 */
export function mountMcp(app: Hono<{ Bindings: Env; Variables: AuthVariables }>): void {
  // Read-mode verification: tools/list and read tools use the isolate cache;
  // the executor re-verifies on the D1 primary before any write tool runs.
  app.all(MCP_PATH, requireAuth("read"), (c) => {
    const ctx = opContext(c);
    const auth = c.get("auth");
    const handler = createMcpHandler(() => buildServer(ctx));
    return handler.fetch(c.req.raw, {
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
