import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { readModelFor } from "../events/read-model.js";
import { ReadModelRefused } from "../read-model/executor.js";
import { admitted } from "../read-model/maintenance.js";
import { PreservationRefused } from "../read-model/preservation.js";
import { searchProjections } from "../repos/cleanups.js";
import { clock } from "../services.js";
import { repairStatement } from "./repairs.js";
import { RECOVERY_GEN } from "./visibility.js";

/*
 * What a recovery does to search once the operational rows are imported
 * (its `fencing` stage), as a maintenance writer at its generation, before
 * the writers resume: it raises the read model's recovery generation (every
 * restored source with a row hidden at once); gives every restored source a
 * row (so a source with none is one with nothing restored); tombstones the
 * restored sources the directory no longer has active (deleted since, or
 * never known) and asks for their search rows' purge; and asks a
 * reconciliation of every repository the directory has active. Each a page
 * at a time, its place kept in the recovery's cursor. After the resume the
 * repair job reconciles each source (visible again once a whole pass of the
 * new generation ends) and purges the tombstoned ones' rows.
 */

/** Sources a fencing page looks at (Proposed). */
export const FENCING_PAGE = 100;

/** The tables restored sources are found in, by their repository column. */
const RESTORED = [
  "search_docs",
  "search_labels",
  "search_milestones",
  "search_repo_nums",
  "search_reconciles",
  "search_repairs",
  "repos",
] as const;

type Cursor =
  | { readonly phase: "generation"; readonly target: number }
  | {
      readonly phase: "sources";
      readonly target: number;
      readonly table: number;
      readonly after: string;
    }
  | { readonly phase: "classify"; readonly target: number; readonly after: string }
  | { readonly phase: "deleted"; readonly target: number; readonly after: string }
  | { readonly phase: "repairs"; readonly target: number; readonly after: string };

interface Recovery {
  readonly generation: number;
  readonly stage: string;
  readonly cursor: string | null;
}

/** The recovery's place moved on, from where this step found it (and its stage, when done). */
async function moved(
  env: Pick<Env, "DIRECTORY">,
  shard: string,
  recoveryId: string,
  from: string | null,
  to: Cursor | null,
): Promise<void> {
  await env.DIRECTORY.prepare(
    `UPDATE read_model_recoveries SET cursor = ?3, stage = ?4, updated_at = ?5
     WHERE shard = ?1 AND recovery_id = ?2 AND stage = 'fencing' AND cursor IS ?6`,
  )
    .bind(
      shard,
      recoveryId,
      to ? JSON.stringify(to) : null,
      to ? "fencing" : "resuming",
      clock(),
      from,
    )
    .run();
}

/** Writes `statements` as the recovery's maintenance writer; refused when its barrier moved. */
async function written(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
  generation: number,
  statements: (org: D1Database) => D1PreparedStatement[],
): Promise<void> {
  if (!(await admitted(env, shard, generation, statements)))
    throw new PreservationRefused("the barrier left the recovery's generation");
}

/**
 * One step of the shard's recovery `recoveryId`'s fencing (`fencing`):
 * done once it moved on to `resuming`.
 */
