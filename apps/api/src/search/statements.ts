import {
  type EntitySnapshot,
  ISSUE_ENTITY,
  IssueRowSchema,
  LABEL_ENTITY,
  LabelRowSchema,
  MILESTONE_ENTITY,
  MilestoneRowSchema,
  PULL_ENTITY,
  PullRequestRowSchema,
} from "@fyrden/domain";

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

/**
 * Whether an event at a position may write the source's projections, over
 * `?1` the repository, `?2` the epoch, `?3` the ownership generation and
 * `?4` the sequence: its epoch is not older than the source's newest (the
 * consumer records it first in the same batch), its ownership generation is
 * current, the repository is not deleted (its tombstone is in the read
 * model: its rows are being purged, and none may come back), and it is
 * after the source's cutoff (what an export already carried).
 */
export const ELIGIBLE = `?2 >= (SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?1)
  AND ?3 >= coalesce((SELECT owner_gen FROM source_owner WHERE source_id = ?1), 0)
  AND NOT EXISTS (SELECT 1 FROM repos WHERE repo_id = ?1 AND deleted = 1)
  AND NOT EXISTS (SELECT 1 FROM search_sources
    WHERE repo_id = ?1 AND (cutoff_epoch, cutoff_seq) >= (?2, ?4))`;

/** A row replaces another only when written at a later epoch, ownership or version. */
const NEWER = (table: string) =>
  `(excluded.epoch_gen, excluded.owner_gen, excluded.version)
     > (${table}.epoch_gen, ${table}.owner_gen, ${table}.version)`;

/** What `search_docs.kind` and `state` hold. */
export const DOC_KIND = { issue: 1, pull: 2 } as const;
export const DOC_STATE = { open: 1, closed: 2, merged: 3 } as const;

/** The key after the repository's id in an entity id (`<repo>#<key>`); throws for another repository's. */
function keyOf(position: SearchPosition, entity: EntitySnapshot, prefix: string): number {
  const head = `${position.repoId}#${prefix}`;
  const key = entity.id.startsWith(head) ? Number(entity.id.slice(head.length)) : Number.NaN;
  if (!Number.isSafeInteger(key) || key < 1)
    throw new Error(`a ${entity.type} entity of another repository, or malformed: ${entity.id}`);
  return key;
}

function malformed(entity: EntitySnapshot): Error {
  return new Error(`malformed ${entity.type} row in ${entity.id}`);
}

const flag = (value: boolean) => (value ? 1 : 0);

/**
 * The statement that projects an issue or pull request snapshot (a
 * deletion's included). A live entity's row must be present (a stored
 * event's is resolved first).
 */
export function docStatement(
  db: D1Database,
  position: SearchPosition,
  entity: EntitySnapshot,
): D1PreparedStatement {
  const number = keyOf(position, entity, "");
  const kind =
    entity.type === ISSUE_ENTITY
      ? DOC_KIND.issue
      : entity.type === PULL_ENTITY
        ? DOC_KIND.pull
        : undefined;
  if (kind === undefined) throw new Error(`not an issue or pull request: ${entity.type}`);
  let fields: (string | number | null)[];
  if (entity.deleted) {
    // Its text and metadata gone with it.
    fields = [null, null, null, 0, 0, null, null, null, "[]", "[]"];
    fields.push(...Array<null>(7).fill(null));
  } else {
    const parsed =
      kind === DOC_KIND.issue
        ? IssueRowSchema.safeParse(entity.row)
        : PullRequestRowSchema.safeParse(entity.row);
    if (!parsed.success || parsed.data.number !== number) throw malformed(entity);
    const row = parsed.data;
    const state = DOC_STATE[row.state];
    fields = [
      state,
      state === DOC_STATE.open ? 1 : 2,
      "stateReason" in row ? row.stateReason : null,
      flag("draft" in row && row.draft),
      flag(row.locked),
      row.lockReason,
      row.authorId,
      row.authorRoot,
      JSON.stringify(row.assignees),
      JSON.stringify(row.labels),
      row.milestone,
      row.title,
      row.body,
      row.createdAt,
      row.updatedAt,
      row.closedAt,
      "mergedAt" in row ? row.mergedAt : null,
    ];
  }
  return db
    .prepare(
      `INSERT INTO search_docs (repo_id, epoch_gen, owner_gen, updated_seq, version, number, kind,
         deleted, state, open_state, state_reason, draft, locked, lock_reason, author_id,
         author_root, assignees, labels, milestone, title, body, created_at, updated_at,
         closed_at, merged_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
         ?19, ?20, ?21, ?22, ?23, ?24, ?25
       WHERE ${ELIGIBLE}
       ON CONFLICT (repo_id, number) DO UPDATE SET
         epoch_gen = excluded.epoch_gen, owner_gen = excluded.owner_gen,
         updated_seq = excluded.updated_seq, version = excluded.version, kind = excluded.kind,
         deleted = excluded.deleted, state = excluded.state, open_state = excluded.open_state,
         state_reason = excluded.state_reason, draft = excluded.draft, locked = excluded.locked,
         lock_reason = excluded.lock_reason, author_id = excluded.author_id,
         author_root = excluded.author_root, assignees = excluded.assignees,
         labels = excluded.labels, milestone = excluded.milestone, title = excluded.title,
         body = excluded.body, created_at = excluded.created_at, updated_at = excluded.updated_at,
         closed_at = excluded.closed_at, merged_at = excluded.merged_at
       WHERE ${NEWER("search_docs")}`,
    )
    .bind(
      position.repoId,
      position.epochGen,
      position.ownerGen,
      position.sourceSeq,
      entity.version,
      number,
      kind,
      flag(entity.deleted),
      ...fields,
    );
}

