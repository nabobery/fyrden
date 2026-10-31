import {
  answersNothing,
  makeProblem,
  mcpAnnotations,
  type OperationDef,
  registry,
} from "@fyrden/api-contract";
import {
  type AuthInfo,
  type CallToolResult,
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  ProtocolError,
  type ReadResourceResult,
  ResourceNotFoundError,
  ResourceTemplate,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { Context, Hono } from "hono";
import { LIVE_POLICY } from "../do/user/live.js";
import { MAX_JSON_BODY_BYTES, readBoundedBody } from "../http/body.js";
import { NO_STORE } from "../http/cache.js";
import { problem } from "../http/problem.js";
import { liveCredential } from "../live/credential.js";
import { liveAllowance } from "../live/directory.js";
import { openLiveSocket } from "../live/routes.js";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";
import { executeOperation, type OpContext, rateLimitKey } from "../ops/execute.js";
import { API_VERSION, opContext, operationHandler } from "../rest/mount.js";
import { clock, newId } from "../services.js";
import {
  FEED_RESOURCE_TEMPLATE,
  feedResourceUri,
  LISTEN_POLICY,
  type ListenId,
  ListenStream,
  listenRequest,
} from "./listen.js";

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
  // An operation that answers nothing: a short text, no structured content (it has no schema).
  if (result.output === null) return { content: [{ type: "text", text: "Done." }] };
  const output = result.output as Record<string, unknown>;
  return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
}

/** A repository file's resource URI: its default branch's version. */
export const FILE_RESOURCE_TEMPLATE = "fyrden://repos/{owner}/{repo}/files/{+path}";
/** The same at a branch, tag or commit (one segment: a branch's slashes encoded as %2F). */
export const FILE_AT_REF_RESOURCE_TEMPLATE =
  "fyrden://repos/{owner}/{repo}/refs/{ref}/files/{+path}";

const getContentsOp = (registry as readonly OperationDef[]).find(
  (op) => op.id === "repos.contents.get",
);

/** The bytes as text, when they are UTF-8 without NUL bytes (as git counts text). */
function asText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Reads a repository file as a resource through the `repos.contents.get`
 * operation, so it is authorized exactly as the tool and REST are: text
 * for UTF-8 files, a blob otherwise, a directory's entries as JSON.
 */
async function readFileResource(
  ctx: OpContext,
  uri: URL,
  variables: Record<string, string | string[]>,
): Promise<ReadResourceResult> {
  const one = (name: string) => {
    const value = variables[name];
    return Array.isArray(value) ? value.join("/") : (value ?? "");
  };
  if (!getContentsOp) throw new Error("repos.contents.get is not registered");
  const result = await executeOperation(getContentsOp, operationHandler(getContentsOp), ctx, {
    owner: one("owner"),
    repo: one("repo"),
    path: decodeURIComponent(one("path")),
    // A branch, tag or commit; the default branch without one.
    ...(one("ref") && { ref: decodeURIComponent(one("ref")) }),
  });
  if (!result.ok) {
    // Missing and not visible look the same, as over REST.
    if (result.problem.status === 404) throw new ResourceNotFoundError(uri.href);
    throw new ProtocolError(-32603, result.problem.detail ?? "The resource could not be read.");
  }
  const contents = result.output as
    | { type: "file"; encoding: "base64" | "none"; content: string; download_url: string }
    | { type: "dir"; entries: unknown[]; next_cursor: string | null }
    | { type: string };
  if (contents.type === "dir")
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(contents),
        },
      ],
    };
  if (contents.type === "file" && "encoding" in contents) {
    if (contents.encoding === "none")
      throw new ProtocolError(
        -32603,
        `The file is too large for a resource; read it at ${contents.download_url}.`,
      );
    const bytes = Uint8Array.from(atob(contents.content), (ch) => ch.charCodeAt(0));
    const text = asText(bytes);
    return {
      contents: [
        text === undefined
          ? { uri: uri.href, mimeType: "application/octet-stream", blob: contents.content }
          : { uri: uri.href, mimeType: "text/plain", text },
      ],
    };
  }
  return {
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(contents) }],
  };
}

/**
 * Reads a file resource. As with tools, the SDK would answer an unexpected
 * exception with its raw message, so only deliberate protocol errors pass
 * through; anything else is logged through the redacting logger and
 * answered generically.
 */
