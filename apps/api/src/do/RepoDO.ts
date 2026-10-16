import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { readGrantLinks } from "@fyrden/adapters-cloudflare/auth";
import {
  DERIVED_REF_PREFIX,
  isNetworkId,
  type JobHandler,
  type JobKind,
  type MaintainerFor,
  orphanReaperHandler,
  type PackRetireOptions,
  REFLOG_PRUNE_BATCH,
  type RefActor,
  RepoGitStorage,
  recordRepoStorage,
  reflogPruneHandler,
} from "@fyrden/adapters-cloudflare/git";
import {
  atInvocationEnd,
  createLogger,
  createMetrics,
  currentInvocation,
  measureInvocation,
  type RequestMeta,
} from "@fyrden/adapters-cloudflare/obs";
import {
  atLeast,
  type CommentSide,
  type CommitIdentity,
  checkAnchor,
  coAuthorTrailers,
  decidePullAction,
  type Envelope,
  type GitPerson,
  lineCount,
  type MergeContext,
  principalTypeOf,
  protectsBranch,
  REPO_ROLES,
  type RepoRole,
  type ReviewEvent,
  rootIdentity,
} from "@fyrden/domain";
import {
  appendTrailers,
  type BlockCache,
  bytesBody,
  encodePushResponse,
  failAtomically,
  isAncestor,
  type LsRefsArgs,
  liveCommands,
  type Oid,
  oidFromHex,
  oidToHex,
  type PackId,
  planPush,
  readPushBody,
  WalkLimitError,
} from "@fyrden/git-core";
import { readModelFor } from "../events/read-model.js";
import { lsRefsResponse, receivePackAdvertisement } from "../git/advertise.js";
import type { ObjectAccessAnswer, ObjectAccessRequest } from "../git/cache/object-access.js";
import { checkObjectAccess } from "../git/cache/object-check.js";
import type { PushReportSummary } from "../git/chunked/head.js";
import {
  type BeginChunked,
  type ChunkedFailure,
  ChunkedUploads,
  type ChunkedView,
} from "../git/chunked/session.js";
import { answerFetchPlan, FETCH_LEASE_TTL_MS } from "../git/fetch/plan.js";
import type { FetchPlanReply, FetchPlanRequest } from "../git/fetch/wire.js";
import { type BeginImport, type ImportRecord, RepoImports } from "../git/import/job.js";
import { defaultImportNetwork, type ImportNetwork } from "../git/import/network.js";
import { openLiveReader, ReadBudgetError } from "../git/live-reader.js";
import type { GcHooks } from "../git/maintenance/gc-job.js";
import { maintenanceHandlers } from "../git/maintenance/handlers.js";
import { MAINTENANCE_DEFAULTS, type MaintenancePolicy } from "../git/maintenance/policy.js";
import { scheduleAfterCommit } from "../git/maintenance/schedule.js";
import { packCapCompactionHandler } from "../git/maintenance/tail-merge-job.js";
import { type PackCapPolicy, packCapPolicy } from "../git/maintenance/tail-merge-plan.js";
import type { PushDecision } from "../git/push/commit.js";
import { ACCESS_LOST } from "../git/push/reauthorize.js";
import { reauthorizeByToken } from "../git/push/reauthorize-token.js";
import {
  type BeginPushInput,
  type BeginPushResult,
  type PushLogMeta,
  type PushProgress,
  RepoPush,
} from "../git/push/repo-push.js";
import type { DetachHooks } from "../network/detach.js";
import {
  collectLater,
  discardImport,
  IMPORT_POLICY,
  ImportBusy,
  type ImportDeps,
  ImportFailed,
  type ImportPolicy,
  type ImportWork,
  PullImports,
  publishStaged,
  readyToPublish,
  releaseLease,
  runImportStep,
} from "../network/pull-import.js";
import { type NoticeAnswer, PullSource, type RevisionNotice } from "../network/pull-source.js";
import { networkRetire, soleNetworkMember } from "../network/repo-client.js";
import { type CopyStep, type CopyStepInput, RepoNetwork } from "../network/repo-network.js";
import type {
  CommitPage,
  CondemnAnswer,
  ExportedRef,
  ForkExport,
  MemberPack,
  ViewPack,
} from "../network/types.js";
import { type CompactSliceInput, VIEW_CAP, viewCompactionHandler } from "../network/view-cap.js";
import { platformSigner } from "../signing/platform-key.js";
import { type SignedFact, verdicts } from "../signing/verification.js";
import { secretKeys } from "../webhooks/secrets.js";
import {
  AUDIT_ARCHIVE_JOB,
  AUDIT_ARCHIVE_POLICY,
  auditArchiveHandler,
  hasUnarchivedAuditRows,
  unarchivedAuditRows,
} from "./base/audit-archiver.js";
import { MigratingDO } from "./base/MigratingDO.js";
import { Outbox } from "./base/outbox.js";
import type { AclSnapshot } from "./OrgDO.js";
import {
  CONFIRMED_KEEP_MS,
  STORAGE_CHARGE_TTL_MS,
  STORAGE_QUOTA_EXCEEDED,
  STORAGE_QUOTA_UNAVAILABLE,
} from "./org/quotas.js";
import { type AclPurpose, RepoAcl } from "./repo/acl.js";
import { type ArchiveFormat, type ArchiveStatus, RepoArchives } from "./repo/archive.js";
import {
  BROWSE_POLICY,
  type Browsed,
  type BrowseFailure,
  type CommitView,
  type CompareView,
  fail,
  type LogInput,
  type LogView,
  type RefView,
  RepoBrowse,
  type TagPage,
} from "./repo/browse.js";
import { RepoComments } from "./repo/comments.js";
import {
  CONFLICTS_POLICY,
  type ConflictsView,
  type MergedIntoHead,
  mergeIntoHead,
  parseSnapshot,
  readConflicts,
} from "./repo/conflicts.js";
import {
  type ContentsView,
  contents,
  type DirCursor,
  rawFile,
  readme,
  type TreeListing,
  treeListing,
} from "./repo/contents.js";
import { type EraseOutcome, eraseRepository, recordNetwork } from "./repo/erase.js";
import {
  type JobActor,
  REPO_DELETED,
  REPO_TRANSFERRING,
  RepoEvents,
  type RepoExport,
  type RepoIdentity,
  type RepoUpdate,
} from "./repo/events.js";
import { excerpt, type FeedActor, type FeedPrincipal, RepoFeed } from "./repo/feed.js";
import {
  BUSY,
  type FileWriteDeps,
  type FileWriteInput,
  type FileWriteResult,
  finishUpload,
  storeUpload,
  writeFiles,
  refused as writeRefused,
} from "./repo/file-writes.js";
import { type HookForDelivery, type HookView, RepoHooks } from "./repo/hooks.js";
import {
  MERGE_POLICY,
  type MergeMade,
  type MergePolicy,
  mergePull,
  PULL_CHANGED,
} from "./repo/merge.js";
import { MERGEABILITY_POLICY, type PullView, RepoMergeability } from "./repo/mergeability.js";
import { mergeBaseOf, type PullFilesPage, pullCommits, pullFiles } from "./repo/pull-files.js";
import {
  type OpenPull,
  type PullCaller,
  type PullChangeFailure,
  type PullPatch,
  type PullRecord,
  RepoPulls,
} from "./repo/pulls.js";
import {
  checkPushRules,
  hasPrecheckRules,
  precheckPushRules,
  type RuleSnapshot,
} from "./repo/push-rules.js";
import {
  type MergeStamps,
  type MergeStanding,
  REBASE_POLICY,
  type RebasePolicy,
  RebaseSagas,
  rebaseCommits,
  rebaseJobId,
  type SagaView,
} from "./repo/rebase-saga.js";
import {
  RepoReviewComments,
  type ReviewCommentFailure,
  type ReviewCommentRecord,
  type ThreadAnchor,
} from "./repo/review-comments.js";
import { RepoReviews, type ReviewFailure } from "./repo/reviews.js";
import {
  RepoRulesets,
  type RuleSuite,
  type RulesetInput,
  type RulesetRecord,
} from "./repo/rulesets.js";
import { factOf } from "./repo/signature.js";
import { suggestedChanges } from "./repo/suggestions.js";
import {
  type TemplateTree,
  type TemplateWriteInput,
  templateTree,
  writeTemplate,
} from "./repo/template.js";
import { repoSchema } from "./schema/repo.js";

/** A listing's cursor that names none this repository keeps for that pull request. */
const INVALID_LISTING = fail(
  422,
  "invalid_cursor",
  "The cursor is not one this API returned, or its listing has expired: start again.",
);

/** Why a change of pull requests or reviews was not attempted. */
type PullChangeRefusal = "repo_not_found" | "repo_transferring" | "access_lost";

/** `text` without the line breaks it ends with (a loop: a regex would backtrack on many). */
function withoutTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") end--;
  return text.slice(0, end);
}

/** Principals one directory query looks up (D1 binds at most 100 parameters). */
const OWNER_BATCH = 50;

/** Stands for a commit not made yet in a ruleset precheck (only the update's kind matters there). */
const ZERO_ID = "0".repeat(40);

/** Why applying suggestions was refused at the commit point. */
const SUGGESTIONS_CHANGED =
  "the pull request or its comments changed while the suggestions were applied";

/** Suggestions to apply to a pull request's head, as the Worker asks for it. */
export interface ApplySuggestionsInput {
  readonly number: number;
  readonly commentIds: readonly number[];
  readonly message: string;
  readonly committer: GitPerson;
  readonly author: GitPerson;
}

/** A merge of the base branch into a pull request's head branch, as the Worker asks for it. */
export interface BaseMergeInput {
  readonly number: number;
  /** Who it is by (the caller; an agent's with its `Co-authored-by`). */
  readonly identity: CommitIdentity;
  /** The commit's message; by default `Merge branch '<base>' into <head>`. */
  readonly message?: string;
}

/** Conflicts resolved, as the Worker asks for it. */
export interface ResolveConflictsInput extends BaseMergeInput {
  /** The base tip and head the conflicts were read at (`ConflictsView.snapshot`). */
  readonly snapshot: string;
  /** The resolved contents of every file whose lines conflict. */
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

/** A head branch brought up to date with its base branch, as the Worker asks for it. */
export interface UpdateBranchInput extends BaseMergeInput {
  /** The head the caller saw: refused (409) when the pull request is elsewhere. */
  readonly expectedHead?: string;
}

/** Heads' repositories told per slice of the `pull_follow` job. Proposed. */
const FOLLOWS_PER_SLICE = 20;
/** When to try again after a head's repository could not be told. Proposed. */
const FOLLOW_RETRY_MS = 30_000;
/** The one job telling heads' repositories which branches to follow. */
const PULL_FOLLOW_JOB = "pull-follow";

/** Calls to other objects opening a pull request from another repository may make. Proposed. */
const OPEN_IMPORT_CALLS = 600;

/** Import steps opening a pull request from another repository may take before it gives up. */
const OPEN_IMPORT_STEPS = 40;

/** The largest file a diff comment's anchor is checked against. */
const ANCHOR_MAX_BYTES = 1024 * 1024;

/** The first comment of a new thread on a pull request's diff, as the Worker asks for it. */
export interface NewReviewComment {
  readonly body: string;
  readonly commitId: string;
  readonly path: string;
  readonly side: CommentSide;
  readonly line: number;
  readonly startLine?: number;
}

/** A merge of a pull request, as the Worker asks for it. */
export interface MergePullInput {
  readonly number: number;
  readonly method: "merge" | "squash" | "rebase";
  /** The head the caller reviewed (GitHub's `sha`): the merge fails if the pull request is elsewhere. */
  readonly expectedHead?: string;
  readonly commitTitle?: string;
  readonly commitMessage?: string;
  /** The head branch's repository's owner's handle (a fork's, or this one's), for the default merge message. */
  readonly ownerHandle: string;
  /** Who a merge commit is by: the merger. */
  readonly mergerIdentity: CommitIdentity;
  /** Who a squashed commit is by: the pull request's author. */
  readonly pullAuthorIdentity: CommitIdentity;
}

/** Why a merge into the head was refused at its commit: the base branch moved meanwhile. */
const BASE_MOVED_WHILE_MERGING = "the base branch moved while the merge was being made";
/** Why a merge into the head was refused at its commit: the pull request closed or was retargeted. */
const PULL_CHANGED_WHILE_MERGING = "the pull request changed while the merge was being made";

/** Whether a hook URL is plain http (as its parser reads it). */
function isHttp(url: string): boolean {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return true;
  }
}

/** A write of a pull request's head branch, as its base hands it to the head's repository. */
export interface PullHeadWrite {
  readonly baseRepoId: string;
  readonly number: number;
  readonly generation: number;
  readonly headRef: string;
  /** The head the write was built on, and the commit it makes (hex). */
  readonly old: string;
  readonly commit: string;
  /** The write's objects (one pack). */
  readonly pack: Uint8Array;
  /** A commit of the base the write has as a parent, to import first. */
  readonly materialize?: string;
  readonly writer: {
    readonly principal: string;
    readonly tokenId: string;
    readonly grantId: string | null;
    readonly requestId: string | null;
  };
  /** Whether the pull request lets maintainers write the branch, as the base has it now. */
  readonly maintainerAllowed: boolean;
  /** The base's check of the writer's token against the base, right before the call. */
  readonly baseDecision: PushDecision | null;
}

/** Why a maintainer's write of a pull request's head branch was refused. */
const MAINTAINER_EDITS_OFF =
  "the pull request's author does not let the base's maintainers write this branch";
/** Why a write of a pull request's head branch was refused at its commit: no longer its branch. */
const PULL_CHANGED_HERE = "the pull request no longer follows this branch";
const MAINTAINER_EDITS_OFF_DETAIL =
  "The head branch is in another repository, and its pull request's author does not let the base's maintainers write it.";

/** A write of a pull request's head branch refused at its commit, as the base answers it. */
function headWriteRefused(report: PushReportSummary): Browsed<never> {
  if (!report.ok && report.error.includes(MAINTAINER_EDITS_OFF))
    return fail(403, "maintainer_edits_off", MAINTAINER_EDITS_OFF_DETAIL);
  if (!report.ok && report.error.includes(PULL_CHANGED_HERE))
    return fail(409, "pull_changed", "The pull request no longer follows this branch.");
  return writeRefused(report);
}

/** A merge refused while the pull request's rebase merge is under way. */
const MERGE_IN_PROGRESS = fail(
  409,
  "merge_in_progress",
  "A rebase merge of this pull request is under way; wait for it, or send the rebase request again.",
);

/** A merge refused because the pull request changed while the request worked it out. */
const PULL_CHANGED_REFUSAL = fail(
  409,
  "pull_changed",
  "The pull request changed while it was being merged; review it and try the merge again.",
);

/** Why a request gave up the rebase running before it (another head or base tip, or no driver). */
const REBASE_REPLACED = fail(
  409,
  "pull_changed",
  "The pull request or its base branch changed while it was being rebased; a new rebase was started.",
);

/** What a repository object knows of the repository's details. */
export interface RepoDetails {
  readonly headTarget: string | null;
  readonly description: string | null;
}

/**
 * Wall-clock budget for one alarm run of background jobs: no new slice
 * starts after it. Proposed. A slice already started may run longer (a
 * maintenance slice up to its policy's `sliceMs`, 20 s), inside the 30 s
 * of CPU an alarm gets (measured on Workers Free, 2026-10-10).
 */
const ALARM_BUDGET_MS = 5_000;
/** The job that tells the account of committed uploads it was not told of at once. */
const STORAGE_CONFIRM_JOB = "storage-confirm";
/** How long before an owed confirmation is tried (again). Proposed. */
const STORAGE_CONFIRM_RETRY_MS = 60_000;
/** Owed confirmations one slice tells. Proposed. */
const STORAGE_CONFIRM_BATCH = 50;
/** How long a confirmation stays owed: within the account's memory of the ones it took. */
const STORAGE_OWED_MAX_AGE_MS = CONFIRMED_KEEP_MS - 24 * 60 * 60 * 1000;
/** How long an archive request builds before it answers "building". Proposed. */
const ARCHIVE_REQUEST_BUDGET_MS = 5_000;

/** The job the deletion runs the audit archiver's slices as (they read no job state). */
const DELETION_SLICE = {
  jobId: AUDIT_ARCHIVE_JOB,
  kind: "audit_archive",
  cursor: null,
  attempts: 0,
  claim: 0,
} as const;

/** One repository: refs, packs, its events and audit log. Keyed by the immutable repo id. */
/** What a generation settled as abandoned answers its own late commit. */
const GENERATION_ABANDONED =
  "the generation from the template was abandoned; the repository is being deleted";

export class RepoDO extends MigratingDO {
  static readonly schema = repoSchema;

  /**
   * Git storage: refs and the single commit point, the pack registry, packs
   * in R2, the commit graph, uploads, leases, explicit locks, jobs and the
   * operation memory pool. Nothing here relies on the input gate across an
   * await; multi-step work takes a lock and ends in one `transactionSync`.
   */
  readonly git: RepoGitStorage;

  /** Where this object's metrics are written. Tests may replace it. */
  metricsDataset: AnalyticsEngineDataset;

  /** Sends one outbox batch to the events queue. Tests may replace it. */
  sendEvents: (envelope: Envelope) => Promise<void>;

  /** Access decisions, from the account's ACL snapshot. */
  readonly acl: RepoAcl;

  /** Pulls the account's ACL snapshot for this repository. Tests may replace it. */
  pullAcl: (accountId: string) => Promise<AclSnapshot>;

  /** Where audit records are archived. Tests may replace it. */
  auditBucket: Pick<R2Bucket, "put">;

  /** Events waiting to be sent; drained by the alarm. */
  readonly outbox: Outbox;

  /** The repository's events and audit rows, written with each change. */
  readonly events: RepoEvents;

  /** Pull requests between the repository's branches. */
  readonly pulls: RepoPulls;

  /** Reviews of pull requests, and reviews requested. */
  readonly reviews: RepoReviews;

  /** Conversation comments on pull requests. */
  readonly comments: RepoComments;

  /** Comments on pull requests' diffs, and their threads. */
  readonly reviewComments: RepoReviewComments;

  /** Whether open pull requests merge cleanly, worked out in the background. */
  readonly mergeability: RepoMergeability;

  /** This repository's branches that are heads of pull requests into other members of its network. */
  readonly pullSource: PullSource;

  /** Revisions of pull requests' heads in other repositories, being imported. */
  readonly pullImports: PullImports;

  /** Rebase merges of pull requests, made over several steps. */
  readonly rebases: RebaseSagas;

