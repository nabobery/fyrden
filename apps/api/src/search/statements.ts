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
import { SAME_DAY } from "./admission.js";

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
 * Who writes: the events consumer (an event, after the source's cutoff) or
 * a reconciliation pass's page (`gen`, while it is the source's current
 * pass, under the export's epoch and ownership, and still at the page it
 * read: `kind` after `after`).
 */
export type SearchWriter =
  | { readonly by: "event" }
  | {
      readonly by: "reconcile";
      readonly gen: number;
      readonly kind: string;
      readonly after: number;
      /** The day its reservation was taken from (its writes stand only within it). */
      readonly day: number;
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
  return writer.by === "reconcile" ? [writer.gen, writer.kind, writer.after, writer.day] : [];
}

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
  const deletedAt = !entity.deleted
    ? null
    : entity.deletedAt !== undefined
      ? entity.deletedAt
      : { epochGen: position.epochGen, sourceSeq: position.sourceSeq };
  const values: Record<string, Value> = {
    [key.column]: key.value,
    version: entity.version,
    deleted: flag(entity.deleted),
    deleted_epoch: deletedAt?.epochGen ?? null,
    deleted_seq: deletedAt?.sourceSeq ?? null,
    ...fields,
  };
  const columns = Object.keys(values);
  // ?1–?4 are the position's; the row's values follow, then the writer's.
  const at = columns.length + 5;
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
       WHERE ${eligible(writer, at)}
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
 * The statement that projects an issue or pull request (a deletion's
 * included). A live entity's row must be present (a stored event's is
 * resolved first).
 */
export function docStatement(
  db: D1Database,
  position: SearchPosition,
  entity: ProjectedEntity,
  writer: SearchWriter = EVENT_WRITER,
): D1PreparedStatement {
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
  return upsert(
    db,
    "search_docs",
    { column: "number", value: number },
    position,
    entity,
    fields,
    writer,
  );
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

/** The statement projecting any entity search projects; undefined for others. */
export function searchStatement(
  db: D1Database,
  position: SearchPosition,
  entity: ProjectedEntity,
  writer: SearchWriter = EVENT_WRITER,
): D1PreparedStatement | undefined {
  switch (entity.type) {
    case ISSUE_ENTITY:
    case PULL_ENTITY:
      return docStatement(db, position, entity, writer);
    case LABEL_ENTITY:
      return labelStatement(db, position, entity, writer);
    case MILESTONE_ENTITY:
      return milestoneStatement(db, position, entity, writer);
    default:
      return undefined;
  }
}
