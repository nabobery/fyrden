import {
  ISSUE_ENTITY,
  IssueRowSchema,
  LABEL_ENTITY,
  LabelRowSchema,
  MILESTONE_ENTITY,
  MilestoneRowSchema,
  PULL_ENTITY,
  PullRequestRowSchema,
} from "@fyrden/domain";
import { ADMITTED, SAME_DAY } from "./admission.js";

/*
 * The one place search's projections are written from (the events
 * consumer's and a rebuild's writes alike, once they write them): a
 * repository's issues and pull requests (`search_docs`), labels and
 * milestones. Every statement carries the same eligibility predicate, so
 * statements of one event agree on whether it applies, and its own
 * version guard, so a delayed or replayed event never moves a row back. A
 * deleted entity keeps its row, marked deleted and without its text.
 */

/** Where a projected write comes from: the source repository's event position. */
export interface SearchPosition {
  readonly repoId: string;
  readonly epochGen: number;
  readonly ownerGen: number;
  readonly sourceSeq: number;
}

/** An entity to project: an event's snapshot, or an export's entity (with its deletion's position). */
export interface ProjectedEntity {
  readonly type: string;
  readonly id: string;
  readonly version: number;
  readonly deleted: boolean;
  readonly row: Record<string, unknown> | null;
  /** An export's tombstone: where its deletion is (null when unknown). */
  readonly deletedAt?: { readonly epochGen: number; readonly sourceSeq: number } | null;
}

/**
 * Who writes: the events consumer (an event, after the source's cutoff;
 * with `admission`, only when its batch's reservation, `token`, was the one
 * admitted, though a `removal` may empty a row already there whatever the
 * admission) or a reconciliation pass's page (`gen`, while it is the
 * source's current pass, under the export's epoch and ownership, and still
 * at the page it read: `kind` after `after`).
 */
export type SearchWriter =
  | {
      readonly by: "event";
      readonly admission?: { readonly token: string; readonly removal: boolean };
    }
  | {
      readonly by: "reconcile";
      readonly gen: number;
      readonly kind: string;
      readonly after: number;
      /** The day its reservation was taken from (its writes stand only within it). */
      readonly day: number;
      /** Its page's growth, admitted in its batch (`token`), as an event's. */
      readonly admission?: { readonly token: string; readonly removal: boolean };
    };
export const EVENT_WRITER: SearchWriter = { by: "event" };

/** The source's fences, over `?1`–`?3` (see `eligible`). */
export const FENCES = `?2 >= (SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?1)
  AND ?3 >= coalesce((SELECT owner_gen FROM source_owner WHERE source_id = ?1), 0)
  AND NOT EXISTS (SELECT 1 FROM repos WHERE repo_id = ?1 AND deleted = 1)`;

/**
 * Whether a write at a position may touch the source's projections, over
 * `?1` the repository, `?2` the epoch, `?3` the ownership generation and
 * `?4` the sequence: its epoch is not older than the source's newest (the
 * consumer records it first in the same batch), its ownership generation is
 * current, and the repository is not deleted (its tombstone is in the read
 * model: its rows are being purged, and none may come back). Then, for an
 * event, it is after the source's cutoff (what an export already carried);
 * for a reconciliation, its pass (`gen`, bound at `?<at>`, then its page's
 * kind and key) is still the source's, under that export's epoch and
 * ownership and at that page (another caller that worked the page first
 * leaves this one's writes refused), and still in the day its budget was
 * reserved from.
 */
export function eligible(writer: SearchWriter, at: number): string {
  return writer.by === "event"
    ? `${FENCES} AND NOT EXISTS (SELECT 1 FROM search_sources
        WHERE repo_id = ?1 AND (cutoff_epoch, cutoff_seq) >= (?2, ?4))`
    : `${FENCES} AND EXISTS (SELECT 1 FROM search_reconciles WHERE repo_id = ?1
        AND gen = ?${at} AND kind = ?${at + 1} AND after = ?${at + 2}
        AND epoch_gen = ?2 AND owner_gen = ?3) AND ${SAME_DAY(at + 3)}`;
}

