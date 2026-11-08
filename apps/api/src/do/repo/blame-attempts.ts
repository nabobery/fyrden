// A blame slice that dies (an instance reset, the CPU limit, an eviction)
// leaves no answer and its checkpoint where it was, and the next request
// would run the same slice again. Resets have been seen to repeat on the same
// work, so a mark is kept across them: each slice records its attempt before
// any work and clears it however it ends, so only a death leaves it behind.
// A second attempt on the same checkpoint runs one step, so the steps before
// the one that dies aren't lost with it; a third refuses that step as
// step_lost, visibly, and the walk moves on. No step is retried forever.
import {
  advanceBlame,
  type BlameAdvance,
  type BlameSliceLimits,
  type BlameSource,
  type BlameState,
  refuseHead,
} from "@fyrden/git-core";
import type { BlameRuns } from "./blame-runs.js";

/**
 * Where a run's slice attempts are kept. A mark must outlive the slice that
 * wrote it: `begin` resolves only once its write would survive a reset.
 */
export interface AttemptLedger {
  /**
   * Records an attempt on the run's checkpoint `generation` and answers how
   * many there have been on it, this one included. A new generation starts
   * again at 1.
   */
  begin(run: string, generation: number): Promise<number>;
  /** The attempts recorded on `generation`, without recording one. */
  peek(run: string, generation: number): number;
  /** Forgets the run's attempts: its slice ended, however it ended. */
  clear(run: string): void;
}

/** A ledger in memory: the reference for the counting, and the tests' ledger. */
export class MemoryAttemptLedger implements AttemptLedger {
  readonly #marks = new Map<string, { generation: number; attempts: number }>();

  async begin(run: string, generation: number): Promise<number> {
    const mark = this.#marks.get(run);
    const attempts = mark?.generation === generation ? mark.attempts + 1 : 1;
    this.#marks.set(run, { generation, attempts });
    return attempts;
  }

  peek(run: string, generation: number): number {
    const mark = this.#marks.get(run);
    return mark?.generation === generation ? mark.attempts : 0;
  }

  clear(run: string): void {
    this.#marks.delete(run);
  }
}

/**
 * The ledger on the run's row: the mark is written, then `begin` waits for
 * the storage to be durable (`ctx.storage.sync()`, which resolves once the
 * pending writes complete), so a reset after it still finds the mark.
 */
export class RunRowAttemptLedger implements AttemptLedger {
  constructor(
    private readonly runs: Pick<BlameRuns, "beginAttempt" | "peekAttempt" | "clearAttempts">,
    private readonly storage: Pick<DurableObjectStorage, "sync">,
  ) {}

  async begin(run: string, generation: number): Promise<number> {
    const attempts = this.runs.beginAttempt(run, generation);
    await this.storage.sync();
    return attempts;
  }

  peek(run: string, generation: number): number {
    return this.runs.peekAttempt(run, generation);
  }

  clear(run: string): void {
    this.runs.clearAttempts(run);
  }
}

export type SliceAttempt =
  | { readonly kind: "slice"; readonly limits: BlameSliceLimits }
  | { readonly kind: "refuse" };

/** What attempt `attempt` on one checkpoint may do. */
export function sliceAttempt(attempt: number, limits: BlameSliceLimits): SliceAttempt {
  if (attempt <= 1) return { kind: "slice", limits };
  if (attempt === 2) return { kind: "slice", limits: { ...limits, maxSteps: 1 } };
  return { kind: "refuse" };
}

export type SliceAttemptResult =
  | { readonly outcome: "advanced"; readonly advance: BlameAdvance }
  | { readonly outcome: "refused" };

/** One slice on checkpoint `generation` of `run`, under the ledger's mark. */
export async function runSliceAttempt(input: {
  readonly ledger: AttemptLedger;
  readonly run: string;
  readonly generation: number;
  readonly state: BlameState;
  readonly source: BlameSource;
  readonly limits: BlameSliceLimits;
}): Promise<SliceAttemptResult> {
  const { ledger, run, state, limits } = input;
  const plan = sliceAttempt(await ledger.begin(run, input.generation), limits);
  try {
    if (plan.kind === "refuse") {
      refuseHead(state, "step_lost", limits);
      return { outcome: "refused" };
    }
    return { outcome: "advanced", advance: await advanceBlame(state, input.source, plan.limits) };
  } finally {
    ledger.clear(run);
  }
}