export async function fenceStep(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
  recoveryId: string,
): Promise<{ done: boolean }> {
  const recovery = await env.DIRECTORY.prepare(
    "SELECT generation, stage, cursor FROM read_model_recoveries WHERE shard = ? AND recovery_id = ?",
  )
    .bind(shard, recoveryId)
    .first<Recovery>();
  if (!recovery) throw new PreservationRefused("no such recovery");
  if (recovery.stage !== "fencing") return { done: recovery.stage !== "importing" };
  const db = readModelFor(env, shard);
  const { generation } = recovery;
  const cursor = recovery.cursor ? (JSON.parse(recovery.cursor) as Cursor) : null;
  if (!cursor) {
    // The generation it raises the read model's to, chosen once.
    const state = await db
      .prepare("SELECT recovery_gen FROM search_index_state WHERE id = 1")
      .first<{ recovery_gen: number }>();
    await moved(env, shard, recoveryId, null, {
      phase: "generation",
      target: (state?.recovery_gen ?? 0) + 1,
    });
    return { done: false };
  }
  const { target } = cursor;
  switch (cursor.phase) {
    case "generation":
      await written(env, shard, generation, (org) => [
        org
          .prepare(
            "UPDATE search_index_state SET recovery_gen = ?1 WHERE id = 1 AND recovery_gen < ?1",
          )
          .bind(target),
      ]);
      await moved(env, shard, recoveryId, recovery.cursor, {
        phase: "sources",
        target,
        table: 0,
        after: "",
      });
      return { done: false };
    case "sources": {
      // The next restored sources of this table, each given a row (hidden: of the generation
      // before) when it has none.
      const table = RESTORED[cursor.table];
      if (!table) {
        await moved(env, shard, recoveryId, recovery.cursor, {
          phase: "classify",
          target,
          after: "",
        });
        return { done: false };
      }
      // Each a seek of the table's repository index past the one before: never a walk of a
      // source's own rows.
      const { results } = await db
        .prepare(
          `WITH RECURSIVE s(repo_id, n) AS (
             SELECT (SELECT repo_id FROM ${table} WHERE repo_id > ?1 ORDER BY repo_id LIMIT 1), 1
             UNION ALL
             SELECT (SELECT repo_id FROM ${table} t WHERE t.repo_id > s.repo_id
               ORDER BY repo_id LIMIT 1), n + 1
             FROM s WHERE s.repo_id IS NOT NULL AND n < ${FENCING_PAGE})
           SELECT repo_id FROM s WHERE repo_id IS NOT NULL`,
        )
        .bind(cursor.after)
        .all<{ repo_id: string }>();
      const ids = results.map((r) => r.repo_id);
      if (ids.length > 0)
        await written(env, shard, generation, (org) => [
          org
            .prepare(
              `INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq, visible_gen)
               SELECT value, 0, 0, ?2 - 1 FROM json_each(?1) WHERE 1
               ON CONFLICT (repo_id) DO NOTHING`,
            )
            .bind(JSON.stringify(ids), target),
        ]);
      await moved(
        env,
        shard,
        recoveryId,
        recovery.cursor,
        ids.length < FENCING_PAGE
          ? { phase: "sources", target, table: cursor.table + 1, after: "" }
          : { phase: "sources", target, table: cursor.table, after: ids.at(-1) ?? "" },
      );
      return { done: false };
    }
    case "classify": {
      // The next sources: those the directory does not have active, tombstoned and their purge asked.
      const { results } = await db
        .prepare(
          `SELECT repo_id FROM search_sources WHERE repo_id > ? ORDER BY repo_id LIMIT ${FENCING_PAGE}`,
        )
        .bind(cursor.after)
        .all<{ repo_id: string }>();
      const ids = results.map((r) => r.repo_id);
      const { results: active } = await env.DIRECTORY.prepare(
        "SELECT id FROM repos WHERE id IN (SELECT value FROM json_each(?)) AND state = 'active'",
      )
        .bind(JSON.stringify(ids))
        .all<{ id: string }>();
      const live = new Set(active.map((r) => r.id));
      const gone = ids.filter((id) => !live.has(id));
      if (gone.length > 0)
        await written(env, shard, generation, (org) => [
          org
            .prepare(
              `INSERT INTO repos (repo_id, deleted, epoch_gen, version, owner_gen, updated_seq,
                 updated_at)
               SELECT value, 1, 0, 0, 0, 0, ?2 FROM json_each(?1) WHERE 1
               ON CONFLICT (repo_id) DO UPDATE SET deleted = 1`,
            )
            .bind(JSON.stringify(gone), clock()),
          org
            .prepare(
              `INSERT INTO search_purges (repo_id, recovery_gen)
               SELECT value, ?2 FROM json_each(?1) WHERE 1
               ON CONFLICT (repo_id) DO UPDATE SET recovery_gen = excluded.recovery_gen`,
            )
            .bind(JSON.stringify(gone), target),
        ]);
      await moved(
        env,
        shard,
        recoveryId,
        recovery.cursor,
        ids.length < FENCING_PAGE
          ? { phase: "deleted", target, after: "" }
          : { phase: "classify", target, after: ids.at(-1) ?? "" },
      );
      return { done: false };
    }
    case "deleted": {
      // Every repository the directory has deleting or deleted in this shard tombstoned, whether
      // or not anything of it was restored: its preserved effects and deliveries go by the
      // tombstone (one made after the restore's point is not in the restored read model).
      const { results } = await env.DIRECTORY.prepare(
        `SELECT id FROM repos WHERE id > ? AND state <> 'active' AND org_shard = ?
         ORDER BY id LIMIT ${FENCING_PAGE}`,
      )
        .bind(cursor.after, shard)
        .all<{ id: string }>();
      const ids = results.map((r) => r.id);
      if (ids.length > 0)
        await written(env, shard, generation, (org) => [
          org
            .prepare(
              `INSERT INTO repos (repo_id, deleted, epoch_gen, version, owner_gen, updated_seq,
                 updated_at)
               SELECT value, 1, 0, 0, 0, 0, ?2 FROM json_each(?1) WHERE 1
               ON CONFLICT (repo_id) DO UPDATE SET deleted = 1`,
            )
            .bind(JSON.stringify(ids), clock()),
        ]);
      await moved(
        env,
        shard,
        recoveryId,
        recovery.cursor,
        ids.length < FENCING_PAGE
          ? { phase: "repairs", target, after: "" }
          : { phase: "deleted", target, after: ids.at(-1) ?? "" },
      );
      return { done: false };
    }
    case "repairs": {
      // The next repositories the directory has active in this shard: each asked a reconciliation.
      const { results } = await env.DIRECTORY.prepare(
        `SELECT id FROM repos WHERE id > ? AND state = 'active' AND org_shard = ?
         ORDER BY id LIMIT ${FENCING_PAGE}`,
      )
        .bind(cursor.after, shard)
        .all<{ id: string }>();
      const now = clock();
      if (results.length > 0)
        await written(env, shard, generation, (org) =>
          results.map((r) => repairStatement(org, r.id, "recovered", now)),
        );
      const done = results.length < FENCING_PAGE;
      await moved(
        env,
        shard,
        recoveryId,
        recovery.cursor,
        done ? null : { phase: "repairs", target, after: results.at(-1)?.id ?? "" },
      );
      return { done };
    }
  }
}

