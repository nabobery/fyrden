import type { JobHandler, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import {
  CODEOWNERS_PATHS,
  type CodeOwner,
  type CodeOwnersFile,
  MAX_CODEOWNERS_BYTES,
  parseCodeOwners,
} from "@fyrden/domain";
import {
  type BlockCache,
  isTreeMode,
  type Oid,
  oidFromHex,
  oidToHex,
  ReadDeferred,
  ReaderWorkSpent,
  type TreeEntry,
} from "@fyrden/git-core";
import { openLiveReader, ReadBudgetError } from "../../git/live-reader.js";
import { BROWSE_POLICY } from "./browse.js";
import {
  CODE_OWNER_LIMITS,
  type CodeOwnerLimits,
  deserializeEvaluation,
  type Evaluation,
  evaluateSlice,
  freshEvaluation,
  serializeEvaluation,
  type TooLargeReason,
} from "./code-owner-slice.js";
import {
  ReadsBudgetSpent,
  ReadsMemoryBusy,
  ReadsTooLargeError,
  UnreadableObjectError,
  withHeldReads,
} from "./held-reads.js";
import { mergeBaseOf } from "./pull-files.js";
import type { PullRecord, RepoPulls } from "./pulls.js";

/*
 * Who owns what each open pull request changes, worked out in the
 * background (see `code-owner-slice.ts`) and shown only for the base branch,
 * base tip and head it was worked out for. A pull request is queued in the
 * transaction of a change that may move those (a draft only once its result
 * is asked for); one job serves the queue, one slice of one pull request at
 * a time, oldest first. An evaluation is keyed by what it was worked out
 * from (merge base, head, CODEOWNERS blob, evaluator version), so a run
 * superseded meanwhile wrote nothing wrong; a pull request points at one
 * only from a run whose queue entry and pair still stand after its last
 * await. Evaluations nothing points at are pruned. The job never fails for
 * good: any error waits and tries again.
 */

/** Bumped with any change of what an evaluation answers for the same inputs (parser, matcher, locations, diff). */
export const CODEOWNERS_EVALUATION_VERSION = 3;

export const CODE_OWNERS_JOB_ID = "code_owners";

/** Proposed values (to be measured). */
export const CODE_OWNERS_POLICY = {
  /** Storage reads one slice makes at most (the queue may start a slice with 800 of 1,000 calls spent). */
  maxReads: 150,
  /**
   * Bytes one slice's reads may build: objects inflated, delta programs and
   * what deltas build, a chain's intermediate objects included (64 MiB).
   */
  maxBuiltBytes: 64 * 1024 * 1024,
  /** The largest tree read (about 37,000 entries, about 26 MiB held while parsed). */
  maxTreeBytes: 1024 * 1024,
  /** Tree bytes one slice reads in all (about 39 MiB held). */
  maxSliceTreeBytes: 1.5 * 1024 * 1024,
  /** Memory a parsed file is held as, per byte of the file (24 MiB at the largest accepted). */
  fileMemoryPerByte: 8,
  /** The delay after an unreadable result, doubling with each in a row, and its ceiling. */
  retryFirstMs: 60_000,
  retryMaxMs: 60 * 60_000,
  /** Evaluations one slice prunes, and open pull requests a restore's scan reads, at most. */
  pruneBatch: 100,
  restorePage: 100,
  /** How long an evaluation nothing points at may stay pending (a run superseded midway). */
  pendingGraceMs: 24 * 60 * 60_000,
};

const NONE = "";
/** What a read the diff needs first answers when it stopped the slice (its outcome published). */
const STOPPED = Symbol("stopped");
/** How long a slice that found the memory it needs held waits to try again. Proposed. */
const MEMORY_RETRY_MS = 5_000;

/** A slice stopped by something outside it (memory held by other work): it keeps nothing. */
class SliceInterrupted extends Error {
  override name = "SliceInterrupted";
}

/** What a pull request shows of its code owners. */
export type CodeOwnersView =
  | { readonly state: "pending" }
  | {
      readonly state: "complete" | "none" | "too_large" | "unreadable";
      readonly reason: TooLargeReason | null;
      readonly retryAt: number | null;
      readonly file: { readonly path: string; readonly sha: string } | null;
      readonly errors: number;
      readonly rules: readonly {
        readonly line: number;
        readonly owners: readonly string[];
        readonly paths: number;
        readonly example: string;
      }[];
      readonly ownerlessPaths: number;
      readonly unmatchedPaths: number;
      readonly unmatchablePaths: number;
      readonly unmatchableExample: string | null;
      /** The evaluation's id and the last line listed, when more rules follow. */
      readonly next: { readonly evalId: number; readonly line: number } | null;
    };

/** What a merge judges its code owners by (see `RepoCodeOwners.forMerge`). */
export type MergeCodeOwners = { readonly stamp: string } & (
  | { readonly state: "none" }
  | { readonly state: "refused"; readonly reason: string }
  | {
      readonly state: "complete";
      readonly rules: readonly {
        readonly line: number;
        /** Its owners as written (`@handle`, `@org/slug`). */
        readonly owners: readonly string[];
        readonly example: string;
      }[];
    }
);

export interface CodeOwnersDeps {
  readonly git: RepoGitStorage;
  readonly pulls: RepoPulls;
  readonly memoryBlocks: () => BlockCache;
  /** Whether the repository takes changes (results wait while it does not). */
  readonly writable: () => boolean;
  readonly log: () => Logger;
}

type Job = { pr_number: number; seq: number; asked: number };
type Pointer = {
  base_ref: string;
  base_tip: string;
  head: string;
  version: number;
  eval_id: number | null;
  file_path: string | null;
  file_blob: string | null;
  outcome: string | null;
  reason: string | null;
  attempts: number;
  retry_at: number | null;
};
type EvalRow = {
  eval_id: number;
  state: "pending" | "complete" | "none" | "too_large";
  reason: string | null;
  errors: number;
  cursor: string | null;
  partial: string | null;
  totals: string | null;
  unmatched: number;
  unmatchable: number;
  unmatchable_example: string | null;
};

/** The pair (and more) a pull request's result must be worked out for. */
interface Target {
  readonly number: number;
  readonly baseRef: string;
  readonly baseTip: Oid;
  readonly head: string;
}

/** The file a base tip names: its location and blob, or none. */
type Located = { readonly path: string; readonly blob: Oid } | null;

export class RepoCodeOwners {
  /** Test seams. */
  readonly hooks: { beforePublish?: () => Promise<void>; afterCheckpoint?: () => void } = {};
  /** An evaluation's budgets (see `CODE_OWNER_LIMITS`), and a slice's reads (`CODE_OWNERS_POLICY`). */
  limits: CodeOwnerLimits = CODE_OWNER_LIMITS;
  policy: typeof CODE_OWNERS_POLICY = CODE_OWNERS_POLICY;
  /** Errors in a row the job waited out (in memory: a restart starts the delays over). */
  #failures = 0;
  /** Whether the slice just run did about what an invocation's CPU allows (see `heavySlice`). */
  #heavy = false;

  constructor(private readonly deps: CodeOwnersDeps) {}

  get #sql() {
    return this.deps.git.context.storage.sql;
  }

  #now(): number {
    return this.deps.git.context.now();
  }

  /**
   * In the transaction of a change of pull request `number`: queued when
   * open, ready and not shown for its current pair already; forgotten when
   * closed. A draft's queued run (asked for) is superseded.
   */
  stale(number: number, open: boolean): void {
    if (!open) {
      this.#run("DELETE FROM code_owner_jobs WHERE pr_number = ?", number);
      const dropped = this.#sql.exec("DELETE FROM code_owner_pointers WHERE pr_number = ?", number);
      this.#count(dropped.rowsWritten);
      // What it pointed at may be no one's now: the job prunes it.
      if (dropped.rowsWritten > 0) this.#ensureJob();
      return;
    }
    const pull = this.deps.pulls.get(number);
    if (!pull) return;
    if (pull.draft) {
      this.#run("UPDATE code_owner_jobs SET seq = seq + 1 WHERE pr_number = ?", number);
      return;
    }
    if (this.#shown(pull)) return;
    this.#queue(number, false);
  }

  /** In a commit's transaction: base branch `branch` moved, so its open ready pull requests' did. */
  staleBase(branch: string): void {
    const queued = this.#sql.exec(
      `INSERT INTO code_owner_jobs (pr_number, seq, requested_at)
       SELECT number, 1, ?1 FROM pull_requests WHERE base_ref = ?2 AND state = 'open' AND draft = 0
       ON CONFLICT (pr_number) DO UPDATE SET seq = seq + 1,
         requested_at = min(requested_at, excluded.requested_at)`,
      this.#now(),
      branch,
    );
    this.#count(queued.rowsWritten);
    if (queued.rowsWritten > 0) this.#ensureJob();
  }

  /** In a restore's transaction: every open pull request is checked again, a page a slice. */
  restored(): void {
    this.#run(
      "INSERT INTO code_owner_restore (id, after) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET after = 0",
    );
    this.#ensureJob();
  }

  /**
   * What pull request `number` shows, its rules after line `after` of
   * evaluation `evalId` (a later page), at most `limit`; undefined without
   * it, `closed` once it is not open, `stale_cursor` when a later page's
   * evaluation is no longer its. One not shown for its current pair is
   * queued (a draft too) and answers `pending`.
   */
  view(
    number: number,
    page: { readonly evalId: number; readonly after: number } | null,
    limit: number,
  ): CodeOwnersView | "closed" | "stale_cursor" | undefined {
    const pull = this.deps.pulls.get(number);
    if (!pull) return undefined;
    if (pull.state !== "open") return "closed";
    const pointer = this.#pointer(pull);
    if (!pointer) {
      if (page) return "stale_cursor";
      const queued = this.#rows<{ asked: number }>(
        "SELECT asked FROM code_owner_jobs WHERE pr_number = ?",
        number,
      )[0];
      if (!queued) this.deps.git.context.storage.transactionSync(() => this.#queue(number, true));
      // A draft queued before it became one: asked for now (its run is not superseded).
      else if (pull.draft && queued.asked === 0)
        this.#run("UPDATE code_owner_jobs SET asked = 1 WHERE pr_number = ?", number);
      return { state: "pending" };
    }
    if (page && page.evalId !== pointer.eval_id) return "stale_cursor";
    const shown = {
      // An unreadable outcome's reason is the job's own (why it waits): not shown.
      reason: pointer.outcome === "too_large" ? (pointer.reason as TooLargeReason) : null,
      retryAt: pointer.retry_at,
      file:
        pointer.file_path && pointer.file_blob
          ? { path: pointer.file_path, sha: pointer.file_blob }
          : null,
      errors: 0,
      rules: [],
      ownerlessPaths: 0,
      unmatchedPaths: 0,
      unmatchablePaths: 0,
      unmatchableExample: null,
      next: null,
    };
    if (pointer.eval_id === null)
      return { ...shown, state: pointer.outcome as "too_large" | "unreadable" };
    const evaluation = this.#evalRow(pointer.eval_id) as EvalRow;
    const rules = this.#rows<{ line: number; owners: string; paths: number; example: string }>(
      `SELECT line, owners, paths, example FROM code_owner_rules
       WHERE eval_id = ? AND line > ? ORDER BY line LIMIT ?`,
      pointer.eval_id,
      page?.after ?? 0,
      limit + 1,
    );
    const listed = rules.slice(0, limit);
    const last = listed.at(-1);
    return {
      ...shown,
      state: evaluation.state as "complete" | "none" | "too_large",
      reason: (evaluation.reason as TooLargeReason | null) ?? shown.reason,
      errors: evaluation.errors,
      rules: listed.map((r) => ({
        line: r.line,
        owners: JSON.parse(r.owners) as string[],
        paths: r.paths,
        example: r.example,
      })),
      ownerlessPaths:
        this.#rows<{ n: number | null }>(
          "SELECT sum(paths) AS n FROM code_owner_rules WHERE eval_id = ? AND owners = '[]'",
          pointer.eval_id,
        )[0]?.n ?? 0,
      unmatchedPaths: evaluation.unmatched,
      unmatchablePaths: evaluation.unmatchable,
      unmatchableExample: evaluation.unmatchable_example,
      next: rules.length > limit && last ? { evalId: pointer.eval_id, line: last.line } : null,
    };
  }

  /**
   * What a merge of `pull` judges its code owners by now: the rules that
   * decide a changed path and name owners (at most the parser's 1,000), or
   * that none are required (no CODEOWNERS at the base tip), or why they
   * cannot be judged; and the stamp of the result it read (the merge's
   * fence compares it at the commit). One not worked out for its current
   * pair is queued, as a read of it is.
   */
  forMerge(pull: PullRecord): MergeCodeOwners {
    const pointer = this.#pointer(pull);
    if (!pointer) {
      this.view(pull.number, null, 0);
      return {
        state: "refused",
        reason: "code owners are still being worked out",
        stamp: "pending",
      };
    }
    const stamp = stampOf(pointer);
    const evaluation = pointer.eval_id === null ? undefined : this.#evalRow(pointer.eval_id);
    if (!evaluation || evaluation.state === "too_large" || evaluation.state === "pending") {
      const why = evaluation?.reason ?? pointer.reason ?? pointer.outcome ?? "unreadable";
      return { state: "refused", reason: `code owners could not be worked out (${why})`, stamp };
    }
    if (evaluation.state === "none") return { state: "none", stamp };
    if (evaluation.errors > 0)
      return {
        state: "refused",
        reason: `CODEOWNERS has ${evaluation.errors} error${evaluation.errors === 1 ? "" : "s"}`,
        stamp,
      };
    if (evaluation.unmatchable > 0)
      return {
        state: "refused",
        reason: `${evaluation.unmatchable} changed path${evaluation.unmatchable === 1 ? "" : "s"} cannot be matched against CODEOWNERS (${evaluation.unmatchable_example ?? "not UTF-8"})`,
        stamp,
      };
    const rules = this.#rows<{ line: number; owners: string; example: string }>(
      `SELECT line, owners, example FROM code_owner_rules
       WHERE eval_id = ? AND paths > 0 AND owners <> '[]' ORDER BY line`,
      evaluation.eval_id,
    ).map((r) => ({ line: r.line, owners: JSON.parse(r.owners) as string[], example: r.example }));
    return { state: "complete", rules, stamp };
  }

  /** The stamp of what `pull` shows now, as `forMerge` gives it, read alone (for a merge's fence). */
  stampFor(pull: PullRecord): string {
    const pointer = this.#pointer(pull);
    return pointer ? stampOf(pointer) : "pending";
  }

  /** The queue's job: a restore's scan first, then one slice of the oldest due pull request, then pruning. */
  handler(): JobHandler {
    return {
      runSlice: async () => {
        // Results are written: not while the repository takes no changes.
        if (!this.deps.writable()) return { done: false, cursor: null, runAfterMs: 60_000 };
        try {
          const { more, evaluated } = await this.#slice();
          this.#failures = 0;
          // A slice that did much (see `heavySlice`) ends the invocation: the next runs in another.
          if (more) return { done: false, cursor: null, endInvocation: evaluated };
          const next = this.#nextAt();
          return next === null
            ? { done: true }
            : { done: false, cursor: null, runAfterMs: Math.max(0, next - this.#now()) };
        } catch (error) {
          // Whatever failed (a write refused when the day's allowance is spent, a read), it is
          // tried again later, never given up: the job's attempts are never spent.
          this.deps.log().warn("working out code owners failed", { error });
          this.#failures++;
          // Failed after heavy work: no other slice in this invocation either.
          return {
            done: false,
            cursor: null,
            runAfterMs: this.#retryDelay(this.#failures),
            endInvocation: this.#heavy,
          };
        }
      },
    };
  }

  /** One slice of the job's work: whether more is to do at once, and whether it evaluated. */
  async #slice(): Promise<{ more: boolean; evaluated: boolean }> {
    this.#heavy = false;
    const restore = this.#rows<{ after: number }>(
      "SELECT after FROM code_owner_restore WHERE id = 1",
    )[0];
    if (restore) {
      this.#restorePage(restore.after);
      return { more: true, evaluated: false };
    }
    const job = this.#rows<Job>(
      `SELECT pr_number, seq, asked FROM code_owner_jobs WHERE requested_at <= ?
       ORDER BY requested_at, pr_number LIMIT 1`,
      this.#now(),
    )[0];
    if (job) {
      await this.#work(job);
      return { more: true, evaluated: this.#heavy };
    }
    return { more: this.#prune() > 0, evaluated: false };
  }

  /** One page of a restore's scan: open ready pull requests not shown for their pair are queued. */
  #restorePage(after: number): void {
    const { policy } = this;
    const numbers = this.#rows<{ number: number }>(
      "SELECT number FROM pull_requests WHERE state = 'open' AND number > ? ORDER BY number LIMIT ?",
      after,
      policy.restorePage,
    ).map((row) => row.number);
    this.deps.git.context.storage.transactionSync(() => {
      for (const number of numbers) {
        const pull = this.deps.pulls.get(number);
        if (pull && !pull.draft && !this.#shown(pull)) this.#queue(number, false);
      }
      if (numbers.length < policy.restorePage)
        this.#run("DELETE FROM code_owner_restore WHERE id = 1");
      else
        this.#run("UPDATE code_owner_restore SET after = ? WHERE id = 1", numbers.at(-1) ?? after);
    });
  }

  /** One slice of pull request `job`'s evaluation, published when it ends and still stands. */
  async #work(job: Job): Promise<void> {
    const pull = this.deps.pulls.get(job.pr_number);
    const baseTip = pull && this.deps.pulls.branchTip(pull.baseRef);
    // Closed, a draft not asked about, or its base branch gone (made again, it is queued again).
    if (pull?.state !== "open" || (pull.draft && job.asked === 0) || !baseTip)
      return void this.#done(job);
    const target: Target = {
      number: pull.number,
      baseRef: pull.baseRef,
      baseTip,
      head: pull.headSha,
    };
    // Shown for its pair already: nothing to do, unless it was unreadable and its delay is over.
    const kept = this.#pointerFor(target);
    if (kept?.outcome === "unreadable" && (kept.retry_at ?? 0) > this.#now())
      return this.#defer(job.pr_number, kept.retry_at ?? this.#now());
    if (kept && kept.outcome !== "unreadable") return void this.#done(job);
    const head = oidFromHex(pull.headSha);
    const found = await mergeBaseOf(this.deps.git.commitGraph, baseTip, head);
    if (!found.ok && found.code === "too_expensive")
      return this.#publishOutcome(job, target, "too_large", "merge_base");
    if (!found.ok && found.code !== "no_merge_base")
      return this.#publishOutcome(job, target, "unreadable", null);
    const mergeBase = found.ok ? found.value : null;
    const graph = this.deps.git.commitGraph;
    const [baseRow, headRow, tipRow] = graph.readSync(
      [mergeBase ?? head, head, baseTip],
      "verified",
    );
    if ((mergeBase && !baseRow) || !headRow || !tipRow)
      return this.#publishOutcome(job, target, "unreadable", null);
    const { policy } = this;
    const counts = { reads: 0 };
    const reader = await openLiveReader(
      { git: this.deps.git, memoryBlocks: this.deps.memoryBlocks() },
      {
        deltaBaseCacheBytes: 4 * 1024 * 1024,
        maxCacheCalls: BROWSE_POLICY.cacheCalls,
        maxReads: policy.maxReads,
        maxBuiltBytes: policy.maxBuiltBytes,
        counts,
      },
    );
    if (!reader) return this.#publishOutcome(job, target, "unreadable", null);
    try {
      const memory = this.deps.git.memory;
      // What the diff needs first (the file's location, then its bytes), within the slice's
      // reads: a budget spent there is a slice without progress; an object too large is final.
      const first = <T>(read: () => Promise<T>, large: TooLargeReason) =>
        read().catch(async (error: unknown): Promise<typeof STOPPED> => {
          // Memory other work holds now: tried again shortly, no slice spent.
          if (error instanceof ReadsMemoryBusy) {
            this.#defer(job.pr_number, this.#now() + MEMORY_RETRY_MS);
            return STOPPED;
          }
          if (
            error instanceof ReadBudgetError ||
            error instanceof ReaderWorkSpent ||
            error instanceof ReadsBudgetSpent
          ) {
            this.#heavy = true;
            await this.#withoutProgress(job, target);
            return STOPPED;
          }
          if (error instanceof ReadsTooLargeError) {
            await this.#publishOutcome(job, target, "too_large", large);
            return STOPPED;
          }
          throw error;
        });
      const located = await first(
        () =>
          withHeldReads(
            reader,
            memory,
            { maxTreeBytes: policy.maxTreeBytes, maxReadBytes: policy.maxSliceTreeBytes },
            (reads) => locate(reads.readTree, tipRow.tree),
          ),
        "tree",
      );
      if (located === STOPPED) return;
      const key = {
        mergeBase: mergeBase ? oidToHex(mergeBase) : NONE,
        head: pull.headSha,
        blob: located ? oidToHex(located.blob) : NONE,
      };
      const row = this.#evaluation(key);
      if (row.state !== "pending") return this.#publish(job, target, located, row.eval_id);
      if (!located) {
        this.#finish(row.eval_id, { ...freshEvaluation(), state: "complete" }, "none", null);
        return this.#publish(job, target, located, row.eval_id);
      }
      const bytes = await first(
        () =>
          withHeldReads(
            reader,
            memory,
            { maxTreeBytes: policy.maxTreeBytes, maxReadBytes: MAX_CODEOWNERS_BYTES },
            (reads) => reads.readBlob(located.blob, MAX_CODEOWNERS_BYTES - 1),
          ),
        "file",
      );
      if (bytes === STOPPED) return;
      if (bytes === undefined) {
        this.#finish(
          row.eval_id,
          { ...freshEvaluation(), state: "too_large", reason: "file" },
          "too_large",
          null,
        );
        return this.#publish(job, target, located, row.eval_id);
      }
      // The parsed file is held from the object's memory while the slice uses it.
      const held = memory.tryReserve(Math.max(1, bytes.length * policy.fileMemoryPerByte));
      if (!held) return this.#defer(job.pr_number, this.#now() + MEMORY_RETRY_MS);
      let current: Evaluation;
      let next: Evaluation;
      let file: CodeOwnersFile;
      try {
        file = parseCodeOwners(bytes);
        // A checkpoint keeps its cursor, counts and totals together.
        current =
          row.partial === null || row.totals === null
            ? freshEvaluation()
            : deserializeEvaluation({
                cursor: row.cursor,
                partial: row.partial,
                totals: row.totals,
                errors: row.errors,
              });
        next = await withHeldReads(
          reader,
          memory,
          { maxTreeBytes: policy.maxTreeBytes, maxReadBytes: policy.maxSliceTreeBytes },
          (reads) =>
            evaluateSlice(
              async (oid) => {
                try {
                  return await reads.readTree(oid);
                } catch (error) {
                  // Memory other work holds now: the slice stops, keeping nothing, and is
                  // tried again shortly (not a slice without progress).
                  if (error instanceof ReadsMemoryBusy) throw new SliceInterrupted();
                  // A budget of the slice's spent: the next slice resumes before this tree.
                  if (
                    error instanceof ReadBudgetError ||
                    error instanceof ReaderWorkSpent ||
                    error instanceof ReadsBudgetSpent
                  ) {
                    // Its reads' budget spent: about what an invocation allows, whatever else.
                    this.#heavy = true;
                    throw new ReadDeferred();
                  }
                  throw error;
                }
              },
              mergeBase ? (baseRow as { tree: Oid }).tree : null,
              headRow.tree,
              file,
              current,
              this.limits,
            ),
        );
      } finally {
        held.release();
      }
      this.#heavy ||= heavySlice(bytes.length, current, next, this.limits.sliceSteps);
      if (next.state === "pending") {
        this.#checkpoint(row.eval_id, next);
        // It got further: a streak of slices that could not read what the diff needs first ends.
        if (next.totals.stalled === 0)
          this.#run(
            `DELETE FROM code_owner_pointers
             WHERE pr_number = ? AND outcome = 'unreadable' AND reason = 'budget'`,
            job.pr_number,
          );
        this.hooks.afterCheckpoint?.();
        // Others waiting take their turn before its next slice (no write when none waits).
        const waiting = this.#rows(
          "SELECT 1 FROM code_owner_jobs WHERE pr_number <> ? AND requested_at <= ? LIMIT 1",
          job.pr_number,
          this.#now(),
        );
        if (waiting.length > 0)
          this.#run(
            "UPDATE code_owner_jobs SET requested_at = ? WHERE pr_number = ? AND seq = ?",
            this.#now(),
            job.pr_number,
            job.seq,
          );
        return;
      }
      this.#finish(row.eval_id, next, next.state, file);
      return this.#publish(job, target, located, row.eval_id);
    } catch (error) {
      if (error instanceof SliceInterrupted)
        return this.#defer(job.pr_number, this.#now() + MEMORY_RETRY_MS);
      if (!(error instanceof UnreadableObjectError)) throw error;
      // An object the evaluation needs cannot be read: kept for the pair, tried again later.
      return this.#publishOutcome(job, target, "unreadable", null);
    } finally {
      reader.release();
    }
  }

  /** The evaluation for `key`, made pending when there is none. */
  #evaluation(key: { mergeBase: string; head: string; blob: string }): EvalRow {
    const select = () =>
      this.#rows<EvalRow>(
        `SELECT eval_id, state, reason, errors, cursor, partial, totals, unmatched, unmatchable,
           unmatchable_example FROM code_owner_evaluations
         WHERE merge_base = ? AND head = ? AND file_blob = ? AND version = ?`,
        key.mergeBase,
        key.head,
        key.blob,
        CODEOWNERS_EVALUATION_VERSION,
      )[0];
    const found = select();
    if (found) return found;
    this.#run(
      `INSERT INTO code_owner_evaluations (merge_base, head, file_blob, version, state, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      key.mergeBase,
      key.head,
      key.blob,
      CODEOWNERS_EVALUATION_VERSION,
      this.#now(),
    );
    return select() as EvalRow;
  }

  #checkpoint(evalId: number, evaluation: Evaluation): void {
    const stored = serializeEvaluation(evaluation);
    this.#run(
      `UPDATE code_owner_evaluations SET cursor = ?, partial = ?, totals = ?, errors = ?,
         updated_at = ? WHERE eval_id = ?`,
      stored.cursor,
      stored.partial,
      stored.totals,
      evaluation.errors,
      this.#now(),
      evalId,
    );
  }

  /** An evaluation's end, its rule rows with it: `complete`, `none` or `too_large`. */
  #finish(
    evalId: number,
    evaluation: Evaluation,
    state: "complete" | "none" | "too_large",
    file: CodeOwnersFile | null,
  ): void {
    this.deps.git.context.storage.transactionSync(() => {
      this.#run("DELETE FROM code_owner_rules WHERE eval_id = ?", evalId);
      if (state === "complete" && file) {
        const owners = new Map(file.rules.map((rule) => [rule.line, rule.owners]));
        for (const [line, counted] of evaluation.rules)
          this.#run(
            "INSERT INTO code_owner_rules (eval_id, line, owners, paths, example) VALUES (?, ?, ?, ?, ?)",
            evalId,
            line,
            JSON.stringify((owners.get(line) ?? []).map(token)),
            counted.paths,
            counted.example,
          );
      }
      this.#run(
        `UPDATE code_owner_evaluations SET state = ?, reason = ?, errors = ?, cursor = NULL,
           partial = NULL, totals = ?, unmatched = ?, unmatchable = ?, unmatchable_example = ?,
           updated_at = ? WHERE eval_id = ?`,
        state,
        evaluation.reason,
        evaluation.errors,
        JSON.stringify(evaluation.totals),
        evaluation.unmatched,
        evaluation.unmatchable,
        evaluation.unmatchableExample,
        this.#now(),
        evalId,
      );
    });
  }

  /** Points the pull request at evaluation `evalId`, if its run still stands (see `#fenced`). */
  async #publish(job: Job, target: Target, located: Located, evalId: number): Promise<void> {
    await this.hooks.beforePublish?.();
    this.deps.git.context.storage.transactionSync(() => {
      if (!this.#fenced(job, target)) return;
      this.#setPointer(target, {
        eval_id: evalId,
        file_path: located?.path ?? null,
        file_blob: located ? oidToHex(located.blob) : null,
        outcome: null,
        reason: null,
        attempts: 0,
        retry_at: null,
      });
      this.#done(job);
    });
  }

  /** Points the pull request at an outcome reached before an evaluation could be keyed. */
  /**
   * A slice that could not read what the diff needs first within its reads:
   * tried again (unreadable, its delay doubling) until as many slices in a
   * row as a stalled diff may have, then `too_large` (`stuck`).
   */
  async #withoutProgress(job: Job, target: Target): Promise<void> {
    const before = this.#pointerFor(target);
    const stalled =
      before?.outcome === "unreadable" && before.reason === "budget" ? before.attempts : 0;
    if (stalled + 1 >= this.limits.stalledSlices)
      return this.#publishOutcome(job, target, "too_large", "stuck");
    return this.#publishOutcome(job, target, "unreadable", "budget");
  }

  async #publishOutcome(
    job: Job,
    target: Target,
    outcome: "too_large" | "unreadable",
    /** Why: a `too_large`'s, or `budget` for an unreadable one whose reads were spent. */
    reason: TooLargeReason | "budget" | null,
  ): Promise<void> {
    // Unreadable for the same pair again, for the same cause: the delay doubles.
    const before = this.#pointerFor(target);
    const attempts =
      outcome === "unreadable"
        ? (before?.outcome === "unreadable" && before.reason === reason ? before.attempts : 0) + 1
        : 0;
    const retryAt = outcome === "unreadable" ? this.#now() + this.#retryDelay(attempts) : null;
    await this.hooks.beforePublish?.();
    this.deps.git.context.storage.transactionSync(() => {
      if (!this.#fenced(job, target)) return;
      this.#setPointer(target, {
        eval_id: null,
        file_path: null,
        file_blob: null,
        outcome,
        reason,
        attempts,
        retry_at: retryAt,
      });
      if (retryAt === null) this.#done(job);
      else this.#defer(job.pr_number, retryAt);
    });
  }

  /**
   * In the publishing transaction (no await since the run read what it
   * worked from): whether the run's queue entry is still the pull
   * request's, and the pull request is still open, ready (or asked about),
   * on the same base branch, base tip and head.
   */
  #fenced(job: Job, target: Target): boolean {
    if (!this.deps.writable()) return false;
    const queued = this.#rows<{ seq: number }>(
      "SELECT seq FROM code_owner_jobs WHERE pr_number = ?",
      job.pr_number,
    )[0];
    if (queued?.seq !== job.seq) return false;
    const pull = this.deps.pulls.get(job.pr_number);
    if (pull?.state !== "open" || (pull.draft && job.asked === 0)) return false;
    const tip = this.deps.pulls.branchTip(pull.baseRef);
    return (
      pull.baseRef === target.baseRef &&
      pull.headSha === target.head &&
      tip !== null &&
      oidToHex(tip) === oidToHex(target.baseTip)
    );
  }

  #setPointer(
    target: Target,
    shown: Omit<Pointer, "base_ref" | "base_tip" | "head" | "version">,
  ): void {
    this.#run(
      `INSERT INTO code_owner_pointers (pr_number, base_ref, base_tip, head, version, eval_id,
         file_path, file_blob, outcome, reason, attempts, retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pr_number) DO UPDATE SET base_ref = excluded.base_ref,
         base_tip = excluded.base_tip, head = excluded.head, version = excluded.version,
         eval_id = excluded.eval_id, file_path = excluded.file_path,
         file_blob = excluded.file_blob, outcome = excluded.outcome, reason = excluded.reason,
         attempts = excluded.attempts, retry_at = excluded.retry_at`,
      target.number,
      target.baseRef,
      oidToHex(target.baseTip),
      target.head,
      CODEOWNERS_EVALUATION_VERSION,
      shown.eval_id,
      shown.file_path,
      shown.file_blob,
      shown.outcome,
      shown.reason,
      shown.attempts,
      shown.retry_at,
    );
  }

  /** The pointer shown for pull request `pull` now: one for its current pair, of this version, whose evaluation exists. */
  #pointer(pull: PullRecord): Pointer | undefined {
    const tip = pull.state === "open" ? this.deps.pulls.branchTip(pull.baseRef) : null;
    if (!tip) return undefined;
    return this.#pointerFor({
      number: pull.number,
      baseRef: pull.baseRef,
      baseTip: tip,
      head: pull.headSha,
    });
  }

  #pointerFor(target: Target): Pointer | undefined {
    const pointer = this.#rows<Pointer>(
      `SELECT base_ref, base_tip, head, version, eval_id, file_path, file_blob, outcome, reason,
         attempts, retry_at FROM code_owner_pointers WHERE pr_number = ?`,
      target.number,
    )[0];
    if (
      !pointer ||
      pointer.base_ref !== target.baseRef ||
      pointer.base_tip !== oidToHex(target.baseTip) ||
      pointer.head !== target.head ||
      pointer.version !== CODEOWNERS_EVALUATION_VERSION
    )
      return undefined;
    if (pointer.eval_id !== null && !this.#evalRow(pointer.eval_id)) return undefined;
    return pointer;
  }

  /** Whether `pull` shows a result for its current pair. */
  #shown(pull: PullRecord): boolean {
    return this.#pointer(pull) !== undefined;
  }

  #evalRow(evalId: number): EvalRow | undefined {
    return this.#rows<EvalRow>(
      `SELECT eval_id, state, reason, errors, cursor, partial, totals, unmatched, unmatchable,
         unmatchable_example FROM code_owner_evaluations WHERE eval_id = ?`,
      evalId,
    )[0];
  }

  /** In a transaction: queues pull request `number` (a newer request supersedes a run under way). */
  #queue(number: number, asked: boolean): void {
    this.#run(
      `INSERT INTO code_owner_jobs (pr_number, seq, requested_at, asked) VALUES (?, 1, ?, ?)
       ON CONFLICT (pr_number) DO UPDATE SET seq = seq + 1,
         requested_at = min(requested_at, excluded.requested_at),
         asked = max(asked, excluded.asked)`,
      number,
      this.#now(),
      asked ? 1 : 0,
    );
    this.#ensureJob();
  }

  #done(job: Job): void {
    this.#run(
      "DELETE FROM code_owner_jobs WHERE pr_number = ? AND seq = ?",
      job.pr_number,
      job.seq,
    );
  }

  #defer(number: number, at: number): void {
    this.#run("UPDATE code_owner_jobs SET requested_at = ? WHERE pr_number = ?", at, number);
  }

  /** Deletes evaluations nothing points at (pending ones once past their grace); how many. */
  #prune(): number {
    const ids = this.#rows<{ eval_id: number }>(
      `SELECT eval_id FROM code_owner_evaluations e
       WHERE NOT EXISTS (SELECT 1 FROM code_owner_pointers p WHERE p.eval_id = e.eval_id)
         AND (e.state <> 'pending' OR e.updated_at < ?)
       LIMIT ?`,
      this.#now() - CODE_OWNERS_POLICY.pendingGraceMs,
      CODE_OWNERS_POLICY.pruneBatch,
    ).map((row) => row.eval_id);
    if (ids.length === 0) return 0;
    this.deps.git.context.storage.transactionSync(() => {
      const list = JSON.stringify(ids);
      this.#run(
        "DELETE FROM code_owner_rules WHERE eval_id IN (SELECT value FROM json_each(?))",
        list,
      );
      this.#run(
        "DELETE FROM code_owner_evaluations WHERE eval_id IN (SELECT value FROM json_each(?))",
        list,
      );
    });
    return ids.length;
  }

  #nextAt(): number | null {
    return (
      this.#rows<{ at: number | null }>("SELECT min(requested_at) AS at FROM code_owner_jobs")[0]
        ?.at ?? null
    );
  }

  #retryDelay(failures: number): number {
    const { retryFirstMs, retryMaxMs } = CODE_OWNERS_POLICY;
    return Math.min(retryFirstMs * 2 ** Math.max(0, failures - 1), retryMaxMs);
  }

  #ensureJob(): void {
    this.deps.git.jobs.ensure("code_owners", CODE_OWNERS_JOB_ID);
  }

  #run(query: string, ...bindings: SqlStorageValue[]): void {
    const cursor = this.#sql.exec(query, ...bindings);
    this.#count(cursor.rowsWritten);
  }

  #rows<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    const cursor = this.#sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.#count(cursor.rowsWritten);
    return rows;
  }

  #count(written: number): void {
    if (written > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "code_owners.write" },
        written,
      );
  }
}