async function readResource(
  read: typeof readFileResource,
  operation: string,
  ctx: OpContext,
  uri: URL,
  variables: Record<string, string | string[]>,
): Promise<ReadResourceResult> {
  try {
    return await read(ctx, uri, variables);
  } catch (error) {
    if (error instanceof ProtocolError || error instanceof ResourceNotFoundError) throw error;
    ctx.log.error("unhandled error", { error, operation });
    throw new ProtocolError(-32603, "An unexpected error occurred.");
  }
}

const syncFeedOp = (registry as readonly OperationDef[]).find((op) => op.id === "feed.sync");

/**
 * Reads the caller's feed resource: a sync of it (`feed.sync`, authorized
 * as the tool is). Another principal's feed is not found, as a missing one.
 */
async function readFeedResource(
  ctx: OpContext,
  uri: URL,
  variables: Record<string, string | string[]>,
): Promise<ReadResourceResult> {
  if (
    variables.principal !== ctx.auth.principalId ||
    uri.href !== feedResourceUri(ctx.auth.principalId)
  )
    throw new ResourceNotFoundError(uri.href);
  if (!syncFeedOp) throw new Error("feed.sync is not registered");
  const result = await executeOperation(syncFeedOp, operationHandler(syncFeedOp), ctx, {});
  if (!result.ok)
    throw new ProtocolError(-32603, result.problem.detail ?? "The feed could not be read.");
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json", text: JSON.stringify(result.output) },
    ],
  };
}

type JsonSchemaOf = StandardSchemaWithJSON["~standard"]["jsonSchema"]["input"];

const convertedOnce = new WeakMap<StandardSchemaWithJSON, StandardSchemaWithJSON>();

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * `schema` with its JSON Schema converted once per isolate. The SDK converts
 * every tool's schemas again for each request (one server per request), which
 * made `tools/list` cost 50-160 ms of CPU on Workers; validation is still
 * the schema's own. The shared result is frozen: nothing may change it.
 */
export function withConvertedJsonSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const known = convertedOnce.get(schema);
  if (known) return known;
  const standard = schema["~standard"];
  const once = (convert: JsonSchemaOf): JsonSchemaOf => {
    const results = new Map<string, ReturnType<JsonSchemaOf>>();
    return (options) => {
      const key = JSON.stringify(options);
      let result = results.get(key);
      if (!result) {
        result = deepFreeze(convert(options));
        results.set(key, result);
      }
      return result;
    };
  };
  const wrapped: StandardSchemaWithJSON = {
    "~standard": {
      ...standard,
      jsonSchema: {
        input: once(standard.jsonSchema.input),
        output: once(standard.jsonSchema.output),
      },
    },
  };
  convertedOnce.set(schema, wrapped);
  return wrapped;
}

/**
 * One MCP server per request (stateless Streamable HTTP), with a tool per
 * registry operation. Resources are subscribed to only on 2026-07-28 (its
 * `subscriptions/listen`; the 2025 revisions' subscriptions need a session)
 * and while the deployment sends live hints.
 */
function buildServer(ctx: OpContext, era: "modern" | "legacy"): McpServer {
  // The tools and resources are the registry's: they never change while a client is connected.
  const subscribe = era === "modern" && liveAllowance(ctx.env) !== null;
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, ...(subscribe && { subscribe: true }) },
    },
  });
  // Repository files as resources (not enumerable: a client names the file it wants).
  server.registerResource(
    "repository-file",
    new ResourceTemplate(FILE_RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: "Repository file",
      description:
        "A file (or a directory's entries) on a repository's default branch: fyrden://repos/{owner}/{repo}/files/{path}.",
    },
    (uri, variables) => readResource(readFileResource, "repos.contents.get", ctx, uri, variables),
  );
  server.registerResource(
    "repository-file-at-ref",
    new ResourceTemplate(FILE_AT_REF_RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: "Repository file at a ref",
      description:
        "A file (or a directory's entries) at a branch, tag or commit: fyrden://repos/{owner}/{repo}/refs/{ref}/files/{path} (a branch's slashes as %2F; a commit's never changes).",
    },
    (uri, variables) => readResource(readFileResource, "repos.contents.get", ctx, uri, variables),
  );
  // The caller's feed: listed (it is the caller's only one), read as a sync, and subscribed to
  // through `subscriptions/listen` where the deployment sends live hints.
  server.registerResource(
    "feed",
    new ResourceTemplate(FEED_RESOURCE_TEMPLATE, {
      list: async () => ({
        resources: [{ uri: feedResourceUri(ctx.auth.principalId), name: "Activity feed" }],
      }),
    }),
    {
      title: "Activity feed",
      description:
        "Your activity feed (fyrden://feed/{your principal id}), read as sync_feed answers. Listen to it with subscriptions/listen: subscribe first, then read it, and read it again (or get_feed with the cursor) on each notifications/resources/updated.",
      mimeType: "application/json",
    },
    (uri, variables) => readResource(readFeedResource, "feed.sync", ctx, uri, variables),
  );
  for (const op of registry as readonly OperationDef[]) {
    if (!op.mcp) continue;
    server.registerTool(
      op.mcp.tool,
      {
        title: op.mcp.title,
        description: op.mcp.description,
        inputSchema: withConvertedJsonSchema(op.input),
        ...(!answersNothing(op) && { outputSchema: withConvertedJsonSchema(op.output) }),
        annotations: mcpAnnotations(op),
      },
      (args: unknown) => runTool(op, ctx, args),
    );
  }
  return server;
}

