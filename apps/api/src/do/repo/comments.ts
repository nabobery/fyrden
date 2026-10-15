import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { decideComment } from "@fyrden/domain";
import type { RepoEvents } from "./events.js";
import type { PullCaller, RepoPulls } from "./pulls.js";

/** The entity type comment snapshots travel as in events. */
export const COMMENT_ENTITY = "issue_comment";

export interface CommentRecord {
  readonly id: number;
  /** The pull request it is on. */
  readonly number: number;
  readonly authorId: string;
  readonly authorRoot: string;
  /** The agents acting for `authorId`, the current one first. */
  readonly actChain: readonly string[];
  readonly body: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
}

export type CommentFailure = "not_found" | "comment_not_found" | "forbidden";

type Row = {
  comment_id: number;
  number: number;
  author_id: string;
  author_root: string;
  act_chain: string | null;
  body: string;
  created_at: number;
  updated_at: number;
  version: number;
};

/** Conversation comments on the repository's pull requests; each change commits with its event and audit row. */
export class RepoComments {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
      readonly pulls: RepoPulls;
      readonly repoId: () => string;
    },
  ) {}

  /** A pull request's comments, oldest first, after comment `after`. */
  list(number: number, after: number, limit: number): CommentRecord[] {
    return this.#rows(
      "SELECT * FROM comments WHERE number = ? AND comment_id > ? ORDER BY comment_id LIMIT ?",
      number,
      after,
      limit,
    ).map(record);
  }

  get(id: number): CommentRecord | undefined {
    const [row] = this.#rows("SELECT * FROM comments WHERE comment_id = ?", id);
    return row && record(row);
  }

  create(
    number: number,
    body: string,
    caller: PullCaller,
  ): { ok: true; comment: CommentRecord } | { ok: false; code: CommentFailure } {
    if (!this.deps.pulls.get(number)) return { ok: false, code: "not_found" };
    const decision = decideComment("create", { isCommentAuthor: true, role: caller.role });
    if (!decision.ok) return { ok: false, code: decision.refusal };
    const { actor } = caller;
    const comment = this.deps.git.context.storage.transactionSync(() => {
      const now = this.deps.git.context.now();
      const [row] = this.#rows(
        `INSERT INTO comments (number, author_id, author_root, act_chain, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        number,
        actor.principal,
        caller.root,
        actor.actChain?.length ? JSON.stringify(actor.actChain) : null,
        body,
        now,
        now,
      );
      const created = record(row as Row);
      this.#emit("created", created, actor, false);
      this.deps.events.auditChange("issue_comment.create", actor, { number, comment: created.id });
      return created;
    });
    return { ok: true, comment };
  }

  edit(
    id: number,
    body: string,
    caller: PullCaller,
  ): { ok: true; comment: CommentRecord } | { ok: false; code: CommentFailure } {
    const current = this.#changeable(id, "edit", caller);
    if (!current.ok) return current;
    if (current.comment.body === body) return current;
    const comment = this.deps.git.context.storage.transactionSync(() => {
      const [row] = this.#rows(
        "UPDATE comments SET body = ?, updated_at = ?, version = version + 1 WHERE comment_id = ? RETURNING *",
        body,
        this.deps.git.context.now(),
        id,
      );
      const edited = record(row as Row);
      this.#emit("edited", edited, caller.actor, false, {
        changes: { body: { from: current.comment.body } },
      });
      this.deps.events.auditChange("issue_comment.edit", caller.actor, {
        number: edited.number,
        comment: id,
      });
      return edited;
    });
    return { ok: true, comment };
  }

  delete(id: number, caller: PullCaller): { ok: true } | { ok: false; code: CommentFailure } {
    const current = this.#changeable(id, "delete", caller);
    if (!current.ok) return current;
    this.deps.git.context.storage.transactionSync(() => {
      this.#rows("DELETE FROM comments WHERE comment_id = ?", id);
      this.#emit(
        "deleted",
        { ...current.comment, version: current.comment.version + 1 },
        caller.actor,
        true,
      );
      this.deps.events.auditChange("issue_comment.delete", caller.actor, {
        number: current.comment.number,
        comment: id,
      });
    });
    return { ok: true };
  }

  #changeable(
    id: number,
    action: "edit" | "delete",
    caller: PullCaller,
  ): { ok: true; comment: CommentRecord } | { ok: false; code: CommentFailure } {
    const comment = this.get(id);
    if (!comment) return { ok: false, code: "comment_not_found" };
    const decision = decideComment(action, {
      isCommentAuthor: caller.root === comment.authorRoot,
      role: caller.role,
    });
    return decision.ok ? { ok: true, comment } : { ok: false, code: decision.refusal };
  }

  #emit(
    event: string,
    comment: CommentRecord,
    actor: RefActor,
    deleted: boolean,
    data: Record<string, unknown> | null = null,
  ): void {
    const { version, ...row } = comment;
    this.deps.events.emitEntity(
      `issue_comment.${event}`,
      actor,
      {
        type: COMMENT_ENTITY,
        id: `${this.deps.repoId()}#comment/${comment.id}`,
        version,
        row: deleted ? null : { ...row, actChain: [...row.actChain] },
      },
      data,
      deleted,
    );
  }

  #rows(query: string, ...bindings: SqlStorageValue[]): Row[] {
    const cursor = this.deps.git.context.storage.sql.exec<Row>(query, ...bindings);
    const rows = cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "comments.write" },
        cursor.rowsWritten,
      );
    return rows;
  }
}

function record(row: Row): CommentRecord {
  return {
    id: row.comment_id,
    number: row.number,
    authorId: row.author_id,
    authorRoot: row.author_root,
    actChain: row.act_chain ? (JSON.parse(row.act_chain) as string[]) : [],
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
