import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { RepoRow } from "@fyrden/domain";
import type {
  ExportedEntity,
  ExportKind,
  ExportPage,
  ExportPageRequest,
} from "../do/repo/export.js";
import { EXPORT_PAGE } from "../do/repo/export.js";
import { readModelFor } from "../events/read-model.js";
import { exportStatements } from "../events/rebuild.js";
import { clock } from "../services.js";
import {
  eligible,
  FENCES,
  type SearchPosition,
  type SearchWriter,
  searchStatement,
  writerParams,
} from "./statements.js";

/*
 * A source's search projections brought to its repository's own state,
 * writing only differences (backfill, repair and recovery alike). A pass
 * reads the repository's export from one position (its epoch, ownership
 * and watermark, fixed for the pass) and, before anything else, sets the
 * source's cutoff there: from then on an event at or before it is refused,
 * since everything it carries is in the export or superseded. The pass then
 * walks the export's kinds a page at a time beside the projection's rows of
 * the same keys: an exported entity newer than its row (or without one) is
 * written; a row the export lacks is marked deleted when it predates the
 * export (an older epoch, or not after the watermark), and kept when a
 * later event wrote it. Each pass has a generation: a superseded pass's
 * writes are refused. A page asked under another epoch or ownership than
 * the pass's starts a new pass. Deletions the cutoff covers are collected
 * once a pass ends.
 */

/** Proposed values. */
export const RECONCILE_POLICY = {
  /** Export pages a call works through (a pass's start counts as one). */
  pagesPerCall: 5,
  /** Projection rows compared a page at most (the export page is cut short beyond them). */
  rowsPerPage: 200,
  /** Projection tombstones collected a table, once a pass ends. */
  collectPage: 500,
};

type WalkedKind = Exclude<ExportKind, "repo">;

interface Pass {
  readonly gen: number;
  readonly epochGen: number;
  readonly ownerGen: number;
  readonly watermark: number;
  readonly kind: WalkedKind | "done";
  readonly after: number;
}

/** What each kind's projection is: its table and key column. */
const TABLES = {
  subjects: { table: "search_docs", key: "number" },
  labels: { table: "search_labels", key: "label_id" },
  milestones: { table: "search_milestones", key: "number" },
} as const;

const NEXT_KIND = { subjects: "labels", labels: "milestones", milestones: "done" } as const;

/** Past every key. */
const NO_KEY = Number.MAX_SAFE_INTEGER;

export interface ReconcileTarget {
  readonly repoId: string;
  /** The org shard its read model is in. */
  readonly shard: string;
}

/**
 * Works up to `pages` export pages of the source's reconciliation (resuming
 * the pass under way, or starting one): `done` once a pass has ended (or
 * the repository has no identity left), `more` otherwise (a pass that
 * could not start, its fences refusing it, is tried again later).
 */
