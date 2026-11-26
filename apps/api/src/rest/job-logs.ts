import { makeProblem } from "@fyrden/api-contract";
import type { Hono, MiddlewareHandler } from "hono";
import { LOG_PAGE_POLICY, type LogPageRow } from "../do/run/log-pages.js";
import { repoFor } from "../git/chunked/operations.js";
import { problem, problemResponse } from "../http/problem.js";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";
import { hasPermission, OperationError, rateLimitKey } from "../ops/execute.js";
import { jobLogPage, logCursor, logPosition } from "../repos/run-logs.js";
import { API_PREFIX, API_V3_PREFIX, opContext } from "./mount.js";

const PATH = "/repos/:owner/:repo/actions/runs/:run_id/jobs/:job_id/logs";
const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const JOB_ID = /^[1-9][0-9]{0,9}$/;
const MAX_JOB_ID = 2 ** 31 - 1;
const COUNT = /^(0|[1-9][0-9]{0,9})$/;

/** Before authentication, so its refusals are not cached either. */
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "private, no-store");
};

/**
 * `GET /api/repos/{owner}/{repo}/actions/runs/{run_id}/jobs/{job_id}/logs`
 * (and under `/api/v3`): a page of a job's log as plain text, each row a
 * line after its time as GitHub writes it, with `Link: rel="next"` while
 * more is stored, so a client that follows it gets the whole log. The same
 * page, bounds and access as `actions.runs.jobs.logs.read`; outside the
 * registry because its answer is not JSON.
 */
export function mountJobLogs(app: Hono<{ Bindings: Env; Variables: AuthVariables }>): void {
  app.on(
    "GET",
    [API_PREFIX + PATH, API_V3_PREFIX + PATH],
    noStore,
    requireAuth("by-method"),
    async (c) => {
      const ctx = opContext(c);
      if (!(await c.env.RATE_LIMIT_WRITE.limit({ key: rateLimitKey(ctx.auth) })).success)
        return problem(c, 429, "rate_limited", "Too many requests for this token.", {
          "Retry-After": "60",
        });
      if (ctx.auth.principalType !== "user" && ctx.auth.principalType !== "agent")
        return problem(
          c,
          403,
          "principal_type_not_allowed",
          `${ctx.auth.principalType} principals cannot read job logs.`,
        );
      if (!hasPermission("actions:read", ctx.auth))
        return problem(c, 403, "missing_permission", "read job logs needs actions:read.");
      const {
        owner,
        repo,
        run_id: runId,
        job_id: jobId,
      } = c.req.param() as Record<"owner" | "repo" | "run_id" | "job_id", string>;
      if (!RUN_ID.test(runId)) return problem(c, 422, "invalid_input", "run_id: a run id.");
      if (!JOB_ID.test(jobId) || Number(jobId) > MAX_JOB_ID)
        return problem(c, 422, "invalid_input", "job_id: a job's id within its run.");
      const [from, tail] = (["from", "tail"] as const).map((name) => c.req.query(name));
      const given = [from, tail, c.req.query("cursor")].filter((q) => q !== undefined);
      if (given.length > 1)
        return problem(c, 422, "invalid_input", "Give at most one of `from`, `tail` and `cursor`.");
      if (from !== undefined && !(COUNT.test(from) && Number(from) <= MAX_JOB_ID))
        return problem(c, 422, "invalid_input", "from: a row index.");
      if (
        tail !== undefined &&
        !(COUNT.test(tail) && Number(tail) >= 1 && Number(tail) <= LOG_PAGE_POLICY.maxTail)
      )
        return problem(c, 422, "invalid_input", "tail: 1 to 10000 rows.");
      try {
        const cursor = logPosition(runId, Number(jobId), c.req.query("cursor"));
        const entry = await repoFor(ctx, owner, repo, "actions:read");
        const page = await jobLogPage(ctx, entry, runId, Number(jobId), {
          ...(cursor && { cursor }),
          ...(from !== undefined && { from: Number(from) }),
          ...(tail !== undefined && { tail: Number(tail) }),
          maxBytes: LOG_PAGE_POLICY.maxRowBytes,
        });
        if (page.state === "none")
          return problem(c, 404, "log_not_found", "The job has no log: it got no runner.");
        const headers = new Headers({
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          // Log text is whatever the workflow printed.
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "X-Fyrden-Log-State": page.state,
        });
        const stored = page.next && (page.next.row < page.end || page.next.offset > 0);
        if (page.next && stored) {
          const url = new URL(c.req.url);
          const path = `${ctx.requestOrigin}${url.pathname}`;
          headers.set(
            "Link",
            `<${path}?cursor=${logCursor(runId, Number(jobId), page.next)}>; rel="next"`,
          );
        }
        return new Response(page.rows.map(textOf).join(""), { headers });
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        const { status, code, message, retryAfter, retryAt } = error;
        return problemResponse(
          c,
          makeProblem({
            status,
            code,
            detail: message,
            requestId: ctx.requestId,
            ...(retryAfter !== undefined && { retryAfter }),
            ...(retryAt !== undefined && { retryAt }),
          }),
        );
      }
    },
  );
}

function textOf(row: LogPageRow): string {
  if ("omitted" in row) return `[row omitted: ${row.bytes} bytes]\n`;
  const starts = !("o" in row) || row.o === 0;
  const ends = !("end" in row) || row.end;
  return `${starts ? stamp(row.t) : ""}${row.c}${ends ? "\n" : ""}`;
}

function stamp(t: number | null): string {
  if (t === null) return "";
  const date = new Date(t);
  return Number.isNaN(date.getTime()) ? "" : `${date.toISOString()} `;
}
