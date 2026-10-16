import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import {
  DERIVED_REF_PREFIX,
  isNetworkId,
  type JobHandler,
  type JobKind,
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
  type Envelope,
  protectsBranch,
  type RepoRole,
  type ReviewEvent,
  rootIdentity,
} from "@fyrden/domain";
import { type BlockCache, type LsRefsArgs, type Oid, oidFromHex, oidToHex } from "@fyrden/git-core";
import { readModelFor } from "../events/read-model.js";
import { lsRefsResponse, receivePackAdvertisement } from "../git/advertise.js";
import type { ObjectAccessAnswer, ObjectAccessRequest } from "../git/cache/object-access.js";
import { checkObjectAccess } from "../git/cache/object-check.js";
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
import type { GcHooks } from "../git/maintenance/gc-job.js";
import { maintenanceHandlers } from "../git/maintenance/handlers.js";
import { MAINTENANCE_DEFAULTS, type MaintenancePolicy } from "../git/maintenance/policy.js";
import { scheduleAfterCommit } from "../git/maintenance/schedule.js";
import { packCapCompactionHandler } from "../git/maintenance/tail-merge-job.js";
import { type PackCapPolicy, packCapPolicy } from "../git/maintenance/tail-merge-plan.js";
import type { PushDecision } from "../git/push/commit.js";
import { ACCESS_LOST } from "../git/push/reauthorize.js";
import {
  type BeginPushInput,
  type BeginPushResult,
  type PushLogMeta,
  type PushProgress,
  RepoPush,
} from "../git/push/repo-push.js";
import type { DetachHooks } from "../network/detach.js";
import {
  IMPORT_POLICY,
  type ImportDeps,
  type ImportPolicy,
  PullImports,
  publishStaged,
} from "../network/pull-import.js";
import { type NoticeAnswer, PullSource, type RevisionNotice } from "../network/pull-source.js";
import { networkMembersAfter, networkRetire, soleNetworkMember } from "../network/repo-client.js";
import { type CopyStep, type CopyStepInput, RepoNetwork } from "../network/repo-network.js";
import type {
  CommitPage,
  CondemnAnswer,
  ExportedRef,
  ForkExport,
  MemberPack,
  ViewPack,
} from "../network/types.js";
import { type CompactSliceInput, viewCompactionHandler } from "../network/view-cap.js";
import { platformSigner } from "../signing/platform-key.js";
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
import { RepoAuthority } from "./repo/authority.js";
import {
  type Browsed,
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
import type { ConflictsView, MergedIntoHead } from "./repo/conflicts.js";
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
import { excerpt, type FeedPrincipal, RepoFeed } from "./repo/feed.js";
import {
  type FileWriteDeps,
  type FileWriteInput,
  type FileWriteResult,
  writeFiles,
} from "./repo/file-writes.js";
import { ForkPulls, type PullHeadWrite } from "./repo/fork-pulls.js";
import {
  type ApplySuggestionsInput,
  HeadBranchWrites,
  type ResolveConflictsInput,
  type UpdateBranchInput,
} from "./repo/head-writes.js";
import { type HookForDelivery, type HookView, RepoHooks } from "./repo/hooks.js";
import { MERGE_POLICY, type MergeMade, type MergePolicy } from "./repo/merge.js";
import { MERGEABILITY_POLICY, type PullView, RepoMergeability } from "./repo/mergeability.js";
import {
  type NewReviewComment,
  type PullChangeRefusal,
  PullDiscussion,
} from "./repo/pull-discussion.js";
import { mergeBaseOf, type PullFilesPage, pullCommits, pullFiles } from "./repo/pull-files.js";
import { type MergePullInput, PullMerging } from "./repo/pull-merging.js";
import { type ForkPullOpened, type PullOpened, PullOpening } from "./repo/pull-opening.js";
import {
  type OpenPull,
  type PullCaller,
  type PullChangeFailure,
  type PullPatch,
  type PullRecord,
  RepoPulls,
} from "./repo/pulls.js";
import { hasPrecheckRules } from "./repo/push-rules.js";
import { REBASE_POLICY, type RebasePolicy, RebaseSagas } from "./repo/rebase-saga.js";
import { RepoReviewComments } from "./repo/review-comments.js";
import { RepoReviews } from "./repo/reviews.js";
import {
  RepoRulesets,
  type RuleSuite,
  type RulesetInput,
  type RulesetRecord,
} from "./repo/rulesets.js";
import {
  type TemplateTree,
  type TemplateWriteInput,
  templateTree,
  writeTemplate,
} from "./repo/template.js";
import type { WriteContext, WriteRefusal } from "./repo/write-context.js";
import { repoSchema } from "./schema/repo.js";
import type { FeedPurge } from "./user/feed.js";

/** A listing's cursor that names none this repository keeps for that pull request. */
const INVALID_LISTING = fail(
  422,
  "invalid_cursor",
  "The cursor is not one this API returned, or its listing has expired: start again.",
);

/**
 * Why a feed's reader may not read the repository (`feedView`): `lost`,
 * certainly, as `loss` says (the repository gone: no account, and the time
 * it was found so; or the account's ACL at `(epochGen, aclVersion)`, as
 * pulled at `until`), so the reader's feed may forget it up to then;
 * `denied`, but on nothing a feed may forget it by (an object without an
 * account); `unknown`, not known (no usable ACL snapshot: a pull failed).
 */
export type FeedViewDenial =
  | { readonly kind: "lost"; readonly loss: Omit<FeedPurge, "repoIds"> }
  | { readonly kind: "denied" }
  | { readonly kind: "unknown" };

/** Whether a hook URL is plain http (as its parser reads it). */
function isHttp(url: string): boolean {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return true;
  }
}

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

  /** Effective roles and the rulesets' judgement of writes. */
  readonly #authority: RepoAuthority;

  /** Review requests, diff threads and the standing a merge is judged by. */
  readonly #discussion: PullDiscussion;

  /** Merges of pull requests into their base branches. */
  readonly #merging: PullMerging;

  /** Writes of pull requests' head branches made through this repository. */
  readonly #headWrites: HeadBranchWrites;

  /** Pull requests between this repository and others of its fork network. */
  readonly #forkPulls: ForkPulls;

  /** Pull requests opened, from this repository's branches or another's of its network. */
  readonly #opening: PullOpening;

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
    this.events = new RepoEvents(
      this.git,
      this.outbox,
      () => this.#repoId(),
      () => this.pullSource.restored(),
    );
    this.pulls = new RepoPulls({
      git: this.git,
      events: this.events,
      repoId: () => this.#repoId(),
      stale: (number, open) => this.mergeability.stale(number, open),
      staleBase: (branch) => this.mergeability.staleBase(branch),
      follow: (pull) => this.#forkPulls.follow(pull),
    });
    this.pullSource = new PullSource({
      git: this.git,
      repoId: () => this.#repoId(),
      tell: (baseRepoId, notice) => {
        // Counted before it is made (a failure too): the job queue stops near the call budget.
        this.git.context.metrics.count("do.request", {
          class: "RepoDO",
          method: "receiveRevision",
        });
        return this.env.REPO.getByName(baseRepoId).receiveRevision(notice);
      },
      log: () => this.#log(),
      epoch: () => this.events.epochGen(),
      members: (after, limit) =>
        networkMembersAfter(this.env, this.#repoId(), after, limit, this.git.context.metrics),
      followAgain: (baseRepoId, after) => {
        // Counted before it is made: the job queue stops starting slices near the call budget.
        this.git.context.metrics.count("do.request", {
          class: "RepoDO",
          method: "followHeadAgain",
        });
        return this.env.REPO.getByName(baseRepoId).followHeadAgain(this.#repoId(), after);
      },
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
      memoryBlocks: () => this.#memoryBlocks(),
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
          this.#discussion.standing(number, pull, method, upToDate),
        internalCalls: () => currentInvocation()?.tally.internal ?? 0,
        committed: () => {
          this.#armOutbox();
          this.#ensureAuditArchive();
        },
        policy: () => this.rebasePolicy,
        hooks: () => this.rebaseHooks,
        feedActor: (actor) => this.#merging.feedActor(actor),
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
    this.#authority = new RepoAuthority({
      git: this.git,
      env: () => this.env,
      acl: this.acl,
      rulesets: () => this.rulesetStore,
      memoryBlocks: () => this.#memoryBlocks(),
    });
    this.#discussion = new PullDiscussion({
      git: this.git,
      pulls: this.pulls,
      reviews: this.reviews,
      reviewComments: this.reviewComments,
      authority: this.#authority,
      memoryBlocks: () => this.#memoryBlocks(),
      viewed: (pull) => this.#viewed(pull),
      pullChange: (method, actor, change, prepare, texts) =>
        this.#pullChange(method, actor, change, prepare, texts),
    });
    const writes: WriteContext = {
      git: this.git,
      env: () => this.env,
      acl: this.acl,
      pulls: this.pulls,
      authority: this.#authority,
      repoId: () => this.#repoId(),
      checkEpoch: () => this.checkEpoch(),
      writeRefusal: () => this.#writeRefusal(),
      writeDeps: () => this.#writeDeps(),
      committed: () => {
        this.#armOutbox();
        this.#ensureAuditArchive();
      },
    };
    this.#merging = new PullMerging({
      ...writes,
      rebases: this.rebases,
      discussion: this.#discussion,
      feed: this.feed,
      mergePolicy: () => this.mergePolicy,
      rebasePolicy: () => this.rebasePolicy,
      hooks: () => this.mergeHooks,
    });
    this.#headWrites = new HeadBranchWrites({
      ...writes,
      reviewComments: this.reviewComments,
      memoryBlocks: () => this.#memoryBlocks(),
      mergePolicy: () => this.mergePolicy,
      suggestionHooks: () => this.suggestionHooks,
      headMergeHooks: () => this.headMergeHooks,
    });
    this.#forkPulls = new ForkPulls({
      ...writes,
      pullSource: this.pullSource,
      pullImports: this.pullImports,
      importDeps: () => this.#importDeps(),
      importPolicy: () => this.importPolicy,
      log: () => this.#log(),
      headWriteHooks: () => this.headWriteHooks,
    });
    this.#opening = new PullOpening({
      ...writes,
      feed: this.feed,
      importDeps: () => this.#importDeps(),
      importPolicy: () => this.importPolicy,
      headReadable: (headRepoId, root) => this.#headReadable(headRepoId, root),
      viewed: (pull) => this.#viewed(pull),
      forkPullHooks: () => this.forkPullHooks,
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
      if (actor.maintainerFor)
        return this.#forkPulls.maintainerRefusal(actor.maintainerFor, refUpdates);
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

  #memoryBlocks(): BlockCache {
    this.#blocks ??= createClockBlockCache();
    return this.#blocks;
  }

  /**
   * The protocol v2 `ls-refs` response for the current refs, pkt-lines and
   * flush. Annotated tags are peeled from the packs when `peel` is asked.
   */
  async lsRefs(args: LsRefsArgs): Promise<Uint8Array> {
    const memoryBlocks = this.#memoryBlocks();
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
        ? await this.#authority.rolesPulled(principal, input.actor?.grantId ?? null)
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
      const ceilings = await this.#authority.rolesPulled(actor.principal, actor.grantId ?? null);
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
      const ceilings = await this.#authority.rolesPulled(actor.principal, actor.grantId ?? null);
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

  /** Opens a pull request between two of the repository's branches (see `PullOpening.open`). */
  createPull(input: Omit<OpenPull, "baseSha" | "headSha">, actor: RefActor): Promise<PullOpened> {
    return this.#measured("createPull", () => this.#opening.open(input, actor));
  }

  /**
   * Opens a pull request whose head is a branch of another repository of
   * the network, its revision imported first (see `PullOpening.openFromFork`).
   */
  createForkPull(
    input: Omit<OpenPull, "baseSha" | "headSha" | "headRefVersion"> & {
      readonly headRepoId: string;
    },
    actor: RefActor,
  ): Promise<ForkPullOpened> {
    return this.#measured("createForkPull", () => this.#opening.openFromFork(input, actor));
  }

  /**
   * The head's repository `headRepoId` was restored and may have lost what
   * it was told: its open pull requests here numbered after `after` (a
   * page) are followed again, as when opened. Answers the number to go on
   * after, or null when there are no more.
   */
  followHeadAgain(headRepoId: string, after: number): number | null {
    if (this.#refusesReads()) return null;
    return this.#forkPulls.followAgain(headRepoId, after);
  }

  /**
   * A revision of a pull request's head in another repository of the
   * network, told by that repository's object (see
   * `ForkPulls.receiveRevision`); `closed` once this one is gone.
   */
  receiveRevision(notice: RevisionNotice): Promise<NoticeAnswer> {
    return this.#measured("receiveRevision", async () =>
      this.#refusesReads() ? "closed" : this.#forkPulls.receiveRevision(notice),
    );
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

  /** Merges a pull request into its base branch (see `PullMerging.merge`). */
  mergePull(input: MergePullInput, actor: RefActor): Promise<Browsed<MergeMade>> {
    return this.#measured("mergePull", () => this.#merging.merge(input, actor));
  }

  /**
   * A page of the files a pull request changes. Without `from`, a listing
   * starts: the merge base of the base it is compared from (the base
   * branch's tip while open, see `comparedBase`) and the recorded head is
   * worked out now, and kept for the later
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
          const found = await mergeBaseOf(
            this.git.commitGraph,
            this.pulls.comparedBase(pull),
            head,
          );
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
   * A page of a pull request's commits, oldest first: from the base it is
   * compared from (`comparedBase`) to the recorded head, kept for the
   * later pages as a file listing is.
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
        base = this.pulls.comparedBase(pull);
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

  /** Requests reviews of principals, each one's access checked here (see `PullDiscussion`). */
  requestReviewers(number: number, reviewerIds: readonly string[], actor: RefActor) {
    return this.#discussion.requestReviewers(number, reviewerIds, actor);
  }

  /** Withdraws review requests. */
  removeRequestedReviewers(number: number, reviewerIds: readonly string[], actor: RefActor) {
    return this.#discussion.removeRequestedReviewers(number, reviewerIds, actor);
  }

  /**
   * A pull request's diff comments, oldest first, with what its diff
   * compares now (whether each is outdated); null when the repository is
   * gone, undefined without the pull request.
   */
  listReviewComments(number: number, after: number, limit: number) {
    return this.#measured("listReviewComments", async () =>
      this.#refusesReads() ? null : this.#discussion.reviewComments(number, after, limit),
    );
  }

  /** One diff comment, with what its pull request's diff compares now; null when the repository is gone. */
  getReviewComment(id: number) {
    return this.#measured("getReviewComment", async () =>
      this.#refusesReads() ? null : this.#discussion.reviewComment(id),
    );
  }

  /** A pull request's threads, oldest first, as `listReviewComments`. */
  listReviewThreads(number: number, after: number, limit: number) {
    return this.#measured("listReviewThreads", async () =>
      this.#refusesReads() ? null : this.#discussion.threads(number, after, limit),
    );
  }

  /** Starts a thread on a pull request's diff, at an anchor checked against the file it names. */
  createReviewComment(number: number, input: NewReviewComment, actor: RefActor) {
    return this.#discussion.createReviewComment(number, input, actor);
  }

  /** Replies in the thread of comment `to`. */
  replyReviewComment(number: number, to: number, body: string, actor: RefActor) {
    return this.#discussion.replyReviewComment(number, to, body, actor);
  }

  editReviewComment(id: number, body: string, actor: RefActor) {
    return this.#discussion.editReviewComment(id, body, actor);
  }

  /** Resolves a thread, or makes it unresolved again. */
  resolveReviewThread(number: number, threadId: number, resolved: boolean, actor: RefActor) {
    return this.#discussion.resolveReviewThread(number, threadId, resolved, actor);
  }

  deleteReviewComment(id: number, actor: RefActor) {
    return this.#pullChange("deleteReviewComment", actor, (caller) =>
      this.reviewComments.delete(id, caller),
    );
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

  /** Applies diff comments' suggestions to a pull request's head branch as one commit. */
  applySuggestions(
    input: ApplySuggestionsInput,
    actor: RefActor,
  ): Promise<Browsed<FileWriteResult & { readonly paths: readonly string[] }>> {
    return this.#measured("applySuggestions", () =>
      this.#headWrites.applySuggestions(input, actor),
    );
  }

  /** The conflicts of merging an open pull request's base branch into its head. */
  pullConflicts(number: number): Promise<Browsed<ConflictsView>> {
    return this.#measured("pullConflicts", async () =>
      this.#refusesReads()
        ? fail(404, "repo_not_found", REPO_DELETED)
        : this.#headWrites.conflicts(number),
    );
  }

  /** Resolves an open pull request's conflicts with its base branch, on its head branch. */
  resolvePullConflicts(
    input: ResolveConflictsInput,
    actor: RefActor,
  ): Promise<Browsed<MergedIntoHead>> {
    return this.#measured("resolvePullConflicts", () =>
      this.#headWrites.resolveConflicts(input, actor),
    );
  }

  /** Brings an open pull request's head branch up to date with its base branch. */
  updatePullBranch(input: UpdateBranchInput, actor: RefActor): Promise<Browsed<MergedIntoHead>> {
    return this.#measured("updatePullBranch", () => this.#headWrites.updateBranch(input, actor));
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
      const ceilings = await this.#authority.rolesPulled(actor.principal, actor.grantId ?? null);
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
      const role = this.#authority.roleNow(actor.principal, ceilings);
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
    const memoryBlocks = this.#memoryBlocks();
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
    const memoryBlocks = this.#memoryBlocks();
    return this.#measured("objectAccess", () =>
      checkObjectAccess({ git: this.git, memoryBlocks }, request),
    );
  }

  /** One browse request, its reader released when it ends. */
  #browse<R>(method: string, use: (browse: RepoBrowse) => R | Promise<R>): Promise<R> {
    const browse = new RepoBrowse({ git: this.git, memoryBlocks: this.#memoryBlocks() });
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
      precheck: (principal, updates, grantId) =>
        this.#authority.precheckUpdates(principal, updates, grantId),
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
    return this.#measured("writeFiles", async () => {
      // Its commit needs the restore generation taken (a cold instance has not yet).
      await this.checkEpoch();
      return writeFiles(await this.#writeDeps(), input);
    });
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
      // Its commit needs the restore generation taken (a cold instance has not yet).
      await this.checkEpoch();
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
    this.#archiver ??= new RepoArchives({ git: this.git, memoryBlocks: this.#memoryBlocks() });
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

  /** What garbage collection keeps besides what the refs and the reflog reach. */
  gcRoots(): Oid[] {
    return this.pulls.recordedBases();
  }

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
      () => this.#memoryBlocks(),
    );
    this.#pushes.accessCheck = async (principal) => {
      // Pulls a snapshot past its write window first (fail closed).
      await this.acl.roleOf(principal, "write");
      return this.acl.allows(principal, "write") ? undefined : ACCESS_LOST;
    };
    this.#pushes.frozen = () => this.events.frozen() ?? this.#generationAbandoned();
    this.#pushes.rules = this.#authority.pushRules();
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
  precheckPush(
    uploadId: string,
    head: Uint8Array,
  ): Promise<{ ok: true } | { ok: false; response: Uint8Array }> {
    return this.#authority.precheckPush(uploadId, head);
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
      const refused = await this.#authority.precheckUpdates(
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
        this.#authority.precheckUpdates(principal, updates, grantId, head),
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
      pull_follow: this.#forkPulls.followHandler(),
      pull_refollow: this.pullSource.refollowHandler(),
      view_compact: viewCompactionHandler({
        git: this.git,
        policy: () => this.maintenance,
        blocks: () => this.#memoryBlocks(),
        ownCap: () => this.packCap.cap,
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
        blocks: () => this.#memoryBlocks(),
        retire: this.retireOptions,
        gc: this.gcHooks,
        roots: () => this.gcRoots(),
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
      blocks: () => this.#memoryBlocks(),
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
      rewriteObjects: () => this.maintenance.maxRewriteObjects,
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

  /**
   * For a reader of an activity feed: whether `principal` (capped by its
   * grant's owners) reads the repository now, its role, and, if it reads
   * it, the excerpts of `members` (at most 100): what feed items name of
   * the repository (`comment/<id>`, `review_comment/<id>`, `review/<id>`,
   * `pull/<n>` for a pull request's description), read now so an edit or
   * deletion shows at once (null for one gone or empty). When it does not
   * read it, `denial` says how sure that is (see `FeedViewDenial`).
   */
  feedView(
    principal: string,
    grantId: string | null,
    members: readonly string[],
  ): Promise<{
    readonly readable: boolean;
    readonly role: RepoRole | null;
    readonly excerpts: Record<string, string | null>;
    readonly denial: FeedViewDenial | null;
  }> {
    return this.#measured("feedView", async () => {
      const gone = () => ({
        readable: false,
        role: null,
        excerpts: {},
        denial: {
          kind: "lost" as const,
          loss: { accountId: "", epochGen: 0, aclVersion: 0, until: Date.now() },
        },
      });
      if (this.#refusesReads()) return gone();
      const ceilings = await this.#authority.rolesPulled(principal, grantId);
      // Deleted meanwhile (its rows not erased yet): nothing of it is read.
      if (this.#refusesReads()) return gone();
      const role = this.#authority.roleNow(principal, ceilings);
      const readable = role !== null || this.events.visibility() === "public";
      if (!readable) {
        // The snapshot the decision used: a denial without one (a pull failed) is no answer.
        const basis = this.acl.basis();
        const denial: FeedViewDenial =
          basis === "unknown"
            ? { kind: "unknown" }
            : basis === "none"
              ? { kind: "denied" }
              : {
                  kind: "lost",
                  loss: {
                    accountId: basis.accountId,
                    epochGen: basis.epochGen,
                    aclVersion: basis.version,
                    until: basis.pulledAt,
                  },
                };
        return { readable, role, excerpts: {}, denial };
      }
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
      return { readable, role, excerpts, denial: null };
    });
  }

  /** Whether `principalId` may read this repository (public, or a role here). */
  async readableBy(principalId: string): Promise<boolean> {
    if (this.#refusesReads()) return false;
    if (this.events.visibility() === "public") return true;
    const ceilings = await this.#authority.rolesPulled(principalId, null);
    return this.#authority.roleNow(principalId, ceilings) !== null;
  }

  /** Where branch `headRef` is, for a pull request's base. */
  async pullHeadTip(headRef: string): Promise<{ sha: string | null; refVersion: number }> {
    // Versions are ordered by the restore generation: the directory's is taken first.
    await this.checkEpoch();
    return this.pullSource.tip(headRef);
  }

  /** A pull request of `baseRepoId` follows branch `headRef` here (see `PullSource.register`). */
  async registerOutgoingPull(input: Parameters<PullSource["register"]>[0]): Promise<{
    sha: string | null;
    refVersion: number;
  }> {
    await this.checkEpoch();
    return this.pullSource.register(input);
  }

  /**
   * Commits a write a pull request's base made of its head branch here
   * (see `ForkPulls.receiveHeadWrite`).
   */
  pullHeadWrite(input: PullHeadWrite): Promise<Browsed<{ sha: string }>> {
    return this.#measured("pullHeadWrite", () => this.#forkPulls.receiveHeadWrite(input));
  }

  /** A pull request of `baseRepoId` no longer follows a branch here (as of `generation`). */
  unregisterOutgoingPull(baseRepoId: string, number: number, generation: number): void {
    this.pullSource.unregister(baseRepoId, number, generation);
  }

  /** A revision a pull request's base imports: the live packs, leased, if `sha` is a commit here. */
  exportRevision(input: { readonly sha: string; readonly holder: string; readonly ttlMs: number }) {
    return this.pullSource.exportRevision(input);
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
  #writeRefusal(): WriteRefusal | undefined {
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
