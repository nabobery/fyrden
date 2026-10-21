import { z } from "zod";
import { answersNothing, type OperationDef, type Registry } from "./op.js";

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Absent for a tool that answers nothing (its result is a short text). */
  outputSchema?: Record<string, unknown>;
  annotations: McpAnnotations;
  /** The registry operation that serves this tool. */
  operationId: string;
}

export interface McpAnnotations {
  readOnlyHint: boolean;
  idempotentHint: boolean;
}

/**
 * Tool annotations for an operation; the MCP endpoint advertises exactly
 * these. Idempotent (MCP: calling it again with the same arguments has no
 * further effect) when it only reads, sets (PUT) or removes (DELETE); not
 * a create or an update, which REST makes safe to retry with an
 * idempotency key that an MCP call does not carry.
 */
export function mcpAnnotations(op: OperationDef): McpAnnotations {
  const readOnly = op.mcp !== false && op.mcp.readOnly;
  const derived = readOnly || op.method === "PUT" || op.method === "DELETE";
  return {
    readOnlyHint: readOnly,
    idempotentHint: (op.mcp !== false ? op.mcp.idempotent : undefined) ?? derived,
  };
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
      ...(!answersNothing(op) && { outputSchema: jsonSchema(op.output, "output") }),
      annotations: mcpAnnotations(op),
      operationId: op.id,
    }));
}
