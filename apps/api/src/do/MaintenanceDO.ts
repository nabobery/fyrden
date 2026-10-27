import { DurableObject } from "cloudflare:workers";
import { createMetrics, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { runMaintenance } from "../cron/maintenance.js";
import { recheckSuppressions } from "../email/suppressions.js";
import { runSearchRepairs } from "../search/repairs.js";

/**
 * Runs the five-minute maintenance (`runMaintenance`) for the cron trigger,
 * which on Workers Free gets 10 ms of CPU where a Durable Object's request
 * gets 30 s. One object (`MAINTENANCE_OBJECT`), holding nothing; a run
 * asked for while one is under way joins it.
 */
export class MaintenanceDO extends DurableObject<Env> {
  #running: Promise<void> | null = null;
  #repairing: Promise<void> | null = null;
  #rechecking: Promise<void> | null = null;

  /**
   * Reconciles the search projections that need it (`runSearchRepairs`), in
   * a request of its own: its D1 calls have an invocation of their own.
   */
  repairSearch(): Promise<void> {
    if (this.#repairing) return this.#repairing;
    const metrics = createMetrics(this.env.METRICS);
    this.#repairing = measureInvocation(
      metrics,
      { where: "do", op: "repairSearch", doClass: "MaintenanceDO" },
      () => runSearchRepairs(this.env, { metrics }).then(() => {}),
    ).finally(() => {
      this.#repairing = null;
    });
    return this.#repairing;
  }

  /**
   * Rechecks the email provider's suppressions that are due
   * (`recheckSuppressions`), in a request of its own: its lookups are
   * external subrequests of an invocation of their own.
   */
  recheckSuppressions(): Promise<void> {
    if (this.#rechecking) return this.#rechecking;
    const metrics = createMetrics(this.env.METRICS);
    this.#rechecking = measureInvocation(
      metrics,
      { where: "do", op: "recheckSuppressions", doClass: "MaintenanceDO" },
      () => recheckSuppressions(this.env, { now: Date.now(), metrics }),
    ).finally(() => {
      this.#rechecking = null;
    });
    return this.#rechecking;
  }

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
