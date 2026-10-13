// Port types the adapters take and return, for callers that do not depend on git-core.
export type { Oid, PackId, RefUpdate } from "@fyrden/git-core";
export { FetchObjectStore } from "./fetch-objects.js";
export {
  DEFAULT_JOB_POLICY,
  type Job,
  type JobHandler,
  type JobKind,
  type JobPolicy,
  JobQueue,
  type RunJobState,
  type SliceResult,
} from "./jobs.js";
export {
  assertNetworkId,
  fetchObjectKey,
  fetchObjectPrefix,
  isFetchCacheKey,
  isNetworkId,
  isUlid,
  newPackId,
  packObjectKey,
  packPrefix,
  scratchPrefix,
} from "./keys.js";
export { type LeaseGrant, type LeaseKind, PackLeases } from "./leases.js";
export {
  type AcquireOptions,
  LOCK_MAINTENANCE,
  LOCK_REF_COMMIT,
  type LockHandle,
  RepoLocks,
} from "./locks.js";
export { type PackSwap, type PackSwapResult, swapPacks } from "./maintenance-swap.js";
export {
  createDoMemoryBudget,
  DO_MEMORY,
  type DoMemoryBudget,
  type MemoryBudgetStats,
  MemoryWaitTimeoutError,
  withReservation,
} from "./memory-budget.js";
export { type PackKind, PackRegistry, type PackRow, type PackState } from "./pack-registry.js";
export {
  type DeletionFence,
  type NetworkPackRef,
  type NetworkRetire,
  PACK_RETIRE_DEFAULTS,
  type PackRetireOptions,
  packR2Keys,
  packRetireHandler,
  RETIRE_JOB_ID,
  schedulePackRetire,
} from "./pack-retire.js";
export { DEFAULT_PART_BYTES, type NewPackUnit, R2PackStore } from "./r2-pack-store.js";
export {
  ORPHAN_REAPER_DEFAULTS,
  ORPHAN_REAPER_JOB_ID,
  type OrphanReaperOptions,
  orphanReaperHandler,
  type PackPrefixSweep,
  scheduleOrphanReaper,
  sweepPackPrefix,
} from "./reaper.js";
export {
  enqueueReflogPrune,
  REFLOG_PRUNE_BATCH,
  REFLOG_PRUNE_JOB_ID,
  REFLOG_PRUNE_MIN_DELAY_MS,
  REFLOG_RETENTION_MS,
  reflogPruneHandler,
  scheduleReflogPrune,
} from "./reflog-prune.js";
export { RepoGitStorage, type RepoGitStorageOptions } from "./repo-git-storage.js";
export { type PackUploadState, ResumablePackUpload } from "./resumable-pack-upload.js";
export { GIT_STORAGE_TABLES_V1 } from "./schema.js";
export type { GitSqlStorage, GitStorageContext } from "./sql.js";
export { promotePendingCommits, SqliteCommitGraph } from "./sqlite-commit-graph.js";
export {
  type CommitContext,
  type RefActor,
  type RepoCommitRequest,
  type RepoCommitResult,
  SqliteRefStore,
} from "./sqlite-ref-store.js";
export {
  REPO_STORAGE_GROUPS,
  type RepoStorageGroup,
  recordRepoStorage,
  repoStorage,
} from "./storage-metrics.js";
export {
  type BeginUpload,
  type BegunUpload,
  indexJobId,
  UPLOAD_TTL_MS,
  type UploadRecord,
  UploadRegistry,
  type UploadState,
} from "./uploads.js";