/** The writer's own parameters, bound after a statement's others (see `eligible`). */
export function writerParams(writer: SearchWriter): (string | number)[] {
  const token = writer.admission === undefined ? [] : [writer.admission.token];
  if (writer.by === "reconcile")
    return [writer.gen, writer.kind, writer.after, writer.day, ...token];
  return token;
}

/**
 * SQL true while a document's (`d`) or a repository's (`n`, its number)
 * entry is in its full-text index: its row of the index's document sizes.
 * A delete of an entry not there would leave the index unreadable
 * (external content), so every delete is guarded by it; the counters go by
 * the rows' marks, whatever the index holds.
 */
export const IN_INDEX = (d = "d") =>
  `EXISTS (SELECT 1 FROM search_fts_docsize z WHERE z.id = ${d}.doc_id)`;
export const IN_REPO_INDEX = (n = "n") =>
  `EXISTS (SELECT 1 FROM search_repos_fts_docsize z WHERE z.id = ${n}.num)`;

/** What `search_docs.kind` and `state` hold. */
export const DOC_KIND = { issue: 1, pull: 2 } as const;
export const DOC_STATE = { open: 1, closed: 2, merged: 3 } as const;

/** The key after the repository's id in an entity id (`<repo>#<key>`); throws for another repository's. */
function keyOf(position: SearchPosition, entity: ProjectedEntity, prefix: string): number {
  const head = `${position.repoId}#${prefix}`;
  const key = entity.id.startsWith(head) ? Number(entity.id.slice(head.length)) : Number.NaN;
  if (!Number.isSafeInteger(key) || key < 1)
    throw new Error(`a ${entity.type} entity of another repository, or malformed: ${entity.id}`);
  return key;
}

function malformed(entity: ProjectedEntity): Error {
  return new Error(`malformed ${entity.type} row in ${entity.id}`);
}

const flag = (value: boolean) => (value ? 1 : 0);

type Value = string | number | null;

/**
 * An entity's row: its key, version and deletion (where it is: an event's
 * own position, an export's tombstone's, or unknown), then `fields`.
 */
function rowValues(
  position: SearchPosition,
  entity: ProjectedEntity,
  column: string,
  key: number,
  fields: Readonly<Record<string, Value>>,
): Record<string, Value> {
  const deletedAt = !entity.deleted
    ? null
    : entity.deletedAt !== undefined
      ? entity.deletedAt
      : { epochGen: position.epochGen, sourceSeq: position.sourceSeq };
  return {
    [column]: key,
    version: entity.version,
    deleted: flag(entity.deleted),
    deleted_epoch: deletedAt?.epochGen ?? null,
    deleted_seq: deletedAt?.sourceSeq ?? null,
    ...fields,
  };
}

/**
 * The writer's admission, for a write with one (its token after the
 * writer's other parameters, from `?<at>`): admitted, or a removal emptying
 * a row already there (keyed `?5`).
 */
function admitted(writer: SearchWriter, table: string, column: string, at: number): string {
  if (writer.admission === undefined) return "";
  const token = writer.by === "reconcile" ? at + 4 : at;
  return writer.admission.removal
    ? ` AND (${ADMITTED(token)} OR EXISTS (SELECT 1 FROM ${table}
        WHERE repo_id = ?1 AND ${column} = ?5))`
    : ` AND ${ADMITTED(token)}`;
}

/**
 * The guarded upsert of one entity's row into `table` (keyed by its
 * repository and `key`): the fences and the writer's condition, then a row
 * replaced only by one written at a later epoch, ownership or version, and
 * a deleted row by nothing at or before its deletion (a reconciliation
 * marks a row the export lacks deleted where it found it gone, keeping its
 * version: an earlier change, delivered late, must not bring it back). A
 * deletion records where it is: an event's own position, an export's
 * tombstone's (unknown: never collected).
 */