/**
 * The CODEOWNERS file tree `root` names: the first of GitHub's locations
 * holding something; a regular file there is it, anything else (a
 * symlink, a submodule, a directory) is passed over (Fyrden's choice).
 */
async function locate(
  readTree: (oid: Oid) => Promise<readonly TreeEntry[]>,
  root: Oid,
): Promise<Located> {
  const trees = new Map<string, readonly TreeEntry[] | null>();
  const dir = async (path: string): Promise<readonly TreeEntry[] | null> => {
    if (trees.has(path)) return trees.get(path) ?? null;
    let entries: readonly TreeEntry[] | null = null;
    if (path === "") entries = await readTree(root);
    else {
      const parent = await dir("");
      const entry = parent?.find((e) => isTreeMode(e.mode) && decode(e.name) === path);
      entries = entry ? await readTree(entry.oid) : null;
    }
    trees.set(path, entries);
    return entries;
  };
  for (const location of CODEOWNERS_PATHS) {
    const slash = location.lastIndexOf("/");
    const entries = await dir(slash < 0 ? "" : location.slice(0, slash));
    const name = location.slice(slash + 1);
    const entry = entries?.find((e) => decode(e.name) === name);
    if (!entry) continue;
    // A regular file (executable or not); a symlink, submodule or directory is passed over.
    if ((entry.mode & 0o170000) === 0o100000) return { path: location, blob: entry.oid };
  }
  return null;
}

