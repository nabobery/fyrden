import { DurableObject } from "cloudflare:workers";
import { createMetrics, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { runMaintenance } from "../cron/maintenance.js";

/**
 * Runs the five-minute maintenance (`runMaintenance`) for the cron trigger,
 * which on Workers Free gets 10 ms of CPU where a Durable Object's request
 * gets 30 s. One object (`MAINTENANCE_OBJECT`), holding nothing; a run
 * asked for while one is under way joins it.
 */
export class MaintenanceDO extends DurableObject<Env> {
  #running: Promise<void> | null = null;

  run(): Promise<void> {
    if (this.#running) return this.#running;
    const metrics = createMetrics(this.env.METRICS);
    this.#running = measureInvocation(
      metrics,
      { where: "do", op: "run", doClass: "MaintenanceDO" },
      () => runMaintenance(this.env, metrics),
    ).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }
}
