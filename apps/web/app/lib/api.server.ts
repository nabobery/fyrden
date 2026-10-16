import { data, type RouterContextProvider, redirect } from "react-router";
import { cloudflareContext } from "./cloudflare.server.js";

/**
 * fyrden-api's REST API as the web UI's server calls it: through the
 * service binding, as the signed-in user (the browser's session cookie,
 * with the header that marks a session credential; no cross-site page can
 * send that header).
 */

export interface ApiResult<T> {
  readonly status: number;
  readonly body: T;
}

export interface Problem {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;
}

function binding(context: Readonly<RouterContextProvider>): Fetcher {
  return context.get(cloudflareContext).env.API as unknown as Fetcher;
}

/** The headers every call carries: the session, and the client's address (for rate limits). */
function forwarded(request: Request): Headers {
  const headers = new Headers({ "X-Fyrden-Session": "1", Accept: "application/json" });
  const cookie = request.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);
  const client = request.headers.get("CF-Connecting-IP");
  if (client) headers.set("CF-Connecting-IP", client);
  return headers;
}

/**
 * A download from the API (raw file bytes, an archive) as the browser gets
 * it: the API's own headers (its type, `nosniff`, a sandboxing CSP, the
 * attachment name) and status, streamed.
 */
export async function apiDownload(
  context: Readonly<RouterContextProvider>,
  request: Request,
  path: string,
): Promise<Response> {
  const res = await binding(context).fetch(
    new Request(`${new URL(request.url).origin}/api${path}`, { headers: forwarded(request) }),
  );
  const headers = new Headers();
  for (const name of [
    "Content-Type",
    "Content-Length",
    "Content-Disposition",
    "X-Content-Type-Options",
    "Content-Security-Policy",
    "ETag",
    "Retry-After",
  ]) {
    const value = res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("Cache-Control", "private, no-store");
  return new Response(res.ok ? res.body : null, { status: res.status, headers });
}

/**
 * The largest JSON request body fyrden-api reads (its `MAX_JSON_BODY_BYTES`,
 * apps/api/src/http/body.ts; a test checks the two agree): a larger one is
 * refused before it is parsed, so a page measures what it sends first.
 */
export const API_MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

/** Calls `method path` (under `/api`) with an optional JSON body. */
export async function apiCall<T>(
  context: Readonly<RouterContextProvider>,
  request: Request,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  return apiCallJson<T>(
    context,
    request,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
  );
}

/** `apiCall` with its body already serialized (to measure it before sending). */
export async function apiCallJson<T>(
  context: Readonly<RouterContextProvider>,
  request: Request,
  method: string,
  path: string,
  json?: string,
): Promise<ApiResult<T>> {
  const headers = forwarded(request);
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", crypto.randomUUID());
  }
  const res = await binding(context).fetch(
    new Request(`${new URL(request.url).origin}/api${path}`, {
      method,
      headers,
      ...(json !== undefined && { body: json }),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/**
 * A GET that must succeed: its body; signed out, a redirect to sign in;
 * else the page answers its status (404 for missing or hidden).
 */
export async function apiGet<T>(
  context: Readonly<RouterContextProvider>,
  request: Request,
  path: string,
): Promise<T> {
  return bodyOf(await apiCall<T>(context, request, "GET", path), request);
}

/** A call's body when it succeeded; signed out, a redirect to sign in; else its status. */
export function bodyOf<T>(result: ApiResult<T>, request: Request): T {
  // Signed out: sign in, then come back.
  if (result.status === 401) throw redirect(signInUrl(request));
  if (result.status >= 400) {
    const problem = result.body as unknown as Problem | null;
    throw data(problem?.detail ?? "Not found", { status: result.status });
  }
  return result.body;
}

export interface SessionUser {
  readonly id: string;
  readonly handle: string;
}

/** The signed-in user, if any. */
export async function signedInUser(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<SessionUser | null> {
  const headers = new Headers();
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  headers.set("Cookie", cookie);
  const res = await binding(context).fetch(
    new Request(`${new URL(request.url).origin}/auth/session`, { headers }),
  );
  if (!res.ok) return null;
  return ((await res.json()) as { user: SessionUser }).user;
}

/**
 * Refuses a form post that did not come from this origin's own pages: the
 * session cookie rides along on a cross-site form (SameSite=Lax lets a
 * top-level POST through on some browsers), the server then adds the
 * session header itself.
 */
export function assertSameOrigin(request: Request): void {
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    throw data("This form did not come from Fyrden's own page.", { status: 403 });
}

/** Bytes of a form post read at most, unless a page allows more. */
export const FORM_MAX_BYTES = 64 * 1024;

/**
 * A form post's fields, read up to `maxBytes` (counted as the bytes arrive:
 * a body may say any Content-Length, or none); a longer one answers 413.
 */
export async function readForm(request: Request, maxBytes = FORM_MAX_BYTES): Promise<FormData> {
  const tooLarge = () => data("This form is too large.", { status: 413 });
  if (Number(request.headers.get("Content-Length")) > maxBytes) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  for (;;) {
    const next = await reader?.read();
    if (!next || next.done) break;
    size += next.value.length;
    if (size > maxBytes) {
      await reader?.cancel();
      throw tooLarge();
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  const type = request.headers.get("Content-Type") ?? "application/x-www-form-urlencoded";
  return new Response(body, { headers: { "Content-Type": type } }).formData();
}

/** Where to sign in and come back to `request`'s page. */
export function signInUrl(request: Request): string {
  const url = new URL(request.url);
  return `/auth/sign-in?return_to=${encodeURIComponent(url.pathname + url.search)}`;
}
