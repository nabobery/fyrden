import type { JobHandler, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import {
  type BlockCache,
  isAncestor,
  type Oid,
  oidFromHex,
  oidToHex,
  WalkLimitError,
} from "@fyrden/git-core";
import type { RepoEvents } from "./events.js";
import { MERGE_POLICY, type MergePolicy, mergeOutcome, type TreeOutcome } from "./merge.js";
import type { PullRecord, RepoPulls } from "./pulls.js";

/*
 * Whether each open pull request merges cleanly into its base branch,
 * worked out in the background for its current pair of base tip and head.
 * A pull request is queued in the transaction that changes it or moves its
 * base branch (a newer request replaces an older one but keeps its place);
 * one job serves the queue, longest waiting first, one merge per slice. A
 * result is kept only for the pair it was worked out for, so a stale one is
 * never shown. Only the outcome is kept: a merge works its tree out again.
 * A result past the budgets or unreadable waits in the queue to be worked
 * out again, after a delay that doubles each time its pair comes to that.
 */

/**
 * What the background merge came to for one pair: `unknown` past the
 * budgets, `error` when an object could not be read.
 */
export type MergeabilityState = "clean" | "conflicts" | "manual" | "unknown" | "error";

/** GitHub's `mergeable_state`, as far as Fyrden works it out. */
export type MergeableState = "clean" | "dirty" | "draft" | "unknown";

/** Why an open pull request's `mergeable` is null. */
export type MergeableReason = "pending" | "too_expensive" | "unreadable";

export interface MergeabilityView {
  /** Whether it merges without conflicts at its current base tip and head; null until known. */
  readonly mergeable: boolean | null;
  readonly mergeableState: MergeableState;
  /** Why `mergeable` is null while open; null when it is known, and once closed. */
  readonly mergeableReason: MergeableReason | null;
}

/** A pull request with whether it merges. */
export type PullView = PullRecord & MergeabilityView;

/**
 * A slice's merge budgets: the merge's, with fewer reads, since the job
 * queue starts a slice with up to 800 of the invocation's 1,000 calls spent.
 * A pull request past them is `unknown` (merging it may still succeed).
 */
export const MERGEABILITY_POLICY: MergePolicy = { ...MERGE_POLICY, maxReads: 150 };

/**
 * The version of the budgets (these, `MERGE_POLICY`'s) and of what reading
 * an object costs against them, kept with each result past them or
 * unreadable. Bump it with any change to either: a result kept under
 * another version is worked out again when its pull request is asked for.
 */
export const MERGEABILITY_POLICY_VERSION = 1;

/**
 * The delay before a result past the budgets, or unreadable, is worked out
 * again for the same pair: `firstMs`, doubling with each try to `maxMs`
 * (Proposed).
 */
export const MERGEABILITY_RETRY = { firstMs: 10 * 60_000, maxMs: 6 * 60 * 60_000 } as const;

/** The delay after the `attempts`-th result in a row past the budgets or unreadable. */
export function mergeabilityRetryDelay(attempts: number): number {
  return Math.min(
    MERGEABILITY_RETRY.firstMs * 2 ** Math.max(0, attempts - 1),
    MERGEABILITY_RETRY.maxMs,
  );
}

/** The one job that serves the queue. */
export const MERGEABILITY_JOB_ID = "mergeability";

/** Conflicting paths an event names. */
const CONFLICTS_NAMED = 10;

export class RepoMergeability {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
      readonly pulls: RepoPulls;
      readonly memoryBlocks: () => BlockCache;
      readonly policy: () => MergePolicy;
      readonly log: () => Logger;
      /** Whether the repository takes changes now (requests may be queued). */
      readonly takesChanges: () => boolean;
      /** Whether results may be written now: it takes changes, with its epoch checked. */
      readonly writable: () => boolean;
      /** Runs between working a result out and writing it. For tests. */
      readonly beforeWrite?: () => Promise<void> | undefined;
    },
  ) {}

  /**
   * In the caller's transaction: an open pull request's mergeability must
   * be worked out again (a closed or merged one's no longer).
   */
  stale(number: number, open: boolean): void {
    const sql = this.deps.git.context.storage.sql;
    if (!open) {
      sql.exec("DELETE FROM mergeability_jobs WHERE pr_number = ?", number);
      return;
    }
    sql.exec(
      `INSERT INTO mergeability_jobs (pr_number, seq, requested_at) VALUES (?, 1, ?)
       ON CONFLICT (pr_number) DO UPDATE SET ${REQUESTED_AGAIN}`,
      number,
      this.deps.git.context.now(),
    );
    this.deps.git.jobs.ensure("mergeability", MERGEABILITY_JOB_ID);
  }

  /**
   * In the caller's transaction: base branch `branch` moved, so every open
   * pull request onto it is worked out again, queued by one statement
   * (however many there are) and the job made to run once.
   */
  staleBase(branch: string): void {
    const queued = this.deps.git.context.storage.sql.exec(
      `INSERT INTO mergeability_jobs (pr_number, seq, requested_at)
       SELECT number, 1, ? FROM pull_requests WHERE base_ref = ? AND state = 'open'
       ON CONFLICT (pr_number) DO UPDATE SET ${REQUESTED_AGAIN}`,
      this.deps.git.context.now(),
      branch,
    );
    if (queued.rowsWritten > 0) this.deps.git.jobs.ensure("mergeability", MERGEABILITY_JOB_ID);
  }

  /**
   * An open pull request asked for: queued when nothing is known for its
   * current pair, or what is known is due to be worked out again, and it is
   * not waiting already; when it is waiting, its job is made to run (should
   * it have stopped after failing), and a delay it waits out that is over
   * (its budgets changed) is ended. Not while the repository takes no
   * changes.
   */
  request(pull: PullRecord): void {
    if (pull.state !== "open" || !this.deps.takesChanges()) return;
    const { storage } = this.deps.git.context;
    storage.transactionSync(() => {
      const now = this.deps.git.context.now();
      const kept = this.#current(pull);
      const due = kept === undefined || (retryAt(kept) ?? Number.POSITIVE_INFINITY) <= now;
      const waiting =
        storage.sql
          .exec("SELECT 1 FROM mergeability_jobs WHERE pr_number = ?", pull.number)
          .toArray().length > 0;
      if (waiting) {
        const hurried =
          due &&
          storage.sql.exec(
            "UPDATE mergeability_jobs SET requested_at = ? WHERE pr_number = ? AND requested_at > ?",
            now,
            pull.number,
            now,
          ).rowsWritten > 0;
        // Otherwise revived only when it stopped: a queued job keeps its time (it may be
        // waiting out a delay), a running one serves the queue.
        const job = this.deps.git.jobs.get(MERGEABILITY_JOB_ID);
        if (hurried || (job?.state !== "queued" && job?.state !== "running"))
          this.deps.git.jobs.ensure("mergeability", MERGEABILITY_JOB_ID);
      } else if (
        due &&
        // Without a base branch there is nothing to work out; made again, it queues itself.
        this.deps.pulls.branchTip(pull.baseRef) !== null
      )
        this.stale(pull.number, true);
    });
  }

  /** The pull request's mergeability at its current base tip and head (GitHub's fields, and why). */
  view(pull: PullRecord): MergeabilityView {
    if (pull.state !== "open")
      return { mergeable: null, mergeableState: "unknown", mergeableReason: null };
    const state = this.#current(pull)?.state;
    const mergeable =
      state === "clean" ? true : state === "conflicts" || state === "manual" ? false : null;
    return {
      mergeable,
      mergeableState: pull.draft
        ? "draft"
        : mergeable === true
          ? "clean"
          : mergeable === false
            ? "dirty"
            : "unknown",
      mergeableReason: reasonOf(state),
    };
  }

  /** The kept result, when it is for the pull request's current base tip and head. */
  #current(pull: PullRecord): Kept | undefined {
    const row = this.#row(pull.number);
    const base = this.deps.pulls.branchTip(pull.baseRef);
    return row && base && row.base_sha === oidToHex(base) && row.head_sha === pull.headSha
      ? row
      : undefined;
  }

  #row(number: number): Kept | undefined {
    return this.deps.git.context.storage.sql
      .exec<Kept>(
        `SELECT base_sha, head_sha, state, computed_at, attempts, policy_version
         FROM mergeability WHERE pr_number = ?`,
        number,
      )
      .toArray()[0];
  }

  /**
   * The queue's job: one pull request per slice, longest waiting first, of
   * those not waiting out a delay.
   */
  handler(): JobHandler {
    return {
      memoryBytes: this.deps.policy().maxOutputBytes + 1024 * 1024,
      runSlice: async () => {
        // Results are written with events: not while the repository takes no changes.
        if (!this.deps.writable()) return { done: false, cursor: null, runAfterMs: 60_000 };
        const { context } = this.deps.git;
        const job = context.storage.sql
          .exec<{ pr_number: number; seq: number }>(
            `SELECT pr_number, seq FROM mergeability_jobs WHERE requested_at <= ?
             ORDER BY requested_at, pr_number LIMIT 1`,
            context.now(),
          )
          .toArray()[0];
        if (job) await this.#work(job.pr_number, job.seq);
        // Judged with no wait before the answer: a pull request queued meanwhile found this
        // job running and left it to this one.
        const next = this.#nextAt();
        return next === null
          ? { done: true }
          : { done: false, cursor: null, runAfterMs: Math.max(0, next - context.now()) };
      },
    };
  }

  /** When the queue's next request is due, or null when none waits. */
  #nextAt(): number | null {
    return this.deps.git.context.storage.sql
      .exec<{ at: number | null }>("SELECT min(requested_at) AS at FROM mergeability_jobs")
      .one().at;
  }

  /** In the transaction or alone: the pull request's request waits until `at`. */
  #defer(number: number, at: number): void {
    this.deps.git.context.storage.sql.exec(
      "UPDATE mergeability_jobs SET requested_at = ? WHERE pr_number = ?",
      at,
      number,
    );
  }

  /** Works out one pull request's mergeability and keeps it, if its pair is still current. */
  async #work(number: number, seq: number): Promise<void> {
    const sql = this.deps.git.context.storage.sql;
    const done = () =>
      sql.exec("DELETE FROM mergeability_jobs WHERE pr_number = ? AND seq = ?", number, seq);
    const pull = this.deps.pulls.get(number);
    const baseTip = pull && this.deps.pulls.branchTip(pull.baseRef);
    // Closed, or its base branch is gone (made again, it is queued again).
    if (pull?.state !== "open" || !baseTip) return void done();
    // Already worked out for this pair (the change that queued it was not a move): kept,
    // unless past the budgets or unreadable, which waits out its delay first.
    const kept = this.#current(pull);
    if (kept) {
      const at = retryAt(kept);
      if (at === undefined) return void done();
      if (at > this.deps.git.context.now()) return this.#defer(number, at);
    }
    const head = oidFromHex(pull.headSha);
    let outcome: TreeOutcome;
    try {
      outcome = await this.#outcome(baseTip, head);
    } catch (error) {
      // Kept as an error for this pair, worked out again after a delay.
      this.deps.log().warn("working out mergeability failed", { number, error });
      outcome = { kind: "unreadable" };
    }
    await this.deps.beforeWrite?.();
    this.deps.git.context.storage.transactionSync(() => {
      // Frozen meanwhile (a transfer, a deletion): left queued.
      if (!this.deps.writable()) return;
      const now = this.deps.pulls.get(number);
      const tip = now && this.deps.pulls.branchTip(now.baseRef);
      if (now?.state !== "open" || !tip || !sameOid(tip, baseTip) || now.headSha !== pull.headSha) {
        // The pair moved meanwhile: it was queued again, and this result is for neither. It
        // waits behind the others now, so a pull request that keeps moving starves none.
        sql.exec(
          "UPDATE mergeability_jobs SET requested_at = ? WHERE pr_number = ?",
          this.deps.git.context.now(),
          number,
        );
        return;
      }
      const again = this.#keep(now, baseTip, outcome);
      // Past the budgets or unreadable: it waits its turn again (a request for the same pair
      // that came meanwhile with it).
      if (again === undefined) done();
      else this.#defer(number, again);
    });
  }

  async #outcome(baseTip: Oid, head: Oid): Promise<TreeOutcome> {
    const policy = this.deps.policy();
    let upToDate: boolean;
    try {
      upToDate = await isAncestor(this.deps.git.commitGraph, "verified", baseTip, head, {
        maxCommits: policy.maxCommits,
      });
    } catch (error) {
      if (!(error instanceof WalkLimitError)) throw error;
      return { kind: "too_expensive" };
    }
    return mergeOutcome(
      { git: this.deps.git, memoryBlocks: this.deps.memoryBlocks() },
      { baseTip, head, upToDate },
      policy,
    );
  }

  /**
   * In the transaction: the result for the pair, and an event when the
   * state changed. Returns when it is to be worked out again, if past the
   * budgets or unreadable.
   */
  #keep(pull: PullRecord, baseTip: Oid, outcome: TreeOutcome): number | undefined {
    const state = stateOf(outcome);
    const base = oidToHex(baseTip);
    const before = this.#row(pull.number);
    // Counted for the pair and its budgets: a move or new budgets start the delays over.
    const inARow =
      before !== undefined &&
      retried(before.state) &&
      before.base_sha === base &&
      before.head_sha === pull.headSha &&
      before.policy_version === MERGEABILITY_POLICY_VERSION;
    const kept: Kept = {
      base_sha: base,
      head_sha: pull.headSha,
      state,
      computed_at: this.deps.git.context.now(),
      attempts: !retried(state) ? 0 : inARow ? before.attempts + 1 : 1,
      policy_version: MERGEABILITY_POLICY_VERSION,
    };
    this.deps.git.context.storage.sql.exec(
      `INSERT INTO mergeability
         (pr_number, base_sha, head_sha, state, computed_at, attempts, policy_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pr_number) DO UPDATE SET base_sha = excluded.base_sha,
         head_sha = excluded.head_sha, state = excluded.state, computed_at = excluded.computed_at,
         attempts = excluded.attempts, policy_version = excluded.policy_version`,
      pull.number,
      kept.base_sha,
      kept.head_sha,
      kept.state,
      kept.computed_at,
      kept.attempts,
      kept.policy_version,
    );
    const again = retryAt(kept);
    if (before?.state === state) return again;
    const view = this.view(pull);
    this.deps.events.emitActivity("pull_request.mergeability", null, {
      number: pull.number,
      state,
      previous_state: before?.state ?? null,
      mergeable: view.mergeable,
      mergeable_state: view.mergeableState,
      base_sha: base,
      head_sha: pull.headSha,
      ...(outcome.kind === "conflicts" && {
        conflicts: outcome.conflicts.slice(0, CONFLICTS_NAMED).map((c) => ({
          path: c.path,
          kind: c.kind,
        })),
        conflicts_total: outcome.conflicts.length,
      }),
    });
    return again;
  }
}

