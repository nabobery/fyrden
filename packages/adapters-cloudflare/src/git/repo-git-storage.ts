import type { Metrics } from "../obs/metrics.js";
import { FetchObjectStore } from "./fetch-objects.js";
import { DEFAULT_JOB_POLICY, type JobPolicy, JobQueue } from "./jobs.js";
import { assertNetworkId } from "./keys.js";
import { PackLeases } from "./leases.js";
import { RepoLocks } from "./locks.js";
import { createDoMemoryBudget, DO_MEMORY, type DoMemoryBudget } from "./memory-budget.js";
import { PackIndexCache } from "./pack-index-cache.js";
import { PackRegistry } from "./pack-registry.js";
import { PACK_RETIRE_DEFAULTS, schedulePackRetire } from "./pack-retire.js";
import { R2PackStore } from "./r2-pack-store.js";
import { scheduleOrphanReaper } from "./reaper.js";
import {
  countRowsWritten,
  first,
  type GitSqlStorage,
  type GitStorageContext,
  noMetrics,
  run,
} from "./sql.js";
import { SqliteCommitGraph } from "./sqlite-commit-graph.js";
import { SqliteRefStore } from "./sqlite-ref-store.js";
import { UploadRegistry } from "./uploads.js";

export interface RepoGitStorageOptions {
  /** The object's storage, with the git storage tables migrated. */
  readonly storage: GitSqlStorage;
  readonly bucket: R2Bucket;
  /** The bucket's name, for cost counters. Default `fyrden-git`. */
  readonly bucketName?: string;
  readonly metrics?: Metrics;
  /** The Durable Object class, for cost counters. Default `RepoDO`. */
  readonly doClass?: string;
  readonly now?: () => number;
  /** Arms the object's alarm for the job queue. */
  readonly setAlarm?: (at: number) => void;
  /** The operation memory pool. Default: a new 72 MiB pool. */
  readonly memory?: DoMemoryBudget;
  readonly partBytes?: number;
  readonly jobPolicy?: JobPolicy;
}

/**
 * The git storage of one repository Durable Object, wired together: refs,
 * the pack registry, packs in R2, the commit graph, uploads, leases, locks,
 * jobs, the memory pool and the pack index cache. Construction does no I/O.
 */
export class RepoGitStorage {
  readonly context: GitStorageContext;
  readonly registry: PackRegistry;
  readonly refStore: SqliteRefStore;
  readonly packStore: R2PackStore;
  readonly commitGraph: SqliteCommitGraph;
  readonly leases: PackLeases;
  readonly uploads: UploadRegistry;
  readonly locks: RepoLocks;
  readonly jobs: JobQueue;
  readonly memory: DoMemoryBudget;
  /** The packs' `.idx` data kept in memory across requests. */
  readonly packIndexes = new PackIndexCache();
  /** Regenerated packs and framed copies that fetch plans write. */
  readonly fetchObjects: FetchObjectStore;
  /** The git bucket (pack and index objects). */
  readonly bucket: R2Bucket;

  constructor(options: RepoGitStorageOptions) {
    this.context = {
      storage: options.storage,
      now: options.now ?? (() => Date.now()),
      metrics: options.metrics ?? noMetrics,
      doClass: options.doClass ?? "RepoDO",
    };
    this.bucket = options.bucket;
    this.registry = new PackRegistry(this.context);
    this.refStore = new SqliteRefStore(this.context, this.registry);
    this.packStore = new R2PackStore(this.context, {
      bucket: options.bucket,
      bucketName: options.bucketName ?? "fyrden-git",
      registry: this.registry,
      networkId: () => this.networkId(),
      ...(options.partBytes === undefined ? {} : { partBytes: options.partBytes }),
    });
    // A materialised fetch object expires after its last lease: the retire job deletes it.
    this.fetchObjects = new FetchObjectStore(
      this.context,
      this.packStore,
      () => this.networkId(),
      () =>
        schedulePackRetire(this.jobs, this.context.now() + PACK_RETIRE_DEFAULTS.fetchObjectTtlMs),
    );
    this.commitGraph = new SqliteCommitGraph(this.context);
    this.leases = new PackLeases(this.context);
    // Every upload gets a reaper pass at its expiry, in case it never commits.
    this.uploads = new UploadRegistry(this.context, this.registry, this.leases, (upload) =>
      scheduleOrphanReaper(this.jobs, upload.expiresAt),
    );
    this.locks = new RepoLocks(this.context);
    this.jobs = new JobQueue(
      this.context,
      options.setAlarm ?? (() => {}),
      options.jobPolicy ?? DEFAULT_JOB_POLICY,
    );
    this.memory = options.memory ?? createDoMemoryBudget(DO_MEMORY.operationPoolBytes);
  }

  /**
   * Records the repository's network and points HEAD at the default branch.
   * Called once when the repository is created; calling it again changes
   * the network (as fork detach does) and leaves HEAD alone.
   */
  initialize(networkId: string, defaultBranch = "refs/heads/main"): void {
    assertNetworkId(networkId);
    const { storage } = this.context;
    const written = storage.transactionSync(() => {
      const existed = first(storage, "SELECT 1 AS one FROM git_meta WHERE id = 1") !== undefined;
      const rows = run(
        storage,
        `INSERT INTO git_meta (id, network_id, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET network_id = excluded.network_id,
           updated_at = excluded.updated_at`,
        networkId,
        this.context.now(),
      );
      if (!existed) this.refStore.setHead(defaultBranch);
      return rows;
    });
    countRowsWritten(this.context, "git.initialize", written);
  }

  /** The repository's network id. Throws until `initialize` has run. */
  networkId(): string {
    const row = first<{ network_id: string }>(
      this.context.storage,
      "SELECT network_id FROM git_meta WHERE id = 1",
    );
    if (!row) throw new Error("git storage is not initialized");
    return row.network_id;
  }
}