function upsert(
  db: D1Database,
  table: string,
  key: { readonly column: string; readonly value: number },
  position: SearchPosition,
  entity: ProjectedEntity,
  fields: Readonly<Record<string, Value>>,
  writer: SearchWriter,
): D1PreparedStatement {
  const values = rowValues(position, entity, key.column, key.value, fields);
  const columns = Object.keys(values);
  // ?1–?4 are the position's; the row's values follow (the key first, ?5), then the writer's.
  const at = columns.length + 5;
  const admission = admitted(writer, table, key.column, at);
  const updated = [
    "epoch_gen",
    "owner_gen",
    "updated_seq",
    ...columns.filter((c) => c !== key.column),
  ];
  return db
    .prepare(
      `INSERT INTO ${table} (repo_id, epoch_gen, owner_gen, updated_seq, ${columns.join(", ")})
       SELECT ?1, ?2, ?3, ?4, ${columns.map((_, i) => `?${i + 5}`).join(", ")}
       WHERE ${eligible(writer, at)}${admission}
       ON CONFLICT (repo_id, ${key.column}) DO UPDATE SET
         ${updated.map((c) => `${c} = excluded.${c}`).join(", ")}
       WHERE (excluded.epoch_gen, excluded.owner_gen, excluded.version)
           > (${table}.epoch_gen, ${table}.owner_gen, ${table}.version)
         AND NOT (${table}.deleted = 1 AND ${table}.deleted_epoch IS NOT NULL
           AND (excluded.epoch_gen, excluded.updated_seq)
             <= (${table}.deleted_epoch, ${table}.deleted_seq))`,
    )
    .bind(
      position.repoId,
      position.epochGen,
      position.ownerGen,
      position.sourceSeq,
      ...Object.values(values),
      ...writerParams(writer),
    );
}

/**
 * The statements that project an issue or pull request (a deletion's
 * included), in one batch: its row and its full-text index together. A
 * live entity's row must be present (a stored event's is resolved first).
 *
 * Every statement takes the same decision (the fences, the writer's
 * condition and the version guard, over the row as it was), so the group
 * either moves the row and its indexed tuple or touches neither:
 *
 * 1. its repository's number, allocated when a tuple is to be indexed and
 *    it has none, and the counter moved past it;
 * 2. the count of indexed documents, by what the write changes;
 * 3. the old indexed tuple deleted from the index while the row still has
 *    it (its text, its repository's and kind's tokens);
 * 4. the row upserted, marked with this group's token when its indexed
 *    tuple (title, body, kind, whether deleted) changes, its mark kept when
 *    only metadata does, cleared with a deletion;
 * 5. the row marked with the token indexed.
 *
 * A row written before its index existed carries no mark: nothing of it is
 * deleted from the index, and it is indexed once its text changes (or a
 * repair indexes it).
 */
