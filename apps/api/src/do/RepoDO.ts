import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import {
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
  measureInvocation,
  type RequestMeta,
} from "@fyrden/adapters-cloudflare/obs";
import type { Envelope, RepoRole } from "@fyrden/domain";
import type { BlockCache, LsRefsArgs } from "@fyrden/git-core";
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
import type { CompactSliceInput } from "../network/view-cap.js";
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
import {
  type Browsed,
  type CommitView,
  type CompareView,
  type LogInput,
  type LogView,
  type RefView,
  RepoBrowse,
  type TagPage,
} from "./repo/browse.js";
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
  REPO_DELETED,
  RepoEvents,
  type RepoExport,
  type RepoIdentity,
  type RepoUpdate,
} from "./repo/events.js";
import { repoSchema } from "./schema/repo.js";

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

  /** Pulls the account's ACL snapshot for this repository. Tests may replace it. */
  pullAcl: (accountId: string) => Promise<AclSnapshot>;

  /** Where audit records are archived. Tests may replace it. */
  auditBucket: Pick<R2Bucket, "put">;

  /** Events waiting to be sent; drained by the alarm. */
  readonly outbox: Outbox;

  /** The repository's events and audit rows, written with each change. */
  readonly events: RepoEvents;

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
    // repository's own, such as maintenance). A refusal refuses the commit.
    this.git.refStore.authorizeCommit = (context) => {
      const principal = context.request.actor?.principal;
      return principal && !this.acl.allows(principal, "write") ? ACCESS_LOST : undefined;
    };
    this.git.refStore.inCommit = (context) => this.events.onCommit(context);
    this.git.refStore.onHeadChanged = () => this.events.onHeadChanged();
    // Every commit (push, import, merge) schedules the maintenance it calls
    // for and records the repository's pack count and storage.
    this.git.refStore.afterCommit = ({ nonFastForward }) => {
      scheduleAfterCommit(this.git, this.maintenance, nonFastForward);
      this.#recordStorage();
      this.#armOutbox();
      this.#ensureAuditArchive();
    };
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
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isNetworkId(networkId)) return { ok: false, error: "not a network id" };
    try {
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
   */
  roleOf(principalId: string, purpose: AclPurpose): Promise<RepoRole | null> {
    return this.#measured("roleOf", () => this.acl.roleOf(principalId, purpose));
  }

  /** The account committed ACL `(epochGen, version)`: an older snapshot is not used again. */
  invalidateAcl(epochGen: number, version: number): void {
    this.acl.invalidate(epochGen, version);
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
    | { ok: false; code: "branch_not_found" | "repo_deleted" | "access_lost" }
  > {
    return this.#measured("updateSettings", async () => {
      await this.checkEpoch();
      // The actor administers the repository now: the Worker checked it
      // before this call; access may have been revoked since. Pulled for a
      // write, then checked with no await before the change.
      const principal = input.actor?.principal;
      if (principal) await this.acl.roleOf(principal, "write");
      // Its deletion started after the caller found it.
      if (this.events.isDeleted()) return { ok: false as const, code: "repo_deleted" as const };
      if (principal && !this.acl.allows(principal, "admin")) {
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
    return this.#pushes;
  }

  /** Opens a push: the upload and its pack rows, before any byte is stored. Returns the body's R2 key. */
  beginPush(input: BeginPushInput): BeginPushResult {
    if (this.#refusesAdmission()) return { ok: false, error: REPO_DELETED };
    return this.#push().begin(input);
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
    return this.#measured("beginChunked", () =>
      this.#refusesAdmission()
        ? ({ ok: false, status: 404, code: "repo_not_found", error: REPO_DELETED } as const)
        : this.#chunked().begin(input),
    );
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
      this.#refusesAdmission()
        ? { ok: false as const, code: "repo_not_found", error: REPO_DELETED }
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

  /** Sends due events; a failure backs off and never fails the alarm or stops the jobs. */
  async #drainOutbox(): Promise<void> {
    try {
      const due = this.outbox.dueAt();
      if (due === null || due > this.git.context.now()) return;
      const result = await this.outbox.drain(this.#repoId());
      if (!result.ok) this.#log().warn("sending events failed", { error: result.error });
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
      reflog_prune: reflogPruneHandler(
        this.git.context,
        REFLOG_PRUNE_BATCH,
        this.maintenance.reflogRetentionMs,
      ),
      detach: this.#network().detachHandler(),
      index: this.#push().indexHandler(),
      compact: packCapCompactionHandler(this.git, () => this.packCap, this.#log()),
      import: this.#imports().handler(),
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

  /** Sets a new fork's refs, once its commit graph is complete. */
  async finishFork(refs: readonly ExportedRef[]): Promise<void> {
    await this.checkEpoch();
    this.#network().finishFork(refs);
  }

  /**
   * Takes the directory's epoch for this repository if it is newer than the
   * recorded one (after a restore). Runs before this instance's first
   * commit; a restore runbook calls it to take the new epoch at once.
   */
  async checkEpoch(): Promise<void> {
    await this.events.checkEpoch(async () => {
      this.git.context.metrics.count("d1.query", { db: "directory", op: "epoch_read" });
      const row = await this.env.DIRECTORY.withSession("first-primary")
        .prepare("SELECT epoch_gen FROM source_epochs WHERE source_id = ?")
        .bind(this.#repoId())
        .first<{ epoch_gen: number }>();
      return row?.epoch_gen ?? null;
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
    actor: string | null,
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

  /** No new upload or import: the repository is being deleted, or its storage is gone (erased). */
  #refusesAdmission(): boolean {
    // Storage first: once erased, its tables are gone.
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
