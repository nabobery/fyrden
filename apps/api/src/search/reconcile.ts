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
import { epochStatement } from "../queues/events-consumer.js";
import { clock } from "../services.js";
import {
  type CallBudget,
  counted,
  type Reservation,
  reserve,
  SAME_DAY,
  settleStatement,
  sizeStatement,
  spentStatement,
  tickStatement,
  usedBy,
} from "./admission.js";
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
 * written; a row the page lacks is marked deleted when it predates that
 * page's reading (an older epoch, or not after its watermark), and kept
 * when a later event wrote it. The repository's own row comes last, from a
 * snapshot read then. Each pass has a generation: a superseded pass's
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

/**
 * The key a pass is at once its walk is through: its last step, the
 * repository's own row, is still to come (a budgeted step of its own).
 */
const FINISHING = -1;

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
 * could not start, its fences refusing it, is tried again later),
 * `blocked` when search's allowance for the day (or the database's size)
 * leaves no room for a step.
 */
export async function reconcileSource(
  env: Env,
  target: ReconcileTarget,
  options: { pages?: number; calls?: CallBudget; metrics?: Metrics } = {},
): Promise<"done" | "more" | "blocked"> {
  const { repoId } = target;
  const { metrics, calls } = options;
  const org = readModelFor(env, target.shard);
  const db = calls ? counted(org, calls) : org;
  const repo = env.REPO.getByName(repoId);
  const exportPage = async (request: ExportPageRequest) =>
    (await repo.exportPage(request)) as ExportPage | "stale" | null;
  let pages = options.pages ?? RECONCILE_POLICY.pagesPerCall;
  // Reads of the pass's own row, charged with the next step's settling (or on their own).
  const lookups = { reads: 0 };
  const end = async <T>(outcome: T): Promise<T> => {
    if (lookups.reads > 0) {
      metrics?.count("d1.query", { db: "org", op: "search_spent" });
      await spentStatement(db, { rows: 0, reads: lookups.reads }).run();
      lookups.reads = 0;
    }
    return outcome;
  };
  let pass = await current(db, repoId, lookups, metrics);
  for (;;) {
    // A step starts only when all it may call fits in what the invocation has left.
    if (pages-- <= 0 || (calls && calls.left < STEP_CALLS)) return end("more");
    const starting = pass === undefined || pass.kind === "done";
    metrics?.count("d1.query", { db: "org", op: "search_reserve" });
    const reservation = await reserve(db, starting ? SMALL_STEP : pageStep());
    if (!reservation) {
      // Removals are made whatever the allowance: they may be what makes room again.
      if (pass !== undefined) await collectTombstones(db, repoId, metrics);
      return end("blocked");
    }
    if (pass === undefined || pass.kind === "done") {
      const page = await exportPage({ kind: "repo", after: 0, limit: 1 });
      if (page === null || page === "stale") {
        await account(db, reservation, [], 0, metrics, lookups);
        return end("done");
      }
      pass = await start(db, repoId, page, reservation, metrics);
      // Refused (the read model's ownership is ahead of the object's): later.
      if (pass === undefined) return end("more");
      continue;
    }
    const { kind, after } = pass;
    const expected = { epochGen: pass.epochGen, ownerGen: pass.ownerGen };
    const page = await exportPage(
      after === FINISHING
        ? { kind: "repo", after: 0, limit: 1, expected }
        : { kind, after, limit: EXPORT_PAGE.entities, expected },
    );
    if (page === null || page === "stale") {
      await account(db, reservation, [], 0, metrics, lookups);
      if (page === null) return end("done");
      // The repository was restored or transferred meanwhile: another pass, from its new position.
      pass = undefined;
      continue;
    }
    let statements: D1PreparedStatement[];
    let next: Pass["kind"];
    let nextAfter: number;
    let read = 0;
    // At the size threshold a step makes removals only, and leaves the pass partial (its
    // repair revision not covered: a whole pass follows).
    const removalsOnly = reservation.removalsOnly;
    if (after === FINISHING) {
      // The walk is through: the repository's own row, from a snapshot read now (after the
      // revision this pass covers was taken, so a change asked for before it is in it).
      const [entity] = page.entities;
      statements = removalsOnly
        ? []
        : exportStatements(
            db,
            {
              sourceId: repoId,
              epochGen: page.epochGen,
              ownerGen: page.ownerGen,
              watermark: page.watermark,
              entities: entity ? [{ ...entity, row: entity.row as RepoRow | null }] : [],
            },
            clock(),
            // Within its reservation's day, as every other write of the step.
            { where: SAME_DAY, params: [reservation.day] },
          );
      next = "done";
      nextAfter = 0;
    } else {
      const found = await differences(
        db,
        repoId,
        pass,
        kind,
        page,
        reservation.day,
        removalsOnly,
        metrics,
      );
      statements = found.statements;
      read = found.read;
      // Past the last kind, the pass finishes with the repository's own row.
      next = !found.ended ? kind : kind === "milestones" ? "milestones" : NEXT_KIND[kind];
      nextAfter = !found.ended ? found.upTo : kind === "milestones" ? FINISHING : 0;
    }
    // The step is done only where its writes could be made: the same fences, and its day.
    statements.push(
      db
        .prepare(
          `UPDATE search_reconciles SET kind = ?7, after = ?8
           WHERE repo_id = ?1 AND gen = ?4 AND kind = ?5 AND after = ?6 AND ${FENCES}
             AND ${SAME_DAY(9)}`,
        )
        .bind(
          repoId,
          pass.epochGen,
          pass.ownerGen,
          pass.gen,
          kind,
          after,
          next,
          nextAfter,
          reservation.day,
        ),
    );
    const checkpoint = statements.length - 1;
    if (removalsOnly)
      statements.push(
        db
          .prepare("UPDATE search_reconciles SET partial = 1 WHERE repo_id = ? AND gen = ?")
          .bind(repoId, pass.gen),
      );
    // Its last step: the repair revision it covered is covered (by a whole pass only).
    if (next === "done")
      statements.push(
        db
          .prepare(
            `UPDATE search_repairs SET covered = active, active = NULL
             WHERE repo_id = ?1 AND active IS NOT NULL
               AND EXISTS (SELECT 1 FROM search_reconciles WHERE repo_id = ?1 AND gen = ?2
                 AND kind = 'done' AND partial = 0)`,
          )
          .bind(repoId, pass.gen),
      );
    statements.push(tickStatement(db));
    metrics?.count("d1.query", { db: "org", op: "reconcile_page" });
    const results = await db.batch(statements);
    await account(db, reservation, results, read, metrics, lookups);
    if ((results[checkpoint]?.meta.changes ?? 0) === 0) {
      const reloaded = await current(db, repoId, lookups, metrics);
      // The source's fences refuse this pass (a transfer or restore landing), or its day ended
      // while it ran: tried again later (a new pass once the repository answers under its new
      // ownership or epoch; the same step from the new day's allowance).
      if (reloaded?.gen === pass.gen && reloaded.kind === kind && reloaded.after === after)
        return end("more");
      // Another caller worked this step first (its writes stand, these were refused).
      pass = reloaded;
      continue;
    }
    pass = { ...pass, kind: next, after: nextAfter };
    if (next === "done") {
      await collectTombstones(db, repoId, metrics);
      return end("done");
    }
  }
}

