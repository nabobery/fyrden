import { DurableObject } from "cloudflare:workers";
import { countedD1, createMetrics, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { runMaintenance } from "../cron/maintenance.js";
import { recheckSuppressions } from "../email/suppressions.js";
import { DEFAULT_ORG_SHARD } from "../events/read-model.js";
import { reaping, sweep } from "../live/directory.js";
import { readModelMaintenance } from "../read-model/maintenance.js";
import { runSearchPurges } from "../search/recovery.js";
import { REPAIR_POLICY, runSearchRepairs } from "../search/repairs.js";

/**
 * Runs the five-minute maintenance (`runMaintenance`) for the cron trigger,
 * which on Workers Free gets 10 ms of CPU where a Durable Object's request
 * gets 30 s. One object (`MAINTENANCE_OBJECT`), holding nothing; a run
 * asked for while one is under way joins it.
 */
export class MaintenanceDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    // Every D1 statement counted against the invocation's tally.
    super(ctx, { ...env, DIRECTORY: countedD1(env.DIRECTORY), ORG_READ: countedD1(env.ORG_READ) });
  }

  #running: Promise<void> | null = null;
  #repairing: Promise<void> | null = null;
  #rechecking: Promise<void> | null = null;
  #sweeping: Promise<void> | null = null;

  /**
   * Reconciles the search projections that need it (`runSearchRepairs`), in
   * a request of its own: its D1 calls have an invocation of their own.
   */
  repairSearch(): Promise<void> {
    if (this.#repairing) return this.#repairing;
    // It writes the read model: not while its maintenance holds ordinary work back.
    if (readModelMaintenance(this.env)) return Promise.resolve();
    const metrics = createMetrics(this.env.METRICS);
    this.#repairing = measureInvocation(
      metrics,
      { where: "do", op: "repairSearch", doClass: "MaintenanceDO" },
      async () => {
        // A recovery's purges first (whether search indexes or not), then the repairs, with the
        // calls the purges left.
        const purged = await runSearchPurges(this.env, DEFAULT_ORG_SHARD, metrics);
        await runSearchRepairs(this.env, {
          metrics,
          calls: REPAIR_POLICY.callsPerRun - purged,
        });
      },
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

  /**
   * Tells feeds of revocations (`sweep`) and reaps live leases whose release
   * was lost, in a request of its own: its calls to feed objects are an
   * invocation's own.
   */
  sweepRevocations(): Promise<void> {
    if (this.#sweeping) return this.#sweeping;
    const metrics = createMetrics(this.env.METRICS);
    this.#sweeping = measureInvocation(
      metrics,
      { where: "do", op: "sweepRevocations", doClass: "MaintenanceDO" },
      async () => {
        const now = Date.now();
        metrics.count("d1.query", { db: "directory", op: "live_reap" }, 4);
        await this.env.DIRECTORY.batch(reaping(this.env.DIRECTORY, now));
        await sweep(
          this.env.DIRECTORY,
          (feed, dependencies) => {
            metrics.count("do.request", { class: "UserDO", method: "revoked" });
            return this.env.USER.getByName(feed).revoked(dependencies);
          },
          now,
          metrics,
        );
      },
    ).finally(() => {
      this.#sweeping = null;
    });
    return this.#sweeping;
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