  /** The repository's webhooks. */
  readonly hooks: RepoHooks;
  readonly feed: RepoFeed;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.metricsDataset = env.METRICS;
    this.git = new RepoGitStorage({
      storage: ctx.storage,
      bucket: env.GIT,
      metrics: createMetrics({
        writeDataPoint: (point) => this.metricsDataset.writeDataPoint(point),
      }),
      setAlarm: (at) => this.#arm(at),
    });
    this.auditBucket = env.ASSETS;
    this.sendEvents = async (envelope) => {
      await env.EVENTS.send(envelope, { contentType: "json" });
    };
    this.outbox = new Outbox(ctx.storage, {
      now: this.git.context.now,
      send: (envelope) => this.sendEvents(envelope),
      metrics: this.git.context.metrics,
      doClass: this.git.context.doClass,
    });
    this.events = new RepoEvents(this.git, this.outbox, () => this.#repoId());
    this.pulls = new RepoPulls({
      git: this.git,
      events: this.events,
      repoId: () => this.#repoId(),
      stale: (number, open) => this.mergeability.stale(number, open),
      follow: (pull) => this.#follow(pull),
    });
    this.pullSource = new PullSource({
      git: this.git,
      repoId: () => this.#repoId(),
      tell: (baseRepoId, notice) => this.env.REPO.getByName(baseRepoId).receiveRevision(notice),
      log: () => this.#log(),
    });
    this.pullImports = new PullImports({
      ...this.#importDeps(),
      policy: () => this.importPolicy,
      publish: (number, work, row) =>
        this.pulls.publishRevision(number, row, () => publishStaged(this.git, work.importId)),
      writable: () => this.#writeRefusal() === undefined && this.events.canEmit(),
      authorReads: async (row) => {
        const pull = this.pulls.get(row.number);
        return pull !== undefined && (await this.#headReadable(row.headRepoId, pull.authorRoot));
      },
    });
    this.mergeability = new RepoMergeability({
      git: this.git,
      events: this.events,
      pulls: this.pulls,
      memoryBlocks: () => {
        this.#blocks ??= createClockBlockCache();
        return this.#blocks;
      },
      policy: () => this.mergeabilityPolicy,
      log: () => this.#log(),
      takesChanges: () => this.#writeRefusal() === undefined,
      writable: () => this.#writeRefusal() === undefined && this.events.canEmit(),
      // Who hears of a conflict is decided with the write: from access as it is now.
      beforeWrite: async () => {
        await this.feed.prepare();
        await this.mergeabilityHooks.beforeWrite?.();
      },
    });
    this.hooks = new RepoHooks({
      git: this.git,
      events: this.events,
      repoId: () => this.#repoId(),
      keys: () => secretKeys(this.env),
    });
    this.feed = new RepoFeed({
      git: this.git,
      mayRead: (principal) =>
        this.events.visibility() === "public" || this.acl.lastRoleOf(principal) !== null,
      roleOf: (principal) => this.acl.lastRoleOf(principal),
      refreshAccess: () => this.acl.refresh(),
      resolveHandles: (handles) => this.#resolveHandles(handles),
      metrics: this.git.context.metrics,
    });
    this.events.routeFeed((type, actor, data, row) => this.feed.blockFor(type, actor, data, row));
    this.rebases = new RebaseSagas(
      {
        writeDeps: () => this.#writeDeps(),
        pulls: this.pulls,
        repoId: () => this.#repoId(),
        standing: (number, pull, method, upToDate) =>
          this.#mergeStanding(number, pull, method, upToDate),
        internalCalls: () => currentInvocation()?.tally.internal ?? 0,
        committed: () => {
          this.#armOutbox();
          this.#ensureAuditArchive();
        },
        policy: () => this.rebasePolicy,
        hooks: () => this.rebaseHooks,
        feedActor: (actor) => this.#feedActorOf(actor),
        withFeed: (actor, change) => this.feed.within(actor, change),
      },
      this.git,
    );
    this.reviews = new RepoReviews({
      git: this.git,
      events: this.events,
      pulls: this.pulls,
      repoId: () => this.#repoId(),
    });
    this.comments = new RepoComments({
      git: this.git,
      events: this.events,
      pulls: this.pulls,
      repoId: () => this.#repoId(),
    });
    this.reviewComments = new RepoReviewComments({
      git: this.git,
      events: this.events,
      pulls: this.pulls,
      repoId: () => this.#repoId(),
    });
    this.pullAcl = async (accountId) => {
      this.git.context.metrics.count("do.request", { class: "OrgDO", method: "snapshotFor" });
      return env.ORG.getByName(accountId).snapshotFor(this.#repoId());
    };
    this.acl = new RepoAcl({
      storage: ctx.storage,
      now: this.git.context.now,
      metrics: this.git.context.metrics,
      account: () => this.events.account(),
      pull: (accountId) => this.pullAcl(accountId),
    });
    // The commit point: the initiating principal may still write, under a
    // snapshot within the write window (a commit without one is the
    // repository's own, such as maintenance); a commit that moves only pull
    // request refs (opening or reopening one) needs it to read. A refusal
    // refuses the commit.
    this.git.refStore.authorizeCommit = (context) => {
      const { actor, refUpdates } = context.request;
      if (!actor) return undefined;
      // A base's maintainer: the head branch only, while its pull request's author allows it.
      if (actor.maintainerFor) return this.#maintainerRefusal(actor.maintainerFor, refUpdates);
      const pullsOnly =
        refUpdates.length > 0 && refUpdates.every((u) => u.name.startsWith(DERIVED_REF_PREFIX));
      return this.acl.allows(actor.principal, pullsOnly ? "read" : "write")
        ? undefined
        : ACCESS_LOST;
    };
    // Open pull requests' refs follow their head branches, in the same commit.
    this.git.refStore.deriveUpdates = (updates) => this.pulls.derive(updates);
    this.git.refStore.inCommit = (context) => {
      this.events.onCommit(context);
      this.pulls.onCommit(context);
      this.pullSource.onCommit(context);
    };
    this.git.refStore.onHeadChanged = () => this.events.onHeadChanged();
    // Every commit (push, import, merge) schedules the maintenance it calls
    // for and records the repository's pack count and storage.
    this.git.refStore.afterCommit = ({ nonFastForward }) => {
      scheduleAfterCommit(this.git, this.maintenance, nonFastForward);
      this.#recordStorage();
      this.#armOutbox();
      this.#ensureAuditArchive();
    };
    // First wake since an upgrade: the new version may have work for the
    // alarm that nothing set it for (stored payloads now due for deletion).
    // After the migration, which the base class runs in the same way.
    ctx.blockConcurrencyWhile(async () => {
      if (!this.migration || this.migration.from >= this.migration.to) return;
      if ((await ctx.storage.getAlarm()) === null) this.#armOutbox();
    });
  }

  /** Queues the audit archiver while audit rows wait to be archived. */
  #ensureAuditArchive(): void {
    if (!hasUnarchivedAuditRows(this.ctx.storage)) return;
    this.git.jobs.ensure("audit_archive", AUDIT_ARCHIVE_JOB, {
      runAt: this.git.context.now() + AUDIT_ARCHIVE_POLICY.delayMs,
    });
  }

  /**
   * Sets the object's one alarm for the job queue (`at`), unless the outbox
   * is due sooner: neither may push back the other's time.
   */
  #arm(at: number): void {
    const due = this.outbox.dueAt();
    void this.ctx.storage.setAlarm(due === null ? at : Math.min(at, due));
  }

