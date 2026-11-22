import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import { CI_POLL_LEASE, ciFleetCap, ciPollBudget } from "../ci/budget.js";
import { workersPlan } from "../git/fetch/mode.js";
import { type AuthenticatedRunner, type FleetLimit, leasePolls } from "./registry.js";

/**
 * A FetchTask's admission: `ok`; revoked by this call for its polling rate
 * or for the fleet's cap; `unaccounted` when its lease could not be
 * recorded (the runner is not revoked, and resumes once restarted); or
 * `gone` when the runner stopped serving since it was authenticated.
 */
export type FetchAdmission = "ok" | "poll_rate" | "fleet_cap" | "unaccounted" | "gone";

export interface RunnerAdmission {
  /** The fleet's limit, read before registration's batch; null: none. */
  readonly fleet: FleetLimit | null;
  /** Called on every FetchTask once the runner is authenticated, at `now` (the isolate's milliseconds). */
  onFetch(
    runner: Pick<AuthenticatedRunner, "id">,
    now: number,
    log?: Logger,
  ): Promise<FetchAdmission>;
}

export const admitEveryRunner: RunnerAdmission = {
  fleet: null,
  onFetch: async () => "ok",
};

const DAY = 86_400_000;

/**
 * An isolate's leased blocks: per runner, the UTC day (the isolate's
 * clock) the block was leased on and the polls it still pays for. Unbounded,
 * a few bytes a runner; blocks of past days are dropped when a day turns.
 */
export class PollBlocks {
  readonly #blocks = new Map<number, { day: number; left: number }>();
  #day = 0;

  get size(): number {
    return this.#blocks.size;
  }

  /** Spends one poll of runner `id`'s block for `day`; false when it holds none. */
  take(id: number, day: number): boolean {
    if (day > this.#day) {
      this.#day = day;
      for (const [runner, block] of this.#blocks) if (block.day < day) this.#blocks.delete(runner);
    }
    const block = this.#blocks.get(id);
    if (!block || block.day !== day || block.left === 0) return false;
    block.left--;
    return true;
  }

  /**
   * Holds `left` more polls for runner `id` on `day`, beside what it still
   * holds that day: leases answered at once for one runner each paid for theirs.
   */
  hold(id: number, day: number, left: number): void {
    if (day !== this.#day) return;
    const held = this.#blocks.get(id);
    this.#blocks.set(id, { day, left: (held?.day === day ? held.left : 0) + left });
  }

  forget(id: number): void {
    this.#blocks.delete(id);
  }
}

const isolateBlocks = new PollBlocks();

/**
 * A block is charged before any poll of it is served, so a lost answer or
 * an evicted isolate can only overcharge. A block is used only on the day
 * (the isolate's clock) the call that leased it began.
 */
export function freeRunnerAdmission(
  db: D1Database,
  fleet: FleetLimit,
  blocks: PollBlocks = isolateBlocks,
  metrics?: Metrics,
): RunnerAdmission {
  return {
    fleet,
    async onFetch(runner, now, log) {
      const day = Math.floor(now / DAY);
      if (blocks.take(runner.id, day)) return "ok";
      let lease: Awaited<ReturnType<typeof leasePolls>>;
      try {
        lease = await leasePolls(db, { id: runner.id, now, block: CI_POLL_LEASE, fleet }, metrics);
      } catch (error) {
        log?.warn("runner poll lease failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return "unaccounted";
      }
      if (lease.status === "leased") {
        blocks.hold(runner.id, day, CI_POLL_LEASE - 1);
        return "ok";
      }
      blocks.forget(runner.id);
      return lease.status === "revoked" ? lease.reason : "gone";
    },
  };
}

export function runnerAdmissionFor(env: Env, metrics?: Metrics): RunnerAdmission {
  if (workersPlan(env) === "paid") return admitEveryRunner;
  return freeRunnerAdmission(
    env.DIRECTORY,
    { cap: ciFleetCap(env) ?? 0, pollBudget: ciPollBudget(env) },
    isolateBlocks,
    metrics,
  );
}
