import type { Metrics } from "./metrics.js";

/** A short name from code (a script, class or method name); anything else is recorded as `other`. */
function codeName(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "other";
}

function eventKind(event: TraceItem["event"]): { event: string; method: string } {
  if (event === null) return { event: "other", method: "" };
  if ("request" in event) return { event: "fetch", method: "" };
  if ("rpcMethod" in event) return { event: "rpc", method: codeName(event.rpcMethod) };
  if ("cron" in event) return { event: "scheduled", method: "" };
  if ("queue" in event) return { event: "queue", method: "" };
  if ("scheduledTime" in event) return { event: "alarm", method: "" };
  return { event: "other", method: "" };
}

/**
 * Writes each traced invocation's CPU and wall time (`worker.cpu_ms`,
 * `worker.wall_ms`). Workers report CPU time only to Tail handlers (the
 * `cpuTime` and `wallTime` of each trace item), not to the running code;
 * Tail Workers need a Workers Paid plan (verified:
 * https://developers.cloudflare.com/workers/observability/logs/tail-workers/).
 * Dimensions are names from code; URLs, headers and log lines are never read.
 */
export function recordTailMetrics(events: readonly TraceItem[], metrics: Metrics): void {
  for (const item of events) {
    const { event, method } = eventKind(item.event);
    const dimensions = {
      script: codeName(item.scriptName),
      entrypoint: item.entrypoint === undefined ? "" : codeName(item.entrypoint),
      event,
      method,
      outcome: codeName(item.outcome),
    };
    if (Number.isFinite(item.cpuTime)) metrics.count("worker.cpu_ms", dimensions, item.cpuTime);
    if (Number.isFinite(item.wallTime)) metrics.count("worker.wall_ms", dimensions, item.wallTime);
  }
}