/**
 * D1 calls a step makes at most: its reservation (and a size check with a
 * retry), the comparison read, its batch, the settling, a reload of the pass
 * and the collection after the last one.
 */
export const STEP_CALLS = 10;

/** What a step that writes a few rows reserves (a pass's start or last step). */
const SMALL_STEP = { rows: 50, reads: 200 };

/**
 * What a page reserves: every exported entity and every projection row it
 * compares written (6 rows each at most, an issue first projected), and
 * read (the range, and each statement's checks).
 */
function pageStep(): { rows: number; reads: number } {
  const statements = EXPORT_PAGE.entities + RECONCILE_POLICY.rowsPerPage;
  return {
    rows: statements * 6 + SMALL_STEP.rows,
    reads: RECONCILE_POLICY.rowsPerPage + 1 + statements * 10 + SMALL_STEP.reads,
  };
}

/**
 * Settles a step's reservation to what its batch (and `read` rows read
 * before it) used, and records the database's size the batch reported.
 */
async function account(
  db: D1Database,
  reservation: Reservation,
  results: readonly D1Result[],
  read: number,
  metrics: Metrics | undefined,
  lookups?: { reads: number },
): Promise<void> {
  const used = usedBy(results);
  read += lookups?.reads ?? 0;
  if (lookups) lookups.reads = 0;
  const tick = (results.at(-1)?.results[0] as { clock?: number } | undefined)?.clock;
  const statements = [
    settleStatement(db, reservation, { rows: used.rows, reads: used.reads + read }),
  ];
  if (tick !== undefined && used.bytes !== undefined)
    statements.push(sizeStatement(db, tick, used.bytes));
  metrics?.count("d1.query", { db: "org", op: "search_settle" }, statements.length);
  await db.batch(statements);
}