export function docStatements(
  db: D1Database,
  position: SearchPosition,
  entity: ProjectedEntity,
  writer: SearchWriter = EVENT_WRITER,
): D1PreparedStatement[] {
  const number = keyOf(position, entity, "");
  const kind =
    entity.type === ISSUE_ENTITY
      ? DOC_KIND.issue
      : entity.type === PULL_ENTITY
        ? DOC_KIND.pull
        : undefined;
  if (kind === undefined) throw new Error(`not an issue or pull request: ${entity.type}`);
  // A deletion's text and metadata go with it.
  let fields: Record<string, Value> = { kind, assignees: "[]", labels: "[]", draft: 0, locked: 0 };
  for (const column of DOC_TEXT_AND_STATE) fields[column] ??= null;
  if (!entity.deleted) {
    const parsed =
      kind === DOC_KIND.issue
        ? IssueRowSchema.safeParse(entity.row)
        : PullRequestRowSchema.safeParse(entity.row);
    if (!parsed.success || parsed.data.number !== number) throw malformed(entity);
    const row = parsed.data;
    const state = DOC_STATE[row.state];
    fields = {
      kind,
      state,
      open_state: state === DOC_STATE.open ? 1 : 2,
      state_reason: "stateReason" in row ? row.stateReason : null,
      draft: flag("draft" in row && row.draft),
      locked: flag(row.locked),
      lock_reason: row.lockReason,
      author_id: row.authorId,
      author_root: row.authorRoot,
      assignees: JSON.stringify(row.assignees),
      labels: JSON.stringify(row.labels),
      milestone: row.milestone,
      title: row.title,
      body: row.body,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      closed_at: row.closedAt,
      merged_at: "mergedAt" in row ? row.mergedAt : null,
    };
  }
  const values = { ...rowValues(position, entity, "number", number, fields), fts_token: null };
  const columns = Object.keys(values);
  // ?1–?4 the position's, the row's values from ?5 (the key first), then this group's token and
  // the writer's.
  const p = (column: string) => `?${columns.indexOf(column) + 5}`;
  const token = columns.length + 5;
  const at = token + 1;
  const params = [
    position.repoId,
    position.epochGen,
    position.ownerGen,
    position.sourceSeq,
    ...Object.values(values),
    crypto.randomUUID(),
    ...writerParams(writer),
  ];
  const decided = `${eligible(writer, at)}${admitted(writer, "search_docs", "number", at)}`;
  // The row as it was is replaced (see `upsert`).
  const newer = (
    d: string,
  ) => `(?2, ?3, ${p("version")}) > (${d}.epoch_gen, ${d}.owner_gen, ${d}.version)
    AND NOT (${d}.deleted = 1 AND ${d}.deleted_epoch IS NOT NULL
      AND (?2, ?4) <= (${d}.deleted_epoch, ${d}.deleted_seq))`;
  // Its indexed tuple changes.
  const changes = (d: string) => `(${d}.deleted IS NOT ${p("deleted")} OR (${p("deleted")} = 0
    AND (${d}.title IS NOT ${p("title")} OR ${d}.body IS NOT ${p("body")} OR ${d}.kind IS NOT ${p("kind")})))`;
  const old = "SELECT 1 FROM search_docs d WHERE d.repo_id = ?1 AND d.number = ?5";
  // The write is taken: no row yet, or one it replaces.
  const taken = `(NOT EXISTS (${old}) OR EXISTS (${old} AND ${newer("d")}))`;
  const indexed = "d.deleted = 0 AND d.fts_token IS NOT NULL";
  const delta = `((CASE WHEN ${p("deleted")} = 0 AND (NOT EXISTS (${old})
      OR EXISTS (${old} AND ${changes("d")}) OR EXISTS (${old} AND ${indexed})) THEN 1 ELSE 0 END)
    - (CASE WHEN EXISTS (${old} AND ${indexed}) THEN 1 ELSE 0 END))`;
  const updated = [
    "epoch_gen",
    "owner_gen",
    "updated_seq",
    ...columns.filter((c) => c !== "number" && c !== "fts_token"),
  ];
  return [
    bound(
      db,
      `INSERT INTO search_repo_nums (repo_id, num)
       SELECT ?1, next_repo_num FROM search_index_state
       WHERE id = 1 AND ${p("deleted")} = 0
         AND NOT EXISTS (SELECT 1 FROM search_repo_nums WHERE repo_id = ?1)
         AND (NOT EXISTS (${old}) OR EXISTS (${old} AND ${newer("d")} AND ${changes("d")}))
         AND ${decided}`,
      params,
    ),
    db
      .prepare(
        `UPDATE search_index_state SET next_repo_num = next_repo_num + 1
       WHERE id = 1 AND EXISTS (SELECT 1 FROM search_repo_nums
         WHERE repo_id = ?1 AND num = search_index_state.next_repo_num)`,
      )
      .bind(position.repoId),
    // Indexed after (live, and new or changed) less indexed before, when they differ.
    bound(
      db,
      `UPDATE search_index_state SET live_docs = live_docs + ${delta}
       WHERE id = 1 AND ${delta} <> 0 AND ${taken} AND ${decided}`,
      params,
    ),
    bound(
      db,
      `INSERT INTO search_fts (search_fts, rowid, title, body, repo, kind)
       SELECT 'delete', d.doc_id, d.title, d.body, 'r' || n.num, 'k' || d.kind
       FROM search_docs d JOIN search_repo_nums n ON n.repo_id = d.repo_id
       WHERE d.repo_id = ?1 AND d.number = ?5 AND ${indexed} AND ${IN_INDEX()}
         AND ${newer("d")} AND ${changes("d")} AND ${decided}`,
      params,
    ),
    bound(
      db,
      `INSERT INTO search_docs (repo_id, epoch_gen, owner_gen, updated_seq, ${columns.join(", ")})
       SELECT ?1, ?2, ?3, ?4, ${columns.map((c) => (c === "fts_token" ? `CASE WHEN ${p("deleted")} = 0 THEN ?${token} END` : p(c))).join(", ")}
       WHERE ${decided}
       ON CONFLICT (repo_id, number) DO UPDATE SET
         ${updated.map((c) => `${c} = excluded.${c}`).join(", ")},
         fts_token = CASE
           WHEN excluded.deleted = 1 THEN NULL
           WHEN ${changes("search_docs")} THEN ?${token}
           ELSE search_docs.fts_token END
       WHERE ${newer("search_docs")}`,
      params,
    ),
    bound(
      db,
      `INSERT INTO search_fts (rowid, title, body, repo, kind)
       SELECT d.doc_id, d.title, d.body, 'r' || n.num, 'k' || d.kind
       FROM search_docs d JOIN search_repo_nums n ON n.repo_id = d.repo_id
       WHERE d.repo_id = ?1 AND d.number = ?5 AND d.deleted = 0 AND d.fts_token = ?${token}`,
      params,
    ),
  ];
}