/** The statement that projects a label snapshot (a deletion's included). */
export function labelStatement(
  db: D1Database,
  position: SearchPosition,
  entity: EntitySnapshot,
): D1PreparedStatement {
  if (entity.type !== LABEL_ENTITY) throw new Error(`not a label: ${entity.type}`);
  const id = keyOf(position, entity, "labels/");
  let fields: (string | null)[] = [null, null, null];
  if (!entity.deleted) {
    const parsed = LabelRowSchema.safeParse(entity.row);
    if (!parsed.success || parsed.data.id !== id) throw malformed(entity);
    fields = [parsed.data.name, parsed.data.color, parsed.data.description];
  }
  return db
    .prepare(
      `INSERT INTO search_labels (repo_id, epoch_gen, owner_gen, updated_seq, version, label_id,
         deleted, name, color, description)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
       WHERE ${ELIGIBLE}
       ON CONFLICT (repo_id, label_id) DO UPDATE SET
         epoch_gen = excluded.epoch_gen, owner_gen = excluded.owner_gen,
         updated_seq = excluded.updated_seq, version = excluded.version,
         deleted = excluded.deleted, name = excluded.name, color = excluded.color,
         description = excluded.description
       WHERE ${NEWER("search_labels")}`,
    )
    .bind(
      position.repoId,
      position.epochGen,
      position.ownerGen,
      position.sourceSeq,
      entity.version,
      id,
      flag(entity.deleted),
      ...fields,
    );
}

/** The statement that projects a milestone snapshot (a deletion's included). */
export function milestoneStatement(
  db: D1Database,
  position: SearchPosition,
  entity: EntitySnapshot,
): D1PreparedStatement {
  if (entity.type !== MILESTONE_ENTITY) throw new Error(`not a milestone: ${entity.type}`);
  const number = keyOf(position, entity, "milestones/");
  let fields: (string | number | null)[] = [null, null, null, null, null];
  if (!entity.deleted) {
    const parsed = MilestoneRowSchema.safeParse(entity.row);
    if (!parsed.success || parsed.data.number !== number) throw malformed(entity);
    const row = parsed.data;
    fields = [row.title, row.state === "open" ? 1 : 2, row.description, row.dueOn, row.closedAt];
  }
  return db
    .prepare(
      `INSERT INTO search_milestones (repo_id, epoch_gen, owner_gen, updated_seq, version, number,
         deleted, title, state, description, due_on, closed_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
       WHERE ${ELIGIBLE}
       ON CONFLICT (repo_id, number) DO UPDATE SET
         epoch_gen = excluded.epoch_gen, owner_gen = excluded.owner_gen,
         updated_seq = excluded.updated_seq, version = excluded.version,
         deleted = excluded.deleted, title = excluded.title, state = excluded.state,
         description = excluded.description, due_on = excluded.due_on,
         closed_at = excluded.closed_at
       WHERE ${NEWER("search_milestones")}`,
    )
    .bind(
      position.repoId,
      position.epochGen,
      position.ownerGen,
      position.sourceSeq,
      entity.version,
      number,
      flag(entity.deleted),
      ...fields,
    );
}

/** The statement projecting any entity search projects; undefined for others. */
export function searchStatement(
  db: D1Database,
  position: SearchPosition,
  entity: EntitySnapshot,
): D1PreparedStatement | undefined {
  switch (entity.type) {
    case ISSUE_ENTITY:
    case PULL_ENTITY:
      return docStatement(db, position, entity);
    case LABEL_ENTITY:
      return labelStatement(db, position, entity);
    case MILESTONE_ENTITY:
      return milestoneStatement(db, position, entity);
    default:
      return undefined;
  }
}
