import type { getSearchStatus, Input, Output } from "@fyrden/api-contract";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import type { OpContext } from "../ops/execute.js";
import { REPO_INDEX } from "../queues/events-consumer.js";
import { READ_MODEL_PROTOCOL } from "../read-model/executor.js";
import { exportAvailability } from "../read-model/export.js";
import { readModelState } from "../read-model/maintenance.js";
import { recoveryState } from "../read-model/recovery.js";
import { restoreTokenState } from "../read-model/restore-token.js";
import { ADMISSION } from "./admission.js";
import { searchIndexing } from "./repairs.js";

/** Search's rows the status reads besides its singletons, each through an index. */
export const STATUS_QUERIES = {
  /** The reconciliation due next (the due index). */
  nextDue: `SELECT since FROM search_repairs WHERE dirty > covered AND blocked_reason IS NULL
    ORDER BY next_at, repo_id LIMIT 1`,
  /** The parked one whose wait ends first (the retry index). */
  nextParked: `SELECT repo_id, blocked_reason, retry_at FROM search_repairs
    WHERE dirty > covered AND blocked_reason IS NOT NULL ORDER BY retry_at, repo_id LIMIT 1`,
  /** A source not known whole (the index of those). */
  firstUncovered: `SELECT repo_id FROM search_sources WHERE index_covered = 0
    ORDER BY repo_id LIMIT 1`,
  /** A source hidden since a recovery (the index of sources by generation). */
  firstHidden: `SELECT repo_id FROM search_sources
    WHERE visible_gen < (SELECT recovery_gen FROM search_index_state WHERE id = 1)
    ORDER BY visible_gen, repo_id LIMIT 1`,
  /** The purge next (the index of purges by generation). */
  nextPurge: "SELECT repo_id FROM search_purges ORDER BY recovery_gen, repo_id LIMIT 1",
};

/**
 * The `admin.search.status` operation (instance administrators): the read
 * model's write protocol, barriers, admission and leases, and search's
 * allowance (with its limits), size, indexes' counts and room, waiting and
 * parked reconciliations, and a source not known whole. Singleton rows and
 * one row each through an index (the shard's leases besides): what it
 * reads stays the same whatever the database holds. A missing protocol row
 * reads as null and the barriers as not consistent, never as a healthy
 * zero.
 */
export async function getSearchStatusOperation(
  ctx: OpContext,
  _input: Input<typeof getSearchStatus>,
): Promise<Output<typeof getSearchStatus>> {
  const { env, metrics } = ctx;
  metrics.count("d1.query", { db: "directory", op: "search_indexing" });
  const indexing = await searchIndexing(env);
  metrics.count("d1.query", { db: "directory", op: "read_model_status" }, 2);
  metrics.count("d1.query", { db: "org", op: "read_model_status" }, 2);
  const state = await readModelState(env, DEFAULT_ORG_SHARD);
  metrics.count("d1.query", { db: "directory", op: "read_model_token" });
  metrics.count("d1.query", { db: "org", op: "read_model_token" });
  const token = await restoreTokenState(env, DEFAULT_ORG_SHARD);
  const db = readModelFor(env, DEFAULT_ORG_SHARD);
  metrics.count("d1.query", { db: "org", op: "search_status" });
  metrics.count("d1.query", { db: "directory", op: "read_model_recovery" });
  const recovery = await recoveryState(env, DEFAULT_ORG_SHARD);
  const [budget, size, counts, repair, parked, uncovered, hidden, purge] = await db.batch([
    db.prepare(
      `SELECT CAST(unixepoch() / 86400 AS INTEGER) AS day, coalesce(b.rows, 0) AS rows,
         coalesce(b.reads, 0) AS reads, coalesce(b.repo_rows, 0) AS repo_rows
       FROM (SELECT 1) LEFT JOIN search_budget b ON b.day = CAST(unixepoch() / 86400 AS INTEGER)`,
    ),
    db.prepare("SELECT bytes, bytes_reserved, observed FROM search_size WHERE id = 1"),
    db.prepare(
      "SELECT live_docs, indexed_repos, recovery_gen FROM search_index_state WHERE id = 1",
    ),
    db.prepare(STATUS_QUERIES.nextDue),
    db.prepare(STATUS_QUERIES.nextParked),
    db.prepare(STATUS_QUERIES.firstUncovered),
    db.prepare(STATUS_QUERIES.firstHidden),
    db.prepare(STATUS_QUERIES.nextPurge),
  ]);
  const today = budget?.results[0] as {
    day: number;
    rows: number;
    reads: number;
    repo_rows: number;
  };
  const observed = size?.results[0] as
    | { bytes: number; bytes_reserved: number; observed: number }
    | undefined;
  const indexes = counts?.results[0] as
    | { live_docs: number; indexed_repos: number; recovery_gen: number }
    | undefined;
  const next = repair?.results[0] as { since: number } | undefined;
  const waiting = parked?.results[0] as
    | { repo_id: string; blocked_reason: string; retry_at: number }
    | undefined;
  const whole = uncovered?.results[0] as { repo_id: string } | undefined;
  const { directory, local, admission, writers } = state;
  return {
    indexing,
    protocol: {
      serving_version: READ_MODEL_PROTOCOL,
      deployed_version: directory?.executorVersion ?? null,
      required_version: local?.protocolVersion ?? null,
      // Refused from protocol 2 on (org migration 0018); only counted before.
      mode: (local?.protocolVersion ?? 0) >= 2 ? "enforced" : "compatibility",
      restore_floor: directory?.floor ?? null,
      restore_token: token,
    },
    barrier: {
      directory_phase: directory?.phase ?? null,
      directory_generation: directory?.generation ?? null,
      org_phase: local?.phase ?? null,
      org_generation: local?.generation ?? null,
      consistent:
        directory !== null &&
        local !== null &&
        directory.phase === local.phase &&
        directory.generation === local.generation,
    },
    admission: {
      open: admission?.open ?? null,
      stray: admission?.stray ?? null,
      sequence: admission?.sequence ?? null,
    },
    writers: {
      live: writers.live,
      expired: writers.expired,
      earliest_deadline: writers.earliest,
    },
    export: exportAvailability(directory?.floor ?? null),
    recovery: recovery
      ? { recovery_id: recovery.recoveryId, generation: recovery.generation, stage: recovery.stage }
      : null,
    search: {
      day: today.day,
      rows: today.rows,
      reads: today.reads,
      repo_rows: today.repo_rows,
      bytes: observed?.bytes ?? 0,
      bytes_reserved: observed?.bytes_reserved ?? 0,
      observed_sequence: observed?.observed ?? 0,
      live_docs: indexes?.live_docs ?? 0,
      indexed_repos: indexes?.indexed_repos ?? 0,
      limits: {
        daily_rows: ADMISSION.dailyRows,
        daily_reads: ADMISSION.dailyReads,
        max_bytes: ADMISSION.maxBytes,
        repository_daily_rows: ADMISSION.repoDailyRows,
        repository_capacity: REPO_INDEX.capacity,
      },
      repair_pending: next !== undefined,
      next_repair_since: next?.since ?? null,
      next_parked: waiting
        ? { repo_id: waiting.repo_id, reason: waiting.blocked_reason, retry_at: waiting.retry_at }
        : null,
      first_uncovered: whole?.repo_id ?? null,
      recovery_gen: indexes?.recovery_gen ?? 0,
      first_hidden: (hidden?.results[0] as { repo_id: string } | undefined)?.repo_id ?? null,
      next_purge: (purge?.results[0] as { repo_id: string } | undefined)?.repo_id ?? null,
    },
  };
}