  /** Arms the alarm for the outbox's next drain, unless a job is due sooner. */
  #armOutbox(): void {
    const due = this.outbox.dueAt();
    if (due === null) return;
    const job = this.git.jobs.nextAt();
    void this.ctx.storage.setAlarm(job === null ? due : Math.min(due, job));
  }

  /** The repository id (this object's name). */
  #repoId(): string {
    return this.ctx.id.name ?? "unknown";
  }

  /**
   * Writes the pack count and storage gauges once, when the current
   * invocation ends (a push of many refs commits many times); a metrics
   * failure never fails the caller.
   */
  #recordStorage(): void {
    atInvocationEnd("repo-storage", () => {
      try {
        recordRepoStorage(this.git, this.#repoId());
      } catch (error) {
        this.#log().warn("recording repository storage failed", { error });
      }
    });
  }

  /**
   * Runs one RPC method or the alarm as a measured invocation: its
   * subrequests and wall time are written when it settles.
   */
  #measured<R>(method: string, fn: () => R | Promise<R>): Promise<R> {
    // While its erase runs, and once it is erased, the object takes no other work.
    if (this.#closed && method !== "eraseForDeletion")
      return Promise.reject(new Error(REPO_DELETED));
    this.#inFlight++;
    return measureInvocation(
      this.git.context.metrics,
      { where: "do", op: method, doClass: "RepoDO" },
      fn,
    ).finally(() => {
      this.#inFlight--;
    });
  }

  /**
   * Measured calls (and the alarm) running in this instance now. Work runs
   * only in the object's one live instance, so a deletion that sees only
   * itself here knows nothing else is writing, whatever stored leases say.
   */
  #inFlight = 0;

  /** Set while the deletion's erase runs, and for good once it erased the storage. */
  #closed = false;

  /**
   * Records the repository's fork network (new packs are stored under it)
   * and points HEAD at the default branch. Errors are returned as values.
   */
  async initGitStorage(
    networkId: string,
    defaultBranch = "refs/heads/main",
    identity?: RepoIdentity & { readonly actor: string | null },
    /** The template this repository is generated from: it takes no other write until then. */
    templateId?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isNetworkId(networkId)) return { ok: false, error: "not a network id" };
    try {
      // Before the storage exists, so no write is ever admitted ahead of the generation.
      if (templateId !== undefined)
        this.ctx.storage.sql.exec(
          `INSERT INTO generation (id, template_id, started_at) VALUES (1, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          templateId,
          this.git.context.now(),
        );
      recordNetwork(this.ctx.storage, networkId, this.git.context.now());
      if (identity) this.events.assertIdentity(identity);
      this.git.initialize(networkId, defaultBranch);
      if (identity) {
        this.events.init(identity, identity.actor);
        this.#armOutbox();
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The in-memory pack block tier (24 MiB fixed, design), created on first use. */
  #blocks: BlockCache | undefined;

  /**
   * The protocol v2 `ls-refs` response for the current refs, pkt-lines and
   * flush. Annotated tags are peeled from the packs when `peel` is asked.
   */
  async lsRefs(args: LsRefsArgs): Promise<Uint8Array> {
    this.#blocks ??= createClockBlockCache();
    const memoryBlocks = this.#blocks;
    return this.#measured("lsRefs", () => lsRefsResponse({ git: this.git, memoryBlocks }, args));
  }

  /** The repository's details this object holds: the ref HEAD points at (`refs/heads/<default branch>`, or null when it is not set) and the description. */
  details(): RepoDetails {
    return { headTarget: this.git.refStore.head(), description: this.events.description() };
  }

  /**
   * `principalId`'s role on the repository for a read or a write (its ACL
   * snapshot, pulled again past its window; null when none is usable).
   * `directoryOwner` (the owner the directory named) counts only for an
   * object without an identity, which no transfer can have moved.
   */
  roleOf(
    principalId: string,
    purpose: AclPurpose,
    directoryOwner?: string,
  ): Promise<RepoRole | null> {
    return this.#measured("roleOf", () => this.acl.roleOf(principalId, purpose, directoryOwner));
  }

  /**
   * Account `accountId` committed ACL `(epochGen, version)`: an older
   * snapshot is not used again (a notice from an account the repository
   * left changes nothing).
   */
  invalidateAcl(accountId: string, epochGen: number, version: number): void {
    this.acl.invalidate(accountId, epochGen, version);
  }

  /** Whether the branch `name` (without `refs/heads/`) exists. */
  hasBranch(name: string): boolean {
    return this.git.refStore.hasRef(`refs/heads/${name}`);
  }

  /**
   * Updates the repository's settings: a rename the directory has made,
   * the description, the default branch (which must exist). Returns the
   * details after the update.
   */
  updateSettings(input: {
    name?: RepoUpdate["name"];
    description?: string | null;
    defaultBranch?: string;
    actor: RefActor | null;
  }): Promise<
    | { ok: true; details: RepoDetails }
    | {
        ok: false;
        code: "branch_not_found" | "repo_deleted" | "repo_transferring" | "access_lost";
      }
  > {
    return this.#measured("updateSettings", async () => {
      await this.checkEpoch();
      // The actor administers the repository now: the Worker checked it
      // before this call; access may have been revoked since. Pulled for a
      // write, then checked with no await before the change.
      const principal = input.actor?.principal;
      // With the owners capping an agent acting (they may have lost access meanwhile too).
      const ceilings = principal
        ? await this.#rolesPulled(principal, input.actor?.grantId ?? null)
        : [];
      // Its deletion started after the caller found it.
      if (this.events.isDeleted()) return { ok: false as const, code: "repo_deleted" as const };
      // The directory refuses a rename while a transfer moves it: no name to record.
      if (this.events.isTransferring())
        return { ok: false as const, code: "repo_transferring" as const };
      if (principal && ![principal, ...ceilings].every((p) => this.acl.allows(p, "admin"))) {
        // The directory's name is recorded even so: a rename already happened there.
        if (input.name) this.events.update({ name: input.name, actor: input.actor });
        this.#armOutbox();
        this.#ensureAuditArchive();
        return { ok: false as const, code: "access_lost" as const };
      }
      const head =
        input.defaultBranch === undefined ? undefined : `refs/heads/${input.defaultBranch}`;
      if (head !== undefined && !this.git.refStore.hasRef(head)) {
        // The directory's name is recorded even so: it is already in use.
        if (input.name) this.events.update({ name: input.name, actor: input.actor });
        this.#armOutbox();
        this.#ensureAuditArchive();
        return { ok: false as const, code: "branch_not_found" as const };
      }
      this.events.update({
        ...(input.name && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(head !== undefined && { head }),
        actor: input.actor,
      });
      this.#armOutbox();
      this.#ensureAuditArchive();
      return { ok: true as const, details: this.details() };
    });
  }

  /** The repository's rulesets, created on first use. */
  #rulesetStore: RepoRulesets | undefined;

  get rulesetStore(): RepoRulesets {
    this.#rulesetStore ??= new RepoRulesets(
      this.ctx.storage,
      (action, actor, details) => this.events.auditChange(action, actor, details),
      () => this.git.context.now(),
    );
    return this.#rulesetStore;
  }

  /** The rulesets and their version (anyone who may read the repository; the Worker checked it). */
  rulesets(): { version: number; rulesets: RulesetRecord[] } {
    return this.rulesetStore.current();
  }

  /** What `evaluate` rulesets found in pushes, newest first (see `RepoRulesets.ruleSuites`). */
  ruleSuites(limit: number, before?: number): RuleSuite[] {
    return this.rulesetStore.ruleSuites(limit, before);
  }

  /** Which of the branches `names` (short names) active rulesets protect, whoever asks. */
  protectedBranches(names: readonly string[]): boolean[] {
    const rulesets = this.rulesetStore.current().rulesets.map((r) => r.ruleset);
    const head = this.git.refStore.head();
    const defaultBranch = head?.startsWith("refs/heads/") ? head.slice("refs/heads/".length) : null;
    return names.map((name) => protectsBranch(rulesets, name, defaultBranch));
  }

  /**
   * Creates, replaces or deletes a ruleset for an administrator (the
   * Worker checked it; checked again here, with no await before the change).
   */
  changeRuleset(
    change:
      | { readonly op: "create"; readonly input: RulesetInput }
      | { readonly op: "update"; readonly id: number; readonly input: RulesetInput }
      | { readonly op: "delete"; readonly id: number },
    actor: RefActor,
  ): Promise<
    | { ok: true; record: RulesetRecord | null }
    | {
        ok: false;
        code:
          | "repo_deleted"
          | "repo_transferring"
          | "access_lost"
          | "not_found"
          | "name_taken"
          | "too_many";
      }
  > {
    return this.#measured("changeRuleset", async () => {
      await this.checkEpoch();
      // With the owners capping an agent acting (they may have lost access meanwhile too).
      const ceilings = await this.#rolesPulled(actor.principal, actor.grantId ?? null);
      if (this.#closed || this.events.isDeleted())
        return { ok: false as const, code: "repo_deleted" as const };
      if (this.events.isTransferring())
        return { ok: false as const, code: "repo_transferring" as const };
      if (![actor.principal, ...ceilings].every((p) => this.acl.allows(p, "admin")))
        return { ok: false as const, code: "access_lost" as const };
      const store = this.rulesetStore;
      const done =
        change.op === "create"
          ? store.create(change.input, actor)
          : change.op === "update"
            ? (store.update(change.id, change.input, actor) ?? ("not_found" as const))
            : store.delete(change.id, actor)
              ? null
              : ("not_found" as const);
      if (typeof done === "string") return { ok: false as const, code: done };
      this.#ensureAuditArchive();
      return { ok: true as const, record: done };
    });
  }

  /** The repository's webhooks (the Worker checked `repository_hooks:read`). */
  listHooks(): Browsed<HookView[]> {
    if (this.#refusesReads()) return fail(404, "repo_not_found", REPO_DELETED);
    return { ok: true, value: this.hooks.list() };
  }

  getHook(id: number): Browsed<HookView> {
    if (this.#refusesReads()) return fail(404, "repo_not_found", REPO_DELETED);
    const hook = this.hooks.get(id);
    return hook
      ? { ok: true, value: hook }
      : fail(404, "hook_not_found", `The repository has no webhook ${id}.`);
  }

  /**
   * Adds a webhook for an administrator (the Worker checked
   * `repository_hooks:write` and the URL; checked again here). Its secret
   * is in the answer, once.
   */
  createHook(
    input: Parameters<RepoHooks["create"]>[1],
    actor: RefActor,
  ): Promise<Browsed<{ hook: HookView; secret: string }>> {
    return this.#asHookAdmin(
      "createHook",
      actor,
      () => this.hooks.prepareSecret(),
      (prepared) => {
        if (isHttp(input.url) && this.events.visibility() !== "public")
          return fail(422, "insecure_url", "A private repository's webhooks need an https URL.");
        return this.hooks.create(prepared, input, actor);
      },
    );
  }

  updateHook(
    id: number,
    patch: Parameters<RepoHooks["update"]>[1],
    actor: RefActor,
  ): Promise<Browsed<HookView>> {
    return this.#asHookAdmin("updateHook", actor, undefined, () => {
      if (patch.url !== undefined && isHttp(patch.url) && this.events.visibility() !== "public")
        return fail(422, "insecure_url", "A private repository's webhooks need an https URL.");
      return this.hooks.update(id, patch, actor);
    });
  }

  deleteHook(id: number, actor: RefActor): Promise<Browsed<true>> {
    return this.#asHookAdmin("deleteHook", actor, undefined, () => this.hooks.delete(id, actor));
  }

  pingHook(id: number, actor: RefActor): Promise<Browsed<true>> {
    return this.#asHookAdmin("pingHook", actor, undefined, () => this.hooks.ping(id, actor));
  }

  /** A new signing secret for the hook (in the answer, once); the previous one signs a week more. */
  rotateHookSecret(id: number, actor: RefActor): Promise<Browsed<{ secret: string }>> {
    return this.#asHookAdmin(
      "rotateHookSecret",
      actor,
      () => this.hooks.prepareSecret(id),
      (prepared) => this.hooks.rotateSecret(prepared, actor),
    );
  }

  dropPreviousHookSecret(id: number, actor: RefActor): Promise<Browsed<true>> {
    return this.#asHookAdmin("dropPreviousHookSecret", actor, undefined, () =>
      this.hooks.dropPreviousSecret(id, actor),
    );
  }

  /** What a delivery attempt needs of the hook now (its open secrets included); `gone` once deleted. */
  hookForDelivery(id: number): Promise<HookForDelivery> {
    // Erased (or being erased): gone for good, not unavailable.
    if (this.#refusesReads()) return Promise.resolve({ kind: "gone" as const });
    return this.#measured("hookForDelivery", async () => {
      if (this.#refusesReads()) return { kind: "gone" as const };
      return this.hooks.forDelivery(id, this.events.visibility() !== "public");
    });
  }

  /** Turns the hook off after its receiver answered 410 Gone (unless it changed since). */
  disableHook(id: number, configVersion: number, reason: string): boolean {
    // Erased: no hook left to turn off.
    if (this.#refusesReads()) return false;
    return this.hooks.disable(id, configVersion, reason);
  }

  /** Seals again, with the current key, secrets sealed with a retired one (an operator's step). */
  resealHookSecrets(limit: number) {
    return this.#measured("resealHookSecrets", () => this.hooks.reseal(limit));
  }

  /**
   * Runs `change` for an administrator of a writable repository: what it
   * needs made first (`prepare`, which may wait), then the checks and the
   * change with no wait between them.
   */
  #asHookAdmin<P, T>(
    method: string,
    actor: RefActor,
    prepare: (() => Promise<Browsed<P>>) | undefined,
    change: (prepared: P) => Browsed<T>,
  ): Promise<Browsed<T>> {
    return this.#measured(method, async () => {
      await this.checkEpoch();
      const ceilings = await this.#rolesPulled(actor.principal, actor.grantId ?? null);
      const prepared = prepare ? await prepare() : ({ ok: true, value: undefined as P } as const);
      if (!prepared.ok) return prepared;
      const refusedWrite = this.#writeRefusal();
      if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
      if (![actor.principal, ...ceilings].every((p) => this.acl.allows(p, "admin")))
        return fail(404, "repo_not_found", "You no longer administer this repository.");
      const done = change(prepared.value);
      this.#armOutbox();
      this.#ensureAuditArchive();
      return done;
    });
  }

  /** The repository's pull requests, newest first, below `before` (a number) when given. */
  listPulls(state: PullRecord["state"] | "all", before: number | undefined, limit: number) {
    return this.#measured("listPulls", () =>
      this.#refusesReads()
        ? null
        : this.pulls.list(state, before, limit).map((p) => this.#viewed(p)),
    );
  }

  /** A change's pull request with whether it merges. */
  #withView(
    result: { ok: true; pull: PullRecord } | { ok: false; code: ReviewFailure },
  ): { ok: true; pull: PullView } | { ok: false; code: ReviewFailure } {
    return result.ok ? { ok: true, pull: this.#viewed(result.pull) } : result;
  }

  /** A pull request with whether it merges, as far as that is known now. */
  #viewed(pull: PullRecord): PullView {
    return { ...pull, ...this.mergeability.view(pull) };
  }

  /** One pull request; undefined when there is none with that number. */
  getPull(number: number) {
    return this.#measured("getPull", () => {
      if (this.#refusesReads()) return null;
      const pull = this.pulls.get(number);
      if (!pull) return undefined;
      const viewed = this.#viewed(pull);
      // Asked for and not known: worked out (a pull request from before results were kept).
      if (viewed.mergeable === null) this.mergeability.request(pull);
      return viewed;
    });
  }

  /**
   * Opens a pull request from one of the repository's branches into
   * another, for a caller the Worker found may open one (checked again
   * here, with no await before the commit).
   */
  createPull(
    input: Omit<OpenPull, "baseSha" | "headSha">,
    actor: RefActor,
  ): Promise<
    | { ok: true; record: PullView }
    | {
        ok: false;
        code:
          | "repo_not_found"
          | "repo_transferring"
          | "access_lost"
          | "base_not_found"
          | "head_not_found"
          | "same_branches"
          | "no_commits"
          | "already_exists"
          | "busy";
        number?: number;
      }
  > {
    return this.#measured("createPull", async () => {
      await this.checkEpoch();
      const ceilings = await this.#rolesPulled(actor.principal, actor.grantId ?? null);
      const root = rootIdentity({
        principalId: actor.principal,
        grantId: actor.grantId ?? null,
        ceilingIds: ceilings,
      });
      if (input.baseRef === input.headRef)
        return { ok: false as const, code: "same_branches" as const };
      const mentioned = await this.feed.prepare([input.body]);
      for (let attempt = 0; attempt < 3; attempt++) {
        const refused = this.#writeRefusal();
        if (refused) return { ok: false as const, code: refused.code as "repo_not_found" };
        if (this.#roleNow(actor.principal, ceilings) === null)
          return { ok: false as const, code: "access_lost" as const };
        const { version } = this.git.refStore.state();
        const baseSha = this.pulls.branchTip(input.baseRef);
        if (!baseSha) return { ok: false as const, code: "base_not_found" as const };
        const headSha = this.pulls.branchTip(input.headRef);
        if (!headSha) return { ok: false as const, code: "head_not_found" as const };
        let merged: boolean;
        try {
          merged = await isAncestor(this.git.commitGraph, "verified", headSha, baseSha, {
            maxCommits: 3 * BROWSE_POLICY.compareMaxCommits,
          });
        } catch (error) {
          // Too far apart to tell cheaply: the head has commits of its own.
          if (!(error instanceof WalkLimitError)) throw error;
          merged = false;
        }
        if (merged) return { ok: false as const, code: "no_commits" as const };
        if (this.git.refStore.state().version !== version) continue;
        const role = this.#roleNow(actor.principal, ceilings);
        const opened = this.feed.within({ root, role, mentioned }, () =>
          this.pulls.open({ ...input, baseSha, headSha }, version, { actor, root }),
        );
        if (!opened.ok && opened.code === "version-conflict") continue;
        this.#armOutbox();
        this.#ensureAuditArchive();
        return opened.ok ? { ok: true as const, record: this.#viewed(opened.record) } : opened;
      }
      return { ok: false as const, code: "busy" as const };
    });
  }

  /**
   * Opens a pull request whose head is a branch of another repository of
   * the network (`headRepoId`, which the Worker found the caller reads):
   * the head's revision is imported first (its packs borrowed, its commit
   * graph copied), then the pull request is opened on it, its rows joining
   * the graph in the same transaction; the head's repository then tells of
   * each later revision.
   */
  createForkPull(
    input: Omit<OpenPull, "baseSha" | "headSha" | "headRefVersion"> & {
      readonly headRepoId: string;
    },
    actor: RefActor,
  ): Promise<
    | { ok: true; record: PullView }
    | {
        ok: false;
        code:
          | "repo_not_found"
          | "repo_transferring"
          | "access_lost"
          | "base_not_found"
          | "head_not_found"
          | "no_commits"
          | "already_exists"
          | "too_expensive"
          | "busy";
        number?: number;
      }
  > {
    return this.#measured("createForkPull", async () => {
      await this.checkEpoch();
      const ceilings = await this.#rolesPulled(actor.principal, actor.grantId ?? null);
      const root = rootIdentity({
        principalId: actor.principal,
        grantId: actor.grantId ?? null,
        ceilingIds: ceilings,
      });
      // What can be refused without importing anything is refused first.
      const refusedEarly = this.#writeRefusal();
      if (refusedEarly) return { ok: false as const, code: refusedEarly.code as "repo_not_found" };
      if (this.#roleNow(actor.principal, ceilings) === null)
        return { ok: false as const, code: "access_lost" as const };
      if (!this.pulls.branchTip(input.baseRef))
        return { ok: false as const, code: "base_not_found" as const };
      const existing = this.pulls.openBetween(input.headRef, input.baseRef, input.headRepoId);
      if (existing !== undefined)
        return { ok: false as const, code: "already_exists" as const, number: existing };
      const mentioned = await this.feed.prepare([input.body]);
      const head = this.env.REPO.getByName(input.headRepoId);
      const tip = await head.pullHeadTip(input.headRef);
      if (!tip.sha) return { ok: false as const, code: "head_not_found" as const };
      const importId = `open:${crypto.randomUUID()}`;
      // Calls this invocation makes to other objects: within Free's 1,000, with room to spare.
      const budget = { used: 2, max: OPEN_IMPORT_CALLS };
      let work: ImportWork = {
        importId,
        headRepoId: input.headRepoId,
        sha: tip.sha,
        step: "snapshot",
        leaseId: null,
        state: {},
      };
      let opened: Awaited<ReturnType<RepoPulls["open"]>> | undefined;
      try {
        for (let steps = 0; work.step !== "publish"; steps++) {
          if (steps >= OPEN_IMPORT_STEPS || budget.used >= budget.max)
            return { ok: false as const, code: "too_expensive" as const };
          work = await runImportStep(this.#importDeps(), work, this.importPolicy, budget);
        }
        await this.forkPullHooks.beforePublish?.();
        // Published, the revision becomes readable through the base: the opener must read the
        // head's repository still (the Worker checked it before the import began).
        if (!(await this.#headReadable(input.headRepoId, root)))
          return { ok: false as const, code: "head_not_found" as const };
        for (let attempt = 0; attempt < 3; attempt++) {
          const refused = this.#writeRefusal();
          if (refused) return { ok: false as const, code: refused.code as "repo_not_found" };
          if (this.#roleNow(actor.principal, ceilings) === null)
            return { ok: false as const, code: "access_lost" as const };
          const { version } = this.git.refStore.state();
          const baseSha = this.pulls.branchTip(input.baseRef);
          if (!baseSha) return { ok: false as const, code: "base_not_found" as const };
          const headSha = oidFromHex(tip.sha);
          // A head the base's graph has already is in its history unless it is ahead of the base.
          if (this.git.commitGraph.readSync([headSha], "verified")[0]) {
            let merged: boolean;
            try {
              merged = await isAncestor(this.git.commitGraph, "verified", headSha, baseSha, {
                maxCommits: 3 * BROWSE_POLICY.compareMaxCommits,
              });
            } catch (error) {
              if (!(error instanceof WalkLimitError)) throw error;
              merged = false;
            }
            if (merged) return { ok: false as const, code: "no_commits" as const };
          }
          if (this.git.refStore.state().version !== version) continue;
          if (!this.ctx.storage.transactionSync(() => readyToPublish(this.git, work)))
            return { ok: false as const, code: "busy" as const };
          const role = this.#roleNow(actor.principal, ceilings);
          opened = this.feed.within({ root, role, mentioned }, () =>
            this.pulls.open(
              { ...input, baseSha, headSha, headRefVersion: tip.refVersion },
              version,
              { actor, root },
              () => {
                // Checked again in the ref transaction: the base's collection may have run.
                if (!readyToPublish(this.git, work)) throw new ImportBusy("the import changed");
                publishStaged(this.git, importId);
              },
            ),
          );
          if (!opened.ok && opened.code === "version-conflict") continue;
          break;
        }
      } catch (error) {
        if (error instanceof ImportFailed)
          return error.code === "too_large"
            ? { ok: false as const, code: "too_expensive" as const }
            : error.code === "unknown_commit"
              ? { ok: false as const, code: "head_not_found" as const }
              : { ok: false as const, code: "busy" as const };
        if (error instanceof ImportBusy) return { ok: false as const, code: "busy" as const };
        throw error;
      } finally {
        if (opened?.ok) {
          // All the head's packs were borrowed: those no ref reaches go with a later collection.
          if ((work.state.packs?.length ?? 0) > 0) collectLater(this.git);
          await releaseLease(this.#importDeps(), work);
        } else await discardImport(this.#importDeps(), work);
      }
      if (!opened) return { ok: false as const, code: "busy" as const };
      if (!opened.ok) return opened as { ok: false; code: "already_exists"; number: number };
      this.#armOutbox();
      this.#ensureAuditArchive();
      return { ok: true as const, record: this.#viewed(opened.record) };
    });
  }

  /**
   * In the transaction of a change of a pull request whose head is in
   * another repository (opened, closed, reopened, merged): that repository
   * must follow the branch for it, or no longer. Recorded here and told by
   * the `pull_follow` job until it is told; closed, its import is dropped.
   */
  #follow(pull: PullRecord): void {
    const follow = pull.state === "open";
    if (!follow) this.pullImports.drop(pull.number);
    this.ctx.storage.sql.exec(
      `INSERT INTO head_follows (pr_number, head_repo_id, head_ref, generation, follow, known_sha,
         requested_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pr_number) DO UPDATE SET head_repo_id = excluded.head_repo_id,
         head_ref = excluded.head_ref, generation = excluded.generation, follow = excluded.follow,
         known_sha = excluded.known_sha, requested_at = excluded.requested_at, next_at = 0,
         revision = excluded.revision`,
      pull.number,
      pull.headRepoId as string,
      pull.headRef,
      pull.generation,
      follow ? 1 : 0,
      pull.headSha,
      this.git.context.now(),
      // The pull request's version: a request replacing this one (even after it was told and
      // deleted) has a later one, so an answer to this one never takes that one away.
      pull.version,
    );
    this.git.jobs.ensure("pull_follow", PULL_FOLLOW_JOB);
  }

  /** The author's consent to maintainer edits, as the pull request has it now (its version with it). */
  #consentOf(number: number) {
    const pull = this.pulls.get(number);
    return (
      pull && {
        maintainerCanModify: pull.maintainerCanModify,
        authorRoot: pull.authorRoot,
        version: pull.version,
      }
    );
  }

  /** The job telling heads' repositories which branches to follow; one not reached is tried later. */
  #followHandler(): JobHandler {
    return {
      runSlice: async () => {
        const sql = this.ctx.storage.sql;
        const rows = sql
          .exec<{
            pr_number: number;
            head_repo_id: string;
            head_ref: string;
            generation: number;
            follow: number;
            known_sha: string | null;
            requested_at: number;
            revision: number;
          }>(
            "SELECT * FROM head_follows WHERE next_at <= ? ORDER BY requested_at LIMIT ?",
            this.git.context.now(),
            FOLLOWS_PER_SLICE,
          )
          .toArray();
        for (const row of rows) {
          const head = this.env.REPO.getByName(row.head_repo_id);
          try {
            if (row.follow === 1) {
              const consent = this.#consentOf(row.pr_number);
              await head.registerOutgoingPull({
                baseRepoId: this.#repoId(),
                number: row.pr_number,
                headRef: row.head_ref,
                generation: row.generation,
                knownSha: row.known_sha,
                ...(consent && { consent }),
              });
            } else await head.unregisterOutgoingPull(this.#repoId(), row.pr_number, row.generation);
          } catch (error) {
            this.#log().warn("telling a pull request's head repository failed", {
              number: row.pr_number,
              error,
            });
            // Tried again later; the others go on meanwhile.
            sql.exec(
              "UPDATE head_follows SET next_at = ? WHERE pr_number = ? AND revision = ?",
              this.git.context.now() + FOLLOW_RETRY_MS,
              row.pr_number,
              row.revision,
            );
            continue;
          }
          // Told: gone unless the pull request changed again meanwhile.
          sql.exec(
            "DELETE FROM head_follows WHERE pr_number = ? AND revision = ?",
            row.pr_number,
            row.revision,
          );
        }
        const next = sql
          .exec<{ at: number | null }>("SELECT min(next_at) AS at FROM head_follows")
          .one().at;
        if (next === null) return { done: true };
        return {
          done: false,
          cursor: null,
          runAfterMs: Math.max(0, next - this.git.context.now()),
        };
      },
    };
  }

  /**
   * Changes a pull request as the mutation matrix allows the caller, with
   * its role and root identity worked out here (no await before the change).
   */
  changePull(
    number: number,
    patch: PullPatch,
    actor: RefActor,
  ): Promise<
    | { ok: true; record: PullView }
    | { ok: false; code: "already_exists"; number: number }
    | {
        ok: false;
        code: Exclude<PullChangeFailure, "already_exists"> | PullChangeRefusal | "busy";
      }
  > {
    return this.#pullChange(
      "changePull",
      actor,
      (caller) => {
        const changed = this.pulls.change(number, patch, caller);
        // Nothing awaits between the read and the commit: a conflict means a
        // concurrent change no retry here could see past.
        if (changed.ok) return { ok: true as const, record: this.#viewed(changed.record) };
        return changed.code === "version-conflict"
          ? { ok: false as const, code: "busy" as const }
          : changed;
      },
      undefined,
      [patch.body],
    );
  }

  /**
   * Merges a pull request into its base branch (a merge commit, or one
   * squashed commit) for a caller with write access, through the push path:
   * built from the base branch's tip and the head recorded now, judged by
   * the rulesets with the pull request's reviews and last push, and
   * committed only while the pull request, its reviews and the base tip
   * are as they were (the commit marks it merged).
   */
  mergePull(input: MergePullInput, actor: RefActor): Promise<Browsed<MergeMade>> {
    return this.#measured("mergePull", async () => {
      await this.checkEpoch();
      const ceilings = await this.#rolesPulled(actor.principal, actor.grantId ?? null);
      // Who hears of the merge is decided with it: from access as it is now.
      const feedActor = await this.#feedActorOf(actor);
      const refusedWrite = this.#writeRefusal();
      if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
      const { number, method } = input;
      const pull = this.pulls.get(number);
      if (!pull)
        return fail(404, "pull_not_found", `The repository has no pull request ${number}.`);
      // A rebase that finished after its request answered: the same answer, merged.
      const saga = method === "rebase" ? this.rebases.view(number) : undefined;
      if (
        saga?.state === "done" &&
        pull.state === "merged" &&
        pull.mergeCommitSha === saga.resultSha &&
        saga.resultSha !== null &&
        atLeast(this.#roleNow(actor.principal, ceilings), "write")
      )
        return { ok: true, value: { sha: saga.resultSha } };
      const decision = decidePullAction("merge", {
        state: pull.state,
        headRefDeleted: false,
        isAuthor: false,
        role: this.#roleNow(actor.principal, ceilings),
      });
      if (!decision.ok)
        return decision.refusal === "forbidden"
          ? fail(403, "forbidden", "Merging a pull request takes write access.")
          : fail(405, "not_mergeable", `Pull request ${number} is not open.`);
      if (
        method !== "rebase" &&
        this.rebases.view(number)?.state === "running" &&
        !this.rebases.undriven(number)
      )
        return MERGE_IN_PROGRESS;
      if (pull.draft)
        return fail(
          405,
          "not_mergeable",
          `Pull request ${number} is a draft; mark it ready for review first.`,
        );
      if (input.expectedHead !== undefined && input.expectedHead !== pull.headSha)
        return fail(409, "head_moved", "The head branch was modified; review it and try again.");
      const baseTip = this.pulls.branchTip(pull.baseRef);
      if (!baseTip) return fail(422, "base_not_found", "The base branch does not exist.");
      const head = oidFromHex(pull.headSha);
      const walk = { maxCommits: this.mergePolicy.maxCommits };
      let upToDate: boolean;
      try {
        if (await isAncestor(this.git.commitGraph, "verified", head, baseTip, walk))
          return fail(405, "not_mergeable", "The base branch already contains the head.");
        upToDate = await isAncestor(this.git.commitGraph, "verified", baseTip, head, walk);
      } catch (error) {
        if (!(error instanceof WalkLimitError)) throw error;
        return fail(
          422,
          "too_expensive",
          "The base branch and the head are too far apart to merge here.",
        );
      }

      const { merge, asRead, stamps } = await this.#mergeStanding(number, pull, method, upToDate);
      const baseRef = `refs/heads/${pull.baseRef}`;
      const precheck = await this.#precheckUpdates(
        actor.principal,
        [{ ref: baseRef, old: oidToHex(baseTip), new: ZERO_ID }],
        actor.grantId ?? null,
        undefined,
        merge,
      );
      if (precheck) return fail(405, "merge_refused", precheck);
      if (method === "rebase")
        return this.#rebase(input, actor, { pull, baseRef, baseTip, head, upToDate, asRead });

      // GitHub's default messages; a squash is the pull request author's.
      const identity: CommitIdentity =
        method === "squash" ? input.pullAuthorIdentity : input.mergerIdentity;
      const title =
        input.commitTitle ??
        (method === "merge"
          ? `Merge pull request #${number} from ${input.ownerHandle}/${pull.headRef}`
          : `${pull.title} (#${number})`);
      const body = input.commitMessage ?? (method === "merge" ? pull.title : (pull.body ?? ""));
      const text =
        body.trim() === "" ? `${title}\n` : `${title}\n\n${withoutTrailingNewlines(body)}\n`;
      // A title or body may hold NUL; git stops reading a message there.
      if (text.includes("\0"))
        return fail(
          422,
          "invalid_input",
          "The pull request's title or body contains NUL; give commit_title and commit_message.",
        );
      const message = appendTrailers(text, coAuthorTrailers(text, identity.coAuthors));
      const made = await mergePull(
        await this.#writeDeps(),
        {
          writer: {
            principal: actor.principal,
            tokenId: actor.tokenId ?? "",
            grantId: actor.grantId ?? null,
            repoId: this.#repoId(),
            requestId: actor.requestId ?? null,
          },
          method,
          baseRef,
          baseTip,
          head,
          upToDate,
          author: identity.author,
          committer: identity.committer,
          message,
          merge,
          fence: () =>
            this.pulls.mergeFence(number, pull) &&
            JSON.stringify(stamps()) === JSON.stringify(asRead)
              ? undefined
              : PULL_CHANGED,
          inCommit: (sha) =>
            this.feed.within(feedActor, () =>
              this.pulls.markMerged(
                number,
                sha,
                method,
                { ...actor, via: "merge" },
                this.git.context.now(),
              ),
            ),
          ...(this.mergeHooks.beforeFinish && { beforeFinish: this.mergeHooks.beforeFinish }),
        },
        this.mergePolicy,
      );
      this.#armOutbox();
      this.#ensureAuditArchive();
      return made;
    });
  }

  /**
   * What the rulesets judge a merge by, from the repository's own records:
   * the pull request's reviews, whose of them count (write access now),
   * its last push and threads; `then` stamps them as read (before any
   * wait), `stamps` as they are when called (in the commit's transaction).
   */
  async #mergeStanding(
    number: number,
    pull: PullRecord,
    method: MergePullInput["method"],
    upToDate: boolean,
  ): Promise<MergeStanding & { readonly asRead: MergeStamps }> {
    const standing = this.reviews.standing(number);
    const threadsThen = this.reviewComments.stamp(number);
    // Whose reviews count: write access now, checked again in the commit's transaction.
    const reviewerOwners = await this.#ownersPulled([
      ...new Set(standing.reviews.map((r) => r.reviewerRoot)),
    ]);
    const eligible = () =>
      [...reviewerOwners]
        .filter(([root, owners]) => atLeast(this.#roleNow(root, owners), "write"))
        .map(([root]) => root);
    const eligibleRoots = new Set(eligible());
    const lastPush =
      pull.lastPusher === null || pull.lastPushAt === null
        ? null
        : {
            pusherRoot: rootIdentity({
              principalId: pull.lastPusher,
              grantId: pull.lastPusherGrant,
              ceilingIds: await this.#ceilingsOf(pull.lastPusher, pull.lastPusherGrant),
            }),
            at: pull.lastPushAt,
          };
    const merge: MergeContext = {
      number,
      method,
      approvals: {
        reviews: standing.reviews,
        headSha: pull.headSha,
        authorRoot: pull.authorRoot,
        lastPush,
        eligibleRoots,
      },
      unresolvedThreads: this.reviewComments.unresolved(number),
      upToDate,
    };
    return {
      merge,
      asRead: {
        reviews: standing.stamp,
        threads: threadsThen,
        eligible: [...eligibleRoots].join(" "),
      },
      stamps: () => ({
        reviews: this.reviews.stamp(number),
        threads: this.reviewComments.stamp(number),
        eligible: eligible().join(" "),
      }),
    };
  }

  /**
   * A rebase merge (see `RebaseSagas`): starts the pull request's saga, or
   * takes up the one running for the same head and base tip, and drives it
   * as far as this request may. Answers the merge when it is done, its
   * refusal when it failed, `merge_in_progress` while the alarm goes on.
   */
  async #rebase(
    input: MergePullInput,
    actor: RefActor,
    at: {
      readonly pull: PullRecord;
      readonly baseRef: string;
      readonly baseTip: Oid;
      readonly head: Oid;
      readonly upToDate: boolean;
      readonly asRead: MergeStamps;
    },
  ): Promise<Browsed<MergeMade>> {
    const { number } = input;
    const policy = this.rebasePolicy;
    // A saga of what this request checked: its head, onto its base branch at its tip.
    const ours = (saga: SagaView) =>
      saga.head === at.pull.headSha &&
      saga.baseRef === at.baseRef &&
      saga.baseTip === oidToHex(at.baseTip);
    // The pull request and its base branch are still as this request saw them.
    const current = () =>
      this.pulls.mergeFence(number, at.pull) &&
      this.pulls.branchTip(at.pull.baseRef)?.every((b, i) => b === at.baseTip[i]) === true;
    let saga = this.rebases.view(number);
    // Finished while this request waited: its merge, when it was of what this one checked.
    if (saga?.state === "done" && saga.resultSha)
      return ours(saga) ? { ok: true, value: { sha: saga.resultSha } } : PULL_CHANGED_REFUSAL;
    // Failed after an earlier request answered: a request for the same attempt answers why, once
    // (the next one starts again); a current request for another one starts its own.
    if (saga?.state === "failed" && saga.failure && !saga.reported) {
      if (ours(saga)) {
        if (this.rebases.report(number, saga.sagaId)) return saga.failure;
      } else if (!current()) return PULL_CHANGED_REFUSAL;
      else this.rebases.report(number, saga.sagaId);
    }
    if (saga?.state === "running" && (!ours(saga) || this.rebases.undriven(number))) {
      // Only a request that is not itself behind replaces it (checked with no wait before).
      if (!current()) return PULL_CHANGED_REFUSAL;
      await this.rebases.abandon(number, saga.sagaId, REBASE_REPLACED);
      saga = this.rebases.view(number);
    }
    if (saga?.state !== "running") {
      const keyId = (await this.#writeDeps()).signer?.keyId;
      if (!keyId)
        return fail(
          422,
          "signing_unavailable",
          "Rebase merges sign every commit they make, and the server has no signing key.",
        );
      if (this.rebases.running() >= policy.maxRunning) return BUSY;
      const commits = await rebaseCommits(this.git.commitGraph, at.baseTip, at.head, {
        maxCommits: policy.maxCommits,
        maxWalk: this.mergePolicy.maxCommits,
      });
      if (!commits.ok) return commits;
      const [base] = this.git.commitGraph.readSync([at.baseTip], "verified");
      if (!base) return fail(422, "unreadable", "An object the merge needs cannot be read.");
      // Checked again with the start: another request may have started or finished one, or the
      // pull request or base branch changed, while this one waited.
      const started = this.rebases.start(
        {
          number,
          pull: at.pull,
          stamps: at.asRead,
          actor: {
            principal: actor.principal,
            tokenId: actor.tokenId ?? null,
            grantId: actor.grantId ?? null,
            onBehalfOf: actor.onBehalfOf ?? null,
            actChain: actor.actChain ?? [],
            requestId: actor.requestId ?? null,
          },
          baseRef: at.baseRef,
          baseTip: at.baseTip,
          baseTree: base.tree,
          head: at.head,
          upToDate: at.upToDate,
          committer: input.mergerIdentity.committer,
          keyId,
          commits: commits.value,
        },
        current,
      );
      if (started === "busy") return BUSY;
      if (started === "changed") return PULL_CHANGED_REFUSAL;
    }
    // The saga this request answers for: one for the head and base tip it checked (another
    // request may have started one for a newer head meanwhile).
    const mine = this.rebases.view(number);
    if (!mine || !ours(mine)) return PULL_CHANGED_REFUSAL;
    await this.git.jobs.runJob(
      rebaseJobId(number),
      this.rebases.handler("request"),
      this.git.memory,
      this.git.context.now() + policy.requestMs,
    );
    this.#armOutbox();
    this.#ensureAuditArchive();
    const now = this.rebases.view(number);
    // Replaced while it ran (by a request for a newer head): not this request's answer.
    if (now?.sagaId !== mine.sagaId) return PULL_CHANGED_REFUSAL;
    if (now.state === "done" && now.resultSha) return { ok: true, value: { sha: now.resultSha } };
    if (now.state === "failed" && now.failure) {
      this.rebases.report(number, now.sagaId);
      return now.failure;
    }
    return fail(
      409,
      "merge_in_progress",
      `The rebase is under way (${now.next} of ${now.commits} commits replayed); send the request again, or watch the pull request, to see it merged.`,
    );
  }

  /**
   * A page of the files a pull request changes. Without `from`, a listing
   * starts: the merge base of the base branch's tip (else the recorded
   * base) and the recorded head is worked out now, and kept for the later
   * pages when there are any; `from` names such a listing (a cursor this
   * repository gave) and where its next page starts.
   */
  listPullFiles(
    number: number,
    from: { readonly listing: string; readonly start: number } | null,
    limit: number,
  ) {
    return this.#browse(
      "listPullFiles",
      async (browse): Promise<Browsed<PullFilesPage & { listing: string | null }>> => {
        if (this.#refusesReads()) return fail(404, "repo_not_found", REPO_DELETED);
        const pull = this.pulls.get(number);
        if (!pull)
          return fail(404, "pull_not_found", `The repository has no pull request ${number}.`);
        let listing = from?.listing ?? null;
        let mergeBase: Oid;
        let head: Oid;
        if (from) {
          const kept = this.pulls.listing(number, "files", from.listing);
          if (!kept) return INVALID_LISTING;
          mergeBase = oidFromHex(kept.base);
          head = oidFromHex(kept.head);
        } else {
          head = oidFromHex(pull.headSha);
          const base = this.pulls.branchTip(pull.baseRef) ?? oidFromHex(pull.baseSha);
          const found = await mergeBaseOf(this.git.commitGraph, base, head);
          if (!found.ok) return found;
          mergeBase = found.value;
        }
        const page = await pullFiles(browse, this.git.commitGraph, {
          mergeBase,
          head,
          start: from?.start ?? 0,
          limit,
        });
        if (!page.ok) return page;
        if (!listing && page.value.next !== null)
          listing = this.pulls.startListing(number, "files", page.value.mergeBase, page.value.head);
        return { ok: true, value: { ...page.value, listing } };
      },
    );
  }

  /**
   * A page of a pull request's commits, oldest first: from the base
   * branch's tip (else the recorded base) to the recorded head, kept for
   * the later pages as a file listing is.
   */
  listPullCommits(
    number: number,
    from: { readonly listing: string; readonly start: number } | null,
    limit: number,
  ) {
    return this.#browse("listPullCommits", async (browse) => {
      if (this.#refusesReads()) return fail(404, "repo_not_found", REPO_DELETED);
      const pull = this.pulls.get(number);
      if (!pull)
        return fail(404, "pull_not_found", `The repository has no pull request ${number}.`);
      let listing = from?.listing ?? null;
      let base: Oid;
      let head: Oid;
      if (from) {
        const kept = this.pulls.listing(number, "commits", from.listing);
        if (!kept) return INVALID_LISTING;
        base = oidFromHex(kept.base);
        head = oidFromHex(kept.head);
      } else {
        base = this.pulls.branchTip(pull.baseRef) ?? oidFromHex(pull.baseSha);
        head = oidFromHex(pull.headSha);
      }
      const page = await pullCommits(browse, this.git.commitGraph, {
        base,
        head,
        start: from?.start ?? 0,
        limit,
      });
      if (!page.ok) return page;
      if (!listing && page.value.next !== null)
        listing = this.pulls.startListing(number, "commits", oidToHex(base), oidToHex(head));
      return { ok: true as const, value: { ...page.value, listing } };
    });
  }

  /** A pull request's reviews in the order submitted; null when the repository is gone, undefined without the pull request. */
  listReviews(number: number, after: number, limit: number) {
    return this.#measured("listReviews", () => {
      if (this.#refusesReads()) return null;
      if (!this.pulls.get(number)) return undefined;
      return this.reviews.list(number, after, limit);
    });
  }

  /** One review of a pull request; null when the repository is gone. */
  getReview(number: number, id: number) {
    return this.#measured("getReview", () =>
      this.#refusesReads() ? null : (this.reviews.get(number, id) ?? undefined),
    );
  }

  /** Submits a review as the caller, its role and root identity worked out here. */
  submitReview(
    number: number,
    input: {
      readonly event: ReviewEvent;
      readonly body: string | null;
      readonly commitSha: string;
    },
    actor: RefActor,
  ) {
    return this.#pullChange(
      "submitReview",
      actor,
      (caller) => this.reviews.submit(number, input, caller),
      undefined,
      [input.body],
    );
  }

  /** Dismisses a review, keeping why. */
  dismissReview(number: number, id: number, message: string, actor: RefActor) {
    return this.#pullChange("dismissReview", actor, (caller) =>
      this.reviews.dismiss(number, id, message, caller),
    );
  }

  /** The principals reviews of a pull request are requested of; undefined without it. */
  requestedReviewers(number: number) {
    return this.#measured("requestedReviewers", () => {
      if (this.#refusesReads()) return null;
      if (!this.pulls.get(number)) return undefined;
      return this.reviews.requested(number);
    });
  }

  /**
   * Requests reviews of principals (users and agents, found by the
   * Worker); each one's access is checked here, an agent's capped by its
   * owner's, before the change.
   */
  requestReviewers(number: number, reviewerIds: readonly string[], actor: RefActor) {
    return this.#pullChange(
      "requestReviewers",
      actor,
      (caller, ceilings) =>
        this.#withView(
          this.reviews.request(
            number,
            [...ceilings].map(([id, owners]) => ({
              id,
              root: rootIdentity({ principalId: id, grantId: null, ceilingIds: owners }),
              role: this.#roleNow(id, owners),
            })),
            caller,
          ),
        ),
      async () => {
        const ceilings = new Map<string, string[]>();
        for (const id of new Set(reviewerIds)) ceilings.set(id, await this.#rolesPulled(id, null));
        return ceilings;
      },
    );
  }

  /** A pull request's comments, oldest first; null when the repository is gone, undefined without the pull request. */
  listComments(number: number, after: number, limit: number) {
    return this.#measured("listComments", () => {
      if (this.#refusesReads()) return null;
      if (!this.pulls.get(number)) return undefined;
      return this.comments.list(number, after, limit);
    });
  }

  /** One comment; null when the repository is gone. */
  getComment(id: number) {
    return this.#measured("getComment", () =>
      this.#refusesReads() ? null : (this.comments.get(id) ?? undefined),
    );
  }

  createComment(number: number, body: string, actor: RefActor) {
    return this.#pullChange(
      "createComment",
      actor,
      (caller) => this.comments.create(number, body, caller),
      undefined,
      [body],
    );
  }

  editComment(id: number, body: string, actor: RefActor) {
    return this.#pullChange(
      "editComment",
      actor,
      (caller) => this.comments.edit(id, body, caller),
      undefined,
      [body],
    );
  }

  deleteComment(id: number, actor: RefActor) {
    return this.#pullChange("deleteComment", actor, (caller) => this.comments.delete(id, caller));
  }

  /** A pull request's diff comments, oldest first; null when the repository is gone, undefined without the pull request. */
  listReviewComments(number: number, after: number, limit: number) {
    return this.#measured("listReviewComments", () => {
      if (this.#refusesReads()) return null;
      const pull = this.pulls.get(number);
      if (!pull) return undefined;
      return { headSha: pull.headSha, comments: this.reviewComments.list(number, after, limit) };
    });
  }

  /** One diff comment, with its pull request's head; null when the repository is gone. */
  getReviewComment(id: number) {
    return this.#measured("getReviewComment", () => {
      if (this.#refusesReads()) return null;
      const comment = this.reviewComments.get(id);
      if (!comment) return undefined;
      return { headSha: this.pulls.get(comment.number)?.headSha ?? null, comment };
    });
  }

  /** A pull request's threads, oldest first; null when the repository is gone, undefined without the pull request. */
  listReviewThreads(number: number, after: number, limit: number) {
    return this.#measured("listReviewThreads", () => {
      if (this.#refusesReads()) return null;
      const pull = this.pulls.get(number);
      if (!pull) return undefined;
      return { headSha: pull.headSha, threads: this.reviewComments.threads(number, after, limit) };
    });
  }

  /**
   * Starts a thread on a pull request's diff, at an anchor checked against
   * the file it names: at the commit (a head the pull request has had) for
   * the head side, at the merge base of the base branch and that commit
   * for the base side.
   */
  createReviewComment(number: number, input: NewReviewComment, actor: RefActor) {
    return this.#pullChange(
      "createReviewComment",
      actor,
      (caller, anchor) =>
        anchor.ok
          ? this.#withHead(this.reviewComments.start(number, anchor.value, input.body, caller))
          : anchor,
      () => this.#checkedAnchor(number, input),
      [input.body],
    );
  }

  /** Replies in the thread of comment `to`. */
  replyReviewComment(number: number, to: number, body: string, actor: RefActor) {
    return this.#pullChange(
      "replyReviewComment",
      actor,
      (caller) => this.#withHead(this.reviewComments.reply(number, to, body, caller)),
      undefined,
      [body],
    );
  }

  /** `input`'s anchor, if the file it names has the lines it names. */
  async #checkedAnchor(
    number: number,
    input: NewReviewComment,
  ): Promise<{ ok: true; value: ThreadAnchor } | BrowseFailure | { ok: false; code: string }> {
    const pull = this.pulls.get(number);
    if (!pull) return { ok: false, code: "not_found" };
    if (!this.pulls.hadHead(number, input.commitId))
      return { ok: false, code: "commit_not_in_pull" };
    // An earlier head force-pushed away is kept only while the reflog keeps it.
    if (!this.git.commitGraph.readSync([oidFromHex(input.commitId)], "verified")[0])
      return { ok: false, code: "commit_unavailable" };
    let at = input.commitId;
    if (input.side === "LEFT") {
      const base = this.pulls.branchTip(pull.baseRef) ?? oidFromHex(pull.baseSha);
      const found = await mergeBaseOf(this.git.commitGraph, base, oidFromHex(input.commitId));
      if (!found.ok) return found;
      at = oidToHex(found.value);
    }
    this.#blocks ??= createClockBlockCache();
    const browse = new RepoBrowse({ git: this.git, memoryBlocks: this.#blocks });
    let file: Awaited<ReturnType<typeof rawFile>>;
    try {
      file = await rawFile(browse, at, input.path, ANCHOR_MAX_BYTES);
    } finally {
      browse.close();
    }
    // A missing file is a refused anchor (422); any other failure keeps its own status.
    if (!file.ok)
      return file.code === "path_not_found" ? { ok: false, code: "path_not_found" } : file;
    const anchor = { side: input.side, line: input.line, startLine: input.startLine ?? null };
    const refused = checkAnchor(anchor, lineCount(file.value.bytes));
    if (refused) return { ok: false, code: refused };
    return { ok: true, value: { commitSha: input.commitId, path: input.path, ...anchor } };
  }

  editReviewComment(id: number, body: string, actor: RefActor) {
    return this.#pullChange(
      "editReviewComment",
      actor,
      (caller) => this.#withHead(this.reviewComments.edit(id, body, caller)),
      undefined,
      [body],
    );
  }

  /** A diff comment's change, with its pull request's head now (whether it is outdated). */
  #withHead(
    result: { ok: true; comment: ReviewCommentRecord } | { ok: false; code: ReviewCommentFailure },
  ) {
    return result.ok
      ? { ...result, headSha: this.pulls.get(result.comment.number)?.headSha ?? null }
      : result;
  }

  deleteReviewComment(id: number, actor: RefActor) {
    return this.#pullChange("deleteReviewComment", actor, (caller) =>
      this.reviewComments.delete(id, caller),
    );
  }

  /** Resolves a thread, or makes it unresolved again. */
  resolveReviewThread(number: number, threadId: number, resolved: boolean, actor: RefActor) {
    return this.#pullChange("resolveReviewThread", actor, (caller) => {
      const result = this.reviewComments.resolve(number, threadId, resolved, caller);
      return result.ok ? { ...result, headSha: this.pulls.get(number)?.headSha ?? null } : result;
    });
  }

  /** Who wrote the diff comments `ids` (missing ones left out): a suggestion's author is credited. */
  reviewCommentAuthors(ids: readonly number[]) {
    return this.#measured("reviewCommentAuthors", () => {
      if (this.#refusesReads()) return null;
      return ids.flatMap((id) => {
        const comment = this.reviewComments.get(id);
        return comment ? [{ id, authorId: comment.authorId }] : [];
      });
    });
  }

  /**
   * Applies the suggestions of diff comments to a pull request's head
   * branch as one commit, through the file-write path (the branch moves
   * only from the head the comments are on; the writer's token is checked
   * again at the commit point), for a caller with write access; their
   * threads are resolved then.
   */
  applySuggestions(
    input: ApplySuggestionsInput,
    actor: RefActor,
  ): Promise<Browsed<FileWriteResult & { readonly paths: readonly string[] }>> {
    return this.#measured("applySuggestions", async () => {
      await this.checkEpoch();
      const ceilings = await this.#rolesPulled(actor.principal, actor.grantId ?? null);
      const refusedWrite = this.#writeRefusal();
      if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
      const role = this.#roleNow(actor.principal, ceilings);
      if (!atLeast(role, "write"))
        return fail(403, "forbidden", "Applying suggestions takes write access.");
      const pull = this.pulls.get(input.number);
      if (!pull)
        return fail(404, "pull_not_found", `The repository has no pull request ${input.number}.`);
      if (pull.state !== "open")
        return fail(422, "wrong_state", `Pull request ${input.number} is not open.`);
      const ids = [...new Set(input.commentIds)];
      const comments = ids.map((id) => this.reviewComments.get(id));
      this.#blocks ??= createClockBlockCache();
      const browse = new RepoBrowse({ git: this.git, memoryBlocks: this.#blocks });
      let changes: Awaited<ReturnType<typeof suggestedChanges>>;
      try {
        changes = await suggestedChanges(browse, pull, comments, ids);
      } finally {
        browse.close();
      }
      if (!changes.ok) return changes;
      const caller = {
        actor,
        root: rootIdentity({
          principalId: actor.principal,
          grantId: actor.grantId ?? null,
          ceilingIds: ceilings,
        }),
        role,
      };
      const applied = comments as ReviewCommentRecord[];
      // Still open, its comments reading as they were.
      const unchanged = () =>
        this.pulls.get(input.number)?.state === "open" &&
        applied.every((c) => this.reviewComments.get(c.id)?.version === c.version);
      const resolveThreads = () => {
        for (const threadId of new Set(applied.map((c) => c.threadId)))
          this.reviewComments.resolve(input.number, threadId, true, caller);
      };
      await this.suggestionHooks.beforeWrite?.();
      const written = await writeFiles(
        await this.#writeDeps(),
        {
          principal: actor.principal,
          tokenId: actor.tokenId ?? "",
          grantId: actor.grantId ?? null,
          repoId: this.#repoId(),
          requestId: actor.requestId ?? null,
          committer: input.committer,
          author: input.author,
          branch: pull.headRef,
          expectedHead: pull.headSha,
          message: input.message,
          changes: changes.value,
        },
        {
          meta: {
            // Committed only while the pull request is open and the comments read as they were.
            fence: () => (unchanged() ? undefined : SUGGESTIONS_CHANGED),
            // With the commit: their threads are resolved, as GitHub's are.
            inCommit: resolveThreads,
          },
          // A head branch in another repository: committed there, this side checked right before.
          ...(pull.headRepoId && {
            elsewhere: {
              ref: `refs/heads/${pull.headRef}`,
              head: oidFromHex(pull.headSha),
              send: (commit: Oid, pack: Uint8Array) =>
                this.#sendHeadWrite(
                  pull,
                  actor,
                  { old: oidFromHex(pull.headSha), commit, pack },
                  () => (unchanged() ? undefined : SUGGESTIONS_CHANGED),
                ),
            },
          }),
          onRefused: (report) =>
            !report.ok && report.error.includes(SUGGESTIONS_CHANGED)
              ? fail(
                  409,
                  "pull_changed",
                  "The pull request or its comments changed while the suggestions were applied; try again.",
                )
              : writeRefused(report),
        },
      );
      if (!written.ok) return written;
      // Committed there: the threads resolved here after, while the comments are unchanged.
      if (pull.headRepoId)
        this.ctx.storage.transactionSync(() => {
          if (unchanged()) resolveThreads();
        });
      this.#armOutbox();
      this.#ensureAuditArchive();
      return { ok: true, value: { ...written.value, paths: changes.value.map((c) => c.path) } };
    });
  }

  /**
   * The conflicts of merging an open pull request's base branch into its
   * head: each conflicted file, those of lines in text files with their
   * contents and markers, and the snapshot a resolution names.
   */
  pullConflicts(number: number): Promise<Browsed<ConflictsView>> {
    return this.#measured("pullConflicts", async () => {
      if (this.#refusesReads()) return fail(404, "repo_not_found", REPO_DELETED);
      const at = this.#headMergeable(number);
      if (!at.ok) return at;
      this.#blocks ??= createClockBlockCache();
      return readConflicts(
        { git: this.git, memoryBlocks: this.#blocks },
        {
          baseTip: at.value.baseTip,
          head: at.value.head,
          baseLabel: at.value.pull.baseRef,
          headLabel: at.value.pull.headRef,
        },
        this.mergePolicy,
      );
    });
  }

  /**
   * Resolves an open pull request's conflicts with its base branch: the
   * base tip merged into the head on the head branch, with the given
   * contents for each file whose lines conflict, made at the snapshot the
   * conflicts were read at (409 when either side moved since).
   */
  resolvePullConflicts(
    input: ResolveConflictsInput,
    actor: RefActor,
  ): Promise<Browsed<MergedIntoHead>> {
    return this.#measured("resolvePullConflicts", async () => {
      const at = await this.#headWritable(input.number, actor);
      if (!at.ok) return at;
      const snapshot = parseSnapshot(input.snapshot);
      if (!snapshot)
        return fail(422, "invalid_input", "The conflict snapshot is not one read here.");
      if (snapshot.headSha !== oidToHex(at.value.head))
        return fail(409, "head_moved", "The head branch moved since the conflicts were read.");
      if (snapshot.baseSha !== oidToHex(at.value.baseTip))
        return fail(409, "base_moved", "The base branch moved since the conflicts were read.");
      const resolutions = new Map<string, Uint8Array>();
      const encoder = new TextEncoder();
      let bytes = 0;
      for (const file of input.files) {
        if (resolutions.has(file.path))
          return fail(422, "invalid_input", `The file ${file.path} is given more than once.`);
        const content = encoder.encode(file.content);
        bytes += content.length;
        if (
          content.length > this.mergePolicy.maxFileBytes ||
          bytes > CONFLICTS_POLICY.maxContentBytes
        )
          return fail(
            422,
            "too_large",
            `Resolved files are ${this.mergePolicy.maxFileBytes} bytes each at most, ${CONFLICTS_POLICY.maxContentBytes} in all.`,
          );
        resolutions.set(file.path, content);
      }
      return this.#mergeIntoHead(input, actor, at.value, resolutions);
    });
  }

  /**
   * Brings an open pull request's head branch up to date: the base tip
   * merged into it (refused when that conflicts, or when the head already
   * contains the base tip).
   */
  updatePullBranch(input: UpdateBranchInput, actor: RefActor): Promise<Browsed<MergedIntoHead>> {
    return this.#measured("updatePullBranch", async () => {
      const at = await this.#headWritable(input.number, actor);
      if (!at.ok) return at;
      if (input.expectedHead !== undefined && input.expectedHead !== oidToHex(at.value.head))
        return fail(409, "head_moved", "The head branch was modified; review it and try again.");
      try {
        const walk = { maxCommits: this.mergePolicy.maxCommits };
        if (
          await isAncestor(this.git.commitGraph, "verified", at.value.baseTip, at.value.head, walk)
        )
          return fail(
            422,
            "up_to_date",
            "The head branch already contains the base branch's latest commit.",
          );
      } catch (error) {
        if (!(error instanceof WalkLimitError)) throw error;
        return fail(422, "too_expensive", "The base branch and the head are too far apart.");
      }
      return this.#mergeIntoHead(input, actor, at.value, undefined);
    });
  }

  /** The head and base tip of an open pull request, to merge the base tip into the head. */
  #headMergeable(
    number: number,
  ): Browsed<{ readonly pull: PullRecord; readonly head: Oid; readonly baseTip: Oid }> {
    const pull = this.pulls.get(number);
    if (!pull) return fail(404, "pull_not_found", `The repository has no pull request ${number}.`);
    if (pull.state !== "open")
      return fail(422, "wrong_state", `Pull request ${number} is not open.`);
    // A head branch in another repository: its tip as this repository last had it (that one
    // moves it only from there).
    const head = pull.headRepoId ? oidFromHex(pull.headSha) : this.pulls.branchTip(pull.headRef);
    if (!head || pull.headRefDeleted)
      return fail(422, "head_not_found", "The head branch does not exist.");
    if (oidToHex(head) !== pull.headSha)
      return fail(409, "head_moved", "The head branch is being updated; try again.");
    const baseTip = this.pulls.branchTip(pull.baseRef);
    if (!baseTip) return fail(422, "base_not_found", "The base branch does not exist.");
    return { ok: true, value: { pull, head, baseTip } };
  }

  /** `#headMergeable` for a caller who may write to the head branch (its rulesets judged now). */
  async #headWritable(
    number: number,
    actor: RefActor,
  ): Promise<Browsed<{ readonly pull: PullRecord; readonly head: Oid; readonly baseTip: Oid }>> {
    await this.checkEpoch();
    const ceilings = await this.#rolesPulled(actor.principal, actor.grantId ?? null);
    const refusedWrite = this.#writeRefusal();
    if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
    if (!atLeast(this.#roleNow(actor.principal, ceilings), "write"))
      return fail(403, "forbidden", "Changing the head branch takes write access.");
    const at = this.#headMergeable(number);
    if (!at.ok) return at;
    // A head branch in another repository: its rulesets are judged there, at the commit.
    if (at.value.pull.headRepoId) return at;
    const precheck = await this.#precheckUpdates(
      actor.principal,
      [{ ref: `refs/heads/${at.value.pull.headRef}`, old: oidToHex(at.value.head), new: ZERO_ID }],
      actor.grantId ?? null,
    );
    if (precheck) return fail(422, "write_refused", precheck);
    return at;
  }

  /**
   * Hands a write of an open pull request's head branch, built here, to
   * the repository the branch is in (see `pullHeadWrite`): this side is
   * checked right before (`fence`, and the writer's token against this
   * repository); that one checks its own in the commit. A close, a
   * retarget or a change of the author's consent landing during the
   * handoff does not stop a write already handed over; later ones are.
   */
  async #sendHeadWrite(
    pull: PullRecord,
    actor: RefActor,
    write: {
      readonly old: Oid;
      readonly commit: Oid;
      readonly pack: Uint8Array;
      readonly materialize?: Oid;
    },
    fence: () => string | undefined,
  ): Promise<Browsed<{ sha: string }>> {
    const writer = {
      principal: actor.principal,
      tokenId: actor.tokenId ?? "",
      grantId: actor.grantId ?? null,
      requestId: actor.requestId ?? null,
    };
    const decision = await reauthorizeByToken(
      this.env.DIRECTORY,
      { ...writer, repoId: this.#repoId() },
      (principalId) => this.acl.roleOf(principalId, "write"),
    );
    if (decision.refusal) return fail(403, "forbidden", decision.refusal);
    // Not frozen (for a transfer) or deleted meanwhile.
    const refusedWrite = this.#writeRefusal();
    if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
    // Still the pull request the write was built for: open, between the same branches.
    const now = this.pulls.get(pull.number);
    if (
      now?.state !== "open" ||
      now.generation !== pull.generation ||
      now.baseRef !== pull.baseRef ||
      now.headRef !== pull.headRef ||
      now.headRepoId !== pull.headRepoId
    )
      return fail(
        409,
        "pull_changed",
        "The pull request was closed, reopened or retargeted meanwhile; try again.",
      );
    const fenced = fence();
    if (fenced) return fail(409, "pull_changed", fenced);
    return this.env.REPO.getByName(pull.headRepoId as string).pullHeadWrite({
      baseRepoId: this.#repoId(),
      number: pull.number,
      generation: pull.generation,
      headRef: pull.headRef,
      old: oidToHex(write.old),
      commit: oidToHex(write.commit),
      pack: write.pack,
      ...(write.materialize && { materialize: oidToHex(write.materialize) }),
      writer,
      maintainerAllowed: now.maintainerCanModify,
      baseDecision: decision,
    });
  }

  /** The base tip merged into the head on the head branch (see `mergeIntoHead`). */
  async #mergeIntoHead(
    input: BaseMergeInput,
    actor: RefActor,
    at: { readonly pull: PullRecord; readonly head: Oid; readonly baseTip: Oid },
    /** The resolved contents of the files whose lines conflict; none to update the branch. */
    resolutions: ReadonlyMap<string, Uint8Array> | undefined,
  ): Promise<Browsed<MergedIntoHead>> {
    const { pull } = at;
    const given = input.message ?? `Merge branch '${pull.baseRef}' into ${pull.headRef}`;
    const text = given.endsWith("\n") ? given : `${given}\n`;
    if (text.includes("\0"))
      return fail(422, "invalid_input", "A commit message must not contain NUL.");
    // The pull request still open between the same branches, the base branch still at the tip
    // merged (the head moves with compare-and-set).
    const fence = () => {
      const now = this.pulls.get(input.number);
      if (
        now?.state !== "open" ||
        now.generation !== pull.generation ||
        now.baseRef !== pull.baseRef ||
        now.headRef !== pull.headRef ||
        now.headRepoId !== pull.headRepoId
      )
        return PULL_CHANGED_WHILE_MERGING;
      return this.pulls.branchTip(pull.baseRef)?.every((b, i) => b === at.baseTip[i]) === true
        ? undefined
        : BASE_MOVED_WHILE_MERGING;
    };
    const made = await mergeIntoHead(
      await this.#writeDeps(),
      {
        writer: {
          principal: actor.principal,
          tokenId: actor.tokenId ?? "",
          grantId: actor.grantId ?? null,
          repoId: this.#repoId(),
          requestId: actor.requestId ?? null,
        },
        headRef: `refs/heads/${pull.headRef}`,
        baseTip: at.baseTip,
        head: at.head,
        resolutions: resolutions ?? new Map(),
        resolving: resolutions !== undefined,
        author: input.identity.author,
        committer: input.identity.committer,
        message: appendTrailers(text, coAuthorTrailers(text, input.identity.coAuthors)),
        meta: { fence },
        ...(this.headMergeHooks.beforeFinish && {
          beforeFinish: this.headMergeHooks.beforeFinish,
        }),
        // The base tip is a parent: brought into the head's repository with its history.
        ...(pull.headRepoId && {
          send: (commit: Oid, pack: Uint8Array) =>
            this.#sendHeadWrite(
              pull,
              actor,
              { old: at.head, commit, pack, materialize: at.baseTip },
              fence,
            ),
        }),
      },
      this.mergePolicy,
    );
    this.#armOutbox();
    this.#ensureAuditArchive();
    if (!made.ok && made.error.includes(BASE_MOVED_WHILE_MERGING))
      return fail(409, "base_moved", "The base branch moved while the merge was made; try again.");
    if (!made.ok && made.error.includes(PULL_CHANGED_WHILE_MERGING))
      return fail(
        409,
        "pull_changed",
        "The pull request was closed or retargeted while the merge was made.",
      );
    return made;
  }

  /** Withdraws review requests. */
  removeRequestedReviewers(number: number, reviewerIds: readonly string[], actor: RefActor) {
    return this.#pullChange("removeRequestedReviewers", actor, (caller) =>
      this.#withView(this.reviews.unrequest(number, reviewerIds, caller)),
    );
  }

  /**
   * Runs a change of pull requests or reviews for `actor`, as one measured
   * invocation (a deletion waits for it): its ceilings and root identity
   * and anything `prepare` reads are worked out first, then, with no await
   * before `change`, whether the repository takes changes and the caller's
   * role now.
   */
  #pullChange<R, P = undefined>(
    method: string,
    actor: RefActor,
    change: (caller: PullCaller, prepared: P) => R,
    prepare?: () => Promise<P>,
    /** Texts the change writes, whose mentions its activity-feed entries name. */
    texts: readonly (string | null | undefined)[] = [],
  ): Promise<R | { ok: false; code: PullChangeRefusal }> {
    return this.#measured(method, async () => {
      await this.checkEpoch();
      const ceilings = await this.#rolesPulled(actor.principal, actor.grantId ?? null);
      const root = rootIdentity({
        principalId: actor.principal,
        grantId: actor.grantId ?? null,
        ceilingIds: ceilings,
      });
      const prepared = (prepare ? await prepare() : undefined) as P;
      const mentioned = await this.feed.prepare(texts);
      const refused = this.#writeRefusal();
      if (refused)
        return { ok: false as const, code: refused.code as "repo_not_found" | "repo_transferring" };
      const role = this.#roleNow(actor.principal, ceilings);
      if (role === null) return { ok: false as const, code: "access_lost" as const };
      const result = this.feed.within({ root, role, mentioned }, () =>
        change({ actor, root, role }, prepared),
      );
      this.#armOutbox();
      this.#ensureAuditArchive();
      return result;
    });
  }

  /**
   * A transfer's first step: no change is taken from here on (pushes,
   * writes, settings, rulesets) until it lands or is called off. Refused
   * unless the repository still belongs to `from`.
   */
  freezeForTransfer(transfer: {
    readonly transferId: string;
    readonly from: string;
    readonly to: string;
  }): Promise<
    | { ok: true }
    | {
        ok: false;
        code:
          | "repo_deleted"
          | "other_transfer"
          | "not_owner"
          | "no_identity"
          | "ended"
          | "generating";
      }
  > {
    return this.#measured("freezeForTransfer", async () => {
      await this.checkEpoch();
      // Not while its generation from a template may still finish or fail (and delete it).
      if (this.#generatingFrom() !== undefined && !this.events.isTransferring())
        return { ok: false as const, code: "generating" as const };
      const frozen = this.events.freezeForTransfer(transfer);
      if (frozen === "frozen" || frozen === "landed") return { ok: true as const };
      return {
        ok: false as const,
        code: frozen === "deleted" ? ("repo_deleted" as const) : frozen,
      };
    });
  }

  /** Transfer `transferId` called off: the repository takes changes again. */
  unfreezeTransfer(transferId: string): void {
    this.events.unfreezeTransfer(transferId);
  }

  /** The owner generation transfer `transferId` lands the repository in (for the read model's fence). */
  transferGeneration(transferId: string): number {
    return this.events.transferGeneration(transferId);
  }

  /**
   * A transfer's last step here: the repository belongs to `to` under its
   * new name, in a new owner generation; its ACL snapshot is pulled from
   * the new account. Returns the owner generation.
   */
  completeTransfer(
    to: {
      readonly transferId: string;
      readonly ownerId: string;
      readonly name: string;
      readonly nameGen: number;
    },
    actor: JobActor | string | null,
  ): Promise<number> {
    return this.#measured("completeTransfer", async () => {
      await this.checkEpoch();
      const { ownerGen, changed } = this.events.completeTransfer(to, actor);
      // Only when it moved: the old account's snapshot and floor mean nothing now.
      if (changed) {
        this.acl.reset();
        this.#armOutbox();
        this.#ensureAuditArchive();
      }
      return ownerGen;
    });
  }

  /** The receive-pack ref advertisement (protocol v0, or v1 with its version line). */
  receivePackAdvertisement(version: 0 | 1): Uint8Array {
    return receivePackAdvertisement(this.git, version);
  }

  /**
   * Plans a protocol v2 `fetch`: the response as literal pkt-lines and
   * stored objects, which stay read-leased until `releaseFetchLease`.
   * Refusals and failures are returned as values (an `ERR` message).
   */
  async planFetch(request: FetchPlanRequest): Promise<FetchPlanReply> {
    this.#blocks ??= createClockBlockCache();
    const memoryBlocks = this.#blocks;
    return this.#measured("planFetch", () =>
      answerFetchPlan({ git: this.git, memoryBlocks }, request),
    );
  }

  /**
   * The object check: whether a commit, a path of a commit, or a diff may
   * be shown through this repository, from its own verified commits.
   * Callers get an `ObjectGrant` from it with `ObjectGrant.authorize`
   * after the access check, and only then consult a response cache.
   */
  async objectAccess(request: ObjectAccessRequest): Promise<ObjectAccessAnswer> {
    this.#blocks ??= createClockBlockCache();
    const memoryBlocks = this.#blocks;
    return this.#measured("objectAccess", () =>
      checkObjectAccess({ git: this.git, memoryBlocks }, request),
    );
  }

  /** One browse request, its reader released when it ends. */
  #browse<R>(method: string, use: (browse: RepoBrowse) => R | Promise<R>): Promise<R> {
    this.#blocks ??= createClockBlockCache();
    const browse = new RepoBrowse({ git: this.git, memoryBlocks: this.#blocks });
    return this.#measured(method, async () => {
      try {
        return await use(browse);
      } finally {
        browse.close();
      }
    });
  }

  /** The repository's branches after `after`, by name. */
  browseBranches(after: string, limit: number): Promise<RefView[]> {
    return this.#browse("browseBranches", (b) => b.branches(after, limit));
  }

  browseBranch(name: string): Promise<Browsed<RefView>> {
    return this.#browse("browseBranch", (b) => b.branch(name));
  }

  /** The repository's tags after `after`, by name, peeled to commits. */
  browseTags(after: string, limit: number): Promise<Browsed<TagPage>> {
    return this.#browse("browseTags", (b) => b.tags(after, limit));
  }

  browseCommit(ref: string | undefined): Promise<Browsed<CommitView>> {
    return this.#browse("browseCommit", (b) => b.commit(ref));
  }

  browseLog(input: LogInput): Promise<Browsed<LogView>> {
    return this.#browse("browseLog", (b) => b.log(input));
  }

  browseCompare(base: string, head: string): Promise<Browsed<CompareView>> {
    return this.#browse("browseCompare", (b) => b.compare(base, head));
  }

  /** What a write this object makes itself needs (file writes, generation from a template). */
  async #writeDeps(): Promise<FileWriteDeps> {
    this.#blocks ??= createClockBlockCache();
    // The commits it makes are signed with the platform's key, when one is set.
    const signer = await platformSigner(this.env);
    return {
      git: this.git,
      push: this.#push(),
      db: this.env.DIRECTORY,
      memoryBlocks: this.#blocks,
      metrics: this.git.context.metrics,
      writerRole: (principalId) => this.acl.roleOf(principalId, "write"),
      ...(signer && { signer }),
      precheck: (principal, updates, grantId) => this.#precheckUpdates(principal, updates, grantId),
    };
  }

  /**
   * Writes files as one commit on a branch, through the push path (see
   * `writeFiles`): the Worker has checked `contents:write`; the token is
   * checked again at the commit point.
   */
  writeFiles(input: FileWriteInput): Promise<Browsed<FileWriteResult>> {
    const refused = this.#writeRefusal();
    if (refused) return Promise.resolve(fail(refused.status, refused.code, refused.error));
    return this.#measured("writeFiles", async () => writeFiles(await this.#writeDeps(), input));
  }

  /** The trees and files of the default branch, for a repository generated from this one. */
  templateTree(): Promise<Browsed<TemplateTree>> {
    if (this.#refusesReads()) return Promise.resolve(fail(404, "repo_not_found", REPO_DELETED));
    return this.#browse("templateTree", (b) => templateTree(b));
  }

  /**
   * Makes this new repository's first commit from the template it is
   * generated from (see `writeTemplate`): the Worker has checked that the
   * caller may read the template and write here; the token is checked
   * again at the commit point. Until it succeeds, the repository takes no
   * other write.
   */
  async generateFrom(
    input: TemplateWriteInput,
  ): Promise<Browsed<{ branch: string; commit: string }>> {
    if (this.#closed || !this.#hasGitStorage() || this.events.isDeleted())
      return fail(404, "repo_not_found", REPO_DELETED);
    const templateId = this.#generatingFrom();
    if (templateId === undefined)
      return fail(409, "not_generating", "The repository is not being generated from a template.");
    if (this.#generationAbandoned() !== undefined)
      return fail(409, "generation_abandoned", GENERATION_ABANDONED);
    const template = await this.env.REPO.getByName(templateId).templateTree();
    if (!template.ok) return template;
    await this.generationHooks.beforeWrite?.();
    return this.#measured("generateFrom", async () => {
      const made = await writeTemplate(await this.#writeDeps(), input, template.value);
      if (made.ok) this.ctx.storage.sql.exec("DELETE FROM generation");
      return made;
    });
  }

  /**
   * Settles a generation its request could not confirm: `committed` when
   * the repository has refs (its first commit was made: nothing else
   * writes while it is pending), whether or not its marker was cleared;
   * `abandoned` while it is pending without them, after which its commit
   * is refused at the commit point, so the repository can be deleted
   * without losing a late one; `none` otherwise (no repository here, as
   * after an erase, or no generation). One synchronous transaction, so it
   * cannot interleave with that commit.
   */
  abandonGeneration(): Promise<"committed" | "abandoned" | "none"> {
    return this.#measured("abandonGeneration", async () =>
      this.ctx.storage.transactionSync(() => {
        const committed = this.#hasGitStorage() && this.git.refStore.readRefsSync().refs.size > 0;
        if (this.#generatingFrom() === undefined)
          return committed ? ("committed" as const) : ("none" as const);
        if (committed) {
          this.ctx.storage.sql.exec("DELETE FROM generation");
          return "committed" as const;
        }
        this.ctx.storage.sql.exec(
          "UPDATE generation SET abandoned_at = ? WHERE abandoned_at IS NULL",
          this.git.context.now(),
        );
        return "abandoned" as const;
      }),
    );
  }

  /** Why a commit is refused: the generation it would finish was abandoned. */
  #generationAbandoned(): string | undefined {
    return this.ctx.storage.sql
      .exec<{ abandoned_at: number | null }>("SELECT abandoned_at FROM generation")
      .toArray()[0]?.abandoned_at != null
      ? GENERATION_ABANDONED
      : undefined;
  }

  /** The template this repository is still being generated from, if it is. */
  #generatingFrom(): string | undefined {
    return this.ctx.storage.sql
      .exec<{ template_id: string }>("SELECT template_id FROM generation")
      .toArray()[0]?.template_id;
  }

  #archiver: RepoArchives | undefined;

  #archives(): RepoArchives {
    this.#blocks ??= createClockBlockCache();
    this.#archiver ??= new RepoArchives({ git: this.git, memoryBlocks: this.#blocks });
    return this.#archiver;
  }

  /**
   * The archive of the commit `ref` names (the default branch without one)
   * in `format`, everything under `prefix` (`prefix-<short id>`): ready, or
   * being built (it is started, and built here for a few seconds).
   */
  archive(input: {
    readonly ref?: string;
    readonly format: ArchiveFormat;
    readonly prefix: string;
  }): Promise<Browsed<ArchiveStatus>> {
    if (this.#refusesReads()) return Promise.resolve(fail(404, "repo_not_found", REPO_DELETED));
    return this.#browse("archive", async (b) => {
      const at = await b.resolveTree(input.ref);
      if (!at.ok) return at;
      const commit = oidToHex(at.value.commit);
      const [row] = this.git.commitGraph.readSync([at.value.commit], "verified");
      return this.#archives().request({
        commit,
        mtime: row?.commitTime ?? 0,
        format: input.format,
        prefix: `${input.prefix}-${commit.slice(0, 7)}`,
        budgetMs: ARCHIVE_REQUEST_BUDGET_MS,
      });
    });
  }

  /** What a path names at a commit: a directory page, a file, a symlink or a submodule. */
  browseContents(input: {
    readonly ref?: string;
    readonly path: string;
    readonly after?: DirCursor;
    readonly limit: number;
  }): Promise<Browsed<{ commit: string; view: ContentsView }>> {
    return this.#browse("browseContents", (b) => contents(b, input));
  }

  browseReadme(ref: string | undefined): Promise<Browsed<{ commit: string; view: ContentsView }>> {
    return this.#browse("browseReadme", (b) => readme(b, ref));
  }

  browseTree(ref: string | undefined, recursive: boolean): Promise<Browsed<TreeListing>> {
    return this.#browse("browseTree", (b) => treeListing(b, ref, recursive));
  }

  browseRaw(
    ref: string | undefined,
    path: string,
  ): Promise<Browsed<{ sha: string; bytes: Uint8Array }>> {
    return this.#browse("browseRaw", (b) => rawFile(b, ref, path));
  }

  /** Extends a fetch's read lease while its response streams; null once it has expired. */
  renewFetchLease(leaseId: string): number | null {
    return this.git.leases.renew(leaseId, FETCH_LEASE_TTL_MS) ?? null;
  }

  /** Releases a fetch's read lease when its response is complete or abandoned. */
  releaseFetchLease(leaseId: string): void {
    this.git.leases.release(leaseId);
  }

  /** The push path's operations (receive-pack), created on first use. */
  #pushes: RepoPush | undefined;

  /**
   * The pack-count cap and its merge budget: the defaults, overridden by
   * Worker variables. Read at each push commit; tests may replace it.
   */
  packCap: PackCapPolicy = packCapPolicy(this.env);

  /** Repack and garbage-collection budgets and timings. Tests may replace them. */
  maintenance: MaintenancePolicy = MAINTENANCE_DEFAULTS;
  /**
   * Options of the pack retire job (retention, deletion fence, and the fork
   * network, which packs it shares are released to). Tests may replace them.
   */
  retireOptions: PackRetireOptions = {
    network: networkRetire(this.env, () => this.#repoId()),
  };
  /** Hooks into garbage-collection slices. For tests. */
  gcHooks: GcHooks = {};

  #log() {
    return createLogger({
      do: "RepoDO",
      ...(this.ctx.id.name === undefined ? {} : { repoId: this.ctx.id.name }),
    });
  }

  #push(): RepoPush {
    this.#pushes ??= new RepoPush(
      this.git,
      this.git.context.metrics,
      this.#log(),
      () => this.packCap,
      () => {
        this.#blocks ??= createClockBlockCache();
        return this.#blocks;
      },
    );
    this.#pushes.accessCheck = async (principal) => {
      // Pulls a snapshot past its write window first (fail closed).
      await this.acl.roleOf(principal, "write");
      return this.acl.allows(principal, "write") ? undefined : ACCESS_LOST;
    };
    this.#pushes.frozen = () => this.events.frozen() ?? this.#generationAbandoned();
    this.#pushes.rules = {
      check: async (input) => {
        // The pusher's effective role pulled fresh; then everything the
        // check reads, and its stamp, taken together with no await between them.
        const ceilings = await this.#rolesPulled(input.principal, input.grantId);
        const { snapshot, stamp } = this.#ruleSnapshot(input.principal, ceilings);
        const signatures = this.#signatureReader(input.packs);
        let checked: Awaited<ReturnType<typeof checkPushRules>>;
        try {
          checked = await checkPushRules(
            {
              git: this.git,
              signatures: (oids) => signatures.facts(oids),
              verdicts: (facts) =>
                verdicts({ env: this.env, metrics: this.git.context.metrics }, facts),
            },
            snapshot,
            { ...input, delegated: input.grantId !== null },
          );
        } finally {
          signatures.release();
        }
        this.rulesetStore.recordEvaluated(input.uploadId, input.principal, checked.evaluated);
        const { refusals } = checked;
        return {
          stamp,
          restamp: () => this.#ruleSnapshot(input.principal, ceilings).stamp,
          writable:
            snapshot.role !== null &&
            REPO_ROLES.indexOf(snapshot.role) >= REPO_ROLES.indexOf("write"),
          refusals,
        };
      },
    };
    const account = () => {
      // A repository from before identities were recorded has no account to charge.
      const owner = this.events.account();
      return owner && this.env.ORG.getByName(owner.accountId);
    };
    this.#pushes.storage = {
      charge: async (uploadId, bytes) => {
        const stub = account();
        if (!stub) return undefined;
        try {
          const fits = await stub.chargeStorage({
            uploadId,
            repoId: this.#repoId(),
            bytes,
            ttlMs: STORAGE_CHARGE_TTL_MS,
          });
          return fits ? undefined : STORAGE_QUOTA_EXCEEDED;
        } catch (error) {
          // Fail closed: an account that cannot be asked takes no bytes.
          this.#log().warn("storage charge failed", { uploadId, error });
          return STORAGE_QUOTA_UNAVAILABLE;
        }
      },
      owe: (uploadId, bytes) => {
        if (!account()) return;
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO storage_owed (upload_id, bytes, owed_at) VALUES (?, ?, ?)",
          uploadId,
          bytes,
          this.git.context.now(),
        );
        // Told right after the commit; this job tells the account should that fail.
        this.git.jobs.ensure("storage_confirm", STORAGE_CONFIRM_JOB, {
          runAt: this.git.context.now() + STORAGE_CONFIRM_RETRY_MS,
        });
      },
      confirm: async (uploadId, bytes) => {
        await this.#confirmStorage(uploadId, bytes);
      },
      release: async (uploadId) => {
        // Not released, what the upload held lapses on its own.
        await account()
          ?.releaseStorage(uploadId)
          .catch((error: unknown) =>
            this.#log().warn("storage release failed", { uploadId, error }),
          );
      },
    };
    return this.#pushes;
  }

  /**
   * Reads the signature facts of commits from the live packs and a push's
   * own `packs`: one reader for a whole check, opened on its first use,
   * within one request's read budget (once it is spent, a commit not read
   * yet is left out, so refused). The caller releases it.
   */
  #signatureReader(packs: readonly PackId[]): {
    facts: (oids: readonly Oid[]) => Promise<Map<string, SignedFact>>;
    release: () => void;
  } {
    let opened: Promise<Awaited<ReturnType<typeof openLiveReader>>> | undefined;
    let spent = false;
    const open = () => {
      this.#blocks ??= createClockBlockCache();
      opened ??= openLiveReader(
        { git: this.git, memoryBlocks: this.#blocks },
        {
          deltaBaseCacheBytes: 4 * 1024 * 1024,
          maxCacheCalls: BROWSE_POLICY.cacheCalls,
          maxReads: BROWSE_POLICY.maxReads,
          extraPacks: packs,
        },
      );
      return opened;
    };
    return {
      facts: async (oids) => {
        const facts = new Map<string, SignedFact>();
        if (spent) return facts;
        try {
          const reader = await open();
          if (!reader) return facts;
          await reader.prefetch(oids);
          for (const oid of oids) {
            const object = await reader.readObject(oid);
            if (object?.type === "commit") facts.set(oidToHex(oid), await factOf(object.bytes));
          }
        } catch (error) {
          // Out of reads: what was read counts; the rest is unreadable, so refused.
          if (!(error instanceof ReadBudgetError)) throw error;
          spent = true;
        }
        return facts;
      },
      release: () => {
        void opened?.then((reader) => reader?.release()).catch(() => {});
      },
    };
  }

  /** Opens a push: the upload and its pack rows, before any byte is stored. Returns the body's R2 key. */
  beginPush(input: BeginPushInput): BeginPushResult {
    const refused = this.#writeRefusal();
    if (refused) return { ok: false, error: refused.error };
    const begun = this.#push().begin(input);
    return begun.ok && hasPrecheckRules(this.rulesetStore) ? { ...begun, precheck: true } : begun;
  }

  /**
   * The rulesets' check of a push's commands before its body is stored
   * (`head` is the start of the body): the git response refusing it when no
   * command may go on; otherwise the push goes on, and its refused commands
   * are refused again at its commit. A head that does not hold the whole
   * command section is not checked here.
   */
  async precheckPush(
    uploadId: string,
    head: Uint8Array,
  ): Promise<{ ok: true } | { ok: false; response: Uint8Array }> {
    const upload = this.git.uploads.get(uploadId);
    if (!upload) return { ok: true };
    let plan: ReturnType<typeof planPush>;
    try {
      const { request } = await readPushBody(bytesBody(head), { pushOptionsAdvertised: true });
      plan = planPush(request, this.git.refStore.readRefsSync());
    } catch {
      return { ok: true };
    }
    const live = liveCommands(plan);
    const ceilings = await this.#rolesPulled(upload.principal, upload.grantId);
    const refusals = precheckPushRules(
      this.#ruleSnapshot(upload.principal, ceilings).snapshot,
      upload.principal,
      live.map((cmd) => ({ index: cmd.index, name: cmd.name as string, kind: cmd.kind })),
      upload.grantId !== null,
    );
    const messages: string[] = [];
    for (const cmd of live) {
      const refusal = refusals.get(cmd.index);
      if (refusal === undefined) continue;
      cmd.error = refusal;
      messages.push(`error: ${refusal}`);
    }
    failAtomically(plan);
    if (liveCommands(plan).length > 0) return { ok: true };
    return {
      ok: false,
      response: encodePushResponse(
        { unpackError: undefined, commands: plan.commands },
        plan.capabilities,
        messages,
      ),
    };
  }

  /** The strongest role the current ACL snapshot allows (an owner's: admin). */
  #ruleRoleNow(principal: string): RepoRole | null {
    for (const role of [...REPO_ROLES].reverse()) if (this.acl.allows(principal, role)) return role;
    return null;
  }

  /** The principal's effective role now: the weakest of its own and its `ceilings`'. */
  #roleNow(principal: string, ceilings: readonly string[]): RepoRole | null {
    let role = this.#ruleRoleNow(principal);
    for (const id of ceilings) {
      const cap = this.#ruleRoleNow(id);
      if (cap === null || (role !== null && REPO_ROLES.indexOf(cap) < REPO_ROLES.indexOf(role)))
        role = cap;
    }
    return role;
  }

  /**
   * Owners whose roles cap a write's: the agents' owners of its delegation
   * grant's chain, or an agent's own owner; none for a user's own token.
   * From the directory's primary (a grant or an owner may change at any time).
   */
  async #ceilingsOf(principal: string, grantId: string | null): Promise<string[]> {
    const db = this.env.DIRECTORY.withSession("first-primary");
    const metrics = this.git.context.metrics;
    if (grantId !== null) {
      metrics.count("d1.query", { db: "directory", op: "token_grants" });
      return [...new Set((await readGrantLinks(db, grantId)).map((l) => l.owner_id))];
    }
    if (principalTypeOf(principal) !== "agent") return [];
    metrics.count("d1.query", { db: "directory", op: "agent_owner" });
    const row = await db
      .prepare("SELECT owner_id FROM principals WHERE id = ?")
      .bind(principal)
      .first<{ owner_id: string | null }>();
    return row?.owner_id ? [row.owner_id] : [];
  }

  /**
   * The owners capping each of `principals` (an agent's own owner; none for
   * a user), from the directory's primary in batches, with all their roles
   * pulled fresh: a few queries however many principals there are.
   */
  async #ownersPulled(principals: readonly string[]): Promise<Map<string, string[]>> {
    const owners = new Map<string, string[]>(principals.map((id) => [id, []]));
    const agents = principals.filter((id) => principalTypeOf(id) === "agent");
    const db = this.env.DIRECTORY.withSession("first-primary");
    for (let at = 0; at < agents.length; at += OWNER_BATCH) {
      const batch = agents.slice(at, at + OWNER_BATCH);
      this.git.context.metrics.count("d1.query", { db: "directory", op: "agent_owner" });
      const { results } = await db
        .prepare(
          `SELECT id, owner_id FROM principals WHERE id IN (${batch.map(() => "?").join(", ")})`,
        )
        .bind(...batch)
        .all<{ id: string; owner_id: string | null }>();
      for (const row of results) if (row.owner_id) owners.set(row.id, [row.owner_id]);
    }
    for (const id of new Set([...owners.keys(), ...[...owners.values()].flat()]))
      await this.acl.roleOf(id, "write");
    return owners;
  }

  /** A write's ceilings, with the principal's and their roles pulled fresh (one snapshot serves all). */
  async #rolesPulled(principal: string, grantId: string | null): Promise<string[]> {
    const ceilings = await this.#ceilingsOf(principal, grantId);
    for (const id of [principal, ...ceilings]) await this.acl.roleOf(id, "write");
    return ceilings;
  }

  /**
   * What a push's rules read, taken at once: the rulesets (with their
   * version), HEAD and the pusher's effective role (the weakest of its own
   * and its `ceilings`', so an agent's bypass is never its owner's above),
   * and a stamp of them that the commit's transaction compares.
   */
  #ruleSnapshot(
    principal: string,
    ceilings: readonly string[] = [],
  ): { snapshot: RuleSnapshot; stamp: string } {
    const { version, rulesets } = this.rulesetStore.current();
    const head = this.git.refStore.head();
    const role = this.#roleNow(principal, ceilings);
    return {
      snapshot: { rulesets: rulesets.map((r) => r.ruleset), head, role },
      stamp: JSON.stringify([version, head, role]),
    };
  }

  /** The rulesets' refusal of ref updates a write or upload session asks for, before anything is stored. */
  async #precheckUpdates(
    principal: string,
    updates: readonly {
      readonly ref: string;
      readonly old: string | null;
      readonly new: string | null;
    }[],
    /** The delegation grant the write is made under (an agent acts for `principal`); null for none. */
    grantId: string | null,
    /** A default branch the write sets as it commits (an import's). */
    head?: string,
    /** The pull request the write merges, for its `pull_request` rules. */
    merge?: MergeContext,
  ): Promise<string | undefined> {
    if (!hasPrecheckRules(this.rulesetStore)) return undefined;
    const ceilings = await this.#rolesPulled(principal, grantId);
    const delegated = grantId !== null;
    const refusals = precheckPushRules(
      this.#ruleSnapshot(principal, ceilings).snapshot,
      principal,
      updates.map((u, index) => ({
        index,
        name: u.ref,
        kind: u.old === null ? "create" : u.new === null ? "delete" : "update",
      })),
      delegated,
      head,
      merge,
    );
    return refusals.size === 0 ? undefined : [...refusals.values()].join("; ");
  }

  /** The push body is stored: plan it and index for up to `budgetMs`, then the alarm continues. */
  runPush(uploadId: string, bodyBytes: number, budgetMs: number): Promise<PushProgress> {
    return this.#measured("runPush", () => this.#push().run(uploadId, bodyBytes, budgetMs));
  }

  /** Where a push stands; runs due indexing for up to `budgetMs`. */
  pushStatus(uploadId: string, budgetMs: number): Promise<PushProgress> {
    return this.#measured("pushStatus", () => this.#push().status(uploadId, budgetMs));
  }

  /** Commits an indexed push with the Worker's re-authorization; returns the response body. */
  finalizePush(
    uploadId: string,
    decision: PushDecision,
    meta: PushLogMeta = {},
  ): Promise<Uint8Array> {
    return this.#measured("finalizePush", async () => {
      await this.checkEpoch();
      return this.#push().finalize(uploadId, decision, meta);
    });
  }

  /** Ends a push whose body could not be stored. */
  abortPush(uploadId: string): Promise<void> {
    return this.#push().abort(uploadId);
  }

  /** Chunked uploads (`uploads.*` operations), created on first use. */
  #chunkedUploads: ChunkedUploads | undefined;

  #chunked(): ChunkedUploads {
    this.#chunkedUploads ??= new ChunkedUploads(
      this.git,
      this.#push(),
      this.git.context.metrics,
      this.#log(),
    );
    return this.#chunkedUploads;
  }

  /** Starts a chunked upload session: the upload, its command section and its multipart upload. */
  beginChunked(input: BeginChunked): Promise<{ ok: true; view: ChunkedView } | ChunkedFailure> {
    // Measured: a deletion waits for an admission that is setting up R2.
    if (this.#closed)
      return Promise.resolve({
        ok: false,
        status: 404,
        code: "repo_not_found",
        error: REPO_DELETED,
      });
    return this.#measured("beginChunked", async () => {
      const closed = this.#writeRefusal();
      if (closed) return { ok: false, ...closed } as const;
      // A session commits all its updates or none: one refused update refuses it.
      const refused = await this.#precheckUpdates(
        input.principal,
        input.updates,
        input.grantId ?? null,
      );
      if (refused)
        return { ok: false, status: 409, code: "ruleset_violation", error: refused } as const;
      return this.#chunked().begin(input);
    });
  }

  /** Where part `part` of `bytes` bytes goes (key, multipart id, R2 part number), if the session takes it now, and the token reserving it. */
  chunkedPartTarget(
    uploadId: string,
    principal: string,
    part: number,
    bytes: number,
  ):
    | { ok: true; key: string; multipartId: string; partNumber: number; token: string }
    | ChunkedFailure {
    return this.#chunked().partTarget(uploadId, principal, part, bytes);
  }

  /** Records a stored part's etag under its reservation `token`. */
  recordChunkedPart(
    uploadId: string,
    principal: string,
    part: number,
    etag: string,
    token: string,
  ): { ok: true; view: ChunkedView } | ChunkedFailure {
    return this.#chunked().recordPart(uploadId, principal, part, etag, token);
  }

  /** Releases a part's reservation after its upload failed. */
  releaseChunkedPart(uploadId: string, principal: string, part: number, token: string): void {
    this.#chunked().releasePart(uploadId, principal, part, token);
  }

  /** Assembles the parts and indexes for up to `budgetMs`; then as a push (`pushStatus`, `finalizePush`). */
  completeChunked(
    uploadId: string,
    principal: string,
    tokenId: string,
    budgetMs: number,
  ): Promise<{ ok: true; progress: PushProgress } | ChunkedFailure> {
    return this.#measured("completeChunked", () =>
      this.#chunked().complete(uploadId, principal, tokenId, budgetMs),
    );
  }

  chunkedView(
    uploadId: string,
    principal: string,
  ): Promise<{ ok: true; view: ChunkedView } | ChunkedFailure> {
    return this.#chunked().view(uploadId, principal);
  }

  abortChunked(
    uploadId: string,
    principal: string,
  ): Promise<{ ok: true; view: ChunkedView } | ChunkedFailure> {
    return this.#chunked().abort(uploadId, principal);
  }

  /** How imports reach the network: the guarded fetch. Tests may replace it. */
  importNetwork: ImportNetwork = defaultImportNetwork();

  #importer: RepoImports | undefined;

  #imports(): RepoImports {
    this.#importer ??= new RepoImports(
      this.git,
      this.#push(),
      this.env,
      this.ctx.storage,
      this.git.context.metrics,
      this.#log(),
      () => this.importNetwork,
      (principalId) => this.acl.roleOf(principalId, "write"),
      () => this.events.account()?.ownerGen,
      (principal, updates, grantId, head) =>
        this.#precheckUpdates(principal, updates, grantId, head),
    );
    return this.#importer;
  }

  /** Starts a server-side import into this (empty) repository; it runs in the alarm. */
  beginImport(
    input: BeginImport,
  ): Promise<{ ok: true; record: ImportRecord } | { ok: false; code: string; error: string }> {
    if (this.#closed)
      return Promise.resolve({ ok: false, code: "repo_not_found", error: REPO_DELETED });
    return this.#measured("beginImport", () =>
      this.#writeRefusal()
        ? {
            ok: false as const,
            code: this.#writeRefusal()?.code ?? "repo_not_found",
            error: this.#writeRefusal()?.error ?? REPO_DELETED,
          }
        : this.#imports().begin(input),
    );
  }

  /**
   * The row and data of an event too large for its queue message, as the
   * JSON `{ row, data }`, by event key; null once its retention has passed.
   */
  eventPayload(key: string): string | null {
    const stored = this.ctx.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM event_payloads WHERE event_key = ?", key)
      .toArray()[0];
    return stored?.payload ?? null;
  }

  /** The latest import's progress or outcome. */
  importRecord(): Promise<ImportRecord | undefined> {
    return this.#imports().record();
  }

  /** Runs due background jobs; the job queue re-arms the alarm for the next one. */
  override async alarm(): Promise<void> {
    await this.#measured("alarm", async () => {
      // Maintenance changes the packs without a commit.
      this.#recordStorage();
      try {
        // Background jobs may commit (an import).
        await this.checkEpoch().catch((error: unknown) =>
          this.#log().warn("checking the repository's epoch failed", { error }),
        );
        await this.#drainOutbox();
        this.#parkJobs();
        await this.#runJobs();
      } finally {
        this.#ensureAuditArchive();
        this.#armOutbox();
      }
    });
  }

  /**
   * Sends events when they are due (a backoff stands), and deletes stored
   * payloads past their retention; a failure backs off and never fails the
   * alarm or stops the jobs.
   */
  async #drainOutbox(): Promise<void> {
    try {
      const now = this.git.context.now();
      const sendAt = this.outbox.sendDueAt();
      if (sendAt !== null && sendAt <= now) {
        const result = await this.outbox.drain(this.#repoId());
        if (!result.ok) this.#log().warn("sending events failed", { error: result.error });
      } else {
        const due = this.outbox.dueAt();
        if (due !== null && due <= now) this.outbox.prunePayloads();
      }
    } catch (error) {
      this.#log().warn("draining the outbox failed", { error });
    }
  }

  #auditArchiver() {
    return auditArchiveHandler({
      storage: this.ctx.storage,
      bucket: this.auditBucket,
      now: this.git.context.now,
      org: () => this.events.orgId() ?? "unknown",
      source: () => this.#repoId(),
      metrics: this.git.context.metrics,
    });
  }

  /**
   * Once its deletion froze it, stops every job but the audit archive (their
   * cursors stay, for the erase to find what they stored), so neither runs
   * nor the alarm waits for them. A slice still running requeues itself
   * when it ends and is stopped again on the next alarm.
   */
  #parkJobs(): void {
    if (!this.events.isDeleted() || !this.#hasGitStorage()) return;
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET state = 'failed', last_error = 'the repository is being deleted'
       WHERE kind <> 'audit_archive'
         AND (state = 'queued' OR (state = 'running' AND lease_expires_at <= ?))`,
      this.git.context.now(),
    );
  }

  #runJobs(): Promise<unknown> {
    const handlers = this.#jobHandlers();
    // Once its deletion froze it, nothing but the audit archive may run.
    return this.git.jobs.runDue(
      this.events.isDeleted() ? { audit_archive: handlers.audit_archive } : handlers,
      this.git.memory,
      this.git.context.now() + ALARM_BUDGET_MS,
    );
  }

  /**
   * Tells the account a committed upload's bytes are the repository's (it
   * counts each upload once), then owes it nothing; false when it could
   * not be told (still owed: the `storage_confirm` job tries again).
   */
  async #confirmStorage(uploadId: string, bytes: number): Promise<boolean> {
    const owner = this.events.account();
    if (!owner) return true;
    try {
      // Not taken while the repository moves between accounts: owed to the next one.
      const taken = await this.env.ORG.getByName(owner.accountId).confirmStorage({
        uploadId,
        repoId: this.#repoId(),
        bytes,
      });
      if (!taken) return false;
    } catch (error) {
      this.#log().warn("storage confirm failed", { uploadId, error });
      return false;
    }
    this.ctx.storage.sql.exec("DELETE FROM storage_owed WHERE upload_id = ?", uploadId);
    return true;
  }

  /** Committed uploads the account has not been told of yet. */
  owedStorage(): { uploadId: string; bytes: number }[] {
    return this.ctx.storage.sql
      .exec<{ upload_id: string; bytes: number }>(
        "SELECT upload_id, bytes FROM storage_owed ORDER BY upload_id",
      )
      .toArray()
      .map((r) => ({ uploadId: r.upload_id, bytes: r.bytes }));
  }

  /** The `storage_confirm` job: tells the account of every upload still owed. */
  #storageConfirmHandler(): JobHandler {
    return {
      runSlice: async () => {
        const sql = this.ctx.storage.sql;
        // Owed past the account's memory of confirmations, one told again could count twice:
        // given up, uncounted.
        const stale = sql
          .exec<{ upload_id: string; bytes: number }>(
            "SELECT upload_id, bytes FROM storage_owed WHERE owed_at < ?",
            this.git.context.now() - STORAGE_OWED_MAX_AGE_MS,
          )
          .toArray();
        for (const row of stale) {
          this.#log().error("storage confirmation given up", {
            uploadId: row.upload_id,
            bytes: row.bytes,
          });
          sql.exec("DELETE FROM storage_owed WHERE upload_id = ?", row.upload_id);
        }
        const owed = sql
          .exec<{ upload_id: string; bytes: number }>(
            "SELECT upload_id, bytes FROM storage_owed ORDER BY owed_at LIMIT ?",
            STORAGE_CONFIRM_BATCH,
          )
          .toArray();
        for (const row of owed) {
          // The account cannot be told now: later, without spending an attempt.
          if (!(await this.#confirmStorage(row.upload_id, row.bytes)))
            return { done: false, cursor: null, runAfterMs: STORAGE_CONFIRM_RETRY_MS };
        }
        // Done only with nothing owed, judged with no wait before the answer: a push that
        // owed more meanwhile found this job running and left it to this one.
        const left = sql.exec<{ n: number }>("SELECT count(*) AS n FROM storage_owed").one().n;
        return left === 0
          ? { done: true }
          : { done: false, cursor: null, runAfterMs: STORAGE_CONFIRM_RETRY_MS };
      },
    };
  }

  #jobHandlers() {
    return {
      storage_confirm: this.#storageConfirmHandler(),
      mergeability: this.mergeability.handler(),
      merge_saga: this.rebases.handler("alarm"),
      pull_notices: this.pullSource.noticesHandler(),
      revision_import: this.pullImports.handler(),
      pull_follow: this.#followHandler(),
      view_compact: viewCompactionHandler({
        git: this.git,
        policy: () => this.maintenance,
        blocks: () => {
          this.#blocks ??= createClockBlockCache();
          return this.#blocks;
        },
        limit: () => VIEW_CAP - this.packCap.cap,
        record: async (output) => {
          await this.env.NETWORK.getByName(this.git.networkId()).recordCompaction({
            networkId: this.git.networkId(),
            forkRepoId: this.#repoId(),
            output,
          });
        },
      }),
      reflog_prune: reflogPruneHandler(
        this.git.context,
        REFLOG_PRUNE_BATCH,
        this.maintenance.reflogRetentionMs,
      ),
      detach: this.#network().detachHandler(),
      index: this.#push().indexHandler(),
      compact: packCapCompactionHandler(this.git, () => this.packCap, this.#log()),
      import: this.#imports().handler(),
      archive: this.#archives().handler(),
      audit_archive: this.#auditArchiver(),
      reap_orphans: orphanReaperHandler(this.git, {
        sweepNetwork: () => soleNetworkMember(this.env, this.git.networkId(), this.#repoId()),
      }),
      ...maintenanceHandlers(this.git, {
        policy: () => this.maintenance,
        log: this.#log(),
        blocks: () => {
          this.#blocks ??= createClockBlockCache();
          return this.#blocks;
        },
        retire: this.retireOptions,
        gc: this.gcHooks,
      }),
    } satisfies Partial<Record<JobKind, JobHandler>>;
  }

  // Fork networks: see src/network/.

  /** Hooks into detach slices. For tests. */
  detachHooks: DetachHooks = {};

  /** Hooks into a generation from a template. For tests. */
  generationHooks: { beforeWrite?: () => Promise<void> } = {};

  /** Hooks into opening a pull request from another repository. For tests. */
  forkPullHooks: { beforePublish?: () => Promise<void> } = {};

  /** Hooks into a merge of a pull request. For tests. */
  mergeHooks: { beforeFinish?: () => Promise<void> } = {};

  /** Hooks into a merge of the base branch into a pull request's head. For tests. */
  headMergeHooks: { beforeFinish?: () => Promise<void> } = {};

  /** Hooks into a write of a pull request's head branch here, handed over by its base. For tests. */
  headWriteHooks: { beforeFinish?: () => Promise<void> } = {};

  /** Hooks into applying suggestions. For tests. */
  suggestionHooks: { beforeWrite?: () => Promise<void> } = {};

  /** A merge's budgets. Tests may replace them. */
  mergePolicy: MergePolicy = MERGE_POLICY;

  /** A rebase merge's budgets. Tests may replace them. */
  rebasePolicy: RebasePolicy = REBASE_POLICY;

  /** Hooks into a rebase merge's commit. For tests. */
  rebaseHooks: {
    beforeFinalize?: () => Promise<void>;
    afterFinalize?: () => Promise<void>;
  } = {};

  /** A revision import's budgets. Tests may replace them. */
  importPolicy: ImportPolicy = IMPORT_POLICY;

  /** A mergeability slice's budgets. Tests may replace them. */
  mergeabilityPolicy: MergePolicy = MERGEABILITY_POLICY;

  /** Hooks into working out mergeability. For tests. */
  mergeabilityHooks: { beforeWrite?: () => Promise<void> } = {};

  #networkOps: RepoNetwork | undefined;

  #network(): RepoNetwork {
    this.#networkOps ??= new RepoNetwork({
      git: this.git,
      env: this.env,
      repoId: () => this.#repoId(),
      blocks: () => {
        this.#blocks ??= createClockBlockCache();
        return this.#blocks;
      },
      policy: () => this.maintenance,
      log: () => this.#log(),
      detachHooks: () => this.detachHooks,
    });
    return this.#networkOps;
  }

  /** A parent's half of fork creation: branches, tags, tips and live packs, read-leased by `holder`. */
  exportForFork(holder: string, ttlMs: number): Promise<ForkExport> {
    // Its packs are about to be erased: a fork must not borrow them.
    if (this.events.isDeleted()) throw new Error(REPO_DELETED);
    return this.#network().exportForFork(holder, ttlMs);
  }

  /** One page of the commit-graph closure from `frontier` (a fork's graph copy). */
  forkCommitPage(frontier: readonly string[], limit: number): CommitPage {
    return this.#network().commitPage(frontier, limit);
  }

  /** What an import of a pull request's head works with. */
  #importDeps(): ImportDeps {
    return {
      git: this.git,
      env: this.env,
      repoId: () => this.#repoId(),
      ownCap: () => this.packCap.cap,
      log: () => this.#log(),
    };
  }

  /**
   * Whether `root` reads `headRepoId` (a repository of the network), asked
   * of its object; a failure to ask is thrown (tried again later), never a
   * refusal.
   */
  #headReadable(headRepoId: string, root: string): Promise<boolean> {
    return this.env.REPO.getByName(headRepoId).readableBy(root);
  }

  /**
   * Active users and agents with the (lower-cased) handles, from the
   * directory, each with the root identity it counts as (a user's agent:
   * that user).
   */
  async #resolveHandles(handles: readonly string[]): Promise<Map<string, FeedPrincipal>> {
    this.git.context.metrics.count("d1.query", { db: "directory", op: "feed_mentions" });
    const { results } = await this.env.DIRECTORY.prepare(
      `SELECT p.id, p.handle,
         CASE WHEN p.type = 'agent' AND o.type = 'user' THEN o.id ELSE p.id END AS root
       FROM principals p LEFT JOIN principals o ON o.id = p.owner_id
       WHERE p.handle COLLATE NOCASE IN (SELECT value FROM json_each(?))
         AND p.type IN ('user', 'agent') AND p.disabled_at IS NULL`,
    )
      .bind(JSON.stringify(handles))
      .all<{ id: string; handle: string; root: string }>();
    return new Map(results.map((r) => [r.handle.toLowerCase(), { id: r.id, root: r.root }]));
  }

  /** `actor` as feeds see the change it makes now (its root identity and role). */
  async #feedActorOf(actor: Pick<RefActor, "principal" | "grantId">): Promise<FeedActor> {
    const ceilings = await this.#rolesPulled(actor.principal, actor.grantId ?? null);
    await this.feed.prepare();
    return {
      root: rootIdentity({
        principalId: actor.principal,
        grantId: actor.grantId ?? null,
        ceilingIds: ceilings,
      }),
      role: this.#roleNow(actor.principal, ceilings),
      mentioned: new Map(),
    };
  }

  /**
   * For a reader of an activity feed: whether `principal` (capped by its
   * grant's owners) reads the repository now, its role, and, if it reads
   * it, the excerpts of `members` (at most 100): what feed items name of
   * the repository (`comment/<id>`, `review_comment/<id>`, `review/<id>`,
   * `pull/<n>` for a pull request's description), read now so an edit or
   * deletion shows at once (null for one gone or empty).
   */
  feedView(
    principal: string,
    grantId: string | null,
    members: readonly string[],
  ): Promise<{
    readonly readable: boolean;
    readonly role: RepoRole | null;
    readonly excerpts: Record<string, string | null>;
  }> {
    return this.#measured("feedView", async () => {
      if (this.#refusesReads()) return { readable: false, role: null, excerpts: {} };
      const ceilings = await this.#rolesPulled(principal, grantId);
      // Deleted meanwhile (its rows not erased yet): nothing of it is read.
      if (this.#refusesReads()) return { readable: false, role: null, excerpts: {} };
      const role = this.#roleNow(principal, ceilings);
      const readable = role !== null || this.events.visibility() === "public";
      if (!readable) return { readable, role, excerpts: {} };
      const excerpts: Record<string, string | null> = {};
      for (const member of members.slice(0, 100)) {
        const [kind, id] = member.split("/") as [string, string | undefined];
        const n = Number(id);
        if (!Number.isSafeInteger(n) || n <= 0) continue;
        const body =
          kind === "comment"
            ? this.comments.get(n)?.body
            : kind === "review_comment"
              ? this.reviewComments.get(n)?.body
              : kind === "pull"
                ? this.pulls.get(n)?.body
                : kind === "review"
                  ? this.ctx.storage.sql
                      .exec<{ body: string | null }>(
                        "SELECT body FROM reviews WHERE review_id = ?",
                        n,
                      )
                      .toArray()[0]?.body
                  : undefined;
        excerpts[member] = excerpt(body);
      }
      return { readable, role, excerpts };
    });
  }

  /** Whether `principalId` may read this repository (public, or a role here). */
  async readableBy(principalId: string): Promise<boolean> {
    if (this.#refusesReads()) return false;
    if (this.events.visibility() === "public") return true;
    const ceilings = await this.#rolesPulled(principalId, null);
    return this.#roleNow(principalId, ceilings) !== null;
  }

  /** Where branch `headRef` is, for a pull request's base. */
  pullHeadTip(headRef: string): { sha: string | null; refVersion: number } {
    return this.pullSource.tip(headRef);
  }

  /** A pull request of `baseRepoId` follows branch `headRef` here (see `PullSource.register`). */
  registerOutgoingPull(input: Parameters<PullSource["register"]>[0]): {
    sha: string | null;
    refVersion: number;
  } {
    return this.pullSource.register(input);
  }

  /**
   * Commits a write a pull request's base made of its head branch here
   * (a merge of the base into it, suggestions applied): the pack the base
   * built, finished through this repository's push path, from `old` only.
   * The writer needs write access here, or the pull request's author lets
   * the base's maintainers write the branch (`maintainerAllowed`, as the
   * base has it, and this repository's own copy), the author still writes
   * here, and the base's check of the writer's token (`baseDecision`) let
   * it through; that consent is checked again in the commit's transaction.
   * With `materialize`, the base commit the write has as a parent is
   * imported first (its history published here before the pack is indexed).
   */
  pullHeadWrite(input: PullHeadWrite): Promise<Browsed<{ sha: string }>> {
    return this.#measured("pullHeadWrite", async () => {
      await this.checkEpoch();
      const refusedWrite = this.#writeRefusal();
      if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
      const maintainerFor = {
        baseRepoId: input.baseRepoId,
        number: input.number,
        generation: input.generation,
      };
      const registration = this.pullSource.registration(
        input.baseRepoId,
        input.number,
        input.generation,
        input.headRef,
      );
      if (!registration)
        return fail(409, "pull_changed", "The pull request no longer follows this branch.");
      const { writer } = input;
      // As a maintainer when the author allows it (the writer's token checked against the base,
      // which it may be limited to); else as one who writes here (its token checked against
      // this repository at the commit).
      if (registration.authorRoot) await this.acl.roleOf(registration.authorRoot, "write");
      const maintainer =
        input.maintainerAllowed &&
        registration.authorRoot !== null &&
        (await this.#principalActive(registration.authorRoot)) &&
        input.baseDecision !== null &&
        input.baseDecision.refusal === undefined &&
        this.#maintainerRefusal(maintainerFor, [{ name: `refs/heads/${input.headRef}` }]) ===
          undefined;
      if (!maintainer) {
        const ceilings = await this.#rolesPulled(writer.principal, writer.grantId ?? null);
        if (!atLeast(this.#roleNow(writer.principal, ceilings), "write"))
          return fail(403, "maintainer_edits_off", MAINTAINER_EDITS_OFF_DETAIL);
      }
      const ref = `refs/heads/${input.headRef}`;
      const tip = this.git.refStore.readRefsSync().refs.get(ref);
      if (!tip || oidToHex(tip) !== input.old)
        return fail(409, "head_moved", "The head branch moved; try again.");
      if (input.materialize) {
        const imported = await this.#importFrom(input.baseRepoId, input.materialize);
        if (!imported.ok) return imported;
      }
      const deps = await this.#writeDeps();
      const author = { ...writer, repoId: this.#repoId() };
      const upload = await storeUpload(deps, author, {
        ref,
        head: tip,
        commit: oidFromHex(input.commit),
        pack: input.pack,
      });
      if (!upload.ok) return upload;
      await this.headWriteHooks.beforeFinish?.();
      const decision = input.baseDecision;
      const committed = await finishUpload(
        deps,
        author,
        upload.value,
        {
          via: "api",
          // Still the pull request's branch, as the base asked.
          fence: () =>
            this.pullSource.registration(
              input.baseRepoId,
              input.number,
              input.generation,
              input.headRef,
            )
              ? undefined
              : PULL_CHANGED_HERE,
          ...(maintainer && {
            maintainerFor,
            authority: () => this.#maintainerRefusal(maintainerFor, [{ name: ref }]),
          }),
        },
        headWriteRefused,
        maintainer && decision ? async () => decision : undefined,
      );
      if (!committed.ok) return committed;
      return { ok: true, value: { sha: input.commit } };
    });
  }

  /**
   * Whether `principalId` is still active (it and, for an agent, its
   * owner not disabled), read from the directory's primary: a role it was
   * granted outlives its disabling.
   */
  async #principalActive(principalId: string): Promise<boolean> {
    const row = await this.env.DIRECTORY.withSession("first-primary")
      .prepare(
        `SELECT p.disabled_at, o.disabled_at AS owner_disabled_at FROM principals p
         LEFT JOIN principals o ON o.id = p.owner_id WHERE p.id = ?`,
      )
      .bind(principalId)
      .first<{ disabled_at: number | null; owner_disabled_at: number | null }>();
    return row !== null && row.disabled_at === null && row.owner_disabled_at === null;
  }

  /**
   * Why a base's maintainer may not write `refUpdates` here now (undefined
   * when it may): exactly the registered head branch, at the pull
   * request's generation, its author allowing it and writing here still.
   */
  #maintainerRefusal(
    maintainerFor: MaintainerFor,
    refUpdates: readonly { readonly name: string }[],
  ): string | undefined {
    const own = refUpdates.filter((u) => !u.name.startsWith(DERIVED_REF_PREFIX));
    const [update] = own;
    if (own.length !== 1 || !update?.name.startsWith("refs/heads/")) return MAINTAINER_EDITS_OFF;
    const registration = this.pullSource.registration(
      maintainerFor.baseRepoId,
      maintainerFor.number,
      maintainerFor.generation,
      update.name.slice("refs/heads/".length),
    );
    if (!registration?.maintainerCanModify || !registration.authorRoot) return MAINTAINER_EDITS_OFF;
    return this.acl.allows(registration.authorRoot, "write") ? undefined : MAINTAINER_EDITS_OFF;
  }

  /**
   * Imports the commit `sha` of `sourceRepoId` (another member of the
   * network) with its history: its packs borrowed, its commit rows copied
   * and published at once, so a write naming it as a parent is indexed.
   */
  async #importFrom(sourceRepoId: string, sha: string): Promise<Browsed<true>> {
    // Even with its commit rows here, its objects may be in packs collected since: always
    // borrowed again (the graph step copies only the commits missing).
    const importId = `head-write:${crypto.randomUUID()}`;
    const budget = { used: 0, max: OPEN_IMPORT_CALLS };
    let work: ImportWork = {
      importId,
      headRepoId: sourceRepoId,
      sha,
      step: "snapshot",
      leaseId: null,
      state: {},
    };
    try {
      for (let steps = 0; work.step !== "publish"; steps++) {
        if (steps >= OPEN_IMPORT_STEPS || budget.used >= budget.max)
          return fail(422, "too_expensive", "The base branch is too far ahead to bring here now.");
        work = await runImportStep(this.#importDeps(), work, this.importPolicy, budget);
      }
      const published = this.ctx.storage.transactionSync(() => {
        if (!readyToPublish(this.git, work)) return false;
        publishStaged(this.git, importId);
        return true;
      });
      if (!published) return BUSY;
      return { ok: true, value: true };
    } catch (error) {
      if (error instanceof ImportFailed)
        return error.code === "too_large"
          ? fail(422, "too_expensive", "The base branch is too far ahead to bring here now.")
          : BUSY;
      if (error instanceof ImportBusy) return BUSY;
      throw error;
    } finally {
      await discardImport(this.#importDeps(), work).catch(() => undefined);
    }
  }

  /** A pull request of `baseRepoId` no longer follows a branch here (as of `generation`). */
  unregisterOutgoingPull(baseRepoId: string, number: number, generation: number): void {
    this.pullSource.unregister(baseRepoId, number, generation);
  }

  /** A revision a pull request's base imports: the live packs, leased, if `sha` is a commit here. */
  exportRevision(input: { readonly sha: string; readonly holder: string; readonly ttlMs: number }) {
    return this.pullSource.exportRevision(input);
  }

  /**
   * A revision of a pull request's head in another repository of the
   * network (told by that repository's object): applied when it needs no
   * import, else queued for import. `closed` when the pull request no
   * longer follows that repository's branch.
   */
  receiveRevision(notice: RevisionNotice): Promise<NoticeAnswer> {
    return this.#measured("receiveRevision", async () => {
      if (this.#refusesReads()) return "closed";
      await this.checkEpoch();
      // Taking no changes now (a transfer): the head's repository tells it again later.
      if (this.#writeRefusal()) throw new Error("the repository takes no changes now");
      const pull = this.pulls.get(notice.number);
      if (pull?.state !== "open" || pull.headRepoId !== notice.headRepoId) return "closed";
      if (notice.generation !== pull.generation) return "stale";
      // Later than the revision applied, and than any queued: an older one never replaces them.
      const queued = this.pullImports.get(notice.number);
      const latest = Math.max(
        pull.headRefVersion ?? -1,
        queued?.generation === pull.generation ? queued.refVersion : -1,
      );
      if (latest >= notice.refVersion) return "stale";
      const actor: RefActor | null = notice.pusher
        ? { principal: notice.pusher, grantId: notice.pusherGrant, via: "push" }
        : null;
      const outcome = this.ctx.storage.transactionSync(() => {
        if (notice.sha === null || notice.sha === pull.headSha) {
          // Deleted, or back where it was: nothing to import, and no older import applies.
          const dropped = this.pullImports.drop(notice.number);
          this.pulls.noteRevision(
            notice.number,
            {
              refVersion: notice.refVersion,
              deleted: notice.sha === null,
              pushed: notice.pushed && notice.sha !== null,
            },
            actor,
          );
          return { answer: "applied" as const, release: dropped };
        }
        const { replaced } = this.pullImports.queue({
          number: notice.number,
          headRepoId: notice.headRepoId,
          generation: notice.generation,
          refVersion: notice.refVersion,
          sha: notice.sha,
          pusher: notice.pusher,
          pusherGrant: notice.pusherGrant,
        });
        return { answer: "queued" as const, release: replaced };
      });
      if (outcome.release) await releaseLease(this.#importDeps(), outcome.release);
      this.#armOutbox();
      this.#ensureAuditArchive();
      return outcome.answer;
    });
  }

  /** A new fork's storage: its network, HEAD and borrowed packs. */
  initFork(
    input: { networkId: string; head: string | null; packs: readonly ViewPack[] },
    identity?: RepoIdentity & { readonly actor: string | null },
  ): void {
    if (identity) this.events.assertIdentity(identity);
    if (isNetworkId(input.networkId))
      recordNetwork(this.ctx.storage, input.networkId, this.git.context.now());
    this.#network().initFork(input);
    if (identity) {
      this.events.init(identity, identity.actor);
      this.#armOutbox();
    }
  }

  /** One bounded step of a new fork's graph copy from its parent (see `RepoNetwork.copyGraphStep`). */
  copyForkGraph(input: CopyStepInput): Promise<CopyStep> {
    return this.#network().copyGraphStep(input);
  }

  /** Sets a new fork's refs, once its commit graph is complete, as `actor` (who forked). */
  async finishFork(refs: readonly ExportedRef[], actor?: RefActor): Promise<void> {
    await this.checkEpoch();
    this.#network().finishFork(refs, actor);
  }

  /**
   * Takes the directory's epoch for this repository if it is newer than the
   * recorded one (after a restore). Runs before this instance's first
   * commit; a restore runbook calls it to take the new epoch at once.
   */
  async checkEpoch(): Promise<void> {
    await this.events.checkEpoch(async (recorded) => {
      const metrics = this.git.context.metrics;
      const primary = this.env.DIRECTORY.withSession("first-primary");
      metrics.count("d1.query", { db: "directory", op: "epoch_read" });
      const epoch = await primary
        .prepare("SELECT epoch_gen FROM source_epochs WHERE source_id = ?")
        .bind(this.#repoId())
        .first<{ epoch_gen: number }>();
      const epochGen = epoch?.epoch_gen ?? null;
      if (epochGen === null || epochGen <= recorded) return { epochGen };
      // Restored: the object may predate a transfer or a rename. What the directory and the
      // read model's fence say now.
      metrics.count("d1.query", { db: "directory", op: "epoch_owner" });
      const row = await primary
        .prepare(
          `SELECT r.owner_id, r.name, r.name_gen, r.org_shard,
             t.transfer_id, t.from_owner, t.to_owner
           FROM repos r LEFT JOIN repo_transfers t
             ON t.repo_id = r.id AND t.step NOT IN ('done', 'failed')
           WHERE r.id = ?`,
        )
        .bind(this.#repoId())
        .first<{
          owner_id: string;
          name: string;
          name_gen: number;
          org_shard: string;
          transfer_id: string | null;
          from_owner: string | null;
          to_owner: string | null;
        }>();
      if (!row) return { epochGen };
      metrics.count("d1.query", { db: "org", op: "owner_fence" });
      const fence = await readModelFor(this.env, row.org_shard)
        .prepare("SELECT owner_gen FROM source_owner WHERE source_id = ?")
        .bind(this.#repoId())
        .first<{ owner_gen: number }>();
      return {
        epochGen,
        owner: {
          ownerId: row.owner_id,
          name: row.name,
          nameGen: row.name_gen,
          ownerFence: fence?.owner_gen ?? 0,
          transfer:
            row.transfer_id && row.from_owner && row.to_owner
              ? { id: row.transfer_id, from: row.from_owner, to: row.to_owner }
              : null,
        },
      };
    });
    // A new epoch's snapshot goes out even if nothing else is written.
    this.#armOutbox();
  }

  /** The repository's current snapshot for a read-model rebuild (null without an identity). */
  exportSnapshot(): RepoExport | null {
    return this.events.exportSnapshot();
  }

  /**
   * The deletion's first steps, each safe to redo: freeze the repository
   * and emit its tombstone (once; from then on no background job but the
   * audit archive runs), send its events and archive its audit rows within
   * `budgetMs`. Ready for the erase when nothing is left to send or archive
   * and no other call or alarm runs in this object.
   */
  prepareDeletion(
    actor: JobActor | string | null,
    budgetMs: number,
  ): Promise<{ ready: boolean; events: number; auditRows: number }> {
    return this.#measured("prepareDeletion", async () => {
      await this.checkEpoch();
      this.events.markDeleted(actor);
      this.#parkJobs();
      const deadline = this.git.context.now() + budgetMs;
      if (this.outbox.pending() > 0) {
        const sent = await this.outbox.drain(this.#repoId());
        if (!sent.ok) this.#log().warn("sending events failed", { error: sent.error });
      }
      const archiver = this.#auditArchiver();
      try {
        while (unarchivedAuditRows(this.ctx.storage) > 0 && this.git.context.now() < deadline)
          await archiver.runSlice(DELETION_SLICE);
      } catch (error) {
        this.#log().warn("archiving audit records failed", { error });
      }
      const events = this.outbox.pending();
      const auditRows = unarchivedAuditRows(this.ctx.storage);
      // Whatever is left, the alarm retries meanwhile.
      this.#armOutbox();
      this.#ensureAuditArchive();
      const alone = this.#inFlight === 1;
      return { ready: events === 0 && auditRows === 0 && alone, events, auditRows };
    });
  }

  /**
   * The deletion's last step: erases what the repository stored outside
   * this object (see `eraseRepository`), then this object's storage and
   * alarm. Refused unless the deletion froze the repository first.
   */
  eraseForDeletion(): Promise<EraseOutcome | "not_frozen"> {
    // Concurrent callers (a request and the cron) share one erase.
    this.#erasing ??= this.#erase().finally(() => {
      this.#erasing = undefined;
    });
    return this.#erasing;
  }

  #erasing: Promise<EraseOutcome | "not_frozen"> | undefined;

  #erase(): Promise<EraseOutcome | "not_frozen"> {
    return this.#measured("eraseForDeletion", async () => {
      if (this.#hasGitStorage()) {
        // An object without an identity (created before identities existed)
        // cannot record the freeze; the directory's mark stands for it.
        if (this.events.hasIdentity() && !this.events.isDeleted()) return "not_frozen";
        if (this.#inFlight > 1) return "busy";
        this.#closed = true;
        let outcome: EraseOutcome;
        try {
          outcome = await eraseRepository(
            this.git,
            this.env,
            this.#repoId(),
            this.events.account()?.accountId,
          );
        } catch (error) {
          this.#closed = false;
          throw error;
        }
        if (outcome !== "erased") {
          this.#closed = false;
          return outcome;
        }
      }
      this.#closed = true;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return "erased";
    });
  }

  /**
   * Why no upload, import or write is taken now: 404 when the repository is
   * gone or going (or still being generated from a template), 409 while a
   * transfer moves it.
   */
  #writeRefusal(): { status: 404 | 409; code: string; error: string } | undefined {
    if (this.#closed || !this.#hasGitStorage() || this.events.isDeleted())
      return { status: 404, code: "repo_not_found", error: REPO_DELETED };
    if (this.events.isTransferring())
      return { status: 409, code: "repo_transferring", error: REPO_TRANSFERRING };
    if (this.#generatingFrom() !== undefined)
      return { status: 404, code: "repo_not_found", error: REPO_DELETED };
    return undefined;
  }

  /** No read: the repository is gone or going (a transfer does not stop reads). */
  #refusesReads(): boolean {
    return this.#closed || !this.#hasGitStorage() || this.events.isDeleted();
  }

  #hasGitStorage(): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'git_meta'",
        )
        .one().n > 0 &&
      this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM git_meta").one().n > 0
    );
  }

  /** One slice of compacting borrowed packs to keep the view under the cap. */
  compactViewSlice(input: CompactSliceInput) {
    return this.#network().compactSlice(input);
  }

  /** Swaps a finished view compaction in. */
  swapCompactedView(output: string, sources: readonly string[]): ViewPack {
    return this.#network().swapCompacted(output, sources);
  }

  /** The registry rows of packs under `networkId` (the network collection's snapshot). */
  networkSnapshot(networkId: string): MemberPack[] {
    // An erased object restarted with empty storage holds nothing: it says
    // so by failing, and the network checks the directory.
    if (!this.#hasGitStorage()) throw new Error("git storage is not initialized");
    return this.#network().networkSnapshot(networkId);
  }

  /** Acknowledges shared packs the network condemns (no new leases), with when leases on them end. */
  condemnShared(packIds: readonly string[]): CondemnAnswer {
    return this.#network().condemnShared(packIds);
  }

  /** Of `packIds`, those this registry names (the network's orphan sweep asks every member). */
  registeredPacks(packIds: readonly string[]): string[] {
    return this.#network().registeredPacks(packIds);
  }

  /** Starts a detach into `newNetworkId` (the network object calls this); it runs in the alarm. */
  beginDetach(newNetworkId: string): { ok: true } | { ok: false; error: string } {
    const now = this.git.context.now();
    // The one it leaves too (an object older than the history has no record of it).
    if (this.#hasGitStorage()) recordNetwork(this.ctx.storage, this.git.networkId(), now);
    if (isNetworkId(newNetworkId)) recordNetwork(this.ctx.storage, newNetworkId, now);
    return this.#network().beginDetach(newNetworkId);
  }

  /** Writes and reads back one value in this object's SQLite storage (used by /healthz). */
  async healthProbe(nonce: string, meta: RequestMeta = {}): Promise<boolean> {
    await this.ctx.storage.put("healthz", nonce);
    createMetrics(this.env.METRICS).count("do.rows_written", {
      class: "RepoDO",
      op: "healthProbe",
    });
    const ok = (await this.ctx.storage.get<string>("healthz")) === nonce;
    createLogger({ ...meta, do: "RepoDO" }).debug("healthz probe", { ok });
    return ok;
  }
}
