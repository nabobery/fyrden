import {
  createLogger,
  createMetrics,
  measureInvocation,
  recordTailMetrics,
  reportTailAlerts,
} from "@fyrden/adapters-cloudflare/obs";

/**
 * Tail handler for fyrden-api (its `tail_consumers` points here, Paid plans
 * only): alert lines for failed invocations, and each invocation's CPU and
 * wall time as metrics (the runtime reports CPU time only to Tail handlers).
 * One batch is one invocation, so its points stay within the per-invocation
 * budget; a large batch drops the rest and counts them.
 */
export async function tail(events: TraceItem[], env: Env): Promise<void> {
  reportTailAlerts(events, createLogger());
  const metrics = createMetrics(env.METRICS);
  await measureInvocation(metrics, { where: "worker", op: "tail" }, () =>
    recordTailMetrics(events, metrics),
  );
}
