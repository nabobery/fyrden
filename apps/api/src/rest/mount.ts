import { type OperationDef, openApiDocument, registry } from "@fyrden/api-contract";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { MAX_JSON_BODY_BYTES, readBoundedBody } from "../http/body.js";
import { problem, problemResponse } from "../http/problem.js";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";
import { executeOperation, type OpContext, type OpHandler, type OpResult } from "../ops/execute.js";
import { handlers } from "../ops/handlers.js";
import { IDEMPOTENCY_KEY } from "./idempotency.js";

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
  | { ok: false; status: 400 | 413 | 422; code: string; detail: string };

const utf8 = new TextDecoder();

/**
 * An operation's input: path parameters over the query (GET) or the JSON
 * body. An empty body is an empty object; any other body must be a JSON
 * object, so a malformed request never runs with every field defaulted.
 */
async function readInput(c: AppContext, op: OperationDef): Promise<ReadResult> {
  const params = c.req.param() as Record<string, string>;
  if (op.method === "GET") return { ok: true, input: { ...c.req.query(), ...params } };
  const raw = await readBoundedBody(c.req.raw, MAX_JSON_BODY_BYTES);
  if (!raw)
    return {
      ok: false,
      status: 413,
      code: "body_too_large",
      detail: `The request body is larger than ${MAX_JSON_BODY_BYTES} bytes.`,
    };
  const text = utf8.decode(raw);
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

function respond(c: AppContext, op: OperationDef, result: OpResult): Response {
  const replayed: Record<string, string> = result.replayed ? { "Idempotent-Replayed": "true" } : {};
  if (!result.ok) {
    const retry =
      result.problem.code === "rate_limited"
        ? { "Retry-After": "60" }
        : result.problem.code === "idempotency_key_in_use"
          ? { "Retry-After": "5" }
          : {};
    return problemResponse(c, result.problem, { ...retry, ...replayed });
  }
  return c.json(
    result.output as Record<string, unknown>,
    (result.status ?? op.successStatus ?? 200) as ContentfulStatusCode,
    replayed,
  );
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
      const key = op.idempotency === "key" ? c.req.header("Idempotency-Key") : undefined;
      if (key !== undefined && !IDEMPOTENCY_KEY.test(key))
        return problem(
          c,
          422,
          "invalid_idempotency_key",
          "An Idempotency-Key is 1-255 printable ASCII characters.",
        );
      return respond(
        c,
        op,
        await executeOperation(op, operationHandler(op), opContext(c), read.input, {
          ...(key !== undefined && { idempotencyKey: key }),
        }),
      );
    });
  }
}
