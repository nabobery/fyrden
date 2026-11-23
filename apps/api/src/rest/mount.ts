import {
  answersNothing,
  IDEMPOTENCY_KEY,
  type OperationDef,
  openApiDocument,
  pagedByTotal,
  registry,
} from "@fyrden/api-contract";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status";
import { MAX_JSON_BODY_BYTES, readBoundedBody } from "../http/body.js";
import { NO_STORE, notModified } from "../http/cache.js";
import { problem, problemResponse } from "../http/problem.js";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";
import {
  executeOperation,
  type OpContext,
  type OpHandler,
  type OpResult,
  sessionRefusal,
} from "../ops/execute.js";
import { handlers } from "../ops/handlers.js";
import { pageLinks } from "./links.js";

export const API_PREFIX = "/api";
/**
 * Where stock `gh` sends REST calls for a host other than github.com, as for
 * GitHub Enterprise Server: every operation answers there too, the same way.
 */
export const API_V3_PREFIX = "/api/v3";
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
    receivedAt: c.get("receivedAt"),
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
/**
 * Path parameters every operation compares ignoring the case of ASCII
 * letters: handles (accounts, agents, owners, organizations, users),
 * repository names, Actions secret and variable names (ASCII only), and
 * label names, which keep other letters' case (`É` and `é` are two labels).
 * File paths, refs, tags, workflow files and the rest compare exactly.
 */
const CASE_INSENSITIVE_PARAMS: ReadonlySet<string> = new Set([
  "account",
  "agent",
  "owner",
  "repo",
  "org",
  "username",
  "template_owner",
  "template_repo",
  "name",
  "secret_name",
]);

const foldAscii = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

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
  // A body naming another resource than its path (GitHub's variable PATCH renames by `name`;
  // Fyrden renames nothing this way) is refused, not silently overridden by the path. A string
  // must match exactly, or ignoring ASCII case for a parameter every operation compares so; a number
  // must be the path's number; any other value is refused.
  for (const [key, value] of Object.entries(params)) {
    if (!Object.hasOwn(body, key)) continue;
    const sent = (body as Record<string, unknown>)[key];
    const same =
      typeof sent === "string"
        ? CASE_INSENSITIVE_PARAMS.has(key)
          ? foldAscii(sent) === foldAscii(value)
          : sent === value
        : typeof sent === "number" && value.trim() !== "" && Number(value) === sent;
    if (!same)
      return {
        ok: false,
        status: 422,
        code: "invalid_input",
        detail: `The body's ${key} is not the path's: it cannot be changed here.`,
      };
  }
  return { ok: true, input: { ...body, ...params } };
}

/** A strong ETag of a body: its SHA-256, the first 16 bytes in hex. */
async function etagOf(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

/**
 * An answer with an ETag of its body, or 304 when the request's
 * `If-None-Match` matches. It is the caller's own: shared caches keep
 * none, and a client revalidates before reusing it.
 */
async function respondWithEtag(c: AppContext, output: unknown, status: number): Promise<Response> {
  const body = JSON.stringify(output);
  const etag = await etagOf(body);
  const caching = { "Cache-Control": "private, no-cache" };
  return (
    notModified(c.req.raw, etag, caching) ??
    c.body(body, status as ContentfulStatusCode, {
      ...caching,
      ETag: etag,
      "Content-Type": "application/json",
    })
  );
}

function respond(c: AppContext, op: OperationDef, result: OpResult): Response | Promise<Response> {
  const headers: Record<string, string> = result.replayed ? { "Idempotent-Replayed": "true" } : {};
  if (!result.ok) {
    const retry =
      result.problem.code === "rate_limited"
        ? { "Retry-After": "60" }
        : result.problem.code === "idempotency_key_in_use"
          ? { "Retry-After": "5" }
          : {};
    return problemResponse(c, result.problem, { ...retry, ...headers });
  }
  if (op.etag) return respondWithEtag(c, result.output, result.status ?? op.successStatus ?? 200);
  // Nothing to answer: no body (a replay of it too), except a 201's `{}`, as
  // GitHub's: clients such as `gh` decode the body of every answer but a 204.
  if (answersNothing(op)) {
    const status = (result.status ?? op.successStatus ?? 204) as StatusCode;
    return status === 201 ? c.json({}, 201, headers) : c.body(null, status, headers);
  }
  // A secret (a new token) is shown once: no cache keeps it.
  return c.json(
    result.output as Record<string, unknown>,
    (result.status ?? op.successStatus ?? 200) as ContentfulStatusCode,
    op.secretResponse ? { ...NO_STORE, ...headers } : headers,
  );
}

/**
 * The `Link` header of a successful answer of an operation paged by `page`
 * and `total_count`, from the page and page size the operation read (a
 * `per_page` past a list's most is read as the most).
 */
function linkOf(
  c: AppContext,
  op: OperationDef,
  input: unknown,
  output: unknown,
): string | undefined {
  if (!pagedByTotal(op)) return undefined;
  const read = op.input.safeParse(input);
  if (!read.success) return undefined;
  const { page, per_page: perPage } = read.data as { page: number; per_page: number };
  const { total_count: total } = output as { total_count: number };
  return pageLinks(new URL(c.req.url), page, perPage, total);
}

/** Registers one Hono route per registry operation under /api. */
/**
 * The operations of a chunked upload session: git's transport, where a git
 * token is taken as git takes it (`fyrden push --chunked` sends one, and
 * cannot send DPoP proofs).
 */
const GIT_TRANSPORT = new Set([
  "uploads.create",
  "uploads.get",
  "uploads.complete",
  "uploads.abort",
]);

const gitTransport = (op: OperationDef) => ({ git: GIT_TRANSPORT.has(op.id) });

/** An operation's answers kept by no cache when it asks (`noStore`): refusals before it runs too. */
const caching =
  (op: OperationDef): MiddlewareHandler =>
  async (c, next) => {
    await next();
    if (op.noStore) c.res.headers.set("Cache-Control", "private, no-store");
  };

export function mountRest(app: Hono<{ Bindings: Env; Variables: AuthVariables }>): void {
  app.get(`${API_PREFIX}/openapi.json`, (c) =>
    c.json(
      openApiDocument(registry, {
        version: API_VERSION,
        serverUrl: new URL(API_PREFIX, c.req.url).href,
      }),
    ),
  );

  for (const op of registry as readonly OperationDef[])
    mountOperation(app, op, operationHandler(op));
}

/** Registers one operation's REST route under /api and /api/v3. */
export function mountOperation(
  app: Hono<{ Bindings: Env; Variables: AuthVariables }>,
  op: OperationDef,
  handler: OpHandler<OperationDef>,
): void {
  const path = op.path.replace(/\{([a-z_]+)\+\}/g, ":$1{.+}").replace(/\{([a-z_]+)\}/g, ":$1");
  app.on(
    op.method,
    [API_PREFIX + path, API_V3_PREFIX + path],
    caching(op),
    requireAuth("by-method", "api", gitTransport(op)),
    async (c) => {
      // Before the body or its key are looked at (as the executor would, after them).
      const refused = sessionRefusal(op, c.get("auth"));
      if (refused) return problem(c, 403, refused.code, refused.detail);
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
      const result = await executeOperation(op, handler, opContext(c), read.input, {
        ...(key !== undefined && { idempotencyKey: key }),
      });
      const res = await respond(c, op, result);
      const link = result.ok ? linkOf(c, op, read.input, result.output) : undefined;
      if (link !== undefined) res.headers.set("Link", link);
      return res;
    },
  );
}
