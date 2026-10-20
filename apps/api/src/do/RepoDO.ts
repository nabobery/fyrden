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
  decideMetadataAction,
  type Envelope,
  type LabelSpec,
  type LockReason,
  protectsBranch,
  type ReactionContent,
  type ReactionTarget,
  type RepoRole,
  type ReviewEvent,
  rootIdentity,
} from "@fyrden/domain";
import { type BlockCache, type LsRefsArgs, type Oid, oidToHex } from "@fyrden/git-core";
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
import { systemClock, type WatchClock } from "../git/import/watch.js";
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
import { ClaimReleases } from "../network/claim-releases.js";
import type { DetachHooks } from "../network/detach.js";
import {
  IMPORT_POLICY,
  type ImportDeps,
  type ImportPolicy,
  PullImports,
  publishStaged,
} from "../network/pull-import.js";
import { type NoticeAnswer, PullSource, type RevisionNotice } from "../network/pull-source.js";
import { networkReclaimHandler, reclaimAfterRestore } from "../network/reclaim.js";
import { networkMembersAfter, soleNetworkMember } from "../network/repo-client.js";
import { type CopyStep, type CopyStepInput, RepoNetwork } from "../network/repo-network.js";
import type {
  CommitPage,
  CondemnAnswer,
  ExportedRef,
  ForkExport,
  MemberPack,
  ViewPack,
} from "../network/types.js";
import {
  type CompactSliceInput,
  forgetMerged,
  viewCompactionHandler,
} from "../network/view-cap.js";
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
import { type AclPurpose, RepoAcl } from "./repo/acl.js";
import { RepoAdministration, type RepoDetails, type RulesetChange } from "./repo/administration.js";
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
import { ChangeLists } from "./repo/change-lists.js";
import { type CommentRecord, RepoComments } from "./repo/comments.js";
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
import { readDirectoryEpoch } from "./repo/epoch.js";
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
import { RepoFeed } from "./repo/feed.js";
import { type FeedViewAnswer, RepoFeedView } from "./repo/feed-view.js";
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
import {
  type IssuePatch,
  RepoIssues,
  type Subject,
  type SubjectKind,
  type SubjectQuery,
} from "./repo/issues.js";
import { MERGE_POLICY, type MergeMade, type MergePolicy } from "./repo/merge.js";
import { MERGEABILITY_POLICY, type PullView, RepoMergeability } from "./repo/mergeability.js";
import {
  type NewReviewComment,
  type PullChangeRefusal,
  PullDiscussion,
} from "./repo/pull-discussion.js";
import { type ListingCursor, pullCommitsListing, pullFilesListing } from "./repo/pull-files.js";
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
import { type Reacted, type ReactionSubject, RepoReactions } from "./repo/reactions.js";
import { REBASE_POLICY, type RebasePolicy } from "./repo/rebase-replay.js";
import { RebaseSagas } from "./repo/rebase-saga.js";
import { RepoReviewComments } from "./repo/review-comments.js";
import { RepoReviews } from "./repo/reviews.js";
import { RepoRulesets, type RuleSuite, type RulesetRecord } from "./repo/rulesets.js";
import { StorageCharges } from "./repo/storage-charges.js";
import {
  type Assignee,
  type MetaInput,
  type MetaPatch,
  type MilestoneQuery,
  RepoSubjectMeta,
  type SubjectMeta,
} from "./repo/subject-meta.js";
import {
  TemplateGeneration,
  type TemplateTree,
  type TemplateWriteInput,
  templateTree,
} from "./repo/template.js";
import type { WriteContext, WriteRefusal } from "./repo/write-context.js";
import { repoSchema } from "./schema/repo.js";

/**
 * Wall-clock budget for one alarm run of background jobs: no new slice
 * starts after it. Proposed. A slice already started may run longer (a
 * maintenance slice up to its policy's `sliceMs`, 20 s), inside the 30 s
 * of CPU an alarm gets (measured on Workers Free, 2026-10-10).
 */
