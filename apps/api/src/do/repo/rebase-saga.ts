import type { Job, JobHandler, RefActor, SliceResult } from "@fyrden/adapters-cloudflare/git";
import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import type { MergeContext } from "@fyrden/domain";
import {
  createSha1Hasher,
  hashObject,
  type Ident,
  MergeBudget,
  type MergeConflict,
  MergeLimitError,
  mergeTrees,
  type NewObject,
  type ObjectSource,
  type Oid,
  oidFromBytes,
  oidFromHex,
  oidToHex,
  parseTree,
  reachableCommits,
  replayCommit,
  type TreeEntry,
  WalkLimitError,
} from "@fyrden/git-core";
import { type PushReportSummary, readPushReport } from "../../git/chunked/head.js";
import { ReadBudgetError } from "../../git/live-reader.js";
import { encodeJson } from "../../git/maintenance/storage.js";
import { reauthorizeByToken } from "../../git/push/reauthorize-token.js";
import { PUSH_BUSY, PUSH_CANCELLED, PUSH_EXPIRED } from "../../git/push/repo-push.js";
import { type Browsed, type BrowseFailure, fail } from "./browse.js";
import type { FeedActor } from "./feed.js";
import {
  FILE_WRITE_POLICY,
  type FileWriteDeps,
  ident,
  packOf,
  type StoredUpload,
  storeUpload,
} from "./file-writes.js";
import {
  MERGE_POLICY,
  MergeTooLargeError,
  mergeRefused,
  PULL_CHANGED,
  TOO_EXPENSIVE,
  UNREADABLE,
  UnreadableObjectError,
  withSource,
} from "./merge.js";
import type { PullRecord, RepoPulls } from "./pulls.js";

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
 * in the same transaction the pull request merged and the saga done.
 */

/** Limits of a rebase merge. Proposed (Workers Free: 1,000 subrequests, 128 MB). */
export const REBASE_POLICY = {
  /** Commits a rebase replays (else `too_expensive`). */
  maxCommits: 250,
  /** Bytes of new objects a saga keeps, its signed commits included (as a merge makes). */
  maxStagedBytes: MERGE_POLICY.maxOutputBytes,
  /** New objects a saga keeps: each is a row written, and deleted at the end. */
  maxStagedObjects: 2_000,
  /** The largest object kept (SQLite rows hold at most 2 MB). */
  maxObjectBytes: 1024 * 1024,
  /** Commits one slice replays. */
  commitsPerSlice: 25,
  /**
   * R2 reads one slice makes; a commit that needs more alone is
   * `too_expensive`. Under the 200 calls the job queue leaves a slice
   * (it starts one with up to 800 made).
   */
  sliceReads: 120,
  /** Internal calls past which a request stops replaying and leaves the rest to the alarm. */
  requestCalls: 400,
  /**
   * Internal calls past which finishing (storing the pack, indexing it,
   * committing) waits for a fresh invocation: indexing's first
   * connectivity batch checks up to 512 objects within the 1,000 calls.
   */
  finishCalls: 200,
  /** Internal calls past which, its push indexed, the commit waits for a fresh invocation. */
  commitCalls: 600,
  /** How long a request drives its saga before it answers. */
  requestMs: 15_000,
  /** Sagas running at once in one repository (their objects are kept here). */
  maxRunning: 3,
  /** A saga still running after this is given up. */
  maxAgeMs: 60 * 60_000,
  /** Unexpected errors in a row after which a saga is given up. */
  maxFailures: 3,
  /** Delay before a slice after an unexpected error. */
  retryMs: 5_000,
  /** Delay before looking at the final push's indexing again, or waiting for a fresh invocation. */
  waitMs: 1_000,
} as const;
export type RebasePolicy = { readonly [K in keyof typeof REBASE_POLICY]: number };

/** The job that drives the pull request's saga. */
export const rebaseJobId = (number: number) => `merge-saga:${number}`;

/** What the fence compares: the pull request's reviews, threads and eligible reviewers. */
export interface MergeStamps {
  readonly reviews: string;
  readonly threads: string;
  readonly eligible: string;
}

/** The pull request's merge context and stamps, as `mergePull` works them out. */
export interface MergeStanding {
  readonly merge: MergeContext;
  /** The stamps now (called again in the commit's transaction). */
  readonly stamps: () => MergeStamps;
}

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

/** The smallest tree entry: mode, space, a one-byte name, NUL, a 20-byte id. */
const MIN_TREE_ENTRY_BYTES = 28;

/** A new object a step keeps. */
type Kept = NewObject | { readonly type: "commit"; readonly oid: Oid; readonly bytes: Uint8Array };

/** A refusal as a saga records it. */
const asFailure = (refusal: Browsed<never>): BrowseFailure =>
  refusal.ok ? fail(422, "rebase_failed", "The rebase was refused.") : refusal;

