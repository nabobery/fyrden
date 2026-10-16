import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { type CommentSide, decideComment, decideResolution } from "@fyrden/domain";
import type { RepoEvents } from "./events.js";
import type { PullCaller, RepoPulls } from "./pulls.js";

/** The entity type review comment snapshots travel as in events. */
export const REVIEW_COMMENT_ENTITY = "pull_request_review_comment";

/** Where a thread is anchored: lines of one file, on one side, at a head the pull request has had. */
export interface ThreadAnchor {
  readonly commitSha: string;
  /** On the base side: the merge base whose file the lines are of; null on the head side. */
  readonly mergeBaseSha: string | null;
  readonly path: string;
  readonly side: CommentSide;
  readonly line: number;
  readonly startLine: number | null;
}

/**
 * What a pull request's diff compares now: its head, and the merge base of
 * its base branch's tip and that head; null when it was not worked out (no
 * anchor asked needed it) or could not be.
 */
export interface Comparison {
  readonly headSha: string;
  readonly mergeBaseSha: string | null;
}

/**
 * Whether a thread's anchor is no longer on the diff: its head is not the
 * pull request's head, or, on the base side, its merge base is not the
 * comparison's (the base branch can move the merge base with the head
 * unchanged).
 */
export function isOutdated(anchor: ThreadAnchor, now: Comparison | null): boolean {
  return (
    anchor.commitSha !== now?.headSha ||
    (anchor.mergeBaseSha !== null && anchor.mergeBaseSha !== now.mergeBaseSha)
  );
}

/** Whether judging `anchor` needs the comparison's merge base worked out. */
export function needsMergeBase(anchor: ThreadAnchor, headSha: string): boolean {
  return anchor.mergeBaseSha !== null && anchor.commitSha === headSha;
}

export interface ThreadRecord extends ThreadAnchor {
  readonly id: number;
  readonly number: number;
  readonly resolvedAt: number | null;
  readonly resolvedBy: string | null;
  /** Its comments now. */
  readonly comments: number;
  readonly version: number;
}

export interface ReviewCommentRecord {
  readonly id: number;
  readonly number: number;
  readonly threadId: number;
  /** The comment it answers; null for a thread's first. */
  readonly inReplyTo: number | null;
  readonly authorId: string;
  readonly authorRoot: string;
  /** The agents acting for `authorId`, the current one first. */
  readonly actChain: readonly string[];
  readonly body: string;
  readonly anchor: ThreadAnchor;
  readonly resolved: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
}

export type ReviewCommentFailure =
  | "not_found"
  | "comment_not_found"
  | "thread_not_found"
  | "forbidden";

type CommentRow = {
  comment_id: number;
  pr_number: number;
  thread_id: number;
  in_reply_to: number | null;
  author_id: string;
  author_root: string;
  act_chain: string | null;
  body: string;
  created_at: number;
  updated_at: number;
  version: number;
  commit_sha: string;
  merge_base_sha: string | null;
  path: string;
  side: CommentSide;
  line: number;
  start_line: number | null;
  resolved_at: number | null;
};

type ThreadRow = {
  thread_id: number;
  pr_number: number;
  commit_sha: string;
  merge_base_sha: string | null;
  path: string;
  side: CommentSide;
  line: number;
  start_line: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  version: number;
  comments: number;
};

const COMMENT_SELECT = `SELECT c.*, t.commit_sha, t.merge_base_sha, t.path, t.side, t.line, t.start_line,
  t.resolved_at
  FROM review_comments c JOIN review_threads t ON t.thread_id = c.thread_id`;
const THREAD_SELECT = `SELECT t.*, (SELECT count(*) FROM review_comments c WHERE c.thread_id = t.thread_id)
  AS comments FROM review_threads t`;

/**
 * Comments on the repository's pull requests' diffs and their threads;
 * each change commits with its event and audit row. The anchor of a new
 * thread is checked by the caller (it reads the file) before it is created.
 */
