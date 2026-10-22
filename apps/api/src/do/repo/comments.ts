import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { decideComment } from "@fyrden/domain";
import { commentOutput, subjectOutput } from "../../repos/shapes.js";
import { capturable } from "../../webhooks/captures.js";
import type { RepoEvents } from "./events.js";
import { ALL_KINDS, type RepoIssues, type SubjectKind } from "./issues.js";
import type { PullCaller } from "./pulls.js";
import type { ReactionCounts } from "./reactions.js";

/** The entity type comment snapshots travel as in events. */
export const COMMENT_ENTITY = "issue_comment";

export interface CommentRecord {
  readonly id: number;
  /** The issue or pull request it is on. */
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

export type CommentFailure = "not_found" | "comment_not_found" | "forbidden" | "locked";

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

/**
 * Conversation comments on the repository's issues and pull requests; each
 * change commits with its event and audit row, and the event carries what
 * the comment is on as it was then. A caller acts only on the kinds it may
 * (`kinds`): any other is not found. While a conversation is locked, only
 * write access and above write, edit or delete its comments.
 */
export class RepoComments {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
      readonly issues: RepoIssues;
      readonly repoId: () => string;
      /** In a comment's deletion: its reactions go with it. */
      readonly forgetReactions: (id: number) => void;
      /** A comment's reactions counted, as they stand (for webhook captures). */
      readonly reactionsOf: (id: number) => ReactionCounts;
      /** In a change's transaction: a comment's text now (null: deleted), for what it refers to. */
      readonly described: (
        comment: CommentRecord,
        kind: SubjectKind,
        text: string | null,
        actor: RefActor,
      ) => void;
    },
  ) {}

  /** The kind of what comment `id` is on; undefined for no comment. */
  kindOf(id: number): SubjectKind | undefined {
    const comment = this.get(id);
    return comment && this.deps.issues.kindOf(comment.number);
  }

  /** An issue's or pull request's comments, oldest first, after comment `after`. */
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
    kinds: readonly SubjectKind[],
  ): { ok: true; comment: CommentRecord } | { ok: false; code: CommentFailure } {
    const conversation = this.deps.issues.conversation(number);
    if (!conversation || !kinds.includes(conversation.kind))
      return { ok: false, code: "not_found" };
    const decision = decideComment("create", {
      isCommentAuthor: true,
      role: caller.role,
      locked: conversation.locked,
    });
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
    kinds: readonly SubjectKind[],
  ): { ok: true; comment: CommentRecord } | { ok: false; code: CommentFailure } {
    const current = this.#changeable(id, "edit", caller, kinds);
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

  delete(
    id: number,
    caller: PullCaller,
    kinds: readonly SubjectKind[],
  ): { ok: true } | { ok: false; code: CommentFailure } {
    const current = this.#changeable(id, "delete", caller, kinds);
    if (!current.ok) return current;
    this.deps.git.context.storage.transactionSync(() => {
      // What its deletion's webhook tells of it, read before they go.
      const reactions = this.deps.reactionsOf(id);
      this.deps.forgetReactions(id);
      this.#rows("DELETE FROM comments WHERE comment_id = ?", id);
      // Gone, its snapshot carries no row: what it was on, for those told of it.
      this.#emit(
        "deleted",
        { ...current.comment, version: current.comment.version + 1 },
        caller.actor,
        true,
        { number: current.comment.number, comment_id: id },
        reactions,
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
    kinds: readonly SubjectKind[],
  ): { ok: true; comment: CommentRecord } | { ok: false; code: CommentFailure } {
    const comment = this.get(id);
    const conversation = comment && this.deps.issues.conversation(comment.number);
    if (!comment || !conversation || !kinds.includes(conversation.kind))
      return { ok: false, code: "comment_not_found" };
    const decision = decideComment(action, {
      isCommentAuthor: caller.root === comment.authorRoot,
      role: caller.role,
      locked: conversation.locked,
    });
    return decision.ok ? { ok: true, comment } : { ok: false, code: decision.refusal };
  }

  /**
   * Emits the comment's event; its webhook capture is what it is on, as
   * the API shows it, the comment with its reactions (`reactions`, read
   * before a deletion), and an edit's changes.
   */
  #emit(
    event: string,
    comment: CommentRecord,
    actor: RefActor,
    deleted: boolean,
    data: Record<string, unknown> | null = null,
    reactions?: ReactionCounts,
  ): void {
    const { version, ...row } = comment;
    // What it is on, as it was then (webhooks and later readers cannot ask once that changed).
    const conversation = this.deps.issues.conversation(comment.number);
    const parent = conversation && {
      kind: conversation.kind,
      number: comment.number,
      title: conversation.title,
      state: conversation.state,
    };
    this.deps.events.emitEntity(
      `issue_comment.${event}`,
      actor,
      {
        type: COMMENT_ENTITY,
        id: `${this.deps.repoId()}#comment/${comment.id}`,
        version,
        row: deleted ? null : { ...row, actChain: [...row.actChain] },
      },
      { ...data, parent },
      deleted,
      () => {
        const subject = this.deps.issues.subject(comment.number);
        return {
          ...(subject && { issue: capturable(subjectOutput(subject, ALL_KINDS)) }),
          comment: capturable(
            commentOutput({
              ...comment,
              reactions: reactions ?? this.deps.reactionsOf(comment.id),
            }),
          ),
          ...(data?.changes !== undefined && { changes: capturable(data.changes) }),
        };
      },
    );
    if (conversation && (event !== "edited" || "body" in ((data?.changes as object) ?? {})))
      this.deps.described(comment, conversation.kind, deleted ? null : comment.body, actor);
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
