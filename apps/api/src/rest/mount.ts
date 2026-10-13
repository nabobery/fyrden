import { type OperationDef, openApiDocument, registry } from "@fyrden/api-contract";
import type { Context, Hono } from "hono";
import { problem, problemResponse } from "../http/problem.js";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";
import { executeOperation, type OpContext, type OpHandler } from "../ops/execute.js";
import { handlers } from "../ops/handlers.js";

export const API_PREFIX = "/api";
export const API_VERSION = "0.0.0";

type AppContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

export function opContext(c: AppContext): OpContext {
  return {
    env: c.env,
    auth: c.get("auth"),
    authState: c.get("authState"),
    log: c.get("log"),
    metrics: c.get("metrics"),
    requestId: c.get("requestId"),
    requestHost: new URL(c.req.url).hostname,
    requestOrigin: new URL(c.req.url).origin,
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  };
}

export function operationHandler(op: OperationDef): OpHandler<OperationDef> {
  return handlers[op.id as keyof typeof handlers] as unknown as OpHandler<OperationDef>;
}

type ReadResult =
  | { ok: true; input: unknown }
  | { ok: false; status: 400 | 422; code: string; detail: string };

/**
 * An operation's input: path parameters over the query (GET) or the JSON
 * body. An empty body is an empty object; any other body must be a JSON
 * object, so a malformed request never runs with every field defaulted.
 */
async function readInput(c: AppContext, op: OperationDef): Promise<ReadResult> {
  const params = c.req.param() as Record<string, string>;
  if (op.method === "GET") return { ok: true, input: { ...c.req.query(), ...params } };
  const text = await c.req.text();
  if (text.trim() === "") return { ok: true, input: { ...params } };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      status: 400,
      code: "invalid_json",
      detail: "The request body is not valid JSON.",
    };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_input",
      detail: "The request body must be a JSON object.",
    };
  }
  return { ok: true, input: { ...body, ...params } };
}

/** Registers one Hono route per registry operation under /api. */
export function mountRest(app: Hono<{ Bindings: Env; Variables: AuthVariables }>): void {
  app.get(`${API_PREFIX}/openapi.json`, (c) =>
    c.json(
      openApiDocument(registry, {
        version: API_VERSION,
        serverUrl: new URL(API_PREFIX, c.req.url).href,
      }),
    ),
  );

  for (const op of registry as readonly OperationDef[]) {
    const path =
      API_PREFIX + op.path.replace(/\{([a-z_]+)\+\}/g, ":$1{.+}").replace(/\{([a-z_]+)\}/g, ":$1");
    app.on(op.method, path, requireAuth("by-method"), async (c) => {
      const read = await readInput(c, op);
      if (!read.ok) return problem(c, read.status, read.code, read.detail);
      const result = await executeOperation(op, operationHandler(op), opContext(c), read.input);
      if (!result.ok) {
        const retry = result.problem.code === "rate_limited" ? { "Retry-After": "60" } : {};
        return problemResponse(c, result.problem, retry);
      }
      return c.json(result.output as Record<string, unknown>, op.successStatus ?? 200);
    });
  }
}
