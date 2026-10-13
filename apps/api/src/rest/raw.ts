import type { Hono } from "hono";
import { repoFor } from "../git/chunked/operations.js";
import { problem } from "../http/problem.js";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";
import { hasPermission, OperationError } from "../ops/execute.js";
import { API_PREFIX, opContext } from "./mount.js";

/** Longest `ref` the raw route takes (the registry's limit for refs). */
const MAX_REF_LENGTH = 1024;

/**
 * `GET /api/repos/{owner}/{repo}/raw/{path}?ref=`: a file's bytes at a
 * branch, tag or commit (the default branch without `ref`); the
 * `download_url` of a file in the contents API. Not a registry operation
 * (its answer is not JSON), so it applies their checks itself: the read
 * rate limit, the principal types and the `contents:read` permission, then
 * the repository's own authorization.
 */
export function mountRaw(app: Hono<{ Bindings: Env; Variables: AuthVariables }>): void {
  app.get(`${API_PREFIX}/repos/:owner/:repo/raw/:path{.+}`, requireAuth("by-method"), async (c) => {
    const ctx = opContext(c);
    const { owner, repo, path } = c.req.param();
    const ref = c.req.query("ref");
    if (!(await c.env.RATE_LIMIT_READ.limit({ key: ctx.auth.id })).success)
      return problem(c, 429, "rate_limited", "Too many requests for this token.", {
        "Retry-After": "60",
      });
    if (ctx.auth.principalType !== "user" && ctx.auth.principalType !== "agent")
      return problem(
        c,
        403,
        "principal_type_not_allowed",
        `${ctx.auth.principalType} principals cannot read files.`,
      );
    if (!hasPermission("contents:read", ctx.auth))
      return problem(c, 403, "missing_permission", "Reading files needs contents:read.");
    if (ref !== undefined && (ref.length === 0 || ref.length > MAX_REF_LENGTH))
      return problem(c, 422, "invalid_input", "ref: must be 1 to 1024 characters.");
    try {
      const entry = await repoFor(ctx, owner, repo, "contents:read");
      ctx.metrics.count("do.request", { class: "RepoDO", method: "browseRaw" });
      const file = await c.env.REPO.getByName(entry.id).browseRaw(ref, path);
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
    } catch (error) {
      if (error instanceof OperationError)
        return problem(c, error.status, error.code, error.message);
      throw error;
    }
  });
}
