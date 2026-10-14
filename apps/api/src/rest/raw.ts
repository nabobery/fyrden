import type { Context, Hono } from "hono";
import { repoFor } from "../git/chunked/operations.js";
import { problem } from "../http/problem.js";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";
import { hasPermission, type OpContext, OperationError, rateLimitKey } from "../ops/execute.js";
import type { RepoEntry } from "../repos/directory.js";
import { API_PREFIX, opContext } from "./mount.js";

/** Longest `ref` the routes outside the registry take (the registry's limit for refs). */
const MAX_REF_LENGTH = 1024;

type AppContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

/**
 * The checks a registry operation reading contents gets, for the routes
 * outside the registry (their answers are not JSON): the read rate limit,
 * the principal types, the `contents:read` permission and the `ref`, then
 * the repository's own authorization. A problem response, or the
 * repository and the operation context.
 */
export async function readAccess(
  c: AppContext,
  what: string,
): Promise<Response | { ctx: OpContext; repo: RepoEntry; ref: string | undefined }> {
  const ctx = opContext(c);
  const { owner, repo } = c.req.param() as { owner: string; repo: string };
  const ref = c.req.param("ref") ?? c.req.query("ref");
  if (!(await c.env.RATE_LIMIT_READ.limit({ key: rateLimitKey(ctx.auth) })).success)
    return problem(c, 429, "rate_limited", "Too many requests for this token.", {
      "Retry-After": "60",
    });
  if (ctx.auth.principalType !== "user" && ctx.auth.principalType !== "agent")
    return problem(
      c,
      403,
      "principal_type_not_allowed",
      `${ctx.auth.principalType} principals cannot ${what}.`,
    );
  if (!hasPermission("contents:read", ctx.auth))
    return problem(c, 403, "missing_permission", `${what} needs contents:read.`);
  if (ref !== undefined && (ref.length === 0 || ref.length > MAX_REF_LENGTH))
    return problem(c, 422, "invalid_input", "ref: must be 1 to 1024 characters.");
  try {
    return { ctx, repo: await repoFor(ctx, owner, repo, "contents:read"), ref };
  } catch (error) {
    if (error instanceof OperationError) return problem(c, error.status, error.code, error.message);
    throw error;
  }
}

/**
 * `GET /api/repos/{owner}/{repo}/raw/{path}?ref=`: a file's bytes at a
 * branch, tag or commit (the default branch without `ref`); the
 * `download_url` of a file in the contents API.
 */
export function mountRaw(app: Hono<{ Bindings: Env; Variables: AuthVariables }>): void {
  app.get(`${API_PREFIX}/repos/:owner/:repo/raw/:path{.+}`, requireAuth("by-method"), async (c) => {
    const access = await readAccess(c, "read files");
    if (access instanceof Response) return access;
    const { ctx, repo, ref } = access;
    ctx.metrics.count("do.request", { class: "RepoDO", method: "browseRaw" });
    const file = await c.env.REPO.getByName(repo.id).browseRaw(ref, c.req.param("path"));
    if (!file.ok) return problem(c, file.status, file.code, file.error);
    return new Response(file.value.bytes, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(file.value.bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-cache",
        ETag: `"${file.value.sha}"`,
      },
    });
  });
}
