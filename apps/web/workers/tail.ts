import { createLogger, reportTailAlerts } from "@fyrden/adapters-cloudflare/obs";

/** Tail handler for fyrden-api (its `tail_consumers` points here, Paid plans only). */
export function tail(events: TraceItem[]): void {
  reportTailAlerts(events, createLogger());
}
