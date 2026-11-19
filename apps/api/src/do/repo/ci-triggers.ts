import {
  type JobHandler,
  newUlid,
  type RefActor,
  type RepoGitStorage,
  type SliceResult,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import type { RepoRole } from "@fyrden/domain";
import {
  type ChangedPaths,
  type ContextEvent,
  type ContributorStanding,
  type DirectoryListing,
  type Discovery,
  discoverWorkflows,
  type GithubContextInput,
  githubContext,
  hasSkipDirective,
  isForkJob,
  MAX_LISTED_ENTRIES,
  MAX_WORKFLOW_BYTES,
  matchEvent,
  needsApproval,
  needsPaths,
  parseTriggers,
  parseWorkflow,
  runTrust,
  skipDirectiveApplies,
  type Trigger,
  type TriggerEvent,
  validateDispatchInputs,
  type WorkflowDirectory,
  type WorkflowFile,
} from "@fyrden/domain/ci";
import {
  type BlockCache,
  diffTrees,
  GitObjectError,
  IdxError,
  isTreeMode,
  MissingCommitError,
  MissingObjectError,
  mergeBases,
  type ObjectReader,
  type Oid,
  oidFromHex,
  oidToHex,
  PackError,
  parseCommit,
  parseTag,
  ReaderWorkSpent,
  Sha1CollisionError,
  TreeDiffLimitError,
  type TreeEntry,
  WalkLimitError,
  ZlibError,
} from "@fyrden/git-core";
import { SHOWN_HANDLE } from "../../accounts/handles.js";
import { approvalBinding } from "../../ci/approval.js";
import { type RunRegistrar, type StartRunAnswer, startRunFrom } from "../../ci/runs.js";
import { openLiveReader, ReadBudgetError } from "../../git/live-reader.js";
import type { RunDO } from "../RunDO.js";
import { MAX_RUN_CONTEXTS_BYTES, type RunSpec, validateRunSpec } from "../run/spec.js";
import { BROWSE_POLICY } from "./browse.js";
import {
  type HeldReads,
  ReadsMemoryBusy,
  ReadsTooLargeError,
  UnreadableObjectError,
  withHeldReads,
} from "./held-reads.js";
import type { ApprovalRequest } from "./run-approvals.js";

/*
 * CI triggers: which changes start runs, and starting them exactly once.
 *
 * A push or a pull request event writes one row to the inbox (`ci_events`)
 * in the change's own transaction, so no event is lost or doubled by a
 * crash between the change and its recording. The `ci_triggers` job drains
 * the inbox in the repository's alarm: for each event it resolves, once,
 * the commits it reads workflows from and the names its runs' contexts
 * carry, writes them back to the row, lists the workflow files at the
 * source commit, reads each file's `on:` (cached by blob), matches the
 * event, allocates a run id and number per (event, trigger kind, workflow)
 * in one transaction and starts the run. A retry (a reset, a duplicate
 * alarm, a lost answer) rebuilds the same spec from the row, so the run
 * object answers with the run it already has.
 */

export const CI_TRIGGERS_JOB = "ci_triggers";

/** What a `workflow_dispatch` request is answered. */
export type DispatchAnswer =
  | { readonly ok: true; readonly runId: string }
  | {
      readonly ok: false;
      readonly code:
        | "ci_off"
        | "repo_not_ready"
        | "ref_not_found"
        | "workflow_not_found"
        | "workflow_not_dispatchable"
        | "busy";
    }
  | {
      readonly ok: false;
      readonly code: "invalid_inputs" | "invalid_workflow";
      readonly errors: readonly Readonly<Record<string, string | number | null>>[];
    };

/**
 * Work one alarm invocation spends on triggers: workflow blobs read or
 * parsed, and trees read. Once spent, the slice ends the invocation and the
 * next one goes on. Proposed.
 */
export const TRIGGER_WORK = { blobs: 8, trees: 64 } as const;
/** Branches one push may move and still start runs; past it the event is refused. Proposed. */
export const MAX_PUSH_REFS = 20;
/** Tags one push may create and start runs: GitHub creates no tag event past three (verified 2026-11-15, https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push). */
export const MAX_PUSH_TAGS = 3;
/** Changed paths a paths filter is matched against; past it the filter counts as matched. Proposed. */
export const MAX_TRIGGER_PATHS = 1_000;
/** Workflow blobs whose `on:` is kept. Proposed. */
const TRIGGER_CACHE_ROWS = 512;
/** How long a decided event is kept: longer than the 24 h idempotency window. Proposed. */
const DONE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PRUNE_BATCH = 100;
/** Trees a paths diff may read; a diff is begun only with this many left. Proposed. */
const DIFF_TREES = 32;
/** Commits a merge-base walk for a paths filter loads at most. Proposed. */
const MERGE_BASE_COMMITS = 5_000;
const MAX_TREE_BYTES = 1024 * 1024;
/** R2 reads one slice's reader makes at most. Proposed. */
const MAX_READER_READS = 200;
/** Runs one slice starts at most, so the job queue's call budget decides between slices. Proposed. */
const MAX_STARTS_PER_SLICE = 16;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 15 * 60_000;
const MEMORY_RETRY_MS = 1_000;
/**
 * Failures of one event's evaluation that involve no read of storage (a
 * fault that repeats whatever is retried) before it is given up. Proposed.
 */
const MAX_EVENT_FAULTS = 20;
/** A pass whose `on:` cannot be read matches these, so its author sees the error (as GitHub does). */
const UNREADABLE_TRIGGERS: readonly Trigger[] = [
  { event: "push", at: { line: 0, column: 0 } },
  { event: "pull_request", at: { line: 0, column: 0 } },
];
/**
 * Pull request actions that may start runs: those this repository emits
 * that a workflow's `types` may name (the support matrix's list).
 */
const PULL_TRIGGER_ACTIONS: ReadonlySet<string> = new Set([
  "assigned",
  "unassigned",
  "labeled",
  "unlabeled",
  "opened",
  "edited",
  "closed",
  "reopened",
  "synchronize",
  "converted_to_draft",
  "locked",
  "unlocked",
  "milestoned",
  "demilestoned",
  "ready_for_review",
  "review_requested",
  "review_request_removed",
]);

const ZERO = "0".repeat(40);
const BRANCH = "refs/heads/";
const TAG = "refs/tags/";
const lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

type PassKind = "push" | "pull_request" | "pull_request_target" | "schedule";
/** A trigger kind a run is allocated under (`ci_event_runs.trigger_kind`). */
type RunKind = PassKind | "workflow_dispatch";

const isPull = (kind: RunKind): kind is "pull_request" | "pull_request_target" =>
  kind === "pull_request" || kind === "pull_request_target";

/** What a push recorded. */
interface PushFacts {
  readonly ref: string;
  readonly before: string | null;
  readonly after: string;
}

/** What a pull request event recorded: the pull request as it stood, and its webhook capture. */
interface PullFacts {
  readonly number: number;
  readonly action: string;
  readonly head_sha: string;
  readonly head_ref: string;
  readonly head_repo_id: string | null;
  readonly base_ref: string;
  readonly author_id: string;
  readonly author_root: string;
  /** The grant the event's actor acted under, if any (absent on rows recorded without it). */
  readonly actor_grant?: string | null;
  readonly payload: Record<string, unknown>;
}

/** One evaluation of an event: a trigger kind and the commit its workflows are read from and run on. */
interface Pass {
  readonly kind: PassKind;
  readonly sha: string;
  readonly ref: string;
}

/** Names the contexts carry, resolved once before the event's first run. */
interface Names {
  readonly owner: string;
  readonly ownerId: string;
  readonly repo: string;
  readonly private: boolean;
  readonly origin: string | null;
  /** Principal ids to handles: the actor, the owner, and the users the payload names. */
  readonly logins: Record<string, string>;
}

/**
 * One slice's work: what it may still read and start, and the workflow
 * listings it read, by commit (a commit's listing never changes), so a push
 * and the refresh after it read the tree once.
 */
interface SliceBudget {
  trees: number;
  blobs: number;
  starts: number;
  readonly listings: Map<string, Discovery>;
}

function newBudget(): SliceBudget {
  return { trees: TRIGGER_WORK.trees, blobs: TRIGGER_WORK.blobs, starts: 0, listings: new Map() };
}

/** What the trigger resolves once and writes back to the event row. */
interface Resolved {
  readonly passes: readonly Pass[];
  readonly defaultBranch: string;
  /** A pull request's base branch tip at the first evaluation (its paths diff starts from the merge base). */
  readonly baseTip: string | null;
  readonly names?: Names;
  /**
   * A `schedule_refresh` event's: the schedules to refresh from the
   * workflows at `sha` (as a default-branch push or a change of the default
   * branch left it, recorded with the change), as `actor`.
   */
  readonly refresh?: {
    readonly sha: string;
    readonly actor: string;
    /** A change of the default branch (every row becomes the actor's), not a push. */
    readonly headChange?: boolean;
  };
}

/**
 * What a schedule refresh recorded, in the transaction of the change it
 * follows: the default branch's tip then, and whether a push moved it or
 * the default branch itself changed.
 */
interface RefreshFacts {
  readonly source: "push" | "head";
  readonly sha: string | null;
}

/** What a scheduled tick recorded. */
interface ScheduleFacts {
  readonly path: string;
  readonly cron: string;
  readonly tick: number;
}

type EventRow = {
  id: number;
  key: string;
  kind: string;
  actor_id: string | null;
  facts: string;
  resolved: string | null;
  pass: number;
  file: number;
  attempts: number;
  faults: number;
  outcome: string | null;
};

type EventRunRow = {
  run_id: string;
  run_number: number;
  workflow_blob: string;
  outcome: string | null;
  started_at: number | null;
};

/**
 * A read of the repository's objects failed for a reason that may pass (the
 * object store, the cache, the network): the event is retried, never given up.
 */
class TransientFailure extends Error {
  override name = "TransientFailure";
}

/**
 * Errors a read throws that are not transient failures: those the
 * evaluation handles itself, and git's decoding errors, which fail every
 * read of the same bytes alike (faults, counted toward giving the event up).
 */
function notTransient(error: unknown): boolean {
  return (
    error instanceof WorkSpent ||
    error instanceof ReadBudgetError ||
    error instanceof ReaderWorkSpent ||
    error instanceof ReadsMemoryBusy ||
    error instanceof ReadsTooLargeError ||
    error instanceof UnreadableObjectError ||
    error instanceof TreeDiffLimitError ||
    error instanceof GitObjectError ||
    error instanceof PackError ||
    error instanceof IdxError ||
    error instanceof ZlibError ||
    error instanceof MissingObjectError ||
    error instanceof Sha1CollisionError ||
    error instanceof SliceAborted
  );
}

/** `read`'s answer; any failure it does not handle itself becomes a {@link TransientFailure}. */
async function transient<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (notTransient(error)) throw error;
    throw new TransientFailure("a read of the repository's objects failed", { cause: error });
  }
}

