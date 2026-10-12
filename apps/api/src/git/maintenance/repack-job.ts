import {
  type Job,
  type JobHandler,
  LOCK_REF_COMMIT,
  type RepoGitStorage,
  type SliceResult,
  schedulePackRetire,
  swapPacks,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import type { BlockCache, PackId } from "@fyrden/git-core";
import { newRunId } from "./ids.js";
import type { MaintenancePolicy } from "./policy.js";
import { selectGeometricRepack } from "./repack-plan.js";
import { type RewriteState, releaseOutputLease, rewriteSlice } from "./rewrite.js";
import { GC_JOB_ID, inProgress, REPACK_JOB_ID } from "./schedule.js";
import {
  type CallCounter,
  decodeJson,
  deleteRun,
  discardOutput,
  encodeJson,
  swapped,
} from "./storage.js";
import { liveCapUnits } from "./tail-merge.js";

/*
 * The geometric repack job: chooses own live packs by the
 * geometric rule, compacts them into one `compact` pack across alarm slices
 * (resumable from the job cursor and scratch checkpoints), then swaps it in
 * with one transaction under the commit lock: the new pack goes live, the
 * sources are superseded (deleted 30 days later by the retire job). The
 * swap waits for leases on the sources (a clone streaming from them), and
 * for pushes being indexed, up to the policy's limits.
 */

type Cursor =
  | {
      readonly v: 1;
      readonly phase: "write";
      readonly runId: string;
      readonly sources: readonly PackId[];
      readonly rewrite?: RewriteState;
    }
  | {
      readonly v: 1;
      readonly phase: "swap";
      readonly runId: string;
      readonly sources: readonly PackId[];
      readonly output: PackId;
      readonly objects: number;
      readonly bytes: number;
      readonly waitingSince: number;
    };

/** How long the swap holds the commit lock (a few synchronous statements). */
const SWAP_LOCK_MS = 30_000;
/** Retry delay when the commit lock is busy. */
const BUSY_RETRY_MS = 5_000;

export function repackHandler(
  git: RepoGitStorage,
  policy: () => MaintenancePolicy,
  log: Logger,
  blocks?: () => BlockCache,
): JobHandler {
  return { runSlice: (job) => new RepackSlice(git, policy(), log, blocks?.()).run(job) };
}

class RepackSlice {
  readonly #counter: CallCounter = { calls: 0 };

  constructor(
    private readonly git: RepoGitStorage,
    private readonly policy: MaintenancePolicy,
    private readonly log: Logger,
    private readonly blocks: BlockCache | undefined,
  ) {}

  async run(job: Job): Promise<SliceResult> {
    // A collection part-way through owns the packs it read; repack after it.
    if (inProgress(this.git, GC_JOB_ID)) return this.#later(job.cursor, this.policy.retryMs);
    const cursor = decodeJson<Cursor>(job.cursor);
    if (cursor?.v !== 1) return this.#plan();
    if (cursor.phase === "write") return this.#write(job, cursor);
    return this.#swap(cursor);
  }

  #plan(): SliceResult {
    const units = selectGeometricRepack(
      liveCapUnits(this.git),
      this.policy.geometricFactor,
      this.policy.maxRewriteObjects,
    );
    if (units.length === 0) return { done: true };
    const chosen = new Set(units.flatMap((u) => u.packIds));
    // Oldest first, so the new pack keeps history order.
    const sources = this.git.registry
      .liveOwn()
      .filter((p) => chosen.has(p.packId))
      .map((p) => p.packId);
    return this.#next({ v: 1, phase: "write", runId: newRunId(this.git), sources });
  }

  async #write(job: Job, cursor: Extract<Cursor, { phase: "write" }>): Promise<SliceResult> {
    if (!cursor.sources.every((id) => this.git.registry.get(id)?.state === "live"))
      return this.#abandon(cursor, cursor.rewrite?.packId);
    let outcome: Awaited<ReturnType<typeof rewriteSlice>>;
    try {
      outcome = await rewriteSlice(
        {
          git: this.git,
          policy: this.policy,
          runId: cursor.runId,
          holder: REPACK_JOB_ID,
          counter: this.#counter,
          ...(this.blocks ? { blocks: this.blocks } : {}),
          deadline: this.git.context.now() + this.policy.sliceMs,
        },
        { kind: "compact", sources: cursor.sources },
        cursor.rewrite,
      );
    } catch (error) {
      // A slice that keeps failing from its checkpoint (one lost with a
      // reset, a completed upload) starts the pack again.
      if (job.attempts < 2) throw error;
      this.log.warn("repack output restarted", { error });
      return this.#abandon(cursor, cursor.rewrite?.packId);
    }
    if (!outcome.done) return this.#next({ ...cursor, rewrite: outcome.state });
    return this.#next({
      v: 1,
      phase: "swap",
      runId: cursor.runId,
      sources: cursor.sources,
      output: outcome.packId,
      objects: outcome.objectCount,
      bytes: outcome.bytes,
      waitingSince: this.git.context.now(),
    });
  }

  async #swap(cursor: Extract<Cursor, { phase: "swap" }>): Promise<SliceResult> {
    const { git, policy } = this;
    const lock = git.locks.tryAcquire(LOCK_REF_COMMIT, REPACK_JOB_ID, SWAP_LOCK_MS);
    if (!lock) return this.#later(encodeJson(cursor), BUSY_RETRY_MS);
    const waited = git.context.now() - cursor.waitingSince;
    let result: ReturnType<typeof swapPacks>;
    try {
      result = swapPacks(git, {
        remove: cursor.sources,
        live: [cursor.output],
        inheritAllReachable: true,
        respectLeases: waited < policy.leaseWaitMs,
        waitForIndexing: waited < policy.indexingWaitMs,
      });
    } finally {
      git.locks.release(lock);
    }
    if (!result.ok) {
      // Swapped already (the cursor saying so was lost): finish the run.
      if (result.reason === "packs-changed" && swapped(git, cursor.output))
        return this.#finished(cursor);
      if (result.reason === "packs-changed") return this.#abandon(cursor, cursor.output);
      return this.#later(encodeJson(cursor), policy.retryMs);
    }
    this.#count("packs_in", cursor.sources.length);
    this.#count("packs_out", 1);
    this.#count("objects", cursor.objects);
    this.#count(
      "bytes_in",
      cursor.sources.reduce((n, id) => n + (git.registry.get(id)?.bytes ?? 0), 0),
    );
    this.#count("bytes_out", cursor.bytes);
    return this.#finished(cursor);
  }

  async #finished(cursor: Extract<Cursor, { phase: "swap" }>): Promise<SliceResult> {
    const { git } = this;
    schedulePackRetire(git.jobs, git.context.now());
    git.leases.releaseHolder(REPACK_JOB_ID);
    await deleteRun(git, cursor.runId);
    // Another roll-up may be due now that the progression changed.
    return { done: false, cursor: null, runAfterMs: 0 };
  }

  /** Gives up this run's output and plans again. */
  async #abandon(cursor: Cursor, output: PackId | undefined): Promise<SliceResult> {
    this.#count("restarts", 1);
    if (cursor.phase === "write") releaseOutputLease(this.git, cursor.rewrite);
    this.git.leases.releaseHolder(REPACK_JOB_ID);
    if (output) await discardOutput(this.git, output);
    await deleteRun(this.git, cursor.runId);
    return { done: false, cursor: null, runAfterMs: 0 };
  }

  #next(cursor: Cursor): SliceResult {
    return { done: false, cursor: encodeJson(cursor), runAfterMs: 0 };
  }

  #later(cursor: Uint8Array | null, ms: number): SliceResult {
    return { done: false, cursor, runAfterMs: ms };
  }

  #count(what: string, n: number): void {
    if (n > 0) this.git.context.metrics.count("git.maintenance", { job: "repack", what }, n);
  }
}