function parseJson(body: Uint8Array | ArrayBuffer | string): unknown {
  try {
    return JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

/** The server's identity, as the SDK names it on results. */
const SERVER_INFO = { name: "fyrden", version: API_VERSION } as const;

/** A server with only what a listen request's validation reads: its capabilities. */
const listenServer = () =>
  new McpServer(SERVER_INFO, { capabilities: { resources: { subscribe: true } } });

/** A listen refusal: a JSON-RPC error, its code the HTTP status, its data the problem. */
function listenRefusal(
  ctx: OpContext,
  id: ListenId,
  status: 400 | 401 | 403 | 409 | 429 | 503,
  code: string,
  detail: string,
  retryAfter?: number,
): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: {
      code: status,
      message: detail,
      data: makeProblem({
        status,
        code,
        detail,
        requestId: ctx.requestId,
        ...(retryAfter !== undefined && { retryAfter }),
      }),
    },
  });
}

const eventStream = (body: ReadableStream<Uint8Array>) =>
  new Response(body, {
    headers: { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" },
  });

/**
 * Serves a `subscriptions/listen` request (see `listen.ts`). A 2025-era one
 * is the SDK's to answer (those revisions have no listen). Otherwise the
 * SDK validates it as it would serve it (envelope, headers, filter); only a
 * request it would serve as a stream goes on, its own stream let go unread.
 * The caller's own feed URI is served while live hints are on, by a live
 * socket opened before the acknowledgement; anything else asked for is
 * left out of the acknowledgement.
 */
async function serveListen(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  ctx: OpContext,
  request: Request,
  parsed: unknown,
  authInfo: AuthInfo,
): Promise<Response> {
  const options = { maxRequestBodySize: MAX_JSON_BODY_BYTES };
  if (await isLegacyRequest(request, parsed))
    return createMcpHandler(({ era }) => buildServer(ctx, era), options).fetch(request, {
      authInfo,
      parsedBody: parsed,
    });
  const probe = await createMcpHandler(listenServer, { ...options, keepAliveMs: 0 }).fetch(
    request,
    { authInfo, parsedBody: parsed },
  );
  if (!probe.headers.get("Content-Type")?.includes("text/event-stream")) return probe;
  await probe.body?.cancel();
  const listen = listenRequest(parsed);
  if (!listen) throw new Error("a served listen request without its id");
  if (new TextEncoder().encode(JSON.stringify(listen.id)).length > LISTEN_POLICY.idBytes)
    return listenRefusal(
      ctx,
      listen.id,
      400,
      "listen_id_too_long",
      `A listen request's id is at most ${LISTEN_POLICY.idBytes} bytes of JSON.`,
    );
  const own = feedResourceUri(ctx.auth.principalId);
  if (!listen.uris.includes(own) || liveAllowance(c.env) === null)
    return eventStream(new ListenStream({ id: listen.id, serverInfo: SERVER_INFO }).readable);
  // Limited by token (or its source), as a write is, before any primary lookup.
  if (!(await c.env.RATE_LIMIT_WRITE.limit({ key: rateLimitKey(ctx.auth) })).success)
    return listenRefusal(ctx, listen.id, 429, "rate_limited", "Too many requests for this token.");
  if (ctx.auth.grantId !== null)
    return listenRefusal(
      ctx,
      listen.id,
      403,
      "delegated_listing",
      "Listen with the user's own credentials.",
    );
  const now = clock();
  const credential = await liveCredential(c.env.DIRECTORY, ctx.auth.id, now);
  if (!credential)
    return listenRefusal(
      ctx,
      listen.id,
      401,
      "invalid_token",
      "This credential cannot hold a live socket.",
    );
  const opened = await openLiveSocket(c.env, credential, `listen:${newId("lsk")}`, ctx.metrics);
  const socket = opened.ok ? (opened.response.webSocket as WebSocket) : null;
  // The client left while the socket was opened: it goes at once.
  if (socket && request.signal.aborted) {
    socket.accept();
    socket.close(1000, "done");
    return new Response(null, { status: 499 });
  }
  if (!opened.ok)
    return listenRefusal(
      ctx,
      listen.id,
      opened.status,
      opened.code,
      opened.message,
      opened.headers["Retry-After"] ? Number(opened.headers["Retry-After"]) : undefined,
    );
  if (!socket) throw new Error("an opened live socket without its WebSocket");
  socket.accept();
  const stream = new ListenStream({
    id: listen.id,
    serverInfo: SERVER_INFO,
    feed: {
      uri: own,
      socket,
      deadline: Math.min(now + LIVE_POLICY.renewMs, credential.expiresAt),
    },
    signal: request.signal,
  });
  return eventStream(stream.readable);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A Fyrden Worker's workers.dev name; the group is the account's subdomain. */
const WORKERS_DEV = /^fyrden-(?:api|web)\.([a-z0-9-]+)\.workers\.dev$/;

/**
 * Whether a request's `Origin` (a browser's) may reach the MCP server: none
 * (a native client), a loopback one, a host `FYRDEN_OWN_HOSTS` lists (the
 * deployment's custom domains), or this deployment's own Workers on
 * workers.dev: the same account subdomain as the request's host. That host
 * is trustworthy only there, because Cloudflare routes a workers.dev name
 * to its own account's Worker alone; elsewhere a DNS-rebinding page names
 * itself in both `Host` and `Origin` (the MCP spec asks servers to check
 * `Origin`).
 */
export function mcpOriginAllowed(
  env: object,
  origin: string | undefined,
  requestHost: string,
): boolean {
  if (origin === undefined) return true;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (LOOPBACK.has(host)) return true;
  const account = WORKERS_DEV.exec(requestHost.toLowerCase())?.[1];
  if (account !== undefined && WORKERS_DEV.exec(host)?.[1] === account) return true;
  const listed = (env as { FYRDEN_OWN_HOSTS?: unknown }).FYRDEN_OWN_HOSTS;
  return (
    typeof listed === "string" &&
    listed
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .includes(host)
  );
}

/**
 * MCP over Streamable HTTP at /mcp. Authentication runs first, in the same
 * middleware as REST; a 401 points clients at the resource's metadata
 * (RFC 9728), and an access token issued for another resource is refused.
 */
export function mountMcp(app: Hono<{ Bindings: Env; Variables: AuthVariables }>): void {
  // Read-mode verification: tools/list and read tools use the isolate cache;
  // the executor re-verifies on the D1 primary before any write tool runs.
  // A browser's request from another site (DNS rebinding) is refused before anything else.
  app.all(MCP_PATH, async (c, next) => {
    if (!mcpOriginAllowed(c.env, c.req.header("Origin"), new URL(c.req.url).hostname))
      return problem(c, 403, "origin_not_allowed", "Requests from this origin are not accepted.");
    await next();
  });
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
    // The token id, not the token: the SDK never needs the secret.
    const authInfo = {
      token: auth.id,
      clientId: auth.principalId,
      scopes: auth.scopes,
      expiresAt: Math.floor(auth.expiresAt / 1000),
    };
    const parsed = c.req.method === "POST" ? parseJson(body) : undefined;
    const answer = listenRequest(parsed)
      ? await serveListen(c, ctx, request, parsed, authInfo)
      : await createMcpHandler(({ era }) => buildServer(ctx, era), {
          maxRequestBodySize: MAX_JSON_BODY_BYTES,
        }).fetch(request, { authInfo });
    // Any answer may hold a secret (a git token) or private content: no cache keeps one.
    const response = new Response(answer.body, answer);
    for (const [name, value] of Object.entries(NO_STORE)) response.headers.set(name, value);
    return response;
  });
}
