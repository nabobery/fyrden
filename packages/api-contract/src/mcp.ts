import { z } from "zod";
import type { OperationDef, Registry } from "./op.js";

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: McpAnnotations;
  /** The registry operation that serves this tool. */
  operationId: string;
}

export interface McpAnnotations {
  readOnlyHint: boolean;
  idempotentHint: boolean;
}

/** Tool annotations for an operation; the MCP endpoint advertises exactly these. */
export function mcpAnnotations(op: OperationDef): McpAnnotations {
  const readOnly = op.mcp !== false && op.mcp.readOnly;
  return { readOnlyHint: readOnly, idempotentHint: op.idempotency !== "none" || readOnly };
}

const jsonSchema = (schema: z.ZodType, io: "input" | "output") => {
  const {
    $schema: _,
    id: __,
    ...rest
  } = z.toJSONSchema(schema, { io, unrepresentable: "throw" }) as Record<string, unknown>;
  return rest;
};

/** MCP tool definitions generated from the registry: same names and schemas as REST. */
export function mcpTools(registry: Registry): McpToolDefinition[] {
  return registry
    .filter(
      (op): op is OperationDef & { mcp: Exclude<OperationDef["mcp"], false> } => op.mcp !== false,
    )
    .map((op) => ({
      name: op.mcp.tool,
      title: op.mcp.title,
      description: op.mcp.description,
      inputSchema: jsonSchema(op.input, "input"),
      outputSchema: jsonSchema(op.output, "output"),
      annotations: mcpAnnotations(op),
      operationId: op.id,
    }));
}