/** A built spec failed validation inside the allocation's transaction, which rolled back. */
class InvalidSpec extends Error {
  override name = "InvalidSpec";
}

/** A test hook's throw: ends the slice as a reset would, never counted against the event. */
class SliceAborted extends Error {
  override name = "SliceAborted";
}

/** The work budget is spent: the event goes on in the next invocation. */
class WorkSpent extends Error {
  override name = "WorkSpent";
}

/** Why one event's evaluation stopped before it was decided. */
type Stopped =
  | { readonly kind: "spent" }
  | { readonly kind: "retry"; readonly afterMs: number; readonly counted: boolean }
  | { readonly kind: "starts" };

export interface CiTriggerHooks {
  /** Before a run is started (a throw counts as a failed start, retried later). */
  beforeStart?: (runId: string) => Promise<void> | void;
  /** After a run was started and before it is recorded as started (a throw ends the slice). */
  afterStart?: (runId: string) => Promise<void> | void;
  /** Before each read of the repository's objects (a throw is the read failing). */
  beforeRead?: () => Promise<void> | void;
  /** No reader opens, as for a repository whose packs are all gone. */
  withoutReader?: boolean;
}

export interface CiTriggerBindings {
  readonly RUN: DurableObjectNamespace<RunDO>;
  readonly DIRECTORY: D1Database;
}

export interface CiTriggersDeps {
  readonly git: RepoGitStorage;
  readonly memoryBlocks: () => BlockCache;
  /** Whether events are recorded at all (`FYRDEN_CI_RUNNERS`). */
  readonly enabled: () => boolean;
  /**
   * The deployment's CI cutoff (`FYRDEN_CI_SINCE`, when CI was last switched
   * on), or null: an event recorded before it closes as `ci_off` unread,
   * though this object never saw CI off.
   */
  readonly since: () => number | null;
  readonly repoId: () => string;
  /** A principal's role here, for the approval rules. */
  readonly roleOf: (principalId: string) => Promise<RepoRole | null>;
  /** The root identity of a principal acting under `grantId` (null: its own token). */
  readonly rootOf: (principalId: string, grantId: string | null) => Promise<string>;
  /** In the transaction recording a held run's creation: its approval request. */
  readonly requestApproval: (request: ApprovalRequest) => void;
  /** In the transaction recording a pull request run's creation that needs no approval. */
  readonly supersedeOlder: (run: Omit<ApprovalRequest, "binding">) => void;
  /** In one transaction: the schedules read for inbox event `eventId` (see `CiSchedules.apply`). */
  readonly applySchedules: (
    eventId: number,
    files: readonly { path: string; blob: string; crons: readonly string[] }[],
    actor: string,
    headChange: boolean,
  ) => string | null;
  /** A refresh that could not be read (see `CiSchedules.skip`). */
  readonly skipSchedules: (eventId: number) => void;
  /** In a change's transaction while CI is off (see `CiSchedules.noteOff`). */
  readonly noteSchedulesOff: () => void;
  /** CI is on: schedules seen off since start again from now (see `CiSchedules.resume`). */
  readonly resumeSchedules: () => void;
  /** Pulls the ACL (unless one within the write window is stored) before approvers are named. */
  readonly refreshAccess: () => Promise<void>;
  /** The repository itself, which records its runs before they are created. */
  readonly registrar: RunRegistrar;
  /** The deployment's public origin, if it has one. */
  readonly origin: () => string | null;
  readonly log: () => Logger;
}

export class CiTriggers {
  /** For tests. */
  hooks: CiTriggerHooks = {};
  /** The run objects and the directory; tests may count calls through them. */
  bindings: CiTriggerBindings | undefined;
  /** Work done so far by this instance, for tests. */
  readonly work = { trees: 0, blobs: 0 };

  constructor(private readonly deps: CiTriggersDeps) {}

  // ---------------------------------------------------------------- recording