export class RepoReviewComments {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
      readonly pulls: RepoPulls;
      readonly repoId: () => string;
    },
  ) {}

  /** A pull request's diff comments, oldest first, after comment `after`. */
  list(number: number, after: number, limit: number): ReviewCommentRecord[] {
    return this.#comments(
      `${COMMENT_SELECT} WHERE c.pr_number = ? AND c.comment_id > ? ORDER BY c.comment_id LIMIT ?`,
      number,
      after,
      limit,
    );
  }

  get(id: number): ReviewCommentRecord | undefined {
    return this.#comments(`${COMMENT_SELECT} WHERE c.comment_id = ?`, id)[0];
  }

  /** A pull request's threads, oldest first, after thread `after`. */
  threads(number: number, after: number, limit: number): ThreadRecord[] {
    return this.#threads(
      `${THREAD_SELECT} WHERE t.pr_number = ? AND t.thread_id > ? ORDER BY t.thread_id LIMIT ?`,
      number,
      after,
      limit,
    );
  }

  thread(number: number, id: number): ThreadRecord | undefined {
    return this.#threads(
      `${THREAD_SELECT} WHERE t.pr_number = ? AND t.thread_id = ?`,
      number,
      id,
    )[0];
  }

  /** Threads not resolved, which a ruleset may require resolved before a merge. */
  unresolved(number: number): number {
    return this.deps.git.context.storage.sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM review_threads WHERE pr_number = ? AND resolved_at IS NULL",
        number,
      )
      .one().n;
  }

  /** Changes when a thread is created, resolved, unresolved or removed. */
  stamp(number: number): string {
    const row = this.deps.git.context.storage.sql
      .exec<{ n: number; last: number; versions: number }>(
        `SELECT count(*) AS n, coalesce(max(thread_id), 0) AS last,
           coalesce(sum(version), 0) AS versions FROM review_threads WHERE pr_number = ?`,
        number,
      )
      .one();
    return `${row.n}:${row.last}:${row.versions}`;
  }

  /** Starts a thread at `anchor` (checked by the caller) with its first comment. */
  start(
    number: number,
    anchor: ThreadAnchor,
    body: string,
    caller: PullCaller,
  ): { ok: true; comment: ReviewCommentRecord } | { ok: false; code: ReviewCommentFailure } {
    if (!this.deps.pulls.get(number)) return { ok: false, code: "not_found" };
    const decision = decideComment("create", { isCommentAuthor: true, role: caller.role });
    if (!decision.ok) return { ok: false, code: decision.refusal };
    const comment = this.deps.git.context.storage.transactionSync(() => {
      const [thread] = this.deps.git.context.storage.sql
        .exec<{ thread_id: number }>(
          `INSERT INTO review_threads (pr_number, commit_sha, merge_base_sha, path, side, line,
             start_line)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING thread_id`,
          number,
          anchor.commitSha,
          anchor.mergeBaseSha,
          anchor.path,
          anchor.side,
          anchor.line,
          anchor.startLine,
        )
        .toArray();
      return this.#insert(number, (thread as { thread_id: number }).thread_id, null, body, caller);
    });
    return { ok: true, comment };
  }

  /** A reply in the thread of comment `to`. */
  reply(
    number: number,
    to: number,
    body: string,
    caller: PullCaller,
  ): { ok: true; comment: ReviewCommentRecord } | { ok: false; code: ReviewCommentFailure } {
    if (!this.deps.pulls.get(number)) return { ok: false, code: "not_found" };
    const parent = this.get(to);
    if (parent?.number !== number) return { ok: false, code: "comment_not_found" };
    const decision = decideComment("create", { isCommentAuthor: true, role: caller.role });
    if (!decision.ok) return { ok: false, code: decision.refusal };
    const comment = this.deps.git.context.storage.transactionSync(() =>
      this.#insert(number, parent.threadId, to, body, caller),
    );
    return { ok: true, comment };
  }

  edit(
    id: number,
    body: string,
    caller: PullCaller,
  ): { ok: true; comment: ReviewCommentRecord } | { ok: false; code: ReviewCommentFailure } {
    const current = this.#changeable(id, "edit", caller);
    if (!current.ok) return current;
    if (current.comment.body === body) return current;
    const comment = this.deps.git.context.storage.transactionSync(() => {
      this.#run(
        "UPDATE review_comments SET body = ?, updated_at = ?, version = version + 1 WHERE comment_id = ?",
        body,
        this.deps.git.context.now(),
        id,
      );
      const edited = this.get(id) as ReviewCommentRecord;
      this.#emit("edited", edited, caller.actor, false, {
        changes: { body: { from: current.comment.body } },
      });
      this.deps.events.auditChange("pull_request_review_comment.edit", caller.actor, {
        number: edited.number,
        comment: id,
      });
      return edited;
    });
    return { ok: true, comment };
  }

  /** Deletes a comment; its thread goes with its last comment. */
  delete(id: number, caller: PullCaller): { ok: true } | { ok: false; code: ReviewCommentFailure } {
    const current = this.#changeable(id, "delete", caller);
    if (!current.ok) return current;
    const { comment } = current;
    this.deps.git.context.storage.transactionSync(() => {
      this.#run("DELETE FROM review_comments WHERE comment_id = ?", id);
      this.#run(
        `DELETE FROM review_threads WHERE thread_id = ?
           AND NOT EXISTS (SELECT 1 FROM review_comments WHERE thread_id = ?)`,
        comment.threadId,
        comment.threadId,
      );
      // Gone, its snapshot carries no row: what it was on, for those told of it.
      this.#emit("deleted", { ...comment, version: comment.version + 1 }, caller.actor, true, {
        number: comment.number,
        comment_id: id,
      });
      this.deps.events.auditChange("pull_request_review_comment.delete", caller.actor, {
        number: comment.number,
        comment: id,
      });
    });
    return { ok: true };
  }

  /** Resolves a thread, or makes it unresolved again; nothing when it already is. */
  resolve(
    number: number,
    threadId: number,
    resolved: boolean,
    caller: PullCaller,
  ): { ok: true; thread: ThreadRecord } | { ok: false; code: ReviewCommentFailure } {
    const pull = this.deps.pulls.get(number);
    if (!pull) return { ok: false, code: "not_found" };
    const thread = this.thread(number, threadId);
    if (!thread) return { ok: false, code: "thread_not_found" };
    const decision = decideResolution({
      isPullAuthor: caller.root === pull.authorRoot,
      role: caller.role,
    });
    if (!decision.ok) return { ok: false, code: decision.refusal };
    if ((thread.resolvedAt !== null) === resolved) return { ok: true, thread };
    const changed = this.deps.git.context.storage.transactionSync(() => {
      this.#run(
        `UPDATE review_threads SET resolved_at = ?, resolved_by = ?, version = version + 1
         WHERE thread_id = ?`,
        resolved ? this.deps.git.context.now() : null,
        resolved ? caller.actor.principal : null,
        threadId,
      );
      const event = resolved ? "resolved" : "unresolved";
      this.deps.events.emitActivity(`pull_request_review_thread.${event}`, caller.actor, {
        number,
        thread: threadId,
      });
      this.deps.events.auditChange(
        `pull_request_review_thread.${resolved ? "resolve" : "unresolve"}`,
        caller.actor,
        { number, thread: threadId },
      );
      return this.thread(number, threadId) as ThreadRecord;
    });
    return { ok: true, thread: changed };
  }

  #insert(
    number: number,
    threadId: number,
    inReplyTo: number | null,
    body: string,
    caller: PullCaller,
  ): ReviewCommentRecord {
    const { actor } = caller;
    const now = this.deps.git.context.now();
    const [row] = this.deps.git.context.storage.sql
      .exec<{ comment_id: number }>(
        `INSERT INTO review_comments (pr_number, thread_id, in_reply_to, author_id, author_root,
           act_chain, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING comment_id`,
        number,
        threadId,
        inReplyTo,
        actor.principal,
        caller.root,
        actor.actChain?.length ? JSON.stringify(actor.actChain) : null,
        body,
        now,
        now,
      )
      .toArray();
    this.#count(1);
    const created = this.get((row as { comment_id: number }).comment_id) as ReviewCommentRecord;
    this.#emit("created", created, actor, false);
    this.deps.events.auditChange("pull_request_review_comment.create", actor, {
      number,
      comment: created.id,
    });
    return created;
  }

  #changeable(
    id: number,
    action: "edit" | "delete",
    caller: PullCaller,
  ): { ok: true; comment: ReviewCommentRecord } | { ok: false; code: ReviewCommentFailure } {
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
    comment: ReviewCommentRecord,
    actor: RefActor,
    deleted: boolean,
    data: Record<string, unknown> | null = null,
  ): void {
    const { version, ...row } = comment;
    this.deps.events.emitEntity(
      `pull_request_review_comment.${event}`,
      actor,
      {
        type: REVIEW_COMMENT_ENTITY,
        id: `${this.deps.repoId()}#review_comment/${comment.id}`,
        version,
        row: deleted ? null : { ...row, actChain: [...row.actChain], anchor: { ...row.anchor } },
      },
      data,
      deleted,
    );
  }

  #comments(query: string, ...bindings: SqlStorageValue[]): ReviewCommentRecord[] {
    return this.deps.git.context.storage.sql
      .exec<CommentRow>(query, ...bindings)
      .toArray()
      .map(commentRecord);
  }

  #threads(query: string, ...bindings: SqlStorageValue[]): ThreadRecord[] {
    return this.deps.git.context.storage.sql
      .exec<ThreadRow>(query, ...bindings)
      .toArray()
      .map(threadRecord);
  }

  #run(query: string, ...bindings: SqlStorageValue[]): void {
    this.#count(this.deps.git.context.storage.sql.exec(query, ...bindings).rowsWritten);
  }

  #count(written: number): void {
    if (written > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "review_comments.write" },
        written,
      );
  }
}

function commentRecord(row: CommentRow): ReviewCommentRecord {
  return {
    id: row.comment_id,
    number: row.pr_number,
    threadId: row.thread_id,
    inReplyTo: row.in_reply_to,
    authorId: row.author_id,
    authorRoot: row.author_root,
    actChain: row.act_chain ? (JSON.parse(row.act_chain) as string[]) : [],
    body: row.body,
    anchor: {
      commitSha: row.commit_sha,
      mergeBaseSha: row.merge_base_sha,
      path: row.path,
      side: row.side,
      line: row.line,
      startLine: row.start_line,
    },
    resolved: row.resolved_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function threadRecord(row: ThreadRow): ThreadRecord {
  return {
    id: row.thread_id,
    number: row.pr_number,
    commitSha: row.commit_sha,
    mergeBaseSha: row.merge_base_sha,
    path: row.path,
    side: row.side,
    line: row.line,
    startLine: row.start_line,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    comments: row.comments,
    version: row.version,
  };
}