const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const decode = (name: Uint8Array) => utf8.decode(name);

/**
 * Whether a slice did enough that no other slice should share its
 * invocation's CPU: a large file parsed (64 KiB or more), many trees read,
 * changes matched or matcher steps spent, or no progress (a budget stopped
 * it: the next slice would repeat its work). A typical evaluation (a small
 * file, a few changes: about 30 ms of CPU, measured on Free) is not.
 * Proposed thresholds.
 */
function heavySlice(
  fileBytes: number,
  before: Evaluation,
  after: Evaluation,
  sliceSteps: number,
): boolean {
  const steps = after.totals.steps - before.totals.steps;
  return (
    fileBytes >= 64 * 1024 ||
    after.totals.stalled > before.totals.stalled ||
    after.totals.trees - before.totals.trees > 64 ||
    after.totals.changes - before.totals.changes > 1_000 ||
    // Many steps, or every step the slice had (its matcher stopped it).
    steps > 100_000 ||
    steps >= sliceSteps
  );
}

/** An owner as CODEOWNERS writes it. */
/** What a merge's fence compares of a pull request's code owners: its result and evaluator version. */
function stampOf(pointer: Pointer): string {
  return `${pointer.eval_id ?? pointer.outcome}:${pointer.version}`;
}

function token(owner: CodeOwner): string {
  return owner.kind === "user" ? `@${owner.handle}` : `@${owner.org}/${owner.slug}`;
}
