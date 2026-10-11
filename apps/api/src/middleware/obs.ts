import {
  createLogger,
  createMetrics,
  Invocation,
  type Logger,
  type Metrics,
} from "@fyrden/adapters-cloudflare/obs";
import { createMiddleware } from "hono/factory";

export type ObsVariables = { requestId: string; log: Logger; metrics: Metrics };

/**
 * Per-request logger and metrics. Runs after the request-id middleware; every
 * line carries the request id, and the completion line carries the matched
 * route, status and duration. The request is one invocation: the
 * subrequests it makes are counted and written when it ends, after any
 * background work that holds it open (a streamed git response).
 */
export const obs = createMiddleware<{ Bindings: Env; Variables: ObsVariables }>(async (c, next) => {
  const log = createLogger({ requestId: c.get("requestId") });
  const metrics = createMetrics(c.env.METRICS);
  c.set("log", log);
  c.set("metrics", metrics);
  const start = Date.now();
  const invocation = new Invocation(metrics, { where: "worker", op: "unmatched" });
  try {
    await invocation.run(next);
  } finally {
    const route = c.req.routePath;
    const status = c.res.status;
    // The current logger: authentication adds the principal to it.
    c.get("log").info("request", { route, method: c.req.method, status, ms: Date.now() - start });
    metrics.count("http.request", { route, method: c.req.method, status: String(status) });
    invocation.op = `${c.req.method} ${route}`;
    invocation.end();
  }
});