/**
 * The statements that put an issue's or pull request's entry back in the
 * full-text index while its row is as `observed` (live, its epoch,
 * ownership, version and mark), unchanged otherwise: a row projected before
 * the index was there (unmarked), or marked but missing from the index.
 * Under the writer's fences and admission, in one batch: its repository's
 * number when it has none, the count of indexed documents when it was
 * unmarked, its mark (this group's token), and its entry from the row's
 * text. A reconciliation's, for rows it found at the export's version.
 */
export function reindexStatements(
  db: D1Database,
  position: SearchPosition,
  number: number,
  observed: {
    readonly epochGen: number;
    readonly ownerGen: number;
    readonly version: number;
    readonly token: string | null;
  },
  writer: SearchWriter,
): D1PreparedStatement[] {
  // ?1–?4 the position's, ?5 the key, ?6–?9 the row as observed, ?10 this group's token, the
  // writer's from ?11.
  const at = 11;
  const params = [
    position.repoId,
    position.epochGen,
    position.ownerGen,
    position.sourceSeq,
    number,
    observed.epochGen,
    observed.ownerGen,
    observed.version,
    observed.token,
    crypto.randomUUID(),
    ...writerParams(writer),
  ];
  const decided = `${eligible(writer, at)}${admitted(writer, "search_docs", "number", at)}`;
  // Still the row observed, still out of the index.
  const out = (d: string) => `${d}.repo_id = ?1 AND ${d}.number = ?5 AND ${d}.deleted = 0
    AND (${d}.epoch_gen, ${d}.owner_gen, ${d}.version) = (?6, ?7, ?8) AND ${d}.fts_token IS ?9
    AND (${d}.fts_token IS NULL OR NOT ${IN_INDEX(d)})`;
  return [
    bound(
      db,
      `INSERT INTO search_repo_nums (repo_id, num)
       SELECT ?1, next_repo_num FROM search_index_state
       WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM search_repo_nums WHERE repo_id = ?1)
         AND EXISTS (SELECT 1 FROM search_docs d WHERE ${out("d")}) AND ${decided}`,
      params,
    ),
    db
      .prepare(
        `UPDATE search_index_state SET next_repo_num = next_repo_num + 1
         WHERE id = 1 AND EXISTS (SELECT 1 FROM search_repo_nums
           WHERE repo_id = ?1 AND num = search_index_state.next_repo_num)`,
      )
      .bind(position.repoId),
    bound(
      db,
      `UPDATE search_index_state SET live_docs = live_docs + 1
       WHERE id = 1 AND EXISTS (SELECT 1 FROM search_docs d WHERE ${out("d")}
         AND d.fts_token IS NULL) AND ${decided}`,
      params,
    ),
    bound(
      db,
      `UPDATE search_docs AS d SET fts_token = ?10 WHERE ${out("d")} AND ${decided}`,
      params,
    ),
    bound(
      db,
      `INSERT INTO search_fts (rowid, title, body, repo, kind)
       SELECT d.doc_id, d.title, d.body, 'r' || n.num, 'k' || d.kind
       FROM search_docs d JOIN search_repo_nums n ON n.repo_id = d.repo_id
       WHERE d.repo_id = ?1 AND d.number = ?5 AND d.deleted = 0 AND d.fts_token = ?10
         AND NOT ${IN_INDEX()}`,
      params,
    ),
  ];
}

