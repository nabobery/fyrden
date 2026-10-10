import type { Logger } from "./logger.js";

const ALERT_OUTCOMES = new Set(["exception", "exceededCpu", "exceededMemory", "canceled"]);

/**
 * Turns failed invocations seen by a Tail handler into structured `alert`
 * lines that Workers Logs alerting can match on. Written through the
 * redacting logger: exception names are arbitrary strings too. Alert metrics
 * and thresholds are not built yet.
 */
export function reportTailAlerts(events: readonly TraceItem[], log: Logger): void {
  for (const event of events) {
    if (!ALERT_OUTCOMES.has(event.outcome) && event.exceptions.length === 0) continue;
    log.warn("alert", {
      alert: event.outcome === "exceededCpu" ? "cpu_limit" : "worker_error",
      script: event.scriptName,
      outcome: event.outcome,
      // Exception names only: messages can carry user data.
      exceptions: event.exceptions.map((e) => e.name),
    });
  }
}
