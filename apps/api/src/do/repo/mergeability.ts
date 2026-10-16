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
 */

/** What the background merge came to for one pair. */
export type MergeabilityState = "clean" | "conflicts" | "manual" | "unknown" | "error";

/** GitHub's `mergeable_state`, as far as Fyrden works it out. */
export type MergeableState = "clean" | "dirty" | "draft" | "unknown";

export interface MergeabilityView {
  /** Whether it merges without conflicts at its current base tip and head; null until known. */
  readonly mergeable: boolean | null;
  readonly mergeableState: MergeableState;
}

/** A pull request with whether it merges. */
export type PullView = PullRecord & MergeabilityView;

/**
 * A slice's merge budgets: the merge's, with fewer reads, since the job
 * queue starts a slice with up to 800 of the invocation's 1,000 calls spent.
 * A pull request past them is `unknown` (merging it may still succeed).
 */
export const MERGEABILITY_POLICY: MergePolicy = { ...MERGE_POLICY, maxReads: 150 };

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
       ON CONFLICT (pr_number) DO UPDATE SET seq = seq + 1`,
      number,
      this.deps.git.context.now(),
    );
    this.deps.git.jobs.ensure("mergeability", MERGEABILITY_JOB_ID);
  }

  /**
   * An open pull request asked for: queued when nothing is known for its
   * current pair and it is not waiting already; when it is waiting, its job
   * is made to run (should it have stopped after failing). Not while the
   * repository takes no changes.
   */
  request(pull: PullRecord): void {
    if (pull.state !== "open" || !this.deps.takesChanges()) return;
    const { storage } = this.deps.git.context;
    storage.transactionSync(() => {
      const waiting =
        storage.sql
          .exec("SELECT 1 FROM mergeability_jobs WHERE pr_number = ?", pull.number)
          .toArray().length > 0;
      if (waiting) {
        // Revived only when it stopped: a queued job keeps its time (it may be waiting out
        // a delay), a running one serves the queue.
        const job = this.deps.git.jobs.get(MERGEABILITY_JOB_ID);
        if (job?.state !== "queued" && job?.state !== "running")
          this.deps.git.jobs.ensure("mergeability", MERGEABILITY_JOB_ID);
      } else if (
        this.#current(pull) === undefined &&
        // Without a base branch there is nothing to work out; made again, it queues itself.
        this.deps.pulls.branchTip(pull.baseRef) !== null
      )
        this.stale(pull.number, true);
    });
  }

  /** The pull request's mergeability at its current base tip and head (GitHub's fields). */
  view(pull: PullRecord): MergeabilityView {
    if (pull.state !== "open") return { mergeable: null, mergeableState: "unknown" };
    const state = this.#current(pull);
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
    };
  }

  /** The kept result, when it is for the pull request's current base tip and head. */
  #current(pull: PullRecord): MergeabilityState | undefined {
    const row = this.#row(pull.number);
    const base = this.deps.pulls.branchTip(pull.baseRef);
    return row && base && row.base_sha === oidToHex(base) && row.head_sha === pull.headSha
      ? row.state
      : undefined;
  }

  #row(number: number) {
    return this.deps.git.context.storage.sql
      .exec<{ base_sha: string; head_sha: string; state: MergeabilityState }>(
        "SELECT base_sha, head_sha, state FROM mergeability WHERE pr_number = ?",
        number,
      )
      .toArray()[0];
  }

  /** The queue's job: one pull request per slice, longest waiting first. */
  handler(): JobHandler {
    return {
      memoryBytes: this.deps.policy().maxOutputBytes + 1024 * 1024,
      runSlice: async () => {
        // Results are written with events: not while the repository takes no changes.
        if (!this.deps.writable()) return { done: false, cursor: null, runAfterMs: 60_000 };
        const job = this.deps.git.context.storage.sql
          .exec<{ pr_number: number; seq: number }>(
            "SELECT pr_number, seq FROM mergeability_jobs ORDER BY requested_at, pr_number LIMIT 1",
          )
          .toArray()[0];
        if (job) await this.#work(job.pr_number, job.seq);
        // Judged with no wait before the answer: a pull request queued meanwhile found this
        // job running and left it to this one.
        return this.#waiting() ? { done: false, cursor: null, runAfterMs: 0 } : { done: true };
      },
    };
  }

  #waiting(): boolean {
    return (
      this.deps.git.context.storage.sql.exec("SELECT 1 FROM mergeability_jobs LIMIT 1").toArray()
        .length > 0
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
    // Already worked out for this pair (the change that queued it was not a move); an
    // error or a pair past the budget is not worked out again until either moves.
    if (this.#current(pull) !== undefined) return void done();
    const head = oidFromHex(pull.headSha);
    let outcome: TreeOutcome;
    try {
      outcome = await this.#outcome(baseTip, head);
    } catch (error) {
      // Kept as an error for this pair rather than retried without end.
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
      this.#keep(now, baseTip, outcome);
      done();
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

  /** In the transaction: the result for the pair, and an event when the state changed. */
  #keep(pull: PullRecord, baseTip: Oid, outcome: TreeOutcome): void {
    const state = stateOf(outcome);
    const previous = this.#row(pull.number)?.state;
    this.deps.git.context.storage.sql.exec(
      `INSERT INTO mergeability (pr_number, base_sha, head_sha, state, computed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (pr_number) DO UPDATE SET base_sha = excluded.base_sha,
         head_sha = excluded.head_sha, state = excluded.state, computed_at = excluded.computed_at`,
      pull.number,
      oidToHex(baseTip),
      pull.headSha,
      state,
      this.deps.git.context.now(),
    );
    if (previous === state) return;
    const view = this.view(pull);
    this.deps.events.emitActivity("pull_request.mergeability", null, {
      number: pull.number,
      state,
      previous_state: previous ?? null,
      mergeable: view.mergeable,
      mergeable_state: view.mergeableState,
      base_sha: oidToHex(baseTip),
      head_sha: pull.headSha,
      ...(outcome.kind === "conflicts" && {
        conflicts: outcome.conflicts.slice(0, CONFLICTS_NAMED).map((c) => ({
          path: c.path,
          kind: c.kind,
        })),
        conflicts_total: outcome.conflicts.length,
      }),
    });
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
