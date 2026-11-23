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
 * a create or an update, which is safe to retry only with the same
 * `idempotency_key` (`mcpInput`), and a call need not carry one.
 */
export function mcpAnnotations(op: OperationDef): McpAnnotations {
  const readOnly = op.mcp !== false && op.mcp.readOnly;
  const derived = readOnly || op.method === "PUT" || op.method === "DELETE";
  return {
    readOnlyHint: readOnly,
    idempotentHint: (op.mcp !== false ? op.mcp.idempotent : undefined) ?? derived,
  };
}

/** What an idempotency key may be, as a REST header or an MCP argument: 1-255 visible ASCII characters, no spaces (`!` to `~`). */
export const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

/** The MCP argument that carries a keyed operation's idempotency key (REST: `Idempotency-Key`). */
export const MCP_IDEMPOTENCY_KEY = "idempotency_key";

const keyedInputs = new WeakMap<OperationDef, z.ZodType>();

/**
 * A tool's input: the operation's, and for an operation that takes an
 * idempotency key, an optional `idempotency_key` too. The same object for
 * the same operation every time (the MCP endpoint converts each schema to
 * JSON Schema once, by identity).
 */
export function mcpInput(op: OperationDef): z.ZodType {
  if (op.idempotency !== "key") return op.input;
  let input = keyedInputs.get(op);
  if (!input) {
    if (!(op.input instanceof z.ZodObject) || MCP_IDEMPOTENCY_KEY in op.input.shape)
      throw new Error(
        `${op.id}: a keyed tool's input must be an object without ${MCP_IDEMPOTENCY_KEY}`,
      );
    input = op.input.extend({
      [MCP_IDEMPOTENCY_KEY]: z
        .string()
        .regex(IDEMPOTENCY_KEY)
        .optional()
        .describe(
          "Makes the call safe to retry: calls by the same token with the same key and arguments run once, within 24 hours, and a retry gets the first answer (as REST's Idempotency-Key). 1-255 visible ASCII characters with no spaces, such as a UUID.",
        ),
    });
    keyedInputs.set(op, input);
  }
  return input;
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
      inputSchema: jsonSchema(mcpInput(op), "input"),
      ...(!answersNothing(op) && { outputSchema: jsonSchema(op.output, "output") }),
      annotations: mcpAnnotations(op),
      operationId: op.id,
    }));
}