export async function reconcileSource(
  env: Env,
  target: ReconcileTarget,
  options: { pages?: number; metrics?: Metrics } = {},
): Promise<"done" | "more"> {
  const { repoId } = target;
  const { metrics } = options;
  const db = readModelFor(env, target.shard);
  const repo = env.REPO.getByName(repoId);
  const exportPage = async (request: ExportPageRequest) =>
    (await repo.exportPage(request)) as ExportPage | "stale" | null;
  let pages = options.pages ?? RECONCILE_POLICY.pagesPerCall;
  let pass = await current(db, repoId, metrics);
  for (;;) {
    if (pass === undefined || pass.kind === "done") {
      if (pages-- <= 0) return "more";
      const page = await exportPage({ kind: "repo", after: 0, limit: 1 });
      if (page === null || page === "stale") return "done";
      pass = await start(db, repoId, page, metrics);
      // Refused (the read model's ownership is ahead of the object's): later.
      if (pass === undefined) return "more";
      continue;
    }
    if (pages-- <= 0) return "more";
    const { kind, after } = pass;
    const page = await exportPage({
      kind,
      after,
      limit: EXPORT_PAGE.entities,
      expected: { epochGen: pass.epochGen, ownerGen: pass.ownerGen },
    });
    if (page === null) return "done";
    if (page === "stale") {
      // The repository was restored or transferred meanwhile: another pass, from its new position.
      pass = undefined;
      continue;
    }
    const { statements, upTo, ended } = await differences(db, repoId, pass, kind, page, metrics);
    const next = ended ? NEXT_KIND[kind] : kind;
    // The page is done only where its writes could be made: the same fences.
    statements.push(
      db
        .prepare(
          `UPDATE search_reconciles SET kind = ?7, after = ?8
           WHERE repo_id = ?1 AND gen = ?4 AND kind = ?5 AND after = ?6 AND ${FENCES}`,
        )
        .bind(repoId, pass.epochGen, pass.ownerGen, pass.gen, kind, after, next, ended ? 0 : upTo),
    );
    metrics?.count("d1.query", { db: "org", op: "reconcile_page" });
    const results = await db.batch(statements);
    if ((results.at(-1)?.meta.changes ?? 0) === 0) {
      const reloaded = await current(db, repoId, metrics);
      // The source's fences refuse this pass (a transfer or restore landing): tried again later,
      // when the repository answers under its new ownership or epoch and a pass starts there.
      if (reloaded?.gen === pass.gen && reloaded.kind === kind && reloaded.after === after)
        return "more";
      // Another caller worked this page first (its writes stand, these were refused).
      pass = reloaded;
      continue;
    }
    pass = { ...pass, kind: next, after: ended ? 0 : upTo };
    if (next === "done") {
      await collectTombstones(db, repoId, metrics);
      return "done";
    }
  }
}

async function current(
  db: D1Database,
  repoId: string,
  metrics: Metrics | undefined,
): Promise<Pass | undefined> {
  metrics?.count("d1.query", { db: "org", op: "reconcile_pass" });
  const row = await db
    .prepare(
      `SELECT gen, epoch_gen, owner_gen, watermark, kind, after FROM search_reconciles
       WHERE repo_id = ?`,
    )
    .bind(repoId)
    .first<{
      gen: number;
      epoch_gen: number;
      owner_gen: number;
      watermark: number;
      kind: Pass["kind"];
      after: number;
    }>();
  if (!row) return undefined;
  return {
    gen: row.gen,
    epochGen: row.epoch_gen,
    ownerGen: row.owner_gen,
    watermark: row.watermark,
    kind: row.kind,
    after: row.after,
  };
}

/**
 * Starts a pass at the export's position, in one batch: the source's epoch,
 * the repository's own row, its cutoff (never lowered) and the pass (a new
 * generation), the last two only within the source's fences; undefined
 * when they refuse it.
 */
async function start(
  db: D1Database,
  repoId: string,
  page: ExportPage,
  metrics: Metrics | undefined,
): Promise<Pass | undefined> {
  const now = clock();
  const [repo] = page.entities;
  metrics?.count("d1.query", { db: "org", op: "reconcile_start" });
  const results = await db.batch<{ gen: number }>([
    ...exportStatements(
      db,
      {
        sourceId: repoId,
        epochGen: page.epochGen,
        ownerGen: page.ownerGen,
        watermark: page.watermark,
        entities: repo ? [{ ...repo, row: repo.row as RepoRow | null }] : [],
      },
      now,
    ),
    db
      .prepare(
        `INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq) SELECT ?1, ?2, ?4
         WHERE ${FENCES}
         ON CONFLICT (repo_id) DO UPDATE SET cutoff_epoch = excluded.cutoff_epoch,
           cutoff_seq = excluded.cutoff_seq
         WHERE (excluded.cutoff_epoch, excluded.cutoff_seq)
           > (search_sources.cutoff_epoch, search_sources.cutoff_seq)`,
      )
      .bind(repoId, page.epochGen, page.ownerGen, page.watermark),
    db
      .prepare(
        `INSERT INTO search_reconciles (repo_id, gen, epoch_gen, owner_gen, watermark, kind,
           after, started_at)
         SELECT ?1, 1, ?2, ?3, ?4, 'subjects', 0, ?5 WHERE ${FENCES}
         ON CONFLICT (repo_id) DO UPDATE SET gen = search_reconciles.gen + 1,
           epoch_gen = excluded.epoch_gen, owner_gen = excluded.owner_gen,
           watermark = excluded.watermark, kind = 'subjects', after = 0,
           started_at = excluded.started_at
         RETURNING gen`,
      )
      .bind(repoId, page.epochGen, page.ownerGen, page.watermark, now),
  ]);
  const gen = results.at(-1)?.results[0]?.gen;
  if (gen === undefined) return undefined;
  return {
    gen,
    epochGen: page.epochGen,
    ownerGen: page.ownerGen,
    watermark: page.watermark,
    kind: "subjects",
    after: 0,
  };
}

