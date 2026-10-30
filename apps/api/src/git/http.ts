import type { Context } from "hono";
import type { AuthVariables } from "../middleware/auth.js";
import { contentType, errPacket, type GitService, NO_CACHE_HEADERS } from "./protocol.js";

export type GitContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

/**
 * Errors go back as `text/plain`, which git prints to the user as
 * `remote: <line>` (remote-curl.c `show_http_message`).
 */
export function gitText(
  c: GitContext,
  status: 400 | 401 | 403 | 404 | 413 | 415 | 429 | 503,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return c.text(`${message}\n`, status, headers);
}

/** `owner` and `repo` from the path; `repo` may carry git's `.git` suffix. */
export function repoParams(c: GitContext): { owner: string; name: string } {
  const owner = c.req.param("owner") ?? "";
  const repo = c.req.param("repo") ?? "";
  return { owner, name: repo.endsWith(".git") ? repo.slice(0, -4) : repo };
}

/** A git protocol payload, never cached. */
export function gitPayload(bytes: Uint8Array<ArrayBuffer>, type: string): Response {
  return new Response(bytes, {
    headers: { "Content-Type": type, ...NO_CACHE_HEADERS },
  });
}

/**
 * An error a git client reports as "remote error: <message>": an `ERR`
 * packet in the service's result type, with status 200. git discards the
 * body of any response with status 300 or more (remote-curl.c `rpc_in`,
 * v2.53.0), so an error status would hide the message behind "RPC failed".
 */
export function gitError(service: GitService, message: string): Response {
  return gitPayload(errPacket(message), contentType.result(service));
}

/**
 * The body type check of `git http-backend` (http-backend.c
 * `check_content_type`): a POST must carry the service's request type.
 */
export function checkRequestType(c: GitContext, service: GitService): Response | undefined {
  const expected = contentType.request(service);
  const actual = c.req.header("Content-Type") ?? "";
  if (actual === expected) return undefined;
  return gitText(
    c,
    415,
    `Expected POST with Content-Type '${expected}', but received '${actual.slice(0, 100)}' instead.`,
    NO_CACHE_HEADERS,
  );
}