/** A result kept for a pair (a row of `mergeability`). */
type Kept = {
  readonly base_sha: string;
  readonly head_sha: string;
  readonly state: MergeabilityState;
  readonly computed_at: number;
  /** Results in a row past the budgets or unreadable for the pair and budgets; 0 otherwise. */
  readonly attempts: number;
  readonly policy_version: number;
};

/**
 * A request queued again keeps its place, unless it waits out a delay: a
 * change to the pull request or its base ends that.
 */
const REQUESTED_AGAIN = "seq = seq + 1, requested_at = min(requested_at, excluded.requested_at)";

/** Whether a result is worked out again later for the same pair. */
function retried(state: MergeabilityState): boolean {
  return state === "unknown" || state === "error";
}

/**
 * When a kept result is due to be worked out again: never when it is
 * known; at once when kept under other budgets; otherwise after its delay.
 */
function retryAt(kept: Kept): number | undefined {
  if (!retried(kept.state)) return undefined;
  if (kept.policy_version !== MERGEABILITY_POLICY_VERSION) return 0;
  return kept.computed_at + mergeabilityRetryDelay(kept.attempts);
}

function reasonOf(state: MergeabilityState | undefined): MergeableReason | null {
  switch (state) {
    case undefined:
      return "pending";
    case "unknown":
      return "too_expensive";
    case "error":
      return "unreadable";
    default:
      return null;
  }
}

function stateOf(outcome: TreeOutcome): MergeabilityState {
  switch (outcome.kind) {
    case "clean":
      return "clean";
    case "conflicts":
      return "conflicts";
    case "manual":
    case "unrelated":
      return "manual";
    case "too_expensive":
      return "unknown";
    case "unreadable":
      return "error";
  }
}

function sameOid(a: Oid, b: Oid): boolean {
  return oidToHex(a) === oidToHex(b);
}