interface ProjectedRow {
  key: number;
  epoch_gen: number;
  owner_gen: number;
  version: number;
  deleted: number;
  updated_seq: number;
}

/**
 * The statements that bring one page's key range of the projection to the
 * export's: the range runs from the pass's key to the export page's last
 * (to the end on its last page), cut short after `rowsPerPage` projection
 * rows; `ended` once the kind's export and projection are both through.
 */
async function differences(
  db: D1Database,
  repoId: string,
  pass: Pass,
  kind: WalkedKind,
  page: ExportPage,
  metrics: Metrics | undefined,
): Promise<{ statements: D1PreparedStatement[]; upTo: number; ended: boolean }> {
  const { table, key } = TABLES[kind];
  const cap = RECONCILE_POLICY.rowsPerPage;
  let upTo = page.next ?? NO_KEY;
  metrics?.count("d1.query", { db: "org", op: "reconcile_rows" });
  const { results } = await db
    .prepare(
      `SELECT ${key} AS key, epoch_gen, owner_gen, version, deleted, updated_seq FROM ${table}
       WHERE repo_id = ? AND ${key} > ? AND ${key} <= ? ORDER BY ${key} LIMIT ?`,
    )
    .bind(repoId, pass.after, upTo, cap + 1)
    .all<ProjectedRow>();
  const rows = results.slice(0, cap);
  const cut = results.length > cap;
  if (cut) upTo = rows.at(-1)?.key ?? upTo;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const position: SearchPosition = {
    repoId,
    epochGen: pass.epochGen,
    ownerGen: pass.ownerGen,
    sourceSeq: pass.watermark,
  };
  const writer: SearchWriter = { by: "reconcile", gen: pass.gen, kind, after: pass.after };
  const statements: D1PreparedStatement[] = [];
  const exported = new Set<number>();
  for (const entity of page.entities) {
    const k = keyOf(entity);
    if (k > upTo) break;
    exported.add(k);
    const row = byKey.get(k);
    // A deletion the cutoff covers needs no row: nothing at or before it is admitted. One
    // after it (an entity made and deleted since the pass began) keeps its row, so its
    // earlier events, delivered late, find it deleted. A row already deleted is compared as
    // any other: a newer deletion (after a restore, say) moves its place on.
    if (entity.deleted && !row && !after(entity.deletedAt, position)) continue;
    if (row && !newer(position, entity.version, row)) continue;
    const statement = searchStatement(db, position, entity, writer);
    if (statement) statements.push(statement);
  }
  // Where the rows the export lacks were found gone: this page's reading.
  const seen: SearchPosition = { ...position, epochGen: page.epochGen, sourceSeq: page.watermark };
  for (const row of rows) {
    if (exported.has(row.key) || row.deleted === 1) continue;
    // Written by an event after the export began: kept.
    if (
      row.epoch_gen > pass.epochGen ||
      (row.epoch_gen === pass.epochGen && row.updated_seq > pass.watermark)
    )
      continue;
    statements.push(absentStatement(db, table, key, position, seen, row.key, writer));
  }
  return { statements, upTo, ended: !cut && page.next === null };
}

