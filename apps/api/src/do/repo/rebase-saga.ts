import type { Job, JobHandler, RefActor, SliceResult } from "@fyrden/adapters-cloudflare/git";
import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import { type Oid, oidFromBytes, oidFromHex, oidToHex } from "@fyrden/git-core";
import { type PushReportSummary, readPushReport } from "../../git/chunked/head.js";
import { encodeJson } from "../../git/maintenance/storage.js";
import { reauthorizeByToken } from "../../git/push/reauthorize-token.js";
import { PUSH_BUSY, PUSH_CANCELLED, PUSH_EXPIRED } from "../../git/push/repo-push.js";
import { type Browsed, type BrowseFailure, fail } from "./browse.js";
import type { FeedActor } from "./feed.js";
import {
  FILE_WRITE_POLICY,
  type FileWriteDeps,
  packOf,
  type StoredUpload,
  storeUpload,
} from "./file-writes.js";
import { mergeRefused, PULL_CHANGED, UNREADABLE } from "./merge.js";
import type { MergeStamps, MergeStanding } from "./pull-discussion.js";
import type { PullRecord, RepoPulls } from "./pulls.js";
import {
  keepObjects,
  keptObjects,
  type RebasePolicy,
  type ReplayCursor,
  type Replayed,
  replayCommits,
} from "./rebase-replay.js";
import type { ReviewerConfirmations } from "./reviewer-confirmation.js";

/*
 * Rebase merges, as sagas. A rebase replays each of the pull request's
 * commits onto the base branch's tip, one after the other, then moves the
 * base branch to the last one. That can take more reads than one
 * invocation may make, so it runs as a job (`merge_saga`, one per pull
 * request) a request starts and drives as far as it can, the alarm going
 * on with it.
 *
 * Everything that decides the new commits' bytes is fixed when the saga
 * starts (the commits, the base tip, the committer and the time, the
 * signing key), so a step done again makes the same bytes. Each commit's
 * new objects are kept in the object's own storage, with the saga's
 * progress, in one transaction under the job's claim and the saga's
 * generation (bumped on each restart): a runner that lost the job writes
 * nothing. Nothing is published before the end, where every kept object
 * goes into one pack, finished through the push path as a merge is: the
 * merger's token checked again, the rulesets judged with the pull request's
 * records, the base branch moved from the tip the saga started from, and
 * in the same transaction the pull request merged and the saga done. The
 * replay itself (the commits chosen, their trees merged, their objects
 * kept) is `rebase-replay.ts`; this file is the saga around it.
 */

/** The job that drives the pull request's saga. */
export const rebaseJobId = (number: number) => `merge-saga:${number}`;

export interface RebaseDeps {
  /** The write deps of the current invocation: its signer is the key in use now. */
  readonly writeDeps: () => Promise<FileWriteDeps>;
  readonly pulls: RepoPulls;
  readonly repoId: () => string;
  /** The pull request's merge context now, for `method`. */
  readonly standing: (
    number: number,
    pull: PullRecord,
    method: "rebase",
    upToDate: boolean,
  ) => Promise<MergeStanding>;
  /** Confirms, at the commit, the reviewers whose approvals the merge counts. */
  readonly reviewers: ReviewerConfirmations;
  /** Internal-service calls the invocation has made so far. */
  readonly internalCalls: () => number;
  /** After a commit: what the object does after any commit it makes (outbox, audit). */
  readonly committed: () => void;
  readonly policy: () => RebasePolicy;
  /** `actor` as activity feeds see the merge it makes, and the merge's commit made with it. */
  readonly feedActor: (actor: Pick<RefActor, "principal" | "grantId">) => Promise<FeedActor>;
  readonly withFeed: <R>(actor: FeedActor, change: () => R) => R;
  /** For tests: runs before the final push is committed, and right after. */
  readonly hooks: () => {
    readonly beforeFinalize?: () => Promise<void>;
    readonly afterFinalize?: () => Promise<void>;
  };
}

export type SagaState = "running" | "done" | "failed";

/** A saga as a request sees it. */
export interface SagaView {
  readonly sagaId: string;
  readonly state: SagaState;
  readonly head: string;
  readonly baseRef: string;
  readonly baseTip: string;
  readonly commits: number;
  readonly next: number;
  readonly resultSha: string | null;
  readonly failure: BrowseFailure | null;
  /** Whether a request has answered its failure. */
  readonly reported: boolean;
}