async function current(
  db: D1Database,
  repoId: string,
  lookups: { reads: number },
  metrics: Metrics | undefined,
): Promise<Pass | undefined> {
  metrics?.count("d1.query", { db: "org", op: "reconcile_pass" });
  const { results, meta } = await db
    .prepare(
      `SELECT gen, epoch_gen, owner_gen, watermark, kind, after FROM search_reconciles
       WHERE repo_id = ?`,
    )
    .bind(repoId)
    .all<{
      gen: number;
      epoch_gen: number;
      owner_gen: number;
      watermark: number;
      kind: Pass["kind"];
      after: number;
    }>();
  lookups.reads += meta.rows_read ?? 0;
  const [row] = results;
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
 * its cutoff (never lowered), the pass (a new generation) and the repair
 * revision it covers, the last three only within the source's fences;
 * undefined when they refuse it. (The repository's own row is written on
 * the pass's last page, from a snapshot read then.)
 */
async function start(
  db: D1Database,
  repoId: string,
  page: ExportPage,
  reservation: Reservation,
  metrics: Metrics | undefined,
): Promise<Pass | undefined> {
  const now = clock();
  metrics?.count("d1.query", { db: "org", op: "reconcile_start" });
  const results = await db.batch<{ gen: number }>([
    epochStatement(db, repoId, page.epochGen, now),
    db
      .prepare(
        `INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq) SELECT ?1, ?2, ?4
         WHERE ${FENCES} AND ${SAME_DAY(5)}
         ON CONFLICT (repo_id) DO UPDATE SET cutoff_epoch = excluded.cutoff_epoch,
           cutoff_seq = excluded.cutoff_seq
         WHERE (excluded.cutoff_epoch, excluded.cutoff_seq)
           > (search_sources.cutoff_epoch, search_sources.cutoff_seq)`,
      )
      .bind(repoId, page.epochGen, page.ownerGen, page.watermark, reservation.day),
    db
      .prepare(
        `INSERT INTO search_reconciles (repo_id, gen, epoch_gen, owner_gen, watermark, kind,
           after, started_at)
         SELECT ?1, 1, ?2, ?3, ?4, 'subjects', 0, ?5 WHERE ${FENCES} AND ${SAME_DAY(6)}
         ON CONFLICT (repo_id) DO UPDATE SET gen = search_reconciles.gen + 1,
           epoch_gen = excluded.epoch_gen, owner_gen = excluded.owner_gen,
           watermark = excluded.watermark, kind = 'subjects', after = 0,
           started_at = excluded.started_at, partial = 0
         RETURNING gen`,
      )
      .bind(repoId, page.epochGen, page.ownerGen, page.watermark, now, reservation.day),
    // The repair revision asked for so far is the one this pass covers.
    db
      .prepare(
        `UPDATE search_repairs SET active = dirty
         WHERE repo_id = ?1 AND ${FENCES} AND ${SAME_DAY(4)}`,
      )
      .bind(repoId, page.epochGen, page.ownerGen, reservation.day),
    tickStatement(db),
  ]);
  await account(db, reservation, results, 0, metrics);
  const gen = results.at(-3)?.results[0]?.gen;
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
  day: number,
  removalsOnly: boolean,
  metrics: Metrics | undefined,
): Promise<{ statements: D1PreparedStatement[]; upTo: number; ended: boolean; read: number }> {
  const { table, key } = TABLES[kind];
  const cap = RECONCILE_POLICY.rowsPerPage;
  let upTo = page.next ?? NO_KEY;
  metrics?.count("d1.query", { db: "org", op: "reconcile_rows" });
  const { results, meta } = await db
    .prepare(
      `SELECT ${key} AS key, epoch_gen, owner_gen, version, deleted, updated_seq FROM ${table}
       WHERE repo_id = ?1 AND ${key} > ?2 AND ${key} <= ?3 AND ${SAME_DAY(5)}
       ORDER BY ${key} LIMIT ?4`,
    )
    // Read within its reservation's day (past it, nothing: its writes are refused too).
    .bind(repoId, pass.after, upTo, cap + 1, day)
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
  const writer: SearchWriter = { by: "reconcile", gen: pass.gen, kind, after: pass.after, day };
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
    // Only removals while the database is at its size threshold.
    if (removalsOnly && !entity.deleted) continue;
    const statement = searchStatement(db, position, entity, writer);
    if (statement) statements.push(statement);
  }
  // Where the rows the export lacks were found gone: this page's reading. A row this page
  // lacks that an event up to it wrote is gone (deleted before the page was read, after the
  // pass took its revision); one an event after it wrote is kept.
  const seen: SearchPosition = { ...position, epochGen: page.epochGen, sourceSeq: page.watermark };
  for (const row of rows) {
    if (exported.has(row.key) || row.deleted === 1) continue;
    if (
      row.epoch_gen > seen.epochGen ||
      (row.epoch_gen === seen.epochGen && row.updated_seq > seen.sourceSeq)
    )
      continue;
    statements.push(absentStatement(db, table, key, position, seen, row.key, writer));
  }
  return { statements, upTo, ended: !cut && page.next === null, read: meta.rows_read ?? 0 };
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
 * Marks a row the export lacks deleted, unless an event after the page was
 * read wrote it meanwhile. Its deletion is placed where the page found it
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
         AND (epoch_gen < ?6 OR (epoch_gen = ?6 AND updated_seq <= ?7))
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
        // Two ranges of the deletion index, each sought (never a scan of the deletions the
        // cutoff does not cover yet): earlier epochs, and the cutoff's own up to its sequence.
        `DELETE FROM ${table} WHERE rowid IN (
           SELECT rowid FROM ${table} WHERE repo_id = ?1 AND deleted = 1
             AND deleted_epoch IS NOT NULL
             AND deleted_epoch < (SELECT cutoff_epoch FROM search_sources WHERE repo_id = ?1)
           UNION ALL
           SELECT rowid FROM ${table} WHERE repo_id = ?1 AND deleted = 1
             AND deleted_epoch = (SELECT cutoff_epoch FROM search_sources WHERE repo_id = ?1)
             AND deleted_seq <= (SELECT cutoff_seq FROM search_sources WHERE repo_id = ?1)
           LIMIT ?2)`,
      )
      .bind(repoId, RECONCILE_POLICY.collectPage);
  metrics?.count("d1.query", { db: "org", op: "reconcile_collect" }, 3);
  const removed = await db.batch([
    collect("search_docs"),
    collect("search_labels"),
    collect("search_milestones"),
  ]);
  // Removals are made whatever the day's allowance (they shrink the database), and counted.
  const used = usedBy(removed);
  metrics?.count("d1.query", { db: "org", op: "search_spent" });
  await spentStatement(db, { rows: used.rows, reads: used.reads }).run();
  return removed.reduce((sum, r) => sum + r.meta.changes, 0);
}