/**
 * `sql` bound to `params` through its highest placeholder (a statement of a
 * group that shares one numbering takes no more values than it names).
 */
export function bound(
  db: D1Database,
  sql: string,
  params: readonly (string | number | null)[],
): D1PreparedStatement {
  const last = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
  return db.prepare(sql).bind(...params.slice(0, last));
}

/** The columns a deleted issue's row keeps empty. */
const DOC_TEXT_AND_STATE = [
  "state",
  "open_state",
  "state_reason",
  "lock_reason",
  "author_id",
  "author_root",
  "milestone",
  "title",
  "body",
  "created_at",
  "updated_at",
  "closed_at",
  "merged_at",
] as const;

/** The statement that projects a label (a deletion's included). */
export function labelStatement(
  db: D1Database,
  position: SearchPosition,
  entity: ProjectedEntity,
  writer: SearchWriter = EVENT_WRITER,
): D1PreparedStatement {
  if (entity.type !== LABEL_ENTITY) throw new Error(`not a label: ${entity.type}`);
  const id = keyOf(position, entity, "labels/");
  let fields: Record<string, Value> = { name: null, color: null, description: null };
  if (!entity.deleted) {
    const parsed = LabelRowSchema.safeParse(entity.row);
    if (!parsed.success || parsed.data.id !== id) throw malformed(entity);
    const { name, color, description } = parsed.data;
    fields = { name, color, description };
  }
  return upsert(
    db,
    "search_labels",
    { column: "label_id", value: id },
    position,
    entity,
    fields,
    writer,
  );
}

/** The statement that projects a milestone (a deletion's included). */
export function milestoneStatement(
  db: D1Database,
  position: SearchPosition,
  entity: ProjectedEntity,
  writer: SearchWriter = EVENT_WRITER,
): D1PreparedStatement {
  if (entity.type !== MILESTONE_ENTITY) throw new Error(`not a milestone: ${entity.type}`);
  const number = keyOf(position, entity, "milestones/");
  let fields: Record<string, Value> = {
    title: null,
    state: null,
    description: null,
    due_on: null,
    closed_at: null,
  };
  if (!entity.deleted) {
    const parsed = MilestoneRowSchema.safeParse(entity.row);
    if (!parsed.success || parsed.data.number !== number) throw malformed(entity);
    const row = parsed.data;
    fields = {
      title: row.title,
      state: row.state === "open" ? 1 : 2,
      description: row.description,
      due_on: row.dueOn,
      closed_at: row.closedAt,
    };
  }
  return upsert(
    db,
    "search_milestones",
    { column: "number", value: number },
    position,
    entity,
    fields,
    writer,
  );
}

/** The statements projecting any entity search projects (one batch); undefined for others. */
export function searchStatements(
  db: D1Database,
  position: SearchPosition,
  entity: ProjectedEntity,
  writer: SearchWriter = EVENT_WRITER,
): D1PreparedStatement[] | undefined {
  switch (entity.type) {
    case ISSUE_ENTITY:
    case PULL_ENTITY:
      return docStatements(db, position, entity, writer);
    case LABEL_ENTITY:
      return [labelStatement(db, position, entity, writer)];
    case MILESTONE_ENTITY:
      return [milestoneStatement(db, position, entity, writer)];
    default:
      return undefined;
  }
}