export interface SagaStart {
  readonly number: number;
  readonly pull: PullRecord;
  readonly stamps: MergeStamps;
  readonly actor: Omit<RefActor, "via">;
  readonly baseRef: string;
  readonly baseTip: Oid;
  readonly baseTree: Oid;
  readonly head: Oid;
  readonly upToDate: boolean;
  readonly committer: { readonly name: string; readonly email: string };
  readonly keyId: string;
  readonly commits: readonly Oid[];
}

type SagaRow = {
  pr_number: number;
  saga_id: string;
  generation: number;
  state: SagaState;
  pull_json: string;
  stamps_json: string;
  actor_json: string;
  base_ref: string;
  base_tip: string;
  head: string;
  up_to_date: number;
  committer_json: string;
  committed_at: number;
  key_id: string;
  commits: ArrayBuffer;
  next: number;
  tip: string;
  tip_tree: string;
  staged_bytes: number;
  staged_objects: number;
  upload_json: string | null;
  result_sha: string | null;
  error_json: string | null;
  failures: number;
  reported: number;
  started_at: number;
  updated_at: number;
};

/** A refusal as a saga records it. */
const asFailure = (refusal: Browsed<never>): BrowseFailure =>
  refusal.ok ? fail(422, "rebase_failed", "The rebase was refused.") : refusal;

/** Rolls a transaction back when the saga or the job is no longer this runner's. */
class NotOwned extends Error {
  override name = "NotOwned";
}

const SIGNING_UNAVAILABLE = fail(
  422,
  "signing_unavailable",
  "Rebase merges sign every commit they make, and the server has no signing key.",
);
const BASE_MOVED = fail(
  405,
  "base_moved",
  "The base branch was modified while the rebase was being made; review it and try the merge again.",
);
const CHANGED = fail(
  409,
  "pull_changed",
  "The pull request changed while it was being merged; review it and try the merge again.",
);
const ABANDONED = fail(
  422,
  "too_expensive",
  "The rebase took too long to make here; rebase locally and push.",
);
const BROKEN = fail(
  422,
  "rebase_failed",
  "The rebase could not be made; try the merge again, or rebase locally and push.",
);
const NOTHING = fail(
  405,
  "not_mergeable",
  "Every commit of the pull request is already in the base branch: there is nothing to rebase.",
);
/** The pull request's saga (the latest one), its runs, and the job that drives it. */
export class RebaseSagas {
  readonly #log = createLogger({ op: "rebase.saga" });

  constructor(
    private readonly deps: RebaseDeps,
    private readonly git: FileWriteDeps["git"],
  ) {}

  get policy(): RebasePolicy {
    return this.deps.policy();
  }

  /** The pull request's latest saga, if any. */
  view(number: number): SagaView | undefined {
    const row = this.#row(number);
    if (!row) return undefined;
    return {
      sagaId: row.saga_id,
      state: row.state,
      head: row.head,
      baseRef: row.base_ref,
      baseTip: row.base_tip,
      commits: row.commits.byteLength / 20,
      next: row.next,
      resultSha: row.result_sha,
      failure: row.error_json ? (JSON.parse(row.error_json) as BrowseFailure) : null,
      reported: row.reported === 1,
    };
  }

  /**
   * The saga's failure, for a request to answer, once: true when this call
   * marked it answered (the next request starts a new saga).
   */
  report(number: number, sagaId: string): boolean {
    return (
      this.git.context.storage.sql.exec(
        `UPDATE merge_sagas SET reported = 1
         WHERE pr_number = ? AND saga_id = ? AND state = 'failed' AND reported = 0`,
        number,
        sagaId,
      ).rowsWritten > 0
    );
  }

  /** Sagas running now. */
  running(): number {
    return this.git.context.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM merge_sagas WHERE state = 'running'")
      .one().n;
  }

  /** Whether the job driving the pull request's saga is gone or has failed. */
  undriven(number: number): boolean {
    const state = this.git.jobs.get(rebaseJobId(number))?.state;
    return state === undefined || state === "failed" || state === "done";
  }