/** A deletion's place in its table's deletion index. */
interface SweepKey {
  readonly row: number;
  readonly repo_id: string;
  readonly deleted_epoch: number;
  readonly deleted_seq: number;
}

/** The tables deletions are swept from, across sources. */
const SWEPT = ["search_docs", "search_labels", "search_milestones"] as const;

/**
 * Removes covered deletions of any source, looking at the next
 * `collectPage` deletions of each table (in its deletion index's order,
 * after where the last sweep stopped) and starting over once through: a
 * deletion its cutoff does not cover yet is passed over, so every source's
 * are reached in turn, and a sweep reads a bounded number of rows. For runs
 * that can do nothing else (search's allowance spent): removals shrink the
 * database, and are made whatever the allowance.
 */
export async function sweepTombstones(db: D1Database, metrics?: Metrics): Promise<number> {
  const page = RECONCILE_POLICY.collectPage;
  metrics?.count("d1.query", { db: "org", op: "search_sweep_cursor" });
  const { results: cursors, meta: cursorMeta } = await db
    .prepare("SELECT name, repo_id, deleted_epoch, deleted_seq, row FROM search_sweep")
    .all<{ name: string } & SweepKey>();
  const cursorOf = new Map(cursors.map((c) => [c.name, c]));
  // Each table's next deletions after its cursor: in index order, from ranges each sought
  // (the same repository, epoch and sequence past the row; a later sequence; a later epoch;
  // a later repository), each limited, merged here.
  const columns = `rowid AS row, repo_id, deleted_epoch, deleted_seq,
    coalesce((SELECT (s.cutoff_epoch, s.cutoff_seq) >= (t.deleted_epoch, t.deleted_seq)
      FROM search_sources s WHERE s.repo_id = t.repo_id), 0) AS covered`;
  const order = "ORDER BY repo_id, deleted_epoch, deleted_seq, rowid LIMIT ?";
  const deleted = "t.deleted = 1 AND t.deleted_epoch IS NOT NULL";
  const windows = SWEPT.map((table) => {
    const at = cursorOf.get(table);
    if (!at)
      return [db.prepare(`SELECT ${columns} FROM ${table} t WHERE ${deleted} ${order}`).bind(page)];
    const from = (where: string, ...values: (string | number)[]) =>
      db
        .prepare(`SELECT ${columns} FROM ${table} t WHERE ${deleted} AND ${where} ${order}`)
        .bind(...values, page);
    return [
      from(
        "t.repo_id = ? AND t.deleted_epoch = ? AND t.deleted_seq = ? AND t.rowid > ?",
        at.repo_id,
        at.deleted_epoch,
        at.deleted_seq,
        at.row,
      ),
      from(
        "t.repo_id = ? AND t.deleted_epoch = ? AND t.deleted_seq > ?",
        at.repo_id,
        at.deleted_epoch,
        at.deleted_seq,
      ),
      from("t.repo_id = ? AND t.deleted_epoch > ?", at.repo_id, at.deleted_epoch),
      from("t.repo_id > ?", at.repo_id),
    ];
  });
  metrics?.count("d1.query", { db: "org", op: "search_sweep_look" });
  const answered = await db.batch<SweepKey & { covered: number }>(windows.flat());
  let next = 0;
  const looked = windows.map((parts) => {
    // Disjoint and in order: their concatenation is the index's order; its first page.
    const rows = parts.flatMap(() => answered[next++]?.results ?? []);
    return rows.slice(0, page);
  });
  const statements: D1PreparedStatement[] = [];
  // Which statements remove deletions (the others move the sweep's place).
  const removals = new Set<number>();
  for (const [i, table] of SWEPT.entries()) {
    const rows = looked[i] ?? [];
    const gone = rows.filter((r) => r.covered === 1).map((r) => r.row);
    if (gone.length > 0) {
      removals.add(statements.length);
      statements.push(
        db
          .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(gone)),
      );
    }
    const last = rows.at(-1);
    // Once through the table, the next sweep starts over.
    statements.push(
      rows.length < page || !last
        ? db.prepare("DELETE FROM search_sweep WHERE name = ?").bind(table)
        : db
            .prepare(
              `INSERT INTO search_sweep (name, repo_id, deleted_epoch, deleted_seq, row)
               VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT (name) DO UPDATE SET repo_id = excluded.repo_id,
                 deleted_epoch = excluded.deleted_epoch, deleted_seq = excluded.deleted_seq,
                 row = excluded.row`,
            )
            .bind(table, last.repo_id, last.deleted_epoch, last.deleted_seq, last.row),
    );
  }
  metrics?.count("d1.query", { db: "org", op: "search_sweep" });
  const removed = await db.batch(statements);
  const used = usedBy([...answered, ...removed]);
  metrics?.count("d1.query", { db: "org", op: "search_spent" });
  await spentStatement(db, {
    rows: used.rows,
    reads: used.reads + (cursorMeta.rows_read ?? 0),
  }).run();
  return removed.reduce((sum, r, i) => sum + (removals.has(i) ? r.meta.changes : 0), 0);
}