/** A commit that stops the rebase (it conflicts, or is too large): the saga fails with it. */
class ReplayRefusal extends Error {
  override name = "ReplayRefusal";
  constructor(readonly failure: BrowseFailure) {
    super(failure.error);
  }
}

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
const TOO_MANY_OBJECTS = fail(
  422,
  "too_expensive",
  "The rebase makes more new objects than one may make here; rebase locally and push.",
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
    const commits = new Uint8Array(row.commits);
    const committer = JSON.parse(row.committer_json) as { name: string; email: string };
    const at = {
      next: row.next,
      tip: oidFromHex(row.tip),
      tipTree: oidFromHex(row.tip_tree),
      bytes: row.staged_bytes,
      objects: row.staged_objects,
    };
    let replayed = 0;
    let budgetLeft = false;
    const holds: { release(): void }[] = [];
    try {
      await withSource(
        writeDeps,
        { ...MERGE_POLICY, maxReads: this.policy.sliceReads },
        async (live, readCommit) => {
          const source = this.#overlay(row.saga_id, live, holds);
          while (at.next * 20 < commits.length && replayed < this.policy.commitsPerSlice) {
            if (mode === "request" && this.deps.internalCalls() >= this.policy.requestCalls) {
              budgetLeft = true;
              return;
            }
            const commit = oidFromBytes(commits, at.next * 20);
            const made = await this.#replayOne(source, readCommit, commit, at, {
              committer: ident(committer, row.committed_at),
              signer: writeDeps.signer,
            });
            if (!this.#stage(job, row, at, made)) return;
            replayed++;
          }
        },
      );
    } catch (error) {
      if (error instanceof ReplayRefusal) return this.#fail(job, row, error.failure);
      // Out of this slice's reads: the next slice goes on, unless one commit alone needs more.
      if (error instanceof ReadBudgetError && replayed > 0) return this.#later(row, 0);
      if (
        error instanceof ReadBudgetError ||
        error instanceof MergeLimitError ||
        error instanceof MergeTooLargeError ||
        error instanceof WalkLimitError
      )
        return this.#fail(job, row, TOO_EXPENSIVE);
      if (error instanceof UnreadableObjectError) return this.#fail(job, row, UNREADABLE);
      throw error;
    } finally {
      for (const held of holds.splice(0)) held.release();
    }
    // A request out of calls stops here; the alarm goes on (a delay ends the request's run).
    return this.#later(row, budgetLeft ? 1 : 0);
  }

  /** One commit replayed onto `at.tip`: its new objects, or nothing when it comes out empty. */
  async #replayOne(
    source: ObjectSource,
    readCommit: (oid: Oid) => Promise<Uint8Array>,
    commit: Oid,
    at: { tip: Oid; tipTree: Oid },
    made: { committer: Ident; signer: FileWriteDeps["signer"] },
  ): Promise<{ tip: Oid; tree: Oid; objects: readonly Kept[] } | "dropped"> {
    const graph = this.git.commitGraph;
    const [row] = graph.readSync([commit], "verified");
    const parentOid = row?.parents.length === 1 ? row.parents[0] : undefined;
    const [parent] = parentOid ? graph.readSync([parentOid], "verified") : [];
    if (!row || !parent) throw new UnreadableObjectError();
    const same = (a: Oid, b: Oid) => oidToHex(a) === oidToHex(b);
    let tree: Oid;
    let objects: readonly Kept[] = [];
    if (same(row.tree, parent.tree)) {
      // Empty from the start: kept, as git rebase keeps it.
      tree = at.tipTree;
    } else if (same(parent.tree, at.tipTree)) {
      tree = row.tree;
    } else {
      const merged = await mergeTrees(source, parent.tree, at.tipTree, row.tree, {
        maxFileBytes: MERGE_POLICY.maxFileBytes,
        budget: new MergeBudget(
          MERGE_POLICY.maxTrees,
          MERGE_POLICY.maxFileMerges,
          MERGE_POLICY.maxOutputBytes,
        ),
      });
      if (merged.kind === "conflicts")
        throw new ReplayRefusal(conflictsIn(oidToHex(commit), merged.conflicts));
      // Its changes are in the base already: dropped, as git rebase drops it.
      if (same(merged.tree, at.tipTree)) return "dropped";
      tree = merged.tree;
      objects = merged.objects;
    }
    const bytes = await replayCommit(await readCommit(commit), {
      tree,
      parent: at.tip,
      committer: made.committer,
      ...(made.signer && { signer: made.signer }),
    });
    const tip = await hashObject(() => createSha1Hasher(), "commit", bytes);
    return { tip, tree, objects: [...objects, { type: "commit", oid: tip, bytes }] };
  }

  /**
   * Keeps one replayed commit's objects and moves the saga past it, in
   * one transaction under the job's claim; false when the saga or the job
   * is no longer this runner's (nothing written).
   */
  #stage(
    job: Job,
    row: SagaRow,
    at: { next: number; tip: Oid; tipTree: Oid; bytes: number; objects: number },
    made: { tip: Oid; tree: Oid; objects: readonly Kept[] } | "dropped",
  ): boolean {
    const { storage } = this.git.context;
    const objects = made === "dropped" ? [] : made.objects;
    if (objects.some((o) => o.bytes.length > this.policy.maxObjectBytes))
      throw new ReplayRefusal(TOO_EXPENSIVE);
    try {
      const kept = storage.transactionSync(() => {
        if (!this.git.jobs.checkpoint(job, this.#cursor(row))) throw new NotOwned();
        let bytes = 0;
        let count = 0;
        for (const object of objects) {
          const written = storage.sql.exec(
            `INSERT OR IGNORE INTO merge_saga_objects (saga_id, oid, type, data)
             VALUES (?, ?, ?, ?)`,
            row.saga_id,
            object.oid,
            object.type,
            object.bytes,
          ).rowsWritten;
          if (written > 0) {
            bytes += object.bytes.length;
            count++;
          }
        }
        if (at.bytes + bytes > this.policy.maxStagedBytes) throw new ReplayRefusal(TOO_EXPENSIVE);
        if (at.objects + count > this.policy.maxStagedObjects)
          throw new ReplayRefusal(TOO_MANY_OBJECTS);
        const tip = made === "dropped" ? at.tip : made.tip;
        const tree = made === "dropped" ? at.tipTree : made.tree;
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

  /**
   * Reads the saga's kept objects first, then the live packs. A kept
   * object's memory is held as a live read's is (`holds`, released when
   * the slice ends), and a kept tree is parsed once.
   */
  #overlay(sagaId: string, live: ObjectSource, holds: { release(): void }[]): ObjectSource {
    const trees = new Map<string, readonly TreeEntry[]>();
    const hold = (bytes: number) => {
      let held: { release(): void } | undefined;
      try {
        held = this.git.memory.tryReserve(Math.max(1, bytes));
      } catch (error) {
        // More than the object's whole budget.
        if (!(error instanceof RangeError)) throw error;
      }
      if (!held) throw new MergeTooLargeError();
      holds.push(held);
    };
    const kept = (oid: Oid) =>
      this.git.context.storage.sql
        .exec<{ data: ArrayBuffer }>(
          "SELECT data FROM merge_saga_objects WHERE saga_id = ? AND oid = ?",
          sagaId,
          oid,
        )
        .toArray()[0]?.data;
    return {
      readTree: async (oid) => {
        const hex = oidToHex(oid);
        const known = trees.get(hex);
        if (known) return known;
        const data = kept(oid);
        if (!data) return live.readTree(oid);
        // As a live tree read holds it: its bytes three times, and each entry it may have.
        const mostEntries = Math.ceil(data.byteLength / MIN_TREE_ENTRY_BYTES);
        hold(3 * data.byteLength + mostEntries * MERGE_POLICY.entryMemoryBytes);
        const entries = parseTree(new Uint8Array(data)).value;
        trees.set(hex, entries);
        return entries;
      },
      readBlob: async (oid, maxBytes) => {
        const data = kept(oid);
        if (!data) return live.readBlob(oid, maxBytes);
        if (data.byteLength > maxBytes) return undefined;
        hold(3 * data.byteLength);
        return new Uint8Array(data);
      },
    };
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

/**
 * The commits a rebase of `head` onto `baseTip` replays, oldest first: the
 * head's commits the base tip does not reach, one chain of single-parent
 * commits.
 */
export async function rebaseCommits(
  graph: FileWriteDeps["git"]["commitGraph"],
  baseTip: Oid,
  head: Oid,
  policy: { readonly maxCommits: number; readonly maxWalk: number },
): Promise<Browsed<Oid[]>> {
  let ahead: Set<string>;
  try {
    const found = await reachableCommits(graph, "verified", [head], [baseTip], {
      maxCommits: policy.maxWalk,
    });
    ahead = new Set([...found].map(oidToHex));
  } catch (error) {
    if (!(error instanceof WalkLimitError)) throw error;
    return TOO_EXPENSIVE;
  }
  if (ahead.size > policy.maxCommits)
    return fail(
      422,
      "too_expensive",
      `The pull request has more than ${policy.maxCommits} commits to rebase; rebase locally and push.`,
    );
  const chain: Oid[] = [];
  for (let at: Oid | undefined = head; at && ahead.has(oidToHex(at)); ) {
    const [row] = graph.readSync([at], "verified");
    if (!row) return UNREADABLE;
    if (row.parents.length > 1)
      return fail(
        405,
        "not_mergeable",
        "The pull request contains merge commits, which a rebase merge does not replay; merge it another way.",
      );
    if (row.parents.length === 0)
      return fail(405, "not_mergeable", "The base branch and the head share no history.");
    chain.push(at);
    at = row.parents[0];
  }
  // Single parents all the way: the chain is every commit found (else the graph is inconsistent).
  if (chain.length !== ahead.size) return UNREADABLE;
  return { ok: true, value: chain.reverse() };
}

/** A rebase refused for a commit's conflicts, naming the first few. */
function conflictsIn(commit: string, conflicts: readonly MergeConflict[]): BrowseFailure {
  const shown = conflicts
    .slice(0, MERGE_POLICY.conflictsShown)
    .map((c) => `${c.path} (${c.kind.replaceAll("_", "/")})`);
  const more = conflicts.length - shown.length;
  return fail(
    405,
    "merge_conflict",
    `Commit ${commit} does not apply cleanly to the base branch: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`,
  );
}
