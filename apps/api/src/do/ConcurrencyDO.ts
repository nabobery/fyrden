import {
  createDoMemoryBudget,
  type GitStorageContext,
  type JobHandler,
  JobQueue,
} from "@fyrden/adapters-cloudflare/git";
import { createMetrics, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { jobPolicy } from "../invocation-calls.js";
import { MigratingDO } from "./base/MigratingDO.js";
import {
  type ConcurrencyRequest,
  type ReceiptAnswer,
  type RenewScope,
  RepoConcurrency,
} from "./repo/concurrency.js";
import { concurrencySchema } from "./schema/concurrency.js";

const ALARM_BUDGET_MS = 5_000;
const JOB = "concurrency";

/** Concurrency authority per repository, outside the repository's restore history. */
export class ConcurrencyDO extends MigratingDO {
  static readonly schema = concurrencySchema;

  readonly context: GitStorageContext;
  readonly jobs: JobQueue;
  readonly concurrency: RepoConcurrency;
  readonly #memory = createDoMemoryBudget(1024 * 1024);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.context = {
      storage: ctx.storage,
      now: () => Date.now(),
      metrics: createMetrics(env.METRICS),
      doClass: "ConcurrencyDO",
    };
    this.jobs = new JobQueue(
      this.context,
      (at) => {
        void ctx.storage.setAlarm(at);
      },
      jobPolicy(env),
    );
    this.concurrency = new RepoConcurrency({
      context: this.context,
      wake: (at) => this.jobs.ensure(JOB, JOB, { runAt: at }),
    });
  }

  #erased(): boolean {
    return (
      this.context.storage.sql.exec("SELECT 1 FROM concurrency_erasure WHERE id = 1").toArray()
        .length > 0
    );
  }

  #check(): void {
    if (this.#erased()) throw new Error("repo_not_found: concurrency coordinator erased");
  }

  async acquire(requests: readonly ConcurrencyRequest[]): Promise<ReceiptAnswer[]> {
    this.#check();
    return requests.map((request) => this.concurrency.acquire(request));
  }

  async status(scopes: readonly { group: string; runId: string; ownerKey: string }[]) {
    this.#check();
    return this.concurrency.status(scopes);
  }

  async renew(runId: string, scopes: readonly RenewScope[]) {
    this.#check();
    return this.concurrency.renew(runId, scopes);
  }

  async release(
    scopes: readonly { group: string; runId: string; ownerKey: string; generation?: number }[],
  ): Promise<(ReceiptAnswer | null)[]> {
    this.#check();
    return scopes.map((scope) => this.concurrency.release(scope));
  }

  /**
   * Forgets a run retiring at the end of its retention: releases what it
   * holds or waits for (a pending run is promoted) and deletes its
   * receipts, signals and lease. Repeating it changes nothing; an erased
   * coordinator holds nothing to forget.
   */
  async forgetRun(runId: string): Promise<void> {
    if (this.#erased()) return;
    this.concurrency.forgetRun(runId);
  }

  /** A permanent fence: delayed repository calls cannot create grants after deletion. */
  async erase(): Promise<void> {
    this.context.storage.transactionSync(() => {
      if (this.#erased()) return;
      this.context.storage.sql.exec(
        "INSERT INTO concurrency_erasure (id, erased_at) VALUES (1, ?)",
        this.context.now(),
      );
      for (const table of [
        "concurrency_groups",
        "concurrency_receipts",
        "concurrency_signals",
        "concurrency_leases",
        "ci_meta",
        "jobs",
      ])
        this.context.storage.sql.exec(`DELETE FROM ${table}`);
    });
    await this.ctx.storage.deleteAlarm();
  }

  #handler(): JobHandler {
    return {
      runSlice: async () => {
        if (this.#erased()) return { done: true };
        const now = this.context.now();
        this.context.storage.transactionSync(() => this.concurrency.settleDue(now));
        for (const signal of this.concurrency.dueSignals(now)) {
          if (this.#erased()) return { done: true };
          try {
            this.context.metrics.count("do.request", {
              class: "RunDO",
              method: "concurrencySignal",
            });
            await this.env.RUN.getByName(signal.run_id).concurrencySignal({
              ownerKey: signal.owner_key,
              group: signal.group_key,
              kind: signal.kind,
              generation: signal.generation,
            });
            if (this.#erased()) return { done: true };
            this.concurrency.signalDelivered(signal);
          } catch {
            if (this.#erased()) return { done: true };
            this.concurrency.signalFailed(signal);
          }
        }
        const next = this.concurrency.nextAt();
        return next === undefined
          ? { done: true }
          : { done: false, cursor: null, runAfterMs: Math.max(0, next - this.context.now()) };
      },
    };
  }

  override async alarm(): Promise<void> {
    if (this.#erased()) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await measureInvocation(
      this.context.metrics,
      { where: "do", op: "alarm", doClass: "ConcurrencyDO" },
      () =>
        this.jobs.runDue(
          { concurrency: this.#handler() },
          this.#memory,
          this.context.now() + ALARM_BUDGET_MS,
        ),
    );
  }
}
