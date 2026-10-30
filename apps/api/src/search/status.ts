import type { getSearchStatus, Input, Output } from "@fyrden/api-contract";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import type { OpContext } from "../ops/execute.js";
import { READ_MODEL_PROTOCOL } from "../read-model/executor.js";
import { exportAvailability } from "../read-model/export.js";
import { readModelState } from "../read-model/maintenance.js";
import { searchIndexing } from "./repairs.js";

/**
 * The `admin.search.status` operation (instance administrators): the read
 * model's write protocol, barriers, admission and leases, and search's
 * allowance, size and waiting reconciliations. Singleton rows and one due
 * row (the shard's leases besides): what it reads stays the same whatever
 * the database holds. A missing protocol row reads as null and the barriers
 * as not consistent, never as a healthy zero.
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
  const db = readModelFor(env, DEFAULT_ORG_SHARD);
  metrics.count("d1.query", { db: "org", op: "search_status" }, 3);
  const [budget, size, repair] = await db.batch([
    db.prepare(
      `SELECT CAST(unixepoch() / 86400 AS INTEGER) AS day, coalesce(b.rows, 0) AS rows,
         coalesce(b.reads, 0) AS reads
       FROM (SELECT 1) LEFT JOIN search_budget b ON b.day = CAST(unixepoch() / 86400 AS INTEGER)`,
    ),
    db.prepare("SELECT bytes, observed FROM search_size WHERE id = 1"),
    // Through the due index: the one due next.
    db.prepare(
      "SELECT since FROM search_repairs WHERE dirty > covered ORDER BY next_at, repo_id LIMIT 1",
    ),
  ]);
  const today = budget?.results[0] as { day: number; rows: number; reads: number };
  const observed = size?.results[0] as { bytes: number; observed: number } | undefined;
  const next = repair?.results[0] as { since: number } | undefined;
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
    search: {
      day: today.day,
      rows: today.rows,
      reads: today.reads,
      bytes: observed?.bytes ?? 0,
      observed_sequence: observed?.observed ?? 0,
      repair_pending: next !== undefined,
      next_repair_since: next?.since ?? null,
    },
  };
}