/** Whether a deletion's position is after the pass's (unknown: before every recorded one). */
function after(deletedAt: ExportedEntity["deletedAt"], position: SearchPosition): boolean {
  if (!deletedAt) return false;
  return deletedAt.epochGen !== position.epochGen
    ? deletedAt.epochGen > position.epochGen
    : deletedAt.sourceSeq > position.sourceSeq;
}

/** Whether a write at `position` of `version` is later than the row's (epoch, ownership, version). */
function newer(position: SearchPosition, version: number, row: ProjectedRow): boolean {
  if (position.epochGen !== row.epoch_gen) return position.epochGen > row.epoch_gen;
  if (position.ownerGen !== row.owner_gen) return position.ownerGen > row.owner_gen;
  return version > row.version;
}

/** The key of an exported entity: what follows its last `#` or `/`. */
function keyOf(entity: ExportedEntity): number {
  return Number(
    entity.id.slice(Math.max(entity.id.lastIndexOf("#"), entity.id.lastIndexOf("/")) + 1),
  );
}

/** The columns a deletion empties, by table (as the statements' deletions leave them). */
const EMPTIED: Record<string, string> = {
  search_docs: `state = NULL, open_state = NULL, state_reason = NULL, draft = 0, locked = 0,
    lock_reason = NULL, author_id = NULL, author_root = NULL, assignees = '[]', labels = '[]',
    milestone = NULL, title = NULL, body = NULL, created_at = NULL, updated_at = NULL,
    closed_at = NULL, merged_at = NULL`,
  search_labels: "name = NULL, color = NULL, description = NULL",
  search_milestones:
    "title = NULL, state = NULL, description = NULL, due_on = NULL, closed_at = NULL",
};

/**
 * Marks a row the export lacks deleted, unless an event after the export
 * began wrote it meanwhile. Its deletion is placed where the page found it
 * gone (`seen`): the row's version stays, and nothing at or before that
 * place may change it again (an earlier change, delivered late); it is
 * collected once a later pass's cutoff covers that place.
 */
function absentStatement(
  db: D1Database,
  table: string,
  key: string,
  position: SearchPosition,
  seen: SearchPosition,
  value: number,
  writer: SearchWriter,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE ${table} SET deleted = 1, ${EMPTIED[table]}, deleted_epoch = ?6,
         deleted_seq = ?7
       WHERE repo_id = ?1 AND ${key} = ?5 AND deleted = 0
         AND (epoch_gen < ?2 OR (epoch_gen = ?2 AND updated_seq <= ?4))
         AND ${eligible(writer, 8)}`,
    )
    .bind(
      position.repoId,
      position.epochGen,
      position.ownerGen,
      position.sourceSeq,
      value,
      seen.epochGen,
      seen.sourceSeq,
      ...writerParams(writer),
    );
}

/**
 * Removes the source's deleted rows its cutoff covers, a page of each
 * table: nothing can bring them back (an event at or before the cutoff is
 * refused, and none comes after a deletion). Deletions of unknown position
 * stay.
 */
export async function collectTombstones(
  db: D1Database,
  repoId: string,
  metrics?: Metrics,
): Promise<number> {
  const collect = (table: string) =>
    db
      .prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT t.rowid FROM ${table} t
           JOIN search_sources s ON s.repo_id = t.repo_id
           WHERE t.repo_id = ?1 AND t.deleted = 1 AND t.deleted_epoch IS NOT NULL
             AND (s.cutoff_epoch, s.cutoff_seq) >= (t.deleted_epoch, t.deleted_seq)
           LIMIT ?2)`,
      )
      .bind(repoId, RECONCILE_POLICY.collectPage);
  metrics?.count("d1.query", { db: "org", op: "reconcile_collect" }, 3);
  const removed = await db.batch([
    collect("search_docs"),
    collect("search_labels"),
    collect("search_milestones"),
  ]);
  return removed.reduce((sum, r) => sum + r.meta.changes, 0);
}