  /**
   * Starts a saga for the pull request, replacing its last one, and queues
   * its job: one transaction, so a saga never runs without a job to drive
   * it. Nothing starts when its last saga is still running or finished as
   * the pull request's merge (`taken`), when `current` says the pull
   * request is no longer as `input.pull` (`changed`), or when as many
   * sagas as the policy allows are running (`busy`).
   */
  start(input: SagaStart, current: () => boolean): "started" | "taken" | "changed" | "busy" {
    const { storage } = this.git.context;
    const now = this.git.context.now();
    const sagaId = crypto.randomUUID().replaceAll("-", "");
    const commits = new Uint8Array(input.commits.length * 20);
    input.commits.forEach((oid, i) => {
      commits.set(oid, i * 20);
    });
    return storage.transactionSync(() => {
      const last = this.#row(input.number);
      // A failure not answered yet is the next request's answer.
      if (
        last?.state === "running" ||
        last?.state === "done" ||
        (last?.state === "failed" && last.reported === 0)
      )
        return "taken";
      if (!current()) return "changed";
      if (this.running() >= this.policy.maxRunning) return "busy";
      if (last) this.#dropObjects(last.saga_id);
      storage.sql.exec(
        `INSERT OR REPLACE INTO merge_sagas (pr_number, saga_id, generation, state, pull_json,
           stamps_json, actor_json, base_ref, base_tip, head, up_to_date, committer_json,
           committed_at, key_id, commits, next, tip, tip_tree, staged_bytes, staged_objects,
           upload_json, result_sha, error_json, failures, started_at, updated_at)
         VALUES (?, ?, 1, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0,
           NULL, NULL, NULL, 0, ?, ?)`,
        input.number,
        sagaId,
        JSON.stringify(input.pull),
        JSON.stringify(input.stamps),
        JSON.stringify(input.actor),
        input.baseRef,
        oidToHex(input.baseTip),
        oidToHex(input.head),
        input.upToDate ? 1 : 0,
        JSON.stringify(input.committer),
        Math.floor(now / 1000),
        input.keyId,
        commits.buffer,
        oidToHex(input.baseTip),
        oidToHex(input.baseTree),
        now,
        now,
      );
      // A slice still running the last saga loses the job: its end is not this saga's.
      this.git.jobs.restart("merge_saga", rebaseJobId(input.number));
      return "started";
    });
  }

  /**
   * Gives up the pull request's running saga `sagaId` from outside its job
   * (a request replacing it): its objects go, and its final push if one was
   * stored. The job's runner, if any, finds it no longer its own.
   */
  async abandon(number: number, sagaId: string, failure: BrowseFailure): Promise<void> {
    const row = this.#row(number);
    if (row?.state !== "running" || row.saga_id !== sagaId) return;
    // Replaced, not refused: nothing for a request to answer.
    if (this.#settle(row, "failed", failure, null, true)) await this.#discardUpload(row);
  }

  /** Drives the pull request's saga: `request` stops early and leaves the rest to the alarm. */
  handler(mode: "request" | "alarm"): JobHandler {
    return {
      runSlice: async (job) => {
        const number = Number(job.jobId.slice("merge-saga:".length));
        // The saga this slice runs: a later one (a request replaced it meanwhile) is not its.
        const row = this.#row(number);
        if (row?.state !== "running") return { done: true };
        let result: SliceResult;
        try {
          result = await this.#slice(job, row, mode);
        } catch (error) {
          result = await this.#failedSlice(job, row, error);
        }
        // A saga started meanwhile (a request replaced the one this slice ran): go on with it.
        if (result.done && this.#row(number)?.state === "running")
          return { done: false, cursor: null, runAfterMs: 0 };
        return result;
      },
    };
  }

  async #slice(job: Job, row: SagaRow, mode: "request" | "alarm"): Promise<SliceResult> {
    const number = row.pr_number;
    if (this.git.context.now() - row.started_at > this.policy.maxAgeMs)
      return this.#fail(job, row, ABANDONED);
    const pull = JSON.parse(row.pull_json) as PullRecord;
    if (!this.deps.pulls.mergeFence(number, pull)) return this.#fail(job, row, CHANGED);
    const baseTip = this.deps.pulls.branchTip(row.base_ref.slice("refs/heads/".length));
    if (!baseTip || oidToHex(baseTip) !== row.base_tip) return this.#fail(job, row, BASE_MOVED);
    const writeDeps = await this.deps.writeDeps();
    const keyId = writeDeps.signer?.keyId;
    if (!keyId) return this.#fail(job, row, SIGNING_UNAVAILABLE);
    // The key changed: nothing was published, so the saga starts again under the new one.
    if (keyId !== row.key_id) return this.#restart(job, row, keyId);
    if (row.next < row.commits.byteLength / 20) return this.#replay(job, row, writeDeps, mode);
    return this.#finish(job, row, writeDeps);
  }

  /** Replays commits from `next` within the slice's bounds, each kept in its own transaction. */
  async #replay(
    job: Job,
    row: SagaRow,
    writeDeps: FileWriteDeps,
    mode: "request" | "alarm",
  ): Promise<SliceResult> {
    const at: ReplayCursor = {
      next: row.next,
      tip: oidFromHex(row.tip),
      tipTree: oidFromHex(row.tip_tree),
      bytes: row.staged_bytes,
      objects: row.staged_objects,
    };
    const end = await replayCommits(this.git, {
      sagaId: row.saga_id,
      commits: new Uint8Array(row.commits),
      at,
      committer: JSON.parse(row.committer_json) as { name: string; email: string },
      committedAt: row.committed_at,
      writeDeps,
      mode,
      policy: () => this.policy,
      internalCalls: this.deps.internalCalls,
      stage: (made) => this.#stage(job, row, at, made),
    });
    return end.kind === "refused"
      ? this.#fail(job, row, end.failure)
      : this.#later(row, end.runAfterMs);
  }