/** Purges a run works at most, and pages each (Proposed). */
export const PURGE_POLICY = { sources: 5 };

/**
 * Purges the search rows of sources a recovery tombstoned, at the read
 * model's current recovery generation (an older one's are not this one's:
 * dropped), one cleanup page each a run, a source done once its page finds
 * nothing left; only while its tombstone stands. Whether search indexes or
 * not; nothing while the read model takes no ordinary writes (a recovery
 * under way). The calls it made.
 */
export async function runSearchPurges(env: Env, shard: string, metrics?: Metrics): Promise<number> {
  const db = readModelFor(env, shard);
  let calls = 1;
  metrics?.count("d1.query", { db: "org", op: "search_purges" });
  const { results } = await db
    .prepare(
      `SELECT p.repo_id, p.recovery_gen, p.recovery_gen = ${RECOVERY_GEN} AS current,
         EXISTS (SELECT 1 FROM repos r WHERE r.repo_id = p.repo_id AND r.deleted = 1) AS tombstoned
       FROM search_purges p ORDER BY p.recovery_gen, p.repo_id LIMIT ?`,
    )
    .bind(PURGE_POLICY.sources)
    .all<{ repo_id: string; recovery_gen: number; current: number; tombstoned: number }>();
  try {
    for (const purge of results) {
      let done = purge.current !== 1 || purge.tombstoned !== 1;
      if (!done) {
        calls++;
        done =
          (await searchProjections.page(env, { repoId: purge.repo_id, shard, gen: 0 }, metrics)) ===
          "done";
      }
      if (done) {
        calls++;
        metrics?.count("d1.query", { db: "org", op: "search_purge_done" });
        // Only the purge as it was read: a newer recovery's, asked meanwhile, stands.
        await db
          .prepare("DELETE FROM search_purges WHERE repo_id = ? AND recovery_gen = ?")
          .bind(purge.repo_id, purge.recovery_gen)
          .run();
      }
    }
  } catch (error) {
    if (!(error instanceof ReadModelRefused)) throw error;
  }
  return calls;
}