const ALARM_BUDGET_MS = 5_000;
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

  /** The repository's generation from a template, while it is pending. */
  readonly #generation: TemplateGeneration;

  /** Changes only an administrator may make: settings, rulesets, webhooks. */
  readonly #admin: RepoAdministration;

  /** The repository as activity feeds read it. */
  readonly #feedView: RepoFeedView;

  /** The account's storage quota, as pushes charge it. */
  readonly #storageCharges: StorageCharges;

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

  /** The files pull requests' listings found changed, kept for their later pages and listings. */
  readonly changeLists: ChangeLists;

  /** Reviews of pull requests, and reviews requested. */
  readonly reviews: RepoReviews;

  /** Issues, numbered with pull requests. */
  readonly issues: RepoIssues;

  /** Labels and milestones, and what issues and pull requests carry of them and who is assigned. */
  readonly subjectMeta: RepoSubjectMeta;

  /** Reactions to issues, pull requests and their comments. */
  readonly reactions: RepoReactions;

  /** Conversation comments on issues and pull requests. */
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
    this.retireOptions = {
      network: new ClaimReleases({
        network: (networkId) => env.NETWORK.getByName(networkId),
        git: this.git,
        repoId: () => this.#repoId(),
        log: () => this.#log(),
      }),
      forget: (packId) => forgetMerged(this.git, packId),
    };
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
      () => {
        this.pullSource.restored();
        reclaimAfterRestore(this.git);
      },
    );
    this.changeLists = new ChangeLists(this.git);
    this.reactions = new RepoReactions({ git: this.git, events: this.events });
    this.subjectMeta = new RepoSubjectMeta({
      git: this.git,
      events: this.events,
      repoId: () => this.#repoId(),
      kindOf: (number) => this.issues.kindOf(number),
      reactionsOf: (numbers) => this.reactions.countsOf("subject", numbers),
      touch: (kind, number, events, actor) =>
        kind === "issue"
          ? this.issues.touch(number, events, actor)
          : this.pulls.touch(number, events, actor),
    });
    this.pulls = new RepoPulls({
      git: this.git,
      events: this.events,
      repoId: () => this.#repoId(),
      snapshotMeta: (number) => this.subjectMeta.snapshot(number),
      stale: (number, open) => this.mergeability.stale(number, open),
      staleBase: (branch) => this.mergeability.staleBase(branch),
      follow: (pull) => this.#forkPulls.follow(pull),
    });
    this.pullSource = new PullSource({
      git: this.git,
      repoId: () => this.#repoId(),
      tell: (baseRepoId, notice) => this.#forkPulls.tell(baseRepoId, notice),
      log: () => this.#log(),
      epoch: () => this.events.epochGen(),
      members: (after, limit) =>
        networkMembersAfter(this.env, this.#repoId(), after, limit, this.git.context.metrics),
      followAgain: (baseRepoId, after) => this.#forkPulls.askFollowAgain(baseRepoId, after),
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
      resolveHandles: (handles) => this.#feedView.resolveHandles(handles),
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
    this.issues = new RepoIssues({
      git: this.git,
      events: this.events,
      pulls: this.pulls,
      repoId: () => this.#repoId(),
      meta: {
        snapshot: (number) => this.subjectMeta.snapshot(number),
        forget: (number) => this.subjectMeta.forget(number),
        forgetReactions: (number) => this.reactions.forgetSubject(number),
        ofMany: (numbers) => this.subjectMeta.ofMany(numbers),
      },
    });
    this.comments = new RepoComments({
      git: this.git,
      events: this.events,
      issues: this.issues,
      repoId: () => this.#repoId(),
      forgetReactions: (id) => this.reactions.forget("comment", id),
    });
    this.reviewComments = new RepoReviewComments({
      git: this.git,
      events: this.events,
      pulls: this.pulls,
      repoId: () => this.#repoId(),
      forgetReactions: (id) => this.reactions.forget("review_comment", id),
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
    this.#generation = new TemplateGeneration({
      git: this.git,
      env: () => this.env,
      refusesReads: () => this.#refusesReads(),
      hasGitStorage: () => this.#hasGitStorage(),
      checkEpoch: () => this.checkEpoch(),
      writeDeps: () => this.#writeDeps(),
      hooks: () => this.generationHooks,
    });
    this.#storageCharges = new StorageCharges({
      git: this.git,
      env: () => this.env,
      account: () => this.events.account(),
      repoId: () => this.#repoId(),
      log: () => this.#log(),
    });
    this.#authority = new RepoAuthority({
      git: this.git,
      env: () => this.env,
      acl: this.acl,
      rulesets: () => this.rulesetStore,
      memoryBlocks: () => this.#memoryBlocks(),
    });
    this.#admin = new RepoAdministration({
      git: this.git,
      acl: this.acl,
      authority: this.#authority,
      events: this.events,
      rulesets: () => this.rulesetStore,
      details: () => this.details(),
      checkEpoch: () => this.checkEpoch(),
      closed: () => this.#closed,
      writeRefusal: () => this.#writeRefusal(),
      armOutbox: () => this.#armOutbox(),
      ensureAuditArchive: () => this.#ensureAuditArchive(),
    });
    this.#feedView = new RepoFeedView({
      git: this.git,
      env: () => this.env,
      acl: this.acl,
      authority: this.#authority,
      pulls: this.pulls,
      issues: this.issues,
      comments: this.comments,
      reviewComments: this.reviewComments,
      isPublic: () => this.events.visibility() === "public",
      refusesReads: () => this.#refusesReads(),
      isTransferring: () => this.events.isTransferring(),
    });
    this.#discussion = new PullDiscussion({
      git: this.git,
      pulls: this.pulls,
      reviews: this.reviews,
      reviewComments: this.reviewComments,
      reacted: (comments) => this.reactions.attach("review_comment", comments),
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
    /** The labels it starts with (its account's defaults); needs `identity`. */
    labels: readonly LabelSpec[] = [],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isNetworkId(networkId)) return { ok: false, error: "not a network id" };
    try {
      // Before the storage exists, so no write is ever admitted ahead of the generation.
      if (templateId !== undefined) this.#generation.record(templateId);
      recordNetwork(this.ctx.storage, networkId, this.git.context.now());
      if (identity) this.events.assertIdentity(identity);
      this.git.initialize(networkId, defaultBranch);
      if (identity) {
        this.events.init(identity, identity.actor);
        this.subjectMeta.copyLabels(labels, null);
        this.#armOutbox();
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The in-memory pack block tier (16 MiB fixed, design), created on first use. */
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
    return this.#measured("updateSettings", () => this.#admin.updateSettings(input));
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
  changeRuleset(change: RulesetChange, actor: RefActor) {
    return this.#measured("changeRuleset", () => this.#admin.changeRuleset(change, actor));
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
      (prepared) =>
        this.#admin.insecureHookUrl(input.url) ?? this.hooks.create(prepared, input, actor),
    );
  }

  updateHook(
    id: number,
    patch: Parameters<RepoHooks["update"]>[1],
    actor: RefActor,
  ): Promise<Browsed<HookView>> {
    return this.#asHookAdmin(
      "updateHook",
      actor,
      undefined,
      () => this.#admin.insecureHookUrl(patch.url) ?? this.hooks.update(id, patch, actor),
    );
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
    return this.#measured(method, () => this.#admin.asHookAdmin(actor, prepare, change));
  }

  /** The repository's pull requests, newest first, below `before` (a number) when given. */
  listPulls(state: PullRecord["state"] | "all", before: number | undefined, limit: number) {
    return this.#measured("listPulls", () => {
      if (this.#refusesReads()) return null;
      const pulls = this.pulls.list(state, before, limit);
      const metas = this.subjectMeta.ofMany(pulls);
      return pulls.map((p) => this.#viewed(p, metas.get(p.number)));
    });
  }

  /** A pull request with whether it merges, as far as that is known now, and its labels, assignees and milestone. */
  #viewed(
    pull: PullRecord,
    meta: SubjectMeta = this.subjectMeta.ofMany([pull]).get(pull.number) as SubjectMeta,
  ): PullView {
    return { ...pull, ...this.mergeability.view(pull), meta };
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

  /** A page of the files a pull request changes (see `pullFilesListing`). */
  listPullFiles(number: number, from: ListingCursor | null, limit: number) {
    return this.#browse("listPullFiles", async (browse) =>
      this.#refusesReads()
        ? fail(404, "repo_not_found", REPO_DELETED)
        : pullFilesListing(browse, this.pulls, this.git.commitGraph, this.changeLists, {
            number,
            from,
            limit,
          }),
    );
  }

  /** A page of a pull request's commits, oldest first (see `pullCommitsListing`). */
  listPullCommits(number: number, from: ListingCursor | null, limit: number) {
    return this.#browse("listPullCommits", async (browse) =>
      this.#refusesReads()
        ? fail(404, "repo_not_found", REPO_DELETED)
        : pullCommitsListing(browse, this.pulls, this.git.commitGraph, { number, from, limit }),
    );
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
   * An issue's or pull request's comments, oldest first; null when the
   * repository is gone, undefined without that number among `kinds` (the
   * kinds the caller may read).
   */
  listComments(number: number, after: number, limit: number, kinds: readonly SubjectKind[]) {
    return this.#measured("listComments", () => {
      if (this.#refusesReads()) return null;
      const kind = this.issues.kindOf(number);
      if (!kind || !kinds.includes(kind)) return undefined;
      return this.reactions.attach("comment", this.comments.list(number, after, limit));
    });
  }

  /** One comment, on a subject of `kinds`; null when the repository is gone. */
  getComment(id: number, kinds: readonly SubjectKind[]) {
    return this.#measured("getComment", () => {
      if (this.#refusesReads()) return null;
      const kind = this.comments.kindOf(id);
      const comment = kind && kinds.includes(kind) ? this.comments.get(id) : undefined;
      return comment && this.reactions.attach("comment", [comment])[0];
    });
  }

  createComment(number: number, body: string, actor: RefActor, kinds: readonly SubjectKind[]) {
    return this.#pullChange(
      "createComment",
      actor,
      (caller) => this.#reacted(this.comments.create(number, body, caller, kinds)),
      undefined,
      [body],
    );
  }

  editComment(id: number, body: string, actor: RefActor, kinds: readonly SubjectKind[]) {
    return this.#pullChange(
      "editComment",
      actor,
      (caller) => this.#reacted(this.comments.edit(id, body, caller, kinds)),
      undefined,
      [body],
    );
  }

  deleteComment(id: number, actor: RefActor, kinds: readonly SubjectKind[]) {
    return this.#pullChange("deleteComment", actor, (caller) =>
      this.comments.delete(id, caller, kinds),
    );
  }

  /** A comment change's comment as the API answers it, with its reactions counted. */
  #reacted<R extends { ok: true; comment: CommentRecord } | { ok: false }>(result: R) {
    return result.ok
      ? {
          ...result,
          comment: this.reactions.attach("comment", [result.comment])[0] as Reacted<CommentRecord>,
        }
      : (result as Exclude<R, { ok: true }>);
  }

  /** A page of the issues and pull requests of `query.kinds` (see `RepoIssues.list`); null when gone. */
  listSubjects(query: SubjectQuery) {
    return this.#measured("listSubjects", () =>
      this.#refusesReads() ? null : this.issues.list(query),
    );
  }

  /** The issue or pull request numbered `number`, of `kinds`; null when gone, undefined for none. */
  getSubject(number: number, kinds: readonly SubjectKind[]) {
    return this.#measured("getSubject", (): Subject | null | undefined => {
      if (this.#refusesReads()) return null;
      const kind = this.issues.kindOf(number);
      if (!kind || !kinds.includes(kind)) return undefined;
      return this.#subject(number, kind);
    });
  }

  /** The issue or pull request numbered `number`, of kind `kind`, with what it is sorted by. */
  #subject(number: number, kind: SubjectKind): Subject | undefined {
    const meta = this.subjectMeta.of(number);
    if (kind === "issue") {
      const issue = this.issues.get(number);
      return issue && { kind, issue, meta };
    }
    const pull = this.pulls.get(number);
    return pull && { kind, pull, meta };
  }

  /**
   * Opens an issue as the caller, its root identity worked out here, with
   * the labels, assignees and milestone `meta` gives it (triage).
   */
  createIssue(
    input: { readonly title: string; readonly body: string | null },
    actor: RefActor,
    meta: MetaInput = {},
  ) {
    return this.#pullChange(
      "createIssue",
      actor,
      (caller, ceilings) => {
        // An object from before identities has no events to record an issue with.
        if (!this.events.hasIdentity())
          return { ok: false as const, code: "repo_not_ready" as const };
        const planned = hasMeta(meta)
          ? this.subjectMeta.planNew(this.#metaPatch(meta, ceilings), caller)
          : undefined;
        if (planned && !planned.ok) return planned;
        const record = this.issues.open(input, caller, planned?.plan);
        return {
          ok: true as const,
          subject: {
            kind: "issue" as const,
            issue: record,
            meta: this.subjectMeta.of(record.number),
          },
        };
      },
      () => this.#assigneeCeilings(meta),
      [input.body],
    );
  }

  /**
   * Changes an issue as the matrix allows (see `RepoIssues.change`), with
   * its labels, assignees and milestone (`meta`), all of it or nothing;
   * `readable`: the kinds a duplicate may be. A pull request's number (of
   * `kinds`) takes only `meta`: its title, body and state change through
   * `changePull`.
   */
  changeIssue(
    number: number,
    patch: IssuePatch,
    actor: RefActor,
    readable: readonly SubjectKind[],
    kinds: readonly SubjectKind[] = ["issue"],
    meta: MetaInput = {},
  ) {
    return this.#pullChange(
      "changeIssue",
      actor,
      (caller, ceilings) => {
        const kind = this.issues.kindOf(number);
        if (!kind || !kinds.includes(kind))
          return { ok: false as const, code: "not_found" as const };
        const planned = hasMeta(meta)
          ? this.subjectMeta.plan(number, this.#metaPatch(meta, ceilings), caller, kinds)
          : undefined;
        if (planned && !planned.ok) return planned;
        if (kind === "pull") {
          if (Object.keys(patch).length > 0)
            return { ok: false as const, code: "pull_request_fields" as const };
          if (planned?.plan.changes)
            this.git.context.storage.transactionSync(() => planned.plan.apply(true));
        } else {
          const changed = this.issues.change(number, patch, caller, readable, planned?.plan);
          if (!changed.ok) return changed;
        }
        return { ok: true as const, subject: this.#subject(number, kind) as Subject };
      },
      () => this.#assigneeCeilings(meta),
      [patch.body],
    );
  }

  /** An issue's or pull request's labels (of `kinds`); null when gone, undefined for none. */
  subjectLabels(number: number, kinds: readonly SubjectKind[]) {
    return this.#measured("subjectLabels", () => {
      if (this.#refusesReads()) return null;
      const kind = this.issues.kindOf(number);
      if (!kind || !kinds.includes(kind)) return undefined;
      return this.subjectMeta.of(number, false).labels;
    });
  }

  /** Changes an issue's or pull request's labels or assignees (of `kinds`; triage). */
  changeSubjectMeta(
    number: number,
    meta: MetaInput,
    actor: RefActor,
    kinds: readonly SubjectKind[],
  ) {
    return this.#pullChange(
      "changeSubjectMeta",
      actor,
      (caller, ceilings) => {
        const planned = this.subjectMeta.plan(
          number,
          this.#metaPatch(meta, ceilings),
          caller,
          kinds,
        );
        if (!planned.ok) return planned;
        if (planned.plan.changes)
          this.git.context.storage.transactionSync(() => planned.plan.apply(true));
        return {
          ok: true as const,
          subject: this.#subject(number, planned.plan.kind) as Subject,
        };
      },
      () => this.#assigneeCeilings(meta),
    );
  }

  /** A page of a target's reactions (of a conversation of `kinds`); null when gone, undefined for none. */
  listReactions(
    target: ReactionTarget,
    targetId: number,
    content: ReactionContent | null,
    after: number,
    limit: number,
    kinds: readonly SubjectKind[],
  ) {
    return this.#measured("listReactions", () => {
      if (this.#refusesReads()) return null;
      const on = this.#reactionSubject(target, targetId, kinds);
      return on && this.reactions.list(target, targetId, content, after, limit);
    });
  }

  /** Reacts to a target (of a conversation of `kinds`) as the caller (see `RepoReactions.react`). */
  createReaction(
    target: ReactionTarget,
    targetId: number,
    content: ReactionContent,
    actor: RefActor,
    kinds: readonly SubjectKind[],
  ) {
    return this.#pullChange("createReaction", actor, (caller) => {
      const on = this.#reactionSubject(target, targetId, kinds);
      if (!on) return { ok: false as const, code: "not_found" as const };
      return this.#withIdentity(() => this.reactions.react(on, content, caller));
    });
  }

  /** Takes the caller's reaction `id` to a target back (see `RepoReactions.delete`). */
  deleteReaction(
    target: ReactionTarget,
    targetId: number,
    id: number,
    actor: RefActor,
    kinds: readonly SubjectKind[],
  ) {
    return this.#pullChange("deleteReaction", actor, (caller) => {
      const on = this.#reactionSubject(target, targetId, kinds);
      if (!on) return { ok: false as const, code: "not_found" as const };
      return this.reactions.delete(on, id, caller);
    });
  }

  /**
   * What a reaction to `targetId` is on, when it exists and its
   * conversation is of `kinds` (a diff comment's is a pull request's):
   * its number and whether it is locked.
   */
  #reactionSubject(
    target: ReactionTarget,
    targetId: number,
    kinds: readonly SubjectKind[],
  ): ReactionSubject | undefined {
    const number =
      target === "subject"
        ? targetId
        : target === "comment"
          ? this.comments.get(targetId)?.number
          : this.reviewComments.get(targetId)?.number;
    const conversation = number === undefined ? undefined : this.issues.conversation(number);
    if (!conversation || number === undefined || !kinds.includes(conversation.kind))
      return undefined;
    if (target === "review_comment" && conversation.kind !== "pull") return undefined;
    return { target, targetId, number, locked: conversation.locked };
  }

  /** A page of the repository's labels by name, after `after`; null when gone. */
  listLabels(after: string | null, limit: number) {
    return this.#measured("listLabels", () =>
      this.#refusesReads() ? null : this.subjectMeta.labels(after, limit),
    );
  }

  /** The label named `name` (ignoring case); null when gone, undefined for none. */
  getLabel(name: string) {
    return this.#measured("getLabel", () =>
      this.#refusesReads() ? null : this.subjectMeta.label(name),
    );
  }

  /** Creates a label (write). */
  createLabel(spec: LabelSpec, actor: RefActor) {
    return this.#pullChange("createLabel", actor, (caller) =>
      this.#withIdentity(() => this.subjectMeta.createLabel(spec, caller)),
    );
  }

  /** Changes a label (write). */
  updateLabel(
    name: string,
    patch: {
      readonly name?: string;
      readonly color?: string;
      readonly description?: string | null;
    },
    actor: RefActor,
  ) {
    return this.#pullChange("updateLabel", actor, (caller) =>
      this.#withIdentity(() => this.subjectMeta.updateLabel(name, patch, caller)),
    );
  }

  /** Deletes a label (write). */
  deleteLabel(name: string, actor: RefActor) {
    return this.#pullChange("deleteLabel", actor, (caller) =>
      this.#withIdentity(() => this.subjectMeta.deleteLabel(name, caller)),
    );
  }

  /** Copies labels in (an account's defaults; write): names already here are kept. */
  copyLabels(specs: readonly LabelSpec[], actor: RefActor) {
    return this.#pullChange("copyLabels", actor, (caller) =>
      this.#withIdentity(() =>
        decideMetadataAction("manage_labels", caller.role).ok
          ? { ok: true as const, labels: this.subjectMeta.copyLabels(specs, caller.actor) }
          : { ok: false as const, code: "forbidden" as const },
      ),
    );
  }

  /** A page of the repository's milestones (see `RepoSubjectMeta.milestones`); null when gone. */
  listMilestones(query: MilestoneQuery) {
    return this.#measured("listMilestones", () =>
      this.#refusesReads() ? null : this.subjectMeta.milestones(query),
    );
  }

  /** One milestone; null when gone, undefined for none. */
  getMilestone(number: number) {
    return this.#measured("getMilestone", () =>
      this.#refusesReads() ? null : this.subjectMeta.milestone(number),
    );
  }

  /** Creates a milestone (write). */
  createMilestone(input: Parameters<RepoSubjectMeta["createMilestone"]>[0], actor: RefActor) {
    return this.#pullChange("createMilestone", actor, (caller) =>
      this.#withIdentity(() => this.subjectMeta.createMilestone(input, caller)),
    );
  }

  /** Changes a milestone (write). */
  updateMilestone(
    number: number,
    patch: Parameters<RepoSubjectMeta["updateMilestone"]>[1],
    actor: RefActor,
  ) {
    return this.#pullChange("updateMilestone", actor, (caller) =>
      this.#withIdentity(() => this.subjectMeta.updateMilestone(number, patch, caller)),
    );
  }

  /** Deletes a milestone (write). */
  deleteMilestone(number: number, actor: RefActor) {
    return this.#pullChange("deleteMilestone", actor, (caller) =>
      this.#withIdentity(() => this.subjectMeta.deleteMilestone(number, caller)),
    );
  }

  /** A change that records events, refused for an object from before identities (it has none to record them with). */
  #withIdentity<R>(change: () => R): R | { ok: false; code: "repo_not_ready" } {
    return this.events.hasIdentity() ? change() : { ok: false, code: "repo_not_ready" };
  }

  /** Before a change: the ceilings of the principals it assigns (an agent is capped by its owners). */
  async #assigneeCeilings(meta: MetaInput): Promise<Map<string, string[]>> {
    const ceilings = new Map<string, string[]>();
    const op = meta.assignees;
    if (!op || "remove" in op) return ceilings;
    for (const id of new Set("add" in op ? op.add : op.set))
      ceilings.set(id, await this.#authority.rolesPulled(id, null));
    return ceilings;
  }

  /** In the change: what `meta` asks, each assignee with its root identity and role now. */
  #metaPatch(meta: MetaInput, ceilings: ReadonlyMap<string, readonly string[]>): MetaPatch {
    const op = meta.assignees;
    const assignee = (id: string): Assignee => {
      const owners = [...(ceilings.get(id) ?? [])];
      return {
        id,
        root: rootIdentity({ principalId: id, grantId: null, ceilingIds: owners }),
        role: this.#authority.roleNow(id, owners),
      };
    };
    return {
      ...(meta.labels && { labels: meta.labels }),
      ...(op && {
        assignees:
          "remove" in op
            ? { remove: op.remove }
            : "add" in op
              ? { add: op.add.map(assignee) }
              : { set: op.set.map(assignee) },
      }),
      ...(meta.milestone !== undefined && { milestone: meta.milestone }),
    };
  }

  /** Locks or unlocks an issue's or pull request's conversation, of `kinds`. */
  setConversationLock(
    number: number,
    lock: { readonly locked: boolean; readonly reason: LockReason | null },
    actor: RefActor,
    kinds: readonly SubjectKind[],
  ) {
    return this.#pullChange("setConversationLock", actor, (caller) =>
      this.issues.setLock(number, lock, caller, kinds),
    );
  }

  /** Deletes an issue for good (admin). */
  deleteIssue(number: number, actor: RefActor) {
    return this.#pullChange("deleteIssue", actor, (caller) => this.issues.delete(number, caller));
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
      await this.changeHooks.beforeChange?.(method);
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
      if (this.#generation.templateId() !== undefined && !this.events.isTransferring())
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
    const template = await this.#generation.template();
    if (!template.ok) return template;
    return this.#measured("generateFrom", () => this.#generation.write(input, template.value));
  }

  /**
   * Settles a generation its request could not confirm (see
   * `TemplateGeneration.abandon`).
   */
  abandonGeneration(): Promise<"committed" | "abandoned" | "none"> {
    return this.#measured("abandonGeneration", async () => this.#generation.abandon());
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
   * Options of the pack retire job (retention, deletion fence, the fork
   * network, which packs it shares are released to, and the view
   * compaction's merges into a pack, forgotten with its row). Tests may
   * replace them.
   */
  retireOptions: PackRetireOptions;
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
    this.#pushes.frozen = () => this.events.frozen() ?? this.#generation.abandoned();
    this.#pushes.rules = this.#authority.pushRules();
    this.#pushes.storage = this.#storageCharges.quota();
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

  /** The time an import's fetch is watched by (how slow its source may be). Tests may replace it. */
  importClock: WatchClock = systemClock;

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
      () => this.importClock,
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

  /** Committed uploads the account has not been told of yet. */
  owedStorage(): { uploadId: string; bytes: number }[] {
    return this.#storageCharges.owed();
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

  #jobHandlers() {
    return {
      storage_confirm: this.#storageCharges.confirmHandler(),
      mergeability: this.mergeability.handler(),
      merge_saga: this.rebases.handler("alarm"),
      pull_notices: this.pullSource.noticesHandler(),
      revision_import: this.pullImports.handler(),
      pull_follow: this.#forkPulls.followHandler(),
      pull_refollow: this.pullSource.refollowHandler(),
      network_reclaim: networkReclaimHandler({
        git: this.git,
        network: (networkId) => this.env.NETWORK.getByName(networkId),
        repoId: () => this.#repoId(),
        log: () => this.#log(),
      }),
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

  /**
   * Hooks into a change of pull requests, issues or comments: after what it
   * prepared (and awaited), right before its checks and write. For tests.
   */
  changeHooks: { beforeChange?: (method: string) => Promise<void> } = {};

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
   * For a reader of an activity feed: whether `principal` reads the
   * repository now, its role, and the excerpts of `members` (see
   * `RepoFeedView.view`).
   */
  feedView(
    principal: string,
    grantId: string | null,
    members: readonly string[],
    threads: readonly string[] = [],
  ): Promise<FeedViewAnswer> {
    return this.#measured("feedView", () =>
      this.#feedView.view(principal, grantId, members, threads),
    );
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

  /** A new fork's storage: its network, HEAD and borrowed packs, and the labels it starts with (its account's defaults; needs `identity`). */
  initFork(
    input: { networkId: string; head: string | null; packs: readonly ViewPack[] },
    identity?: RepoIdentity & { readonly actor: string | null },
    labels: readonly LabelSpec[] = [],
  ): void {
    if (identity) this.events.assertIdentity(identity);
    if (isNetworkId(input.networkId))
      recordNetwork(this.ctx.storage, input.networkId, this.git.context.now());
    this.#network().initFork(input);
    if (identity) {
      this.events.init(identity, identity.actor);
      this.subjectMeta.copyLabels(labels, null);
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
    await this.events.checkEpoch((recorded) =>
      readDirectoryEpoch(this.env, this.git.context.metrics, this.#repoId(), recorded),
    );
    // A new epoch's snapshot goes out even if nothing else is written.
    this.#armOutbox();
  }

  /** The repository's current snapshot for a read-model rebuild (null without an identity). */
  exportSnapshot(): RepoExport | null {
    return this.events.exportSnapshot();
  }

  /** The tombstone the deletion puts into the read model (null without an identity). */
  deletionTombstone(): RepoExport | "not_frozen" | null {
    return this.events.deletionTombstone();
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
    if (this.#generation.templateId() !== undefined)
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

  /**
   * The registry rows of packs under `networkId` (the network collection's
   * snapshot), which it claims at `claimSeq`.
   */
  networkSnapshot(networkId: string, claimSeq: number): MemberPack[] {
    // An erased object restarted with empty storage holds nothing: it says
    // so by failing, and the network checks the directory.
    if (!this.#hasGitStorage()) throw new Error("git storage is not initialized");
    return this.#network().networkSnapshot(networkId, claimSeq);
  }

  /**
   * Acknowledges shared packs the network condemns (no new leases), with
   * when leases on them end; refuses for packs its view holds, which the
   * network then claims again at `claim.seq`.
   */
  condemnShared(
    packIds: readonly string[],
    claim: { readonly networkId: string; readonly seq: number },
  ): CondemnAnswer {
    return this.#network().condemnShared(packIds, claim);
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

/** Whether a change asks anything of labels, assignees or the milestone. */
function hasMeta(meta: MetaInput): boolean {
  return meta.labels !== undefined || meta.assignees !== undefined || meta.milestone !== undefined;
}