  /**
   * Keeps one replayed commit's objects and moves the saga past it, in
   * one transaction under the job's claim; false when the saga or the job
   * is no longer this runner's (nothing written).
   */
  #stage(job: Job, row: SagaRow, at: ReplayCursor, made: Replayed): boolean {
    const { storage } = this.git.context;
    const objects = keptObjects(made, this.policy);
    try {
      const kept = storage.transactionSync(() => {
        if (!this.git.jobs.checkpoint(job, this.#cursor(row))) throw new NotOwned();
        const { bytes, count, tip, tree } = keepObjects(
          this.git,
          { sagaId: row.saga_id, at, made, objects },
          this.policy,
        );
        const moved = storage.sql.exec(
          `UPDATE merge_sagas SET next = next + 1, tip = ?, tip_tree = ?,
             staged_bytes = staged_bytes + ?, staged_objects = staged_objects + ?, failures = 0,
             updated_at = ?
           WHERE saga_id = ? AND generation = ? AND state = 'running' AND next = ?`,
          oidToHex(tip),
          oidToHex(tree),
          bytes,
          count,
          this.git.context.now(),
          row.saga_id,
          row.generation,
          at.next,
        ).rowsWritten;
        if (moved === 0) throw new NotOwned();
        return { bytes, count, tip, tree };
      });
      at.next++;
      at.tip = kept.tip;
      at.tipTree = kept.tree;
      at.bytes += kept.bytes;
      at.objects += kept.count;
      return true;
    } catch (error) {
      if (error instanceof NotOwned) return false;
      throw error;
    }
  }

  /** Every commit replayed: one pack of the kept objects, stored, indexed and committed. */
  async #finish(job: Job, row: SagaRow, writeDeps: FileWriteDeps): Promise<SliceResult> {
    const number = row.pr_number;
    if (row.tip === row.base_tip) return this.#fail(job, row, NOTHING);
    // Indexing and the commit need a fresh share of the invocation's calls.
    if (this.deps.internalCalls() > this.policy.finishCalls)
      return this.#later(row, this.policy.waitMs);
    const actor = JSON.parse(row.actor_json) as Omit<RefActor, "via">;
    const writer = {
      principal: actor.principal,
      tokenId: actor.tokenId ?? "",
      grantId: actor.grantId ?? null,
      repoId: this.deps.repoId(),
      requestId: actor.requestId ?? null,
    };
    let upload = row.upload_json ? (JSON.parse(row.upload_json) as StoredUpload) : undefined;
    if (!upload) {
      const stored = await this.#store(row, writeDeps, writer);
      if (stored === "short") return this.#later(row, this.policy.waitMs);
      if (!stored.ok)
        return stored.code === "busy"
          ? this.#later(row, this.policy.waitMs)
          : this.#fail(job, row, stored);
      if (!this.#attach(job, row, stored.value)) {
        await this.#discard(writeDeps, stored.value);
        return this.#later(row, 0);
      }
      upload = stored.value;
    }
    // A runner that lost the job leaves the push for the one that took it over.
    const yields = () => !this.git.jobs.checkpoint(job, this.#cursor(row));
    const progress = await writeDeps.push.status(
      upload.uploadId,
      FILE_WRITE_POLICY.indexStepMs,
      yields,
    );
    if (progress.state === "indexing") return this.#later(row, this.policy.waitMs);
    if (progress.state === "done") {
      // Committed by an earlier run of this step.
      if (this.#row(number)?.state === "done") return { done: true };
      // Settled without its commit (refused when planned, cancelled, expired): a new push is
      // made, a bounded number of times.
      return this.#pushSettled(job, row, upload, readPushReport(progress.response));
    }
    // Indexing may have spent the invocation's calls: the commit (its checks) waits for fresh ones.
    if (this.deps.internalCalls() > this.policy.commitCalls)
      return this.#later(row, this.policy.waitMs);
    const pull = JSON.parse(row.pull_json) as PullRecord;
    const standing = await this.deps.standing(number, pull, "rebase", row.up_to_date === 1);
    // Bound, with no await since, to the ownership the reviewers were just judged under.
    const confirm = this.deps.reviewers.for(standing.ceilings);
    const decision = await reauthorizeByToken(writeDeps.db, writer, writeDeps.writerRole);
    const tip = oidFromHex(row.tip);
    // A runner that lost the job leaves the push to the one that took it over.
    if (!this.git.jobs.checkpoint(job, this.#cursor(row))) return this.#later(row, 0);
    const feedActor = await this.deps.feedActor(actor);
    await this.deps.hooks().beforeFinalize?.();
    let response: Uint8Array;
    try {
      response = await writeDeps.push.finalize(upload.uploadId, decision, {
        repoId: writer.repoId,
        via: "merge",
        yields,
        merge: standing.merge,
        confirm,
        fence: () => {
          if (!this.git.jobs.checkpoint(job, this.#cursor(row))) return PULL_CHANGED;
          const now = this.#row(number);
          if (
            now?.saga_id !== row.saga_id ||
            now.generation !== row.generation ||
            now.state !== "running"
          )
            return PULL_CHANGED;
          if (!this.deps.pulls.mergeFence(number, pull)) return PULL_CHANGED;
          return JSON.stringify(standing.stamps()) === row.stamps_json ? undefined : PULL_CHANGED;
        },
        inCommit: () => {
          this.deps.withFeed(feedActor, () =>
            this.deps.pulls.markMerged(
              number,
              // Its push moves the branch from `base_tip` only.
              { sha: tip, base: oidFromHex(row.base_tip), method: "rebase" },
              { ...actor, via: "merge" },
              this.git.context.now(),
            ),
          );
          if (!this.#settle(row, "done", null, row.tip))
            throw new Error("the rebase is no longer this run's");
        },
      });
      await this.deps.hooks().afterFinalize?.();
    } catch (error) {
      // Past its commit, the saga is done whatever failed after.
      if (this.#row(number)?.state !== "done") throw error;
      this.deps.committed();
      return { done: true };
    }
    this.deps.committed();
    const report = readPushReport(response);
    if (report.ok) return { done: true };
    // Cancelled, expired or kept from the commit lock before it could commit: as at the status
    // above, made again.
    if ([PUSH_CANCELLED, PUSH_EXPIRED, PUSH_BUSY].some((m) => report.error.includes(m)))
      return this.#pushSettled(job, row, upload, report);
    // Refused at the commit point: the push has settled its upload.
    return this.#fail(job, row, asFailure(mergeRefused(report)), true);
  }

  /** The kept objects as one pack, stored as the final push's body. */
  async #store(
    row: SagaRow,
    writeDeps: FileWriteDeps,
    writer: Parameters<typeof storeUpload>[1],
  ): Promise<Browsed<StoredUpload> | "short"> {
    // The objects, the pack builder's chunks and the pack, as a merge holds them.
    const memory = this.git.memory.tryReserve(3 * row.staged_bytes + 1024 * 1024);
    if (!memory) return "short";
    try {
      const objects = this.git.context.storage.sql
        .exec<{ oid: ArrayBuffer; type: "blob" | "tree" | "commit"; data: ArrayBuffer }>(
          "SELECT oid, type, data FROM merge_saga_objects WHERE saga_id = ? ORDER BY rowid",
          row.saga_id,
        )
        .toArray()
        .map((o) => ({
          type: o.type,
          oid: oidFromBytes(new Uint8Array(o.oid)),
          data: new Uint8Array(o.data),
        }));
      const pack = await packOf(this.git, objects);
      return await storeUpload(writeDeps, writer, {
        ref: row.base_ref,
        head: oidFromHex(row.base_tip),
        commit: oidFromHex(row.tip),
        pack,
      });
    } finally {
      memory.release();
    }
  }

  /** Records the stored final push as the saga's, under the job's claim; false when not its own. */
  #attach(job: Job, row: SagaRow, upload: StoredUpload): boolean {
    const { storage } = this.git.context;
    try {
      return storage.transactionSync(() => {
        if (!this.git.jobs.checkpoint(job, this.#cursor(row))) throw new NotOwned();
        const written = storage.sql.exec(
          `UPDATE merge_sagas SET upload_json = ?, updated_at = ?
           WHERE saga_id = ? AND generation = ? AND state = 'running' AND upload_json IS NULL`,
          JSON.stringify(upload),
          this.git.context.now(),
          row.saga_id,
          row.generation,
        ).rowsWritten;
        if (written === 0) throw new NotOwned();
        return true;
      });
    } catch (error) {
      if (error instanceof NotOwned) return false;
      throw error;
    }
  }

  /** A final push settled without its commit: made again, a bounded number of times. */
  #pushSettled(
    job: Job,
    row: SagaRow,
    upload: StoredUpload,
    report: PushReportSummary,
  ): Promise<SliceResult> | SliceResult {
    const refusal = asFailure(mergeRefused(report));
    if (row.failures + 1 >= this.policy.maxFailures) return this.#fail(job, row, refusal, true);
    this.#detach(job, row, upload);
    return this.#later(row, 0);
  }

  /** Forgets the saga's settled final push (counted as a failure), under the job's claim. */
  #detach(job: Job, row: SagaRow, upload: StoredUpload): void {
    const { storage } = this.git.context;
    storage.transactionSync(() => {
      if (!this.git.jobs.checkpoint(job, this.#cursor(row))) return;
      storage.sql.exec(
        `UPDATE merge_sagas SET upload_json = NULL, failures = failures + 1, updated_at = ?
         WHERE saga_id = ? AND generation = ? AND state = 'running' AND upload_json = ?`,
        this.git.context.now(),
        row.saga_id,
        row.generation,
        JSON.stringify(upload),
      );
    });
  }

  /** Starts the saga again under another signing key: its kept objects and final push go. */
  async #restart(job: Job, row: SagaRow, keyId: string): Promise<SliceResult> {
    const { storage } = this.git.context;
    const [base] = this.git.commitGraph.readSync([oidFromHex(row.base_tip)], "verified");
    if (!base) return this.#fail(job, row, UNREADABLE);
    let restarted = false;
    try {
      restarted = storage.transactionSync(() => {
        if (!this.git.jobs.checkpoint(job, this.#cursor(row))) throw new NotOwned();
        const written = storage.sql.exec(
          `UPDATE merge_sagas SET generation = generation + 1, key_id = ?, next = 0, tip = ?,
             tip_tree = ?, staged_bytes = 0, staged_objects = 0, upload_json = NULL,
             failures = 0, updated_at = ?
           WHERE saga_id = ? AND generation = ? AND state = 'running'`,
          keyId,
          row.base_tip,
          oidToHex(base.tree),
          this.git.context.now(),
          row.saga_id,
          row.generation,
        ).rowsWritten;
        if (written === 0) throw new NotOwned();
        this.#dropObjects(row.saga_id);
        return true;
      });
    } catch (error) {
      if (!(error instanceof NotOwned)) throw error;
    }
    if (restarted) {
      this.#log.info("rebase restarted under a new signing key", { saga: row.saga_id });
      await this.#discardUpload(row);
    }
    return this.#later(row, 0);
  }

  /**
   * Fails the saga with `failure`, under the job's claim: its kept objects
   * go, and its final push unless the push settled it (`settled`).
   */
  async #fail(
    job: Job,
    row: SagaRow,
    failure: BrowseFailure,
    settled = false,
  ): Promise<SliceResult> {
    let failed = false;
    try {
      failed = this.git.context.storage.transactionSync(() => {
        if (!this.git.jobs.checkpoint(job, this.#cursor(row))) throw new NotOwned();
        if (!this.#settle(row, "failed", failure)) throw new NotOwned();
        return true;
      });
    } catch (error) {
      if (!(error instanceof NotOwned)) throw error;
    }
    if (failed && !settled) await this.#discardUpload(row);
    return { done: true };
  }

  /** An unexpected error: counted, and the saga given up after a few in a row. */
  async #failedSlice(job: Job, entry: SagaRow, error: unknown): Promise<SliceResult> {
    // Counted against the saga the slice ran, as it is now (the slice may have moved it on).
    const row = this.#row(entry.pr_number);
    if (
      row?.state !== "running" ||
      row.saga_id !== entry.saga_id ||
      row.generation !== entry.generation
    )
      return { done: true };
    this.#log.error("rebase step failed", { saga: row.saga_id, error });
    if (row.failures + 1 >= this.policy.maxFailures) return this.#fail(job, row, BROKEN);
    const { storage } = this.git.context;
    storage.transactionSync(() => {
      if (!this.git.jobs.checkpoint(job, this.#cursor(row))) return;
      storage.sql.exec(
        `UPDATE merge_sagas SET failures = failures + 1, updated_at = ?
         WHERE saga_id = ? AND generation = ? AND state = 'running'`,
        this.git.context.now(),
        row.saga_id,
        row.generation,
      );
    });
    return this.#later(row, this.policy.retryMs);
  }

  /**
   * Ends the saga's run as `state` (from running, at its generation only:
   * a finished saga never changes again), its kept objects deleted. False
   * when it was not running at that generation.
   */
  #settle(
    row: SagaRow,
    state: "done" | "failed",
    failure: BrowseFailure | null,
    resultSha: string | null = null,
    reported = false,
  ): boolean {
    const written = this.git.context.storage.sql.exec(
      `UPDATE merge_sagas SET state = ?, error_json = ?, result_sha = ?, reported = ?,
         updated_at = ?
       WHERE saga_id = ? AND generation = ? AND state = 'running'`,
      state,
      failure ? JSON.stringify(failure) : null,
      resultSha,
      reported ? 1 : 0,
      this.git.context.now(),
      row.saga_id,
      row.generation,
    ).rowsWritten;
    if (written === 0) return false;
    this.#dropObjects(row.saga_id);
    return true;
  }

  /** Aborts the saga's stored final push, if any (an expired upload is reaped anyway). */
  async #discardUpload(row: SagaRow): Promise<void> {
    if (!row.upload_json) return;
    const upload = JSON.parse(row.upload_json) as StoredUpload;
    try {
      await this.#discard(await this.deps.writeDeps(), upload);
    } catch (error) {
      this.#log.warn("rebase cleanup left its push for the reaper", { saga: row.saga_id, error });
    }
  }

  async #discard(writeDeps: FileWriteDeps, upload: StoredUpload): Promise<void> {
    await writeDeps.push.abort(upload.uploadId);
    await this.git.bucket.delete([...upload.keys]).catch(() => undefined);
  }

  #later(row: SagaRow, runAfterMs: number): SliceResult {
    return { done: false, cursor: this.#cursor(row), runAfterMs };
  }

  #cursor(row: SagaRow): Uint8Array {
    return encodeJson({ saga: row.saga_id, generation: row.generation });
  }

  #dropObjects(sagaId: string): void {
    this.git.context.storage.sql.exec("DELETE FROM merge_saga_objects WHERE saga_id = ?", sagaId);
  }

  #row(number: number): SagaRow | undefined {
    return this.git.context.storage.sql
      .exec<SagaRow>("SELECT * FROM merge_sagas WHERE pr_number = ?", number)
      .toArray()[0];
  }
}