  /**
   * In a commit's transaction: records the branch and tag moves that may
   * start `push` runs. Only new commits on `refs/heads/` and `refs/tags/`
   * count (a deletion starts nothing, a documented difference from GitHub);
   * a fork's initialization and imports start nothing. Per push (a push
   * without `atomic` commits each ref on its own, all with its `pushId`;
   * any other commit is a push of its own), more than
   * {@link MAX_PUSH_TAGS} tags record no tag event, and more than
   * {@link MAX_PUSH_REFS} branches record one refused row instead of any.
   * Rows of the push already recorded are taken back while undecided. A
   * move of the default branch also records a `schedule_refresh` event after
   * the push's, refused or not.
   */
  recordPush(
    refs: readonly { name: string; oldOid: Oid | null; newOid: Oid | null }[],
    actor: RefActor | undefined,
    sourceSeq: number,
  ): void {
    if (!this.deps.enabled()) {
      this.deps.noteSchedulesOff();
      return;
    }
    if (!actor) return;
    if (actor.via !== "push" && actor.via !== "merge" && actor.via !== "api") return;
    const moved = refs.filter(
      (r) =>
        r.newOid !== null &&
        (r.name.startsWith(BRANCH) || r.name.startsWith(TAG)) &&
        (r.oldOid === null || oidToHex(r.oldOid) !== oidToHex(r.newOid)),
    );
    if (moved.length === 0) return;
    const group = `push:${actor.pushId ? `u${actor.pushId}` : `s${sourceSeq}`}:`;
    const refused = `${group}*`;
    const noTags = `${group}tags*`;
    const earlier = this.#sql()
      .exec<{ id: number; key: string; state: string }>(
        // The keys of this push: those after `group` and before it with its `:` replaced by `;`.
        "SELECT id, key, state FROM ci_events WHERE key > ? AND key < ?",
        group,
        `${group.slice(0, -1)};`,
      )
      .toArray();
    const now = this.#now();
    // The default branch's schedules follow this push, whatever becomes of its runs, its branches
    // refused included: their own event after the push's, outside its keys (which a later commit
    // of the push takes back).
    const head = this.deps.git.refStore.head();
    const defaultMove = moved.find((r) => r.name === head && r.name.startsWith(BRANCH));
    const refresh = () => {
      if (defaultMove) this.#recordRefresh("push", oidToHex(defaultMove.newOid as Oid), actor, now);
    };
    if (earlier.some((e) => e.key === refused)) {
      refresh();
      return;
    }
    const refOf = (key: string) => key.slice(group.length);
    const recorded = earlier.filter((e) => e.key !== noTags).map((e) => refOf(e.key));
    const branches = new Set([
      ...recorded.filter((r) => r.startsWith(BRANCH)),
      ...moved.filter((r) => r.name.startsWith(BRANCH)).map((r) => r.name),
    ]);
    const tags = new Set([
      ...recorded.filter((r) => r.startsWith(TAG)),
      ...moved.filter((r) => r.name.startsWith(TAG)).map((r) => r.name),
    ]);
    const takeBack = (which: (ref: string) => boolean) => {
      for (const e of earlier)
        if (e.key !== noTags && which(refOf(e.key)) && this.#undecided(e.id))
          this.#sql().exec("DELETE FROM ci_events WHERE id = ?", e.id);
    };
    if (branches.size > MAX_PUSH_REFS) {
      takeBack(() => true);
      this.#insert(refused, "push", actor.principal, { refs: branches.size }, now, {
        outcome: "too_many_refs",
      });
      this.deps.git.context.metrics.count("ci.trigger_outcome", { outcome: "too_many_refs" });
      refresh();
      return;
    }
    const tooManyTags = tags.size > MAX_PUSH_TAGS || earlier.some((e) => e.key === noTags);
    if (tooManyTags && !earlier.some((e) => e.key === noTags)) {
      takeBack((ref) => ref.startsWith(TAG));
      // Remembered for the push's later tags; GitHub creates no event for them (silently).
      this.#insert(noTags, "push", actor.principal, { tags: tags.size }, now, {
        outcome: "too_many_tags",
      });
    }
    for (const r of moved) {
      if (tooManyTags && r.name.startsWith(TAG)) continue;
      const facts: PushFacts = {
        ref: r.name,
        before: r.oldOid && oidToHex(r.oldOid),
        after: oidToHex(r.newOid as Oid),
      };
      this.#insert(`${group}${r.name}`, "push", actor.principal, facts, now);
    }
    refresh();
  }

  /** Whether an event is pending with no run allocated for it yet. */
  #undecided(id: number): boolean {
    return (
      this.#sql()
        .exec(
          `SELECT 1 FROM ci_events e WHERE e.id = ? AND e.state = 'pending'
             AND NOT EXISTS (SELECT 1 FROM ci_event_runs r WHERE r.event_id = e.id)`,
          id,
        )
        .toArray().length > 0
    );
  }

  /**
   * In the transaction of a change of the default branch by `actor` (a
   * settings change, an import): its schedules are refreshed from the new
   * branch's tip. Nothing while CI is off.
   */
  recordHeadChange(head: string, actor: RefActor): void {
    if (!this.deps.enabled()) return;
    this.#recordRefresh(
      "head",
      (head.startsWith(BRANCH) && this.#tip(head)) || null,
      actor,
      this.#now(),
    );
  }

  /** A schedule refresh from `sha`, the default tip as the change left it (none: no schedules read). */
  #recordRefresh(source: RefreshFacts["source"], sha: string | null, actor: RefActor, now: number) {
    const facts: RefreshFacts = { source, sha };
    this.#insert(
      `schedule_refresh:${newUlid(now)}`,
      "schedule_refresh",
      actor.principal,
      facts,
      now,
    );
  }

  /** In the transaction of a due schedule entry's fire: its tick, for the slice to run. */
  recordSchedule(key: string, actor: string, facts: object): void {
    this.#insert(key, "schedule", actor, facts, this.#now());
  }

  /** In a pull request change's transaction: records an event that may start pull request runs. */
  recordPull(
    action: string,
    pull: {
      readonly number: number;
      readonly headSha: string;
      readonly headRef: string;
      readonly headRepoId: string | null;
      readonly baseRef: string;
      readonly authorId: string;
      readonly authorRoot: string;
    },
    actor: RefActor | null,
    sourceSeq: number,
    capture: () => Record<string, unknown>,
  ): void {
    if (!this.deps.enabled()) {
      this.deps.noteSchedulesOff();
      return;
    }
    if (!PULL_TRIGGER_ACTIONS.has(action)) return;
    const facts: PullFacts = {
      number: pull.number,
      action,
      head_sha: pull.headSha,
      head_ref: pull.headRef,
      head_repo_id: pull.headRepoId,
      base_ref: pull.baseRef,
      author_id: pull.authorId,
      author_root: pull.authorRoot,
      actor_grant: actor?.grantId ?? null,
      payload: capture(),
    };
    // An event without an actor (the server following a fork's branch) runs as the author.
    this.#insert(
      `pull:${pull.number}:${sourceSeq}`,
      "pull_request",
      actor?.principal ?? pull.authorId,
      facts,
      this.#now(),
    );
  }

  #insert(
    key: string,
    kind: string,
    actorId: string,
    facts: object,
    now: number,
    done?: { outcome: string },
  ): void {
    const cursor = this.#sql().exec(
      `INSERT OR IGNORE INTO ci_events (key, kind, state, outcome, actor_id, facts, created_at, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      key,
      kind,
      done ? "done" : "pending",
      done?.outcome ?? null,
      actorId,
      JSON.stringify(facts),
      now,
      done ? now : null,
    );
    this.#countWritten("ci.record", cursor.rowsWritten);
    this.deps.git.jobs.ensure(CI_TRIGGERS_JOB, CI_TRIGGERS_JOB);
  }

  // ---------------------------------------------------------------- the job

  handler(): JobHandler {
    return { runSlice: () => this.#slice() };
  }

  /**
   * Pending events recorded before the CI cutoff close as `ci_off`, as if
   * this object had seen CI off: nothing read or started, a run allocated
   * and not yet confirmed (a dispatch answered with its id) included, the
   * same accepted exception as the off branch of the slice.
   */
  #closeBeforeCutoff(): void {
    const since = this.deps.since();
    if (since === null) return;
    const closed = this.#sql().exec(
      `UPDATE ci_events SET state = 'done', outcome = 'ci_off', done_at = ?
       WHERE state = 'pending' AND created_at < ?`,
      this.#now(),
      since,
    );
    this.#countOff(closed.rowsWritten);
  }

  #countOff(rows: number): void {
    if (rows > 0)
      this.deps.git.context.metrics.count("ci.trigger_outcome", { outcome: "ci_off" }, rows);
  }

  /**
   * Decides pending events that are due, oldest first, within one
   * invocation's work budget, and ends the invocation once it is spent. An
   * event whose start was refused, or failed, waits for its own retry
   * deadline (`next_at`) while later events go on; the job then sleeps until
   * the earliest deadline. With the switch off, pending events are decided
   * as `ci_off` without being read: turning it on replays nothing; so are
   * those recorded before the CI cutoff, which an object asleep through CI
   * off and on again never saw. The loop
   * reads the inbox again before it ends, with no await in between, so an
   * event recorded while it ran is decided too.
   */
  async #slice(): Promise<SliceResult> {
    this.#prune();
    if (!this.deps.enabled()) {
      this.deps.noteSchedulesOff();
      // Off means off, also for a dispatch already answered with its run's id whose run was not
      // created yet: it closes here and the run never exists (an accepted exception: switching
      // CI off is a rare operator action).
      const now = this.#now();
      const off = this.#sql().exec(
        "UPDATE ci_events SET state = 'done', outcome = 'ci_off', done_at = ? WHERE state = 'pending'",
        now,
      );
      this.#countOff(off.rowsWritten);
      return { done: true };
    }
    this.#closeBeforeCutoff();
    // On again after it was seen off: schedules start from now, replaying none.
    this.deps.resumeSchedules();
    const budget = newBudget();
    const opened = this.#reader();
    try {
      for (;;) {
        const row = this.#sql()
          .exec<EventRow>(
            `SELECT id, key, kind, actor_id, facts, resolved, pass, file, attempts, faults, outcome
             FROM ci_events WHERE state = 'pending' AND next_at <= ? ORDER BY id LIMIT 1`,
            this.#now(),
          )
          .toArray()[0];
        if (!row) break;
        const stopped = await this.#evaluateRow(row, budget, opened.open);
        if (stopped?.kind === "spent") return { done: false, cursor: null, endInvocation: true };
        if (stopped?.kind === "starts") return { done: false, cursor: null, runAfterMs: 0 };
      }
    } finally {
      opened.release();
    }
    const next = this.#sql()
      .exec<{ at: number | null }>(
        "SELECT min(next_at) AS at FROM ci_events WHERE state = 'pending'",
      )
      .one().at;
    if (next === null) return { done: true };
    return { done: false, cursor: null, runAfterMs: Math.max(0, next - this.#now()) };
  }

  /**
   * An event's evaluation threw something it does not handle. A failed read
   * of storage is retried with backoff for as long as it takes. Anything
   * else is a fault: retried too, and given up as `evaluation_failed` after
   * {@link MAX_EVENT_FAULTS} of them, so a fault that repeats cannot hold
   * the event forever, but never while a run it allocated may exist without
   * its start confirmed (each evaluation tries those first).
   */
  #failed(row: EventRow, error: unknown): Stopped | undefined {
    const retry: Stopped = { kind: "retry", afterMs: backoff(row.attempts), counted: true };
    if (error instanceof TransientFailure) {
      this.deps.log().warn("a CI trigger event could not read storage", {
        error: error.cause,
        event: row.id,
      });
      return retry;
    }
    this.#sql().exec("UPDATE ci_events SET faults = faults + 1 WHERE id = ?", row.id);
    const unconfirmed =
      this.#sql()
        .exec(
          "SELECT 1 FROM ci_event_runs WHERE event_id = ? AND started_at IS NULL AND outcome IS NULL",
          row.id,
        )
        .toArray().length > 0;
    if (row.faults + 1 < MAX_EVENT_FAULTS || unconfirmed) {
      this.deps.log().warn("evaluating a CI trigger event failed", { error, event: row.id });
      return retry;
    }
    this.deps.log().error("a CI trigger event kept failing and was given up", {
      error,
      event: row.id,
    });
    this.#sql().exec(
      `UPDATE ci_events SET state = 'done', outcome = 'evaluation_failed', done_at = ?
       WHERE id = ? AND state = 'pending'`,
      this.#now(),
      row.id,
    );
    this.deps.git.context.metrics.count("ci.trigger_outcome", { outcome: "evaluation_failed" });
    return undefined;
  }

  /**
   * Deletes decided events older than the retention, with their
   * allocations: at the start of each slice, so a repository without new
   * events keeps no alarm for them.
   */
  #prune(): void {
    const before = this.#now() - DONE_RETENTION_MS;
    const old = this.#sql()
      .exec<{ id: number }>(
        "SELECT id FROM ci_events WHERE state = 'done' AND done_at < ? ORDER BY done_at LIMIT ?",
        before,
        PRUNE_BATCH,
      )
      .toArray();
    if (old.length === 0) return;
    this.deps.git.context.storage.transactionSync(() => {
      for (const { id } of old) {
        this.#sql().exec(
          "DELETE FROM ci_run_specs WHERE run_id IN (SELECT run_id FROM ci_event_runs WHERE event_id = ?)",
          id,
        );
        this.#sql().exec("DELETE FROM ci_event_runs WHERE event_id = ?", id);
        this.#sql().exec("DELETE FROM ci_events WHERE id = ?", id);
      }
    });
  }

  /**
   * A `workflow_dispatch` (by API): the workflow file `input.file` at
   * `input.ref`, which must also be on the default branch (GitHub runs a
   * dispatch only for such a file; the version at the ref runs), with its
   * inputs checked. Every read and check comes first; then one transaction
   * records the event under `input.key` and allocates its run with its
   * spec, and the run is started inline (the job retries it after any
   * failure, so the answer names the run once it is recorded). The same
   * key again answers the run it recorded.
   */
  async dispatch(input: {
    readonly file: string;
    readonly ref: string;
    readonly inputs: unknown;
    readonly actor: string;
    readonly key: string;
    /** Why nothing may be written now, if anything stops it. */
    readonly refusal: () => DispatchAnswer | undefined;
  }): Promise<DispatchAnswer> {
    const key = `dispatch:${input.key}`;
    const recorded = (): DispatchAnswer | undefined => {
      if (!this.deps.enabled()) return { ok: false, code: "ci_off" };
      const [known] = this.#sql()
        .exec<{ run_id: string }>(
          `SELECT r.run_id FROM ci_events e JOIN ci_event_runs r ON r.event_id = e.id
           WHERE e.key = ?`,
          key,
        )
        .toArray();
      if (known) return { ok: true, runId: known.run_id };
      return input.refusal();
    };
    const early = recorded();
    if (early) return early;
    const ref = this.#dispatchRef(input.ref);
    if (!ref) return { ok: false, code: "ref_not_found" };
    const head = this.deps.git.refStore.head();
    const defaultBranch = head?.startsWith(BRANCH) ? head.slice(BRANCH.length) : "";
    const defaultTip = this.#tip(`${BRANCH}${defaultBranch}`);
    // A workflow id is a file name: no numeric ids, and no paths (only direct entries count).
    if (/^\d+$/.test(input.file) || input.file.includes("/") || !defaultTip)
      return { ok: false, code: "workflow_not_found" };
    const opened = this.#reader();
    try {
      const reader = await opened.open();
      if (!reader) return { ok: false, code: "repo_not_ready" };
      const sha = await peel(reader, ref.oid);
      if (!sha) return { ok: false, code: "ref_not_found" };
      // A failed read of storage is a transient failure (answered busy), as in the job.
      const reads = <T>(use: (r: HeldReads) => Promise<T>) =>
        transient(async () => {
          await this.hooks.beforeRead?.();
          return withHeldReads(
            reader,
            this.deps.git.memory,
            { maxTreeBytes: MAX_TREE_BYTES, maxReadBytes: 64 * MAX_TREE_BYTES },
            use,
          );
        });
      const fileAt = async (commit: string): Promise<WorkflowFile | undefined> => {
        const [row] = this.deps.git.commitGraph.readSync([oidFromHex(commit) as Oid], "verified");
        if (!row) return undefined;
        const found = await reads((r) => discoverIn(row.tree, (oid) => r.readTree(oid)));
        return found.ok ? found.files.find((f) => f.name === input.file) : undefined;
      };
      const defaultFile = await fileAt(defaultTip);
      if (!defaultFile) return { ok: false, code: "workflow_not_found" };
      const file = sha === defaultTip ? defaultFile : await fileAt(sha);
      if (!file) return { ok: false, code: "workflow_not_found" };
      const dispatchSource = async (
        file: WorkflowFile,
      ): Promise<
        | { ok: true; bytes: Uint8Array; trigger: Extract<Trigger, { event: "workflow_dispatch" }> }
        | Extract<DispatchAnswer, { ok: false }>
      > => {
        const bytes = await reads((r) =>
          r.readBlob(oidFromHex(file.oid) as Oid, MAX_WORKFLOW_BYTES),
        );
        if (!bytes)
          return {
            ok: false,
            code: "invalid_workflow",
            errors: [
              {
                code: "file_too_large",
                feature: "",
                path: "",
                line: 0,
                column: 0,
                message: `The workflow file is larger than ${MAX_WORKFLOW_BYTES} bytes.`,
              },
            ],
          };
        const parsed = parseTriggers(file.path, bytes);
        if (!parsed.ok)
          return {
            ok: false,
            code: "invalid_workflow",
            errors: parsed.errors.map(({ code, feature, path, line, column, message }) => ({
              code,
              feature,
              path,
              line,
              column,
              message,
            })),
          };
        const trigger = parsed.triggers.find((t) => t.event === "workflow_dispatch");
        if (trigger?.event !== "workflow_dispatch")
          return { ok: false, code: "workflow_not_dispatchable" };
        return { ok: true, bytes, trigger };
      };
      const defaultSource = await dispatchSource(defaultFile);
      if (!defaultSource.ok) return defaultSource;
      const selected = file.oid === defaultFile.oid ? defaultSource : await dispatchSource(file);
      if (!selected.ok) return selected;
      const { bytes, trigger } = selected;
      const checked = validateDispatchInputs(trigger.inputs, input.inputs);
      if (!checked.ok)
        return {
          ok: false,
          code: "invalid_inputs",
          errors: checked.errors.map((e) => ({ input: e.input, message: e.message })),
        };
      // The directory unreachable: busy, like a failed read.
      const names = await transient(() => this.readNames([input.actor]));
      const workflow = parseWorkflow(file.path, bytes);
      const name = workflow.ok ? workflow.workflow.name?.value : undefined;
      const repoId = this.deps.repoId();
      const origin = names.origin ?? "";
      const source = lossy.decode(bytes);
      const build = (runId: string, runNumber: number): RunSpec => ({
        runId,
        repoId,
        sha,
        ref: ref.name,
        event: "workflow_dispatch",
        actor: input.actor,
        workflow: { path: file.path, source },
        // A dispatch runs the repository's own code, by someone who may write it.
        trust: "trusted",
        fork: false,
        inputs: checked.inputs,
        github: githubContext({
          serverUrl: origin,
          apiUrl: origin ? `${origin}/api` : "",
          repository: contextRepository(repoId, names, defaultBranch),
          actor: { id: input.actor, login: names.logins[input.actor] ?? "" },
          workflow: { path: file.path, ...(name ? { name } : {}) },
          runId,
          runNumber,
          event: { kind: "workflow_dispatch", ref: ref.name, sha, inputs: checked.eventInputs },
        }),
      });
      // Inputs and defaults show twice in the contexts (typed, and as event strings): a spec
      // past the contexts' size is refused here, before anything is recorded, rather than by
      // the allocation's own check (which stays, and would fail the request).
      try {
        validateRunSpec(build(newUlid(this.#now()), Number.MAX_SAFE_INTEGER));
      } catch (error) {
        if (!(error instanceof TypeError) || !/contexts exceed/.test(error.message)) throw error;
        return {
          ok: false,
          code: "invalid_inputs",
          errors: [
            {
              input: null,
              message: `The run's contexts, the inputs and their defaults included, would exceed ${MAX_RUN_CONTEXTS_BYTES} bytes.`,
            },
          ],
        };
      }
      const resolved: Resolved = { passes: [], defaultBranch, baseTip: null, names };
      const made = this.deps.git.context.storage.transactionSync(
        (): DispatchAnswer | { eventId: number; runId: string } => {
          // Read again with no await before the write: a request with the same key may have
          // recorded it meanwhile, or the repository been frozen.
          const again = recorded();
          if (again) return again;
          const [event] = this.#sql()
            .exec<{ id: number }>(
              `INSERT INTO ci_events (key, kind, state, actor_id, facts, resolved, created_at)
               VALUES (?, 'workflow_dispatch', 'pending', ?, ?, ?, ?) RETURNING id`,
              key,
              input.actor,
              JSON.stringify({
                ref: ref.name,
                sha,
                path: file.path,
                inputs: checked.inputs,
                eventInputs: checked.eventInputs,
              }),
              JSON.stringify(resolved),
              this.#now(),
            )
            .toArray();
          const id = (event as { id: number }).id;
          const spec = this.allocateRun(id, "workflow_dispatch", file.path, file.oid, build);
          this.deps.git.jobs.ensure(CI_TRIGGERS_JOB, CI_TRIGGERS_JOB);
          return { eventId: id, runId: spec.runId };
        },
      );
      if ("ok" in made) return made;
      try {
        await this.decideNow(made.eventId);
      } catch (error) {
        // Recorded: the job starts the run, and the answer names it.
        this.deps.log().warn("starting a dispatched run failed", { error, runId: made.runId });
      }
      return { ok: true, runId: made.runId };
    } catch (error) {
      // Before the record, a read that may succeed shortly (memory other work holds, the object
      // store unreachable): a refusal to retry, never an error that spends the request's key.
      if (error instanceof ReadsMemoryBusy || error instanceof TransientFailure)
        return { ok: false, code: "busy" };
      throw error;
    } finally {
      opened.release();
    }
  }

  /** The full ref a dispatch names (a branch first, then a tag, of that name) and its value. */
  #dispatchRef(ref: string): { name: string; oid: string } | undefined {
    const candidates =
      ref.startsWith(BRANCH) || ref.startsWith(TAG)
        ? [ref]
        : ref.startsWith("refs/")
          ? []
          : [`${BRANCH}${ref}`, `${TAG}${ref}`];
    for (const name of candidates) {
      const oid = this.#tip(name);
      if (oid) return { name, oid };
    }
    return undefined;
  }

  /** A direct ref's value, or undefined. */
  #tip(name: string): string | undefined {
    const row = this.#sql()
      .exec<{ oid: ArrayBuffer | null }>(
        "SELECT oid FROM refs WHERE name = ? AND kind = 'direct'",
        name,
      )
      .toArray()[0];
    return row?.oid ? oidToHex(new Uint8Array(row.oid) as Oid) : undefined;
  }

  /**
   * Decides the event `eventId` now, as the job would, with its own reader:
   * for a request that answers with the event's run. Any failure is the
   * job's to retry (the event was recorded, and the job ensured, first).
   */
  async decideNow(eventId: number): Promise<void> {
    this.#closeBeforeCutoff();
    const row = this.#sql()
      .exec<EventRow>(
        `SELECT id, key, kind, actor_id, facts, resolved, pass, file, attempts, faults, outcome
         FROM ci_events WHERE id = ? AND state = 'pending'`,
        eventId,
      )
      .toArray()[0];
    if (!row || !this.deps.enabled()) return;
    const budget = newBudget();
    const opened = this.#reader();
    try {
      await this.#evaluateRow(row, budget, opened.open);
    } finally {
      opened.release();
    }
  }

  /**
   * One event's evaluation and what follows from it: done, or its retry
   * deadline set (`next_at`, `attempts`). A spent budget or the start cap
   * is the caller's to act on.
   */
  async #evaluateRow(
    row: EventRow,
    budget: SliceBudget,
    open: () => Promise<ObjectReader | undefined>,
  ): Promise<Stopped | undefined> {
    let stopped: Stopped | undefined;
    try {
      stopped = await new Evaluation(this, row, budget, open).run();
    } catch (error) {
      if (error instanceof SliceAborted) throw error.cause;
      stopped = this.#failed(row, error);
    }
    if (stopped?.kind === "retry")
      this.#sql().exec(
        "UPDATE ci_events SET next_at = ?, attempts = attempts + ? WHERE id = ?",
        this.#now() + stopped.afterMs,
        stopped.counted ? 1 : 0,
        row.id,
      );
    return stopped;
  }

  /** A reader opened on first use, for one slice or one request; released by the caller. */
  #reader(): { open: () => Promise<ObjectReader | undefined>; release: () => void } {
    let reader: ObjectReader | undefined;
    return {
      open: async () => {
        if (this.hooks.withoutReader) return undefined;
        reader ??= await transient(() =>
          openLiveReader(
            { git: this.deps.git, memoryBlocks: this.deps.memoryBlocks() },
            {
              deltaBaseCacheBytes: 4 * 1024 * 1024,
              maxCacheCalls: BROWSE_POLICY.cacheCalls,
              maxReads: MAX_READER_READS,
            },
          ),
        );
        return reader;
      },
      release: () => (reader as { release?: () => void } | undefined)?.release?.(),
    };
  }

  /**
   * The names runs' contexts carry: the repository's owner and name, its
   * visibility, the deployment's origin, and the handles of `ids` (and the
   * owner), in one directory query.
   * @internal
   */
  async readNames(principals: Iterable<string>): Promise<Names> {
    const meta = this.#sql()
      .exec<{ owner_id: string | null; name: string | null; visibility: string | null }>(
        "SELECT owner_id, name, visibility FROM repo_meta WHERE id = 1",
      )
      .toArray()[0];
    const ownerId = meta?.owner_id ?? "";
    const ids = new Set<string>([ownerId, ...principals]);
    ids.delete("");
    const logins: Record<string, string> = {};
    if (ids.size > 0) {
      this.deps.git.context.metrics.count("d1.query", { db: "directory", op: "ci_names" });
      const { results } = await this.boundTo()
        .DIRECTORY.prepare(
          `SELECT p.id, ${SHOWN_HANDLE} AS handle FROM principals p
           WHERE p.id IN (SELECT value FROM json_each(?1))`,
        )
        .bind(JSON.stringify([...ids].sort()))
        .all<{ id: string; handle: string | null }>();
      for (const r of results) logins[r.id] = r.handle ?? "";
    }
    return {
      owner: logins[ownerId] ?? "",
      ownerId,
      repo: meta?.name ?? "",
      private: meta?.visibility !== "public",
      origin: this.deps.origin(),
      logins,
    };
  }

  /**
   * In one transaction: the next run number of the workflow, a new run id,
   * and the run's spec, kept for event `eventId` before the run is created,
   * so its start can be repeated without reading git again. The spec is
   * stored as its JSON without the workflow source, and the source as text:
   * at most 500,000 bytes of source and 1 MiB of contexts
   * (`validateRunSpec`), so a row stays within about 1.55 MB, kept to here
   * as a conservative target (Durable Object SQLite allows larger rows:
   * verified 2026-11-16,
   * https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits).
   * Throws {@link InvalidSpec}, allocating nothing, for a spec that does not validate.
   * @internal
   */
  allocateRun(
    eventId: number,
    kind: RunKind,
    path: string,
    blob: string,
    build: (runId: string, runNumber: number) => RunSpec,
  ): RunSpec {
    const now = this.#now();
    return this.deps.git.context.storage.transactionSync(() => {
      const number = this.#sql()
        .exec<{ last: number }>(
          `INSERT INTO ci_run_numbers (workflow_path, last) VALUES (?, 1)
           ON CONFLICT (workflow_path) DO UPDATE SET last = last + 1 RETURNING last`,
          path,
        )
        .one().last;
      const runId = newUlid(now);
      const spec = build(runId, number);
      try {
        validateRunSpec(spec);
      } catch (error) {
        throw new InvalidSpec("invalid run spec", { cause: error });
      }
      this.#sql().exec(
        `INSERT INTO ci_event_runs (event_id, trigger_kind, workflow_path, run_id, run_number,
             workflow_blob, approval, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        kind,
        path,
        runId,
        number,
        blob,
        spec.approval ? 1 : 0,
        now,
      );
      this.#sql().exec(
        "INSERT INTO ci_run_specs (run_id, spec, source) VALUES (?, ?, ?)",
        runId,
        JSON.stringify({ ...spec, workflow: { path: spec.workflow.path, source: "" } }),
        spec.workflow.source,
      );
      return spec;
    });
  }

  // ---------------------------------------------------------------- shared with evaluations

  /** @internal */
  sql() {
    return this.#sql();
  }

  /** @internal */
  now(): number {
    return this.#now();
  }

  /** @internal */
  get repo(): CiTriggersDeps {
    return this.deps;
  }

  /** @internal The bindings, as given or as set at construction. */
  boundTo(): CiTriggerBindings {
    if (!this.bindings) throw new Error("CI triggers have no bindings");
    return this.bindings;
  }

  /** @internal The `on:` of a workflow blob as cached, refreshing its use time at most hourly. */
  cachedTriggers(blob: string): readonly Trigger[] | null | undefined {
    const row = this.#sql()
      .exec<{ triggers: string; used_at: number }>(
        "SELECT triggers, used_at FROM ci_trigger_cache WHERE blob = ?",
        blob,
      )
      .toArray()[0];
    if (!row) return undefined;
    const now = this.#now();
    if (row.used_at < now - 60 * 60_000)
      this.#sql().exec("UPDATE ci_trigger_cache SET used_at = ? WHERE blob = ?", now, blob);
    return JSON.parse(row.triggers) as readonly Trigger[] | null;
  }

  /** @internal Keeps a blob's `on:` (null: unreadable), the least recently used beyond the cap evicted. */
  cacheTriggers(blob: string, triggers: readonly Trigger[] | null): void {
    const now = this.#now();
    this.deps.git.context.storage.transactionSync(() => {
      this.#sql().exec(
        `INSERT INTO ci_trigger_cache (blob, triggers, used_at) VALUES (?, ?, ?)
         ON CONFLICT (blob) DO UPDATE SET triggers = excluded.triggers, used_at = excluded.used_at`,
        blob,
        JSON.stringify(triggers),
        now,
      );
      this.#sql().exec(
        `DELETE FROM ci_trigger_cache WHERE blob IN (
           SELECT blob FROM ci_trigger_cache ORDER BY used_at DESC, blob LIMIT -1 OFFSET ?)`,
        TRIGGER_CACHE_ROWS,
      );
    });
  }

  #sql() {
    return this.deps.git.context.storage.sql;
  }

  #now(): number {
    return this.deps.git.context.now();
  }

  #countWritten(op: string, rows: number): void {
    if (rows > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op },
        rows,
      );
  }
}

/**
 * One event's evaluation within a slice: its passes and files from where
 * the row's progress says, stopping when the budget is spent or a start
 * must wait. Returns undefined once the event is decided (and marked done).
 */
class Evaluation {
  readonly #t: CiTriggers;
  readonly #row: EventRow;
  readonly #budget: SliceBudget;
  readonly #open: () => Promise<ObjectReader | undefined>;
  #pass: number;
  #file: number;
  #outcome: string | null = null;
  #resolved: Resolved | undefined;
  /** The changed paths of this event, computed once (both pull request passes share them). */
  #paths: ChangedPaths | undefined;
  readonly #standing = new Map<string, ContributorStanding>();

  constructor(
    triggers: CiTriggers,
    row: EventRow,
    budget: SliceBudget,
    open: () => Promise<ObjectReader | undefined>,
  ) {
    this.#t = triggers;
    this.#row = row;
    this.#budget = budget;
    this.#open = open;
    this.#pass = row.pass;
    this.#file = row.file;
    // A refusal recorded by an earlier slice of this event is its outcome until another replaces it.
    this.#outcome = row.outcome;
  }

  async run(): Promise<Stopped | undefined> {
    try {
      // Runs allocated before, whose start is unconfirmed, first and from their stored specs:
      // nothing below may decide the event while one is.
      const reconciled = await this.#reconcile();
      if (reconciled === "gone") return this.#done("repo_gone");
      if (reconciled) {
        this.#saveProgress();
        return reconciled;
      }
      // A dispatch's run is allocated with its record: once it started, the event is decided.
      if (this.#row.kind === "workflow_dispatch") return this.#done(this.#outcome);
      const reader = await this.#open();
      if (!reader) return this.#done("unreadable");
      const resolved = await this.#resolve(reader);
      if (typeof resolved === "string") return this.#done(resolved);
      for (; this.#pass < resolved.passes.length; this.#pass++, this.#file = 0) {
        const pass = resolved.passes[this.#pass] as Pass;
        const stopped = await this.#runPass(reader, pass);
        if (stopped === "gone") return this.#done("repo_gone");
        if (stopped) {
          this.#saveProgress();
          return stopped;
        }
      }
      if (resolved.refresh) {
        const refreshed = await this.#refreshSchedules(reader, resolved.refresh);
        if (typeof refreshed === "object") {
          this.#saveProgress();
          return refreshed;
        }
        if (refreshed) this.#outcome = refreshed;
      }
      return this.#done(this.#outcome);
    } catch (error) {
      if (error instanceof WorkSpent || error instanceof ReadBudgetError) {
        this.#saveProgress();
        return { kind: "spent" };
      }
      if (error instanceof ReaderWorkSpent) {
        this.#saveProgress();
        return { kind: "spent" };
      }
      if (error instanceof ReadsMemoryBusy) {
        this.#saveProgress();
        return { kind: "retry", afterMs: MEMORY_RETRY_MS, counted: false };
      }
      throw error;
    }
  }

  /**
   * Starts again every run this event allocated whose start was never
   * confirmed (a lost answer, a failure before or after the create), from
   * the spec stored with its allocation: no git read, so a workflow blob
   * gone since, or no reader at all, cannot keep it unconfirmed. The run
   * object answers a repeated create with the run it has.
   */
  async #reconcile(): Promise<Stopped | "gone" | undefined> {
    const open = this.#t
      .sql()
      .exec<{
        trigger_kind: RunKind;
        workflow_path: string;
        run_id: string;
        spec: string | null;
        source: string | null;
      }>(
        `SELECT r.trigger_kind, r.workflow_path, r.run_id, s.spec, s.source
         FROM ci_event_runs r LEFT JOIN ci_run_specs s ON s.run_id = r.run_id
         WHERE r.event_id = ? AND r.started_at IS NULL AND r.outcome IS NULL ORDER BY r.run_id`,
        this.#row.id,
      )
      .toArray();
    for (const run of open) {
      if (run.spec === null || run.source === null) {
        // Every allocation stores its spec in its own transaction; none can lack one.
        this.#t.repo.log().error("a CI run was allocated without its spec", { runId: run.run_id });
        this.#mark(run.trigger_kind, run.workflow_path, "spec_missing");
        continue;
      }
      if (this.#budget.starts >= MAX_STARTS_PER_SLICE) return { kind: "starts" };
      const spec = JSON.parse(run.spec) as RunSpec;
      const stopped = await this.#launch(run.trigger_kind, run.workflow_path, {
        ...spec,
        workflow: { path: spec.workflow.path, source: run.source },
      });
      if (stopped) return stopped;
    }
    return undefined;
  }

  #facts<F>(): F {
    return JSON.parse(this.#row.facts) as F;
  }

  #done(outcome: string | null): undefined {
    const now = this.#t.now();
    this.#t.sql().exec(
      `UPDATE ci_events SET state = 'done', outcome = ?, done_at = ?, pass = ?, file = ?
         WHERE id = ? AND state = 'pending'`,
      outcome,
      now,
      this.#pass,
      this.#file,
      this.#row.id,
    );
    if (outcome) this.#t.repo.git.context.metrics.count("ci.trigger_outcome", { outcome });
    return undefined;
  }

  #saveProgress(): void {
    this.#t
      .sql()
      .exec(
        "UPDATE ci_events SET pass = ?, file = ?, outcome = coalesce(?, outcome) WHERE id = ?",
        this.#pass,
        this.#file,
        this.#outcome,
        this.#row.id,
      );
  }

  // -------------------------------------------------------------- resolving

  /**
   * The event's passes and their commits, resolved at the first evaluation
   * and written back, so a retry reads workflows from, and checks out, the
   * same commits whatever the branches did since; or why the event is done.
   */
  async #resolve(reader: ObjectReader): Promise<Resolved | string> {
    if (this.#row.resolved) {
      this.#resolved = JSON.parse(this.#row.resolved) as Resolved;
      return this.#resolved;
    }
    const git = this.#t.repo.git;
    const head = git.refStore.head();
    const defaultBranch = head?.startsWith(BRANCH) ? head.slice(BRANCH.length) : "";
    const tipOf = (branch: string): string | null => {
      if (!branch) return null;
      const row = this.#t
        .sql()
        .exec<{ oid: ArrayBuffer | null }>(
          "SELECT oid FROM refs WHERE name = ? AND kind = 'direct'",
          `${BRANCH}${branch}`,
        )
        .toArray()[0];
      return row?.oid ? oidToHex(new Uint8Array(row.oid) as Oid) : null;
    };
    let passes: Pass[];
    let baseTip: string | null = null;
    let refresh: Resolved["refresh"];
    const defaultRef = `${BRANCH}${defaultBranch}`;
    if (this.#row.kind === "push") {
      const facts = this.#facts<PushFacts>();
      const commit = await peel(reader, facts.after);
      if (!commit) return "not_a_commit";
      passes = [{ kind: "push", sha: commit, ref: facts.ref }];
    } else if (this.#row.kind === "schedule_refresh") {
      // The schedules at the tip the change left, as whoever made it.
      const facts = this.#facts<RefreshFacts>();
      passes = [];
      if (facts.sha)
        refresh = {
          sha: facts.sha,
          actor: this.#row.actor_id ?? "",
          headChange: facts.source === "head",
        };
    } else if (this.#row.kind === "schedule") {
      // The default tip at this first evaluation, recorded, so a retry runs the same commit.
      const tip = tipOf(defaultBranch);
      passes = tip ? [{ kind: "schedule", sha: tip, ref: defaultRef }] : [];
    } else if (this.#row.kind === "pull_request") {
      const facts = this.#facts<PullFacts>();
      passes = [
        { kind: "pull_request", sha: facts.head_sha, ref: `refs/pull/${facts.number}/head` },
      ];
      const tip = tipOf(defaultBranch);
      if (tip)
        passes.push({ kind: "pull_request_target", sha: tip, ref: `${BRANCH}${defaultBranch}` });
      baseTip = tipOf(facts.base_ref);
    } else return "unsupported_event";
    const resolved: Resolved = { passes, defaultBranch, baseTip, ...(refresh && { refresh }) };
    this.#t
      .sql()
      .exec(
        "UPDATE ci_events SET resolved = ? WHERE id = ?",
        JSON.stringify(resolved),
        this.#row.id,
      );
    this.#resolved = resolved;
    return resolved;
  }

  /**
   * The names the contexts carry, read once (one directory query) and
   * written back before the event's first run.
   */
  async #names(): Promise<Names> {
    const resolved = this.#resolved as Resolved;
    if (resolved.names) return resolved.names;
    const ids = new Set<string>([this.#actor()]);
    if (this.#row.kind === "pull_request") usersIn(this.#facts<PullFacts>().payload, ids);
    const names = await this.#t.readNames(ids);
    const next: Resolved = { ...resolved, names };
    this.#t
      .sql()
      .exec("UPDATE ci_events SET resolved = ? WHERE id = ?", JSON.stringify(next), this.#row.id);
    this.#resolved = next;
    return names;
  }

  /** Who the event's runs act as. */
  #actor(): string {
    if (this.#row.actor_id) return this.#row.actor_id;
    return this.#row.kind === "pull_request" ? this.#facts<PullFacts>().author_id : "";
  }

  // -------------------------------------------------------------- one pass

  /** Every workflow file of one pass from the row's progress; a reason to stop, or nothing once decided. */
  async #runPass(reader: ObjectReader, pass: Pass): Promise<Stopped | "gone" | undefined> {
    let discovery: Discovery;
    try {
      discovery = this.#budget.listings.get(pass.sha) ?? (await this.#discover(reader, pass.sha));
      this.#budget.listings.set(pass.sha, discovery);
    } catch (error) {
      const refused = refusal(error);
      if (!refused) throw error;
      this.#outcome = refused;
      return undefined;
    }
    if (!discovery.ok) {
      this.#outcome = discovery.code;
      return undefined;
    }
    const event = this.#triggerEvent(pass);
    let skipped: boolean | undefined;
    for (; this.#file < discovery.files.length; this.#file++) {
      const file = discovery.files[this.#file] as WorkflowFile;
      // A tick runs its own workflow only (another with the same cron has its own tick).
      if (pass.kind === "schedule" && file.path !== this.#facts<ScheduleFacts>().path) continue;
      // Started, refused, or unconfirmed and left to the next evaluation's reconciliation.
      if (this.#allocation(pass.kind, file.path)) continue;
      const triggers = await this.#triggersOf(reader, file);
      if (needsPaths(triggers, event) && this.#paths === undefined)
        this.#paths = await this.#changedPaths(reader, pass);
      const matched = needsPaths(triggers, event)
        ? matchEvent(triggers, event, this.#paths)
        : matchEvent(triggers, event);
      if (!matched) continue;
      if (skipDirectiveApplies(pass.kind)) {
        skipped ??= hasSkipDirective(await this.#message(reader, pass.sha));
        if (skipped) return undefined;
      }
      // A fork's run from a first-time contributor is created held, and waits for a
      // maintainer's approval before anything of it runs.
      const waits = await this.#unlessUnreachable(() => this.#wouldWaitForApproval(pass.kind));
      if (typeof waits === "object") return waits;
      if (this.#budget.starts >= MAX_STARTS_PER_SLICE) return { kind: "starts" };
      const started = await this.#start(reader, pass, file, waits);
      if (started) return started;
    }
    return undefined;
  }

  /**
   * `read`'s answer, or a retry when it fails: the directory or the
   * account's object could not answer (a transient failure that must not
   * exhaust the job).
   */
  async #unlessUnreachable<T>(read: () => Promise<T>): Promise<T | Stopped> {
    try {
      return await read();
    } catch (error) {
      this.#t.repo.log().warn("a CI trigger could not read what it needs", { error });
      return { kind: "retry", afterMs: backoff(this.#row.attempts), counted: true };
    }
  }

  /**
   * Refreshes the repository's schedules from the workflows at `sha`, all
   * read before anything is written: a listing that cannot be read, or a
   * budget spent part-way, changes no row. Why some were not kept, if so.
   */
  async #refreshSchedules(
    reader: ObjectReader,
    refresh: NonNullable<Resolved["refresh"]>,
  ): Promise<string | Stopped | undefined> {
    // Refreshes apply in the order of their events: a schedule's actor is whoever pushed the
    // change of its file, which an older refresh still pending may hold. This one waits until
    // that one is decided (it runs no sooner than that one's retry). Refreshes start no run, so
    // a push's runs never hold one.
    const older = this.#t
      .sql()
      .exec<{ next_at: number }>(
        `SELECT next_at FROM ci_events WHERE state = 'pending' AND id < ?
           AND kind = 'schedule_refresh' ORDER BY next_at DESC LIMIT 1`,
        this.#row.id,
      )
      .toArray()[0];
    if (older)
      return {
        kind: "retry",
        afterMs: Math.max(1_000, older.next_at - this.#t.now() + 1),
        counted: false,
      };
    let discovery = this.#budget.listings.get(refresh.sha);
    if (!discovery) {
      try {
        discovery = await this.#discover(reader, refresh.sha);
        this.#budget.listings.set(refresh.sha, discovery);
      } catch (error) {
        if (!refusal(error)) throw error;
        this.#t.repo.skipSchedules(this.#row.id);
        return undefined;
      }
    }
    if (!discovery.ok) {
      this.#t.repo.skipSchedules(this.#row.id);
      return undefined;
    }
    const files: { path: string; blob: string; crons: string[] }[] = [];
    for (const file of discovery.files) {
      const schedule = (await this.#triggersOf(reader, file)).find((t) => t.event === "schedule");
      if (schedule?.event === "schedule")
        files.push({ path: file.path, blob: file.oid, crons: schedule.crons.map((c) => c.value) });
    }
    return (
      this.#t.repo.applySchedules(
        this.#row.id,
        files,
        refresh.actor,
        refresh.headChange === true,
      ) ?? undefined
    );
  }

  #triggerEvent(pass: Pass): TriggerEvent {
    if (pass.kind === "push") {
      const facts = this.#facts<PushFacts>();
      return { kind: "push", ref: facts.ref, created: facts.before === null };
    }
    if (pass.kind === "schedule")
      return { kind: "schedule", cron: this.#facts<ScheduleFacts>().cron };
    const facts = this.#facts<PullFacts>();
    return { kind: pass.kind, action: facts.action, baseRef: `${BRANCH}${facts.base_ref}` };
  }

  #allocation(kind: PassKind, path: string): EventRunRow | undefined {
    return this.#t
      .sql()
      .exec<EventRunRow>(
        `SELECT run_id, run_number, workflow_blob, outcome, started_at FROM ci_event_runs
         WHERE event_id = ? AND trigger_kind = ? AND workflow_path = ?`,
        this.#row.id,
        kind,
        path,
      )
      .toArray()[0];
  }

  /** Whether a run of this pass would wait for a maintainer's approval (a fork's first-time contributor). */
  async #wouldWaitForApproval(kind: PassKind): Promise<boolean> {
    if (!isPull(kind)) return false;
    const facts = this.#facts<PullFacts>();
    const fork = isForkJob(this.#t.repo.repoId(), facts.head_repo_id);
    if (!fork) return false;
    // Standing is a root identity's: an agent acting on its own token counts as its owner, as
    // the author already does (`author_root`). The run itself still acts as the event's actor.
    const actor =
      this.#actor() === facts.author_id
        ? facts.author_root
        : await this.#t.repo.rootOf(this.#actor(), facts.actor_grant ?? null);
    return needsApproval({
      kind,
      fork,
      author: await this.#standingOf(facts.author_root),
      actor: await this.#standingOf(actor),
    });
  }

  async #standingOf(principalId: string): Promise<ContributorStanding> {
    const known = this.#standing.get(principalId);
    if (known) return known;
    const merged =
      this.#t
        .sql()
        .exec(
          "SELECT 1 FROM pull_requests WHERE author_root = ? AND state = 'merged' LIMIT 1",
          principalId,
        )
        .toArray().length > 0;
    const standing = { role: await this.#t.repo.roleOf(principalId), hasMergedPull: merged };
    this.#standing.set(principalId, standing);
    return standing;
  }

  // -------------------------------------------------------------- reading

  async #reads<T>(reader: ObjectReader, use: (reads: HeldReads) => Promise<T>): Promise<T> {
    return transient(async () => {
      await this.#t.hooks.beforeRead?.();
      return withHeldReads(
        reader,
        this.#t.repo.git.memory,
        { maxTreeBytes: MAX_TREE_BYTES, maxReadBytes: 64 * MAX_TREE_BYTES },
        use,
      );
    });
  }

  /** A tree read within the budget; `trees` keeps the pass's reads. */
  #tree(reads: HeldReads, oid: Oid, trees: Map<string, readonly TreeEntry[]>) {
    const hex = oidToHex(oid);
    const known = trees.get(hex);
    if (known) return Promise.resolve(known);
    if (this.#budget.trees <= 0) throw new WorkSpent();
    this.#budget.trees--;
    this.#t.work.trees++;
    return reads.readTree(oid).then((entries) => {
      trees.set(hex, entries);
      return entries;
    });
  }

  /** The workflow files at `sha`: one root tree read when neither directory exists. */
  async #discover(reader: ObjectReader, sha: string): Promise<Discovery> {
    const root = this.#rootTree(sha);
    if (!root) throw new UnreadableObjectError();
    const trees = new Map<string, readonly TreeEntry[]>();
    return this.#reads(reader, (reads) => discoverIn(root, (oid) => this.#tree(reads, oid, trees)));
  }

  #rootTree(sha: string): Oid | undefined {
    const [row] = this.#t.repo.git.commitGraph.readSync([oidFromHex(sha) as Oid], "verified");
    return row?.tree;
  }

  /** A workflow's `on:`, from the cache or read and parsed within the budget (null: unreadable). */
  async #triggersOf(reader: ObjectReader, file: WorkflowFile): Promise<readonly Trigger[]> {
    const cached = this.#t.cachedTriggers(file.oid);
    if (cached !== undefined) return cached ?? UNREADABLE_TRIGGERS;
    const bytes = await this.#blob(reader, file.oid);
    const parsed = bytes ? parseTriggers(file.path, bytes) : undefined;
    const triggers = parsed?.ok ? parsed.triggers : null;
    this.#t.cacheTriggers(file.oid, triggers);
    return triggers ?? UNREADABLE_TRIGGERS;
  }

  /** A workflow blob's bytes within the budget; undefined when larger than a workflow may be. */
  async #blob(reader: ObjectReader, oid: string): Promise<Uint8Array | undefined> {
    if (this.#budget.blobs <= 0) throw new WorkSpent();
    this.#budget.blobs--;
    this.#t.work.blobs++;
    return this.#reads(reader, (reads) =>
      reads.readBlob(oidFromHex(oid) as Oid, MAX_WORKFLOW_BYTES),
    );
  }

  async #commit(reader: ObjectReader, sha: string) {
    const bytes = await this.#reads(reader, (reads) => reads.readCommit(oidFromHex(sha) as Oid));
    return parseCommit(bytes).value;
  }

  async #message(reader: ObjectReader, sha: string): Promise<string> {
    return lossy.decode((await this.#commit(reader, sha)).message);
  }

  /**
   * The paths the event changed, for a paths filter: a branch push's
   * before..after, a pull request's merge base..head. Cut at
   * {@link MAX_TRIGGER_PATHS}, or not computable within its bounds (a
   * history too long to walk, a commit no longer stored, more trees than a
   * diff reads): incomplete, so the filter counts as matched.
   */
  async #changedPaths(reader: ObjectReader, pass: Pass): Promise<ChangedPaths> {
    const incomplete: ChangedPaths = { paths: [], complete: false };
    if (this.#budget.trees < DIFF_TREES) throw new WorkSpent();
    let from: string | null;
    let to: string;
    if (pass.kind === "push") {
      const facts = this.#facts<PushFacts>();
      from = facts.before;
      to = pass.sha;
    } else {
      const facts = this.#facts<PullFacts>();
      const base = (this.#resolved as Resolved).baseTip;
      if (!base) return incomplete;
      to = facts.head_sha;
      try {
        const [first] = await mergeBases(
          this.#t.repo.git.commitGraph,
          "verified",
          oidFromHex(base) as Oid,
          [oidFromHex(to) as Oid],
          { maxCommits: MERGE_BASE_COMMITS },
        );
        from = first ? oidToHex(first) : null;
      } catch (error) {
        if (error instanceof WalkLimitError || error instanceof MissingCommitError)
          return incomplete;
        throw error;
      }
    }
    const newTree = this.#rootTree(to);
    const oldTree = from === null ? null : this.#rootTree(from);
    if (!newTree || (from !== null && !oldTree)) return incomplete;
    const trees = new Map<string, readonly TreeEntry[]>();
    const limit = this.#budget.trees;
    try {
      const listed = await this.#reads(reader, (reads) =>
        diffTrees((oid) => this.#tree(reads, oid, trees), oldTree ?? null, newTree, {
          maxTrees: limit,
          maxChanges: MAX_TRIGGER_PATHS,
        }),
      );
      return { paths: listed.changes.map((c) => c.path), complete: !listed.truncated };
    } catch (error) {
      if (error instanceof TreeDiffLimitError || error instanceof WorkSpent) return incomplete;
      throw error;
    }
  }

  // -------------------------------------------------------------- starting

  /**
   * Builds the run of this pass and file, allocates its id and number and
   * stores its spec in one transaction, then starts it; a reason to stop,
   * or nothing once the file is decided.
   */
  async #start(
    reader: ObjectReader,
    pass: Pass,
    file: WorkflowFile,
    held: boolean,
  ): Promise<Stopped | "gone" | undefined> {
    const bytes = await this.#blob(reader, file.oid);
    if (!bytes) {
      // Larger than any workflow may be: no run could hold it.
      this.#outcome = "workflow_too_large";
      return undefined;
    }
    const names = await this.#unlessUnreachable(() => this.#names());
    if ("kind" in names) return names;
    const build = await this.#specBuilder(
      reader,
      pass,
      file.path,
      bytes,
      names,
      held ? { workflowBlob: file.oid, action: this.#facts<PullFacts>().action } : undefined,
    );
    let spec: RunSpec;
    try {
      spec = this.#allocate(pass.kind, file.path, file.oid, build);
    } catch (error) {
      if (!(error instanceof InvalidSpec)) throw error;
      // Nothing was allocated (the transaction rolled back).
      this.#t.repo.log().error("a trigger built an invalid run spec", {
        error: error.cause,
        path: file.path,
      });
      this.#outcome = "invalid_spec";
      return undefined;
    }
    return this.#launch(pass.kind, file.path, spec);
  }

  /** Starts an allocated run from its spec and records the answer. */
  async #launch(kind: RunKind, path: string, spec: RunSpec): Promise<Stopped | "gone" | undefined> {
    this.#budget.starts++;
    const binding = await approvalBinding(spec);
    let answer: StartRunAnswer;
    try {
      await this.#t.hooks.beforeStart?.(spec.runId);
      answer = await startRunFrom(this.#t.repo.registrar, this.#t.boundTo(), spec);
    } catch (error) {
      this.#t.repo.log().warn("starting a CI run failed", { error, runId: spec.runId });
      return { kind: "retry", afterMs: backoff(this.#row.attempts), counted: true };
    }
    try {
      await this.#t.hooks.afterStart?.(spec.runId);
    } catch (error) {
      throw new SliceAborted("aborted after a start", { cause: error });
    }
    // Only a held run that planned asks for approval: one whose workflow failed to plan
    // completed as that failure at creation, and nothing in it can run.
    const held = binding !== null && answer.ok && answer.run.approval !== null;
    // A pull request run's creation may tell its approvers (a request, or a supersede): the ACL
    // is pulled first; if it cannot be, the approvals' job tells them later.
    if (answer.ok && isPull(kind)) await this.#t.repo.refreshAccess().catch(() => {});
    if (answer.ok) {
      this.#t.repo.git.context.storage.transactionSync(() => {
        this.#t.sql().exec(
          `UPDATE ci_event_runs SET started_at = ? WHERE event_id = ? AND trigger_kind = ?
             AND workflow_path = ?`,
          this.#t.now(),
          this.#row.id,
          kind,
          path,
        );
        // The run object holds the spec now.
        this.#t.sql().exec("DELETE FROM ci_run_specs WHERE run_id = ?", spec.runId);
        // Only now that the run exists may anyone approve or supersede it.
        if (isPull(kind)) {
          const run = {
            runId: spec.runId,
            eventId: this.#row.id,
            pull: this.#facts<PullFacts>().number,
            kind,
            path,
            actor: spec.actor,
          };
          // A newer run supersedes the older waiting ones whether or not it waits itself.
          if (held && binding !== null) this.#t.repo.requestApproval({ ...run, binding });
          else this.#t.repo.supersedeOlder(run);
        }
      });
      return undefined;
    }
    switch (answer.code) {
      case "repo_not_found":
        return "gone";
      case "repo_not_ready":
      case "repo_transferring":
        return { kind: "retry", afterMs: backoff(this.#row.attempts), counted: true };
      case "run_exists":
        // Another spec under this run id: never retried with a new id.
        this.#t.repo.log().error("a CI run id names another run", { runId: spec.runId });
        this.#mark(kind, path, "run_exists");
        return undefined;
      case "run_erased":
        this.#mark(kind, path, "run_erased");
        return undefined;
    }
  }

  /** Decides an allocated run without a start: its stored spec is no longer needed. */
  #mark(kind: RunKind, path: string, outcome: string): void {
    this.#t.repo.git.context.storage.transactionSync(() => {
      const [run] = this.#t
        .sql()
        .exec<{ run_id: string }>(
          `UPDATE ci_event_runs SET outcome = ? WHERE event_id = ? AND trigger_kind = ?
             AND workflow_path = ? RETURNING run_id`,
          outcome,
          this.#row.id,
          kind,
          path,
        )
        .toArray();
      if (run) this.#t.sql().exec("DELETE FROM ci_run_specs WHERE run_id = ?", run.run_id);
    });
  }

  /**
   * In one transaction: the next run number of the workflow, a new run id,
   * and the run's spec, kept for this event before the run is created, so
   * its start can be repeated without reading git again. The spec is
   * stored as its JSON without the workflow source, and the source as
   * text: at most 500,000 bytes of source and 1 MiB of contexts
   * (`validateRunSpec`), about 1.56 MB at most, within the 2 MB a row is
   * kept to here as a conservative target (Durable Object SQLite allows
   * larger rows: verified 2026-11-16,
   * https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits).
   * Throws {@link InvalidSpec}, allocating nothing, for a spec that does not validate.
   */
  #allocate(
    kind: PassKind,
    path: string,
    blob: string,
    build: (runId: string, runNumber: number) => RunSpec,
  ): RunSpec {
    return this.#t.allocateRun(this.#row.id, kind, path, blob, build);
  }

  /**
   * What builds the run's spec from its id and number: everything else
   * read first, from the event row and the workflow's bytes, so the spec is
   * built inside the allocation's transaction.
   */
  async #specBuilder(
    reader: ObjectReader,
    pass: Pass,
    path: string,
    bytes: Uint8Array,
    names: Names,
    approval: RunSpec["approval"],
  ): Promise<(runId: string, runNumber: number) => RunSpec> {
    const resolved = this.#resolved as Resolved;
    const repoId = this.#t.repo.repoId();
    const actorId = this.#actor();
    const parsed = parseWorkflow(path, bytes);
    const name = parsed.ok ? parsed.workflow.name?.value : undefined;
    const fork = isPull(pass.kind) && isForkJob(repoId, this.#facts<PullFacts>().head_repo_id);
    const origin = names.origin ?? "";
    const event = await this.#contextEvent(reader, pass, names);
    const source = lossy.decode(bytes);
    return (runId, runNumber) => {
      const input: GithubContextInput = {
        serverUrl: origin,
        apiUrl: origin ? `${origin}/api` : "",
        repository: contextRepository(repoId, names, resolved.defaultBranch),
        actor: { id: actorId, login: names.logins[actorId] ?? "" },
        workflow: { path, ...(name ? { name } : {}) },
        runId,
        runNumber,
        event,
      };
      return {
        runId,
        repoId,
        sha: pass.sha,
        ref: pass.ref,
        event: pass.kind,
        actor: actorId,
        workflow: { path, source },
        trust: runTrust(pass.kind, fork),
        fork,
        ...(approval && { approval }),
        github: githubContext(input),
      };
    };
  }

  async #contextEvent(reader: ObjectReader, pass: Pass, names: Names): Promise<ContextEvent> {
    if (pass.kind === "schedule")
      return { kind: "schedule", cron: this.#facts<ScheduleFacts>().cron, sha: pass.sha };
    if (pass.kind === "push") {
      const facts = this.#facts<PushFacts>();
      const commit = await this.#commit(reader, pass.sha);
      const person = (p: { name: Uint8Array; email: Uint8Array }) => ({
        name: lossy.decode(p.name),
        email: lossy.decode(p.email),
      });
      return {
        kind: "push",
        ref: facts.ref,
        before: facts.before ?? ZERO,
        after: pass.sha,
        created: facts.before === null,
        headCommit: {
          id: pass.sha,
          treeId: oidToHex(commit.tree),
          message: lossy.decode(commit.message),
          timestamp: isoTime(commit.committer.timestamp),
          author: person(commit.author),
          committer: person(commit.committer),
        },
        pusher: { name: names.logins[this.#actor()] ?? "", email: "" },
      };
    }
    const facts = this.#facts<PullFacts>();
    const payload = withLogins(facts.payload, names.logins) as Record<string, unknown>;
    if (pass.kind === "pull_request")
      return {
        kind: "pull_request",
        action: facts.action,
        number: facts.number,
        headSha: facts.head_sha,
        headBranch: facts.head_ref,
        baseBranch: facts.base_ref,
        payload,
      };
    return {
      kind: "pull_request_target",
      action: facts.action,
      number: facts.number,
      headBranch: facts.head_ref,
      baseBranch: facts.base_ref,
      defaultBranchSha: pass.sha,
      payload,
    };
  }
}

/** The workflow files under the tree `root`, read through `readTree` (see `discoverWorkflows`). */
function discoverIn(
  root: Oid,
  readTree: (oid: Oid) => Promise<readonly TreeEntry[]>,
): Promise<Discovery> {
  return discoverWorkflows({
    list: async (path: WorkflowDirectory): Promise<DirectoryListing> => {
      let entries = await readTree(root);
      const names = path.split("/");
      for (const [i, name] of names.entries()) {
        const entry = entries.find((e) => lossy.decode(e.name) === name);
        if (!entry) return { kind: "absent" };
        const last = i === names.length - 1;
        if (!isTreeMode(entry.mode)) return last ? { kind: "not-a-directory" } : { kind: "absent" };
        entries = await readTree(entry.oid);
      }
      if (entries.length > MAX_LISTED_ENTRIES) return { kind: "too-large" };
      return {
        kind: "directory",
        entries: entries.map((e) => ({ name: e.name, mode: e.mode, oid: oidToHex(e.oid) })),
      };
    },
  });
}

/** The `repository` of a run's `github` context, from the names resolved for it. */
function contextRepository(
  repoId: string,
  names: Names,
  defaultBranch: string,
): GithubContextInput["repository"] {
  const origin = names.origin ?? "";
  const full = `${names.owner}/${names.repo}`;
  return {
    id: repoId,
    name: names.repo,
    owner: { id: names.ownerId, login: names.owner },
    defaultBranch,
    private: names.private,
    htmlUrl: origin ? `${origin}/${full}` : "",
    cloneUrl: origin ? `${origin}/${full}.git` : "",
  };
}

/** The commit `sha` names, through annotated tags; undefined when it names none. */
async function peel(reader: ObjectReader, sha: string): Promise<string | undefined> {
  let oid = oidFromHex(sha) as Oid;
  for (let depth = 0; depth < 8; depth++) {
    const object = await transient(() => reader.readObject(oid));
    if (!object) return undefined;
    if (object.type === "commit") return oidToHex(oid);
    if (object.type !== "tag") return undefined;
    oid = parseTag(object.bytes).value.object;
  }
  return undefined;
}

/** Why a pass cannot be read, when the error is one that ends it; undefined for any other. */
function refusal(error: unknown): string | undefined {
  if (error instanceof ReadsMemoryBusy) return undefined;
  if (error instanceof ReadsTooLargeError) return "too_large";
  if (error instanceof UnreadableObjectError) return "unreadable";
  return undefined;
}

/** The furthest a JavaScript date reaches from the epoch, in ms (ECMAScript's time range). */
const MAX_DATE_MS = 8.64e15;

/**
 * A commit time (seconds) in ISO 8601, UTC. Git accepts times no date can
 * hold; those are clamped to the nearest one a date can (`+275760-09-13T00:00:00.000Z`
 * or its negative), so a commit's time never stops its event.
 */
function isoTime(seconds: number): string {
  const ms = seconds * 1000;
  const clamped = Number.isFinite(ms) ? Math.max(-MAX_DATE_MS, Math.min(MAX_DATE_MS, ms)) : 0;
  return new Date(clamped).toISOString();
}

function backoff(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts, 20), RETRY_MAX_MS);
}

/** Collects the principal ids a capture names (`{ $user: id }`). */
function usersIn(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) for (const item of value) usersIn(item, ids);
  else if (value !== null && typeof value === "object") {
    const user = (value as { $user?: unknown }).$user;
    if (typeof user === "string") ids.add(user);
    else for (const item of Object.values(value)) usersIn(item, ids);
  }
}

/** A capture with each `{ $user: id }` shown as `{ login, id }`, as a webhook body shows it. */
function withLogins(value: unknown, logins: Readonly<Record<string, string>>): unknown {
  if (Array.isArray(value)) return value.map((item) => withLogins(item, logins));
  if (value !== null && typeof value === "object") {
    const user = (value as { $user?: unknown }).$user;
    if (typeof user === "string") return { login: logins[user] ?? "", id: user };
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withLogins(item, logins)]),
    );
  }
  return value;
}
