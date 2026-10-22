import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  decideIssueAction,
  type FeedSubjectKind,
  ISSUE_ACTION_RULES,
  ISSUE_ENTITY,
  type IssueAction,
  type IssueRefusal,
  type IssueRow,
  type IssueState,
  type IssueStatePatch,
  type IssueStateReason,
  type IssueStateRefusal,
  type LockReason,
  planIssueState,
  type SubjectMetaField,
} from "@fyrden/domain";
import type { RepoEvents } from "./events.js";
import type { PullCaller, PullRecord, RepoPulls } from "./pulls.js";
import type {
  MetaPlan,
  MetaSubject,
  SnapshotMeta,
  SubjectEvent,
  SubjectMeta,
} from "./subject-meta.js";

/*
 * The repository's issues. They take their numbers from the sequence pull
 * requests take theirs from (`repo_meta.next_number`), read and advanced in
 * the transaction that writes the row, so no two subjects share one. Every
 * change commits with its event and audit row; a deleted issue leaves a
 * tombstone for good (numbers are never used again, and feeds check it
 * when they show the issue's items).
 */

/** What a subject's number names: an issue or a pull request. */
export type SubjectKind = FeedSubjectKind;

/** An issue as the repository keeps it (its labels, assignees and milestone are read apart). */
export interface IssueRecord extends Omit<IssueRow, SubjectMetaField> {
  /** The agents that opened it for `authorId`, the current one first; empty when it acted itself. */
  readonly authorAct: readonly string[];
  /** What `duplicateOf` names now: null when nothing (it was deleted, or there is none). */
  readonly duplicateKind: SubjectKind | null;
  /** Bumped on every change. */
  readonly version: number;
}

/** A change asked of an issue; a field left out stays as it is. */
export interface IssuePatch extends IssueStatePatch {
  readonly title?: string;
  readonly body?: string | null;
}

export type IssueChangeFailure =
  | IssueRefusal
  | IssueStateRefusal
  | "not_found"
  /** A duplicate target that does not exist, or that the caller may not read. */
  | "duplicate_target_not_found";

/** A listing's sort key: the number (creation order) or the time of the last change. */
export type SubjectSort = "created" | "updated";

/** Where a listing page starts after: the last item's sort key and number. */
export interface SubjectBoundary {
  readonly key: number;
  readonly number: number;
}

export interface SubjectQuery {
  readonly kinds: readonly SubjectKind[];
  readonly state: "open" | "closed" | "all";
  readonly sort: SubjectSort;
  readonly direction: "asc" | "desc";
  readonly after: SubjectBoundary | null;
  readonly limit: number;
}

/** A listed subject: an issue, or a pull request as the issue endpoints answer it, with its labels, assignees and milestone. */
export type Subject =
  | { readonly kind: "issue"; readonly issue: IssueRecord; readonly meta: SubjectMeta }
  | { readonly kind: "pull"; readonly pull: PullRecord; readonly meta: SubjectMeta };

type Row = {
  number: number;
  title: string;
  body: string | null;
  state: IssueState;
  state_reason: IssueStateReason | null;
  duplicate_of: number | null;
  locked: number;
  lock_reason: LockReason | null;
  author_id: string;
  author_root: string;
  author_act: string | null;
  closed_at: number | null;
  closed_by: string | null;
  milestone: number | null;
  version: number;
  created_at: number;
  updated_at: number;
};

/** The states a listing's `state` takes of each kind (`closed` pull requests include merged ones). */
const STATES: Record<SubjectKind, Record<SubjectQuery["state"], readonly string[]>> = {
  issue: { open: ["open"], closed: ["closed"], all: ["open", "closed"] },
  pull: { open: ["open"], closed: ["closed", "merged"], all: ["open", "closed", "merged"] },
};
const TABLES: Record<SubjectKind, string> = { issue: "issues", pull: "pull_requests" };

export class RepoIssues {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
      readonly pulls: RepoPulls;
      readonly repoId: () => string;
      /** What an issue's labels, assignees and milestone are: read into its snapshots, gone with it. */
      readonly meta: {
        readonly snapshot: (number: number) => SnapshotMeta;
        readonly forget: (number: number) => void;
        /** The reactions to it and to its comments, gone with it (before its comments). */
        readonly forgetReactions: (number: number) => void;
        /** In a change's transaction: its body now, for what it refers to. */
        readonly described: (number: number, body: string | null, actor: RefActor | null) => void;
        /** In its deletion: what it and its comments refer to, and what refers to it, go. */
        readonly forgetReferences: (number: number, actor: RefActor) => void;
        readonly ofMany: (subjects: readonly MetaSubject[]) => Map<number, SubjectMeta>;
      };
    },
  ) {}

  get(number: number): IssueRecord | undefined {
    const row = this.#rows("SELECT * FROM issues WHERE number = ?", number)[0];
    return row && this.#record(row);
  }

  /** Whether `number` is an issue or a pull request now; undefined for neither (never, or deleted). */
  kindOf(number: number): SubjectKind | undefined {
    const [row] = this.#exec<{ kind: SubjectKind }>(
      `SELECT 'issue' AS kind FROM issues WHERE number = ?1
       UNION ALL SELECT 'pull' FROM pull_requests WHERE number = ?1`,
      number,
    );
    return row?.kind;
  }

  /** Whether the issue or pull request numbered `number` was deleted (issues only: a tombstone). */
  deleted(number: number): boolean {
    return this.#exec("SELECT 1 FROM issue_tombstones WHERE number = ?", number).length > 0;
  }

  /** The issue's or pull request's conversation: its kind, whether it is locked, its title and state. */
  conversation(
    number: number,
  ): { kind: SubjectKind; locked: boolean; title: string; state: string } | undefined {
    const issue = this.get(number);
    if (issue)
      return { kind: "issue", locked: issue.locked, title: issue.title, state: issue.state };
    const pull = this.deps.pulls.get(number);
    return pull && { kind: "pull", locked: pull.locked, title: pull.title, state: pull.state };
  }

  /**
   * Opens an issue: its number, row, what `meta` gives it (labels,
   * assignees, a milestone: its opening event carries them), event and
   * audit row in one transaction; `meta` gives the checked change for the
   * number it takes.
   */
  open(
    input: { readonly title: string; readonly body: string | null },
    caller: PullCaller,
    meta?: (number: number) => MetaPlan,
  ): IssueRecord {
    const { storage } = this.deps.git.context;
    return storage.transactionSync(() => {
      const now = this.deps.git.context.now();
      // Read and advanced with the insert, with no await between: numbers are never shared.
      const number = storage.sql
        .exec<{ next_number: number }>("SELECT next_number FROM repo_meta WHERE id = 1")
        .one().next_number;
      storage.sql.exec("UPDATE repo_meta SET next_number = ? WHERE id = 1", number + 1);
      const [row] = this.#rows(
        `INSERT INTO issues (number, title, body, state, author_id, author_root, author_act,
           created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?) RETURNING *`,
        number,
        input.title,
        input.body,
        caller.actor.principal,
        caller.root,
        caller.actor.actChain?.length ? JSON.stringify(caller.actor.actChain) : null,
        now,
        now,
      );
      meta?.(number).apply(false);
      const opened = this.#record(row as Row);
      this.#emit("opened", opened, caller.actor);
      this.deps.events.auditChange("issue.open", caller.actor, { number });
      return opened;
    });
  }

  /**
   * Applies a patch as the matrix allows, all of it or nothing: the edit
   * first, then the change of state. A duplicate target must be an issue
   * or a pull request of the repository of one of the kinds the caller
   * reads (`readable`). Each action emits its event and writes its audit
   * row, in one transaction.
   */
  change(
    number: number,
    patch: IssuePatch,
    caller: PullCaller,
    readable: readonly SubjectKind[],
    /** A change of its labels, assignees or milestone, checked already, applied with the rest. */
    meta?: MetaPlan,
  ): { ok: true; record: IssueRecord } | { ok: false; code: IssueChangeFailure } {
    const current = this.get(number);
    if (!current) return { ok: false, code: "not_found" };
    const now = this.deps.git.context.now();
    const plan = planIssueState(current, patch, { number, actor: caller.actor.principal, now });
    if (!plan.ok) return { ok: false, code: plan.refusal };
    // A target given is checked first, whatever else the patch asks or whether it changes
    // anything: one the caller may not read answers as one that does not exist.
    const target = patch.duplicateOf;
    if (target !== undefined) {
      const kind = this.kindOf(target);
      if (!kind || !readable.includes(kind))
        return { ok: false, code: "duplicate_target_not_found" };
    }
    const title = patch.title ?? current.title;
    const body = patch.body === undefined ? current.body : patch.body;
    const edits = title !== current.title || body !== current.body;
    const actions: IssueAction[] = [
      ...(edits ? (["edit"] as const) : []),
      ...(plan.action ? [plan.action] : []),
    ];
    for (const action of actions) {
      const decision = decideIssueAction(action, {
        state: current.state,
        isAuthor: caller.root === current.authorRoot,
        role: caller.role,
      });
      if (!decision.ok) return { ok: false, code: decision.refusal };
    }
    if (actions.length === 0 && !meta?.changes) return { ok: true, record: current };
    const changed = this.deps.git.context.storage.transactionSync(() => {
      let record = current;
      if (edits) {
        const [row] = this.#update(number, now, "title = ?, body = ?", title, body);
        record = this.#record(row as Row);
        this.#emit("edited", record, caller.actor, {
          changes: {
            ...(title !== current.title && { title: { from: current.title } }),
            ...(body !== current.body && { body: { from: current.body } }),
          },
        });
        this.deps.events.auditChange(ISSUE_ACTION_RULES.edit.audit, caller.actor, { number });
      }
      if (plan.action && plan.event) {
        const { next } = plan;
        const [row] = this.#update(
          number,
          now,
          "state = ?, state_reason = ?, duplicate_of = ?, closed_at = ?, closed_by = ?",
          next.state,
          next.stateReason,
          next.duplicateOf,
          next.closedAt,
          next.closedBy,
        );
        const before = record;
        record = this.#record(row as Row);
        this.#emit(
          plan.event,
          record,
          caller.actor,
          plan.event === "edited"
            ? { changes: { state_reason: { from: before.stateReason } } }
            : null,
        );
        this.deps.events.auditChange(ISSUE_ACTION_RULES[plan.action].audit, caller.actor, {
          number,
          ...(record.stateReason && { reason: record.stateReason }),
          ...(record.duplicateOf !== null && { duplicate_of: record.duplicateOf }),
        });
      }
      if (meta?.changes) {
        meta.apply(true);
        record = this.get(number) as IssueRecord;
      }
      return record;
    });
    return { ok: true, record: changed };
  }

  /**
   * In a merge's transaction, or applying another repository's: closes an
   * issue a merged pull request's description names (`completed`, closed by
   * `actor`), naming the pull request when it is this repository's. An
   * issue closed already, or none, changes nothing.
   */
  closeByReference(number: number, pull: number | null, actor: RefActor): boolean {
    const current = this.get(number);
    if (current?.state !== "open") return false;
    const now = this.deps.git.context.now();
    const [row] = this.#update(
      number,
      now,
      "state = 'closed', state_reason = 'completed', closed_at = ?, closed_by = ?",
      now,
      actor.principal,
    );
    this.#emit(
      "closed",
      this.#record(row as Row),
      actor,
      pull === null ? null : { pull_request: pull },
    );
    this.deps.events.auditChange(ISSUE_ACTION_RULES.close.audit, actor, {
      number,
      reason: "completed",
      ...(pull !== null && { pull_request: pull }),
    });
    return true;
  }

  /**
   * In a change's transaction: the issue's labels, assignees or milestone
   * changed; bumps its version and update time and emits `events` with its
   * snapshot as it now stands.
   */
  touch(number: number, events: readonly SubjectEvent[], actor: RefActor): void {
    const [row] = this.#update(number, this.deps.git.context.now(), "");
    const record = this.#record(row as Row);
    for (const { event, data } of events) this.#emit(event, record, actor, data);
  }

  /**
   * Locks or unlocks an issue's or a pull request's conversation (write
   * access), for a caller that may act on its kind (`kinds`). Changing
   * nothing (locked already with that reason) emits nothing.
   */
  setLock(
    number: number,
    lock: { readonly locked: boolean; readonly reason: LockReason | null },
    caller: PullCaller,
    kinds: readonly SubjectKind[],
  ):
    | { ok: true; locked: boolean; reason: LockReason | null }
    | { ok: false; code: "not_found" | "forbidden" } {
    const kind = this.kindOf(number);
    if (!kind || !kinds.includes(kind)) return { ok: false, code: "not_found" };
    const action = lock.locked ? "lock" : "unlock";
    const reason = lock.locked ? lock.reason : null;
    if (kind === "pull") {
      const result = this.deps.pulls.setLock(number, lock.locked, reason, caller);
      return result.ok ? { ok: true, locked: lock.locked, reason } : result;
    }
    const current = this.get(number) as IssueRecord;
    const decision = decideIssueAction(action, {
      state: current.state,
      isAuthor: caller.root === current.authorRoot,
      role: caller.role,
    });
    if (!decision.ok) return { ok: false, code: "forbidden" };
    if (current.locked === lock.locked && current.lockReason === reason)
      return { ok: true, locked: lock.locked, reason };
    this.deps.git.context.storage.transactionSync(() => {
      const now = this.deps.git.context.now();
      const [row] = this.#update(
        number,
        now,
        "locked = ?, lock_reason = ?",
        lock.locked ? 1 : 0,
        reason,
      );
      this.#emit(lock.locked ? "locked" : "unlocked", this.#record(row as Row), caller.actor);
      this.deps.events.auditChange(ISSUE_ACTION_RULES[action].audit, caller.actor, {
        number,
        ...(reason && { reason }),
      });
    });
    return { ok: true, locked: lock.locked, reason };
  }

  /**
   * Deletes an issue for good (admin): its comments and feed participants
   * go with it, a tombstone (no text) stays, its deletion is emitted and
   * audited, all in one transaction.
   */
  delete(
    number: number,
    caller: PullCaller,
  ): { ok: true } | { ok: false; code: "not_found" | IssueRefusal } {
    const current = this.get(number);
    if (!current) return { ok: false, code: "not_found" };
    const decision = decideIssueAction("delete", {
      state: current.state,
      isAuthor: caller.root === current.authorRoot,
      role: caller.role,
    });
    if (!decision.ok) return { ok: false, code: decision.refusal };
    this.deps.git.context.storage.transactionSync(() => {
      const now = this.deps.git.context.now();
      const version = current.version + 1;
      this.deps.meta.forgetReactions(number);
      this.deps.meta.forgetReferences(number, caller.actor);
      this.#exec("DELETE FROM comments WHERE number = ?", number);
      this.#exec("DELETE FROM feed_participants WHERE number = ?", number);
      this.#exec("DELETE FROM feed_participation WHERE number = ?", number);
      this.deps.meta.forget(number);
      this.#exec("DELETE FROM issues WHERE number = ?", number);
      this.#exec(
        "INSERT INTO issue_tombstones (number, version, deleted_at, deleted_by) VALUES (?, ?, ?, ?)",
        number,
        version,
        now,
        caller.actor.principal,
      );
      this.#emit(
        "deleted",
        { ...current, version },
        caller.actor,
        { number, title: current.title },
        true,
      );
      this.deps.events.auditChange(ISSUE_ACTION_RULES.delete.audit, caller.actor, { number });
    });
    return { ok: true };
  }

  /**
   * A page of the repository's issues and pull requests of `kinds`, in the
   * listing's order, at most `limit`. Each kind and state is its own index
   * range (a continuation splits its boundary into two, so a page never
   * walks rows sharing one sort key), each taking at most `limit` rows, and
   * the ranges are merged here: a page reads at most a few `limit`s of
   * rows, whatever the repository holds.
   */
  list(query: SubjectQuery): Subject[] {
    const { sort, direction, after, limit } = query;
    const desc = direction === "desc";
    const cmp = desc ? "<" : ">";
    const order = desc ? "DESC" : "ASC";
    const keyColumn = sort === "created" ? "number" : "updated_at";
    const found: { kind: SubjectKind; number: number; key: number }[] = [];
    for (const kind of query.kinds) {
      const table = TABLES[kind];
      for (const state of STATES[kind][query.state]) {
        const select = `SELECT number, ${keyColumn} AS key FROM ${table} WHERE state = ?`;
        const ranges: [string, ...unknown[]][] =
          after === null
            ? [[`${select} ORDER BY ${keyColumn} ${order}, number ${order} LIMIT ?`, state]]
            : sort === "created"
              ? [
                  [
                    `${select} AND number ${cmp} ? ORDER BY number ${order} LIMIT ?`,
                    state,
                    after.number,
                  ],
                ]
              : [
                  [
                    `${select} AND updated_at = ? AND number ${cmp} ? ORDER BY number ${order} LIMIT ?`,
                    state,
                    after.key,
                    after.number,
                  ],
                  [
                    `${select} AND updated_at ${cmp} ? ORDER BY updated_at ${order}, number ${order} LIMIT ?`,
                    state,
                    after.key,
                  ],
                ];
        for (const [sql, ...bindings] of ranges)
          for (const row of this.#exec<{ number: number; key: number }>(sql, ...bindings, limit))
            found.push({ kind, ...row });
      }
    }
    found.sort((a, b) =>
      a.key !== b.key
        ? desc
          ? b.key - a.key
          : a.key - b.key
        : desc
          ? b.number - a.number
          : a.number - b.number,
    );
    const page = found.slice(0, limit);
    const pulls = new Map<number, PullRecord>();
    const issues = new Map(
      this.#rows(
        "SELECT * FROM issues WHERE number IN (SELECT value FROM json_each(?))",
        JSON.stringify(page.filter((p) => p.kind === "issue").map((p) => p.number)),
      ).map((row) => [row.number, this.#record(row)]),
    );
    const metas = this.deps.meta.ofMany([
      ...issues.values(),
      ...page.flatMap((p) => {
        const pull = p.kind === "pull" ? this.deps.pulls.get(p.number) : undefined;
        if (pull) pulls.set(p.number, pull);
        return pull ? [pull] : [];
      }),
    ]);
    return page.flatMap((p): Subject[] => {
      const meta = metas.get(p.number) as SubjectMeta;
      if (p.kind === "issue") {
        const issue = issues.get(p.number);
        return issue ? [{ kind: "issue", issue, meta }] : [];
      }
      const pull = pulls.get(p.number);
      return pull ? [{ kind: "pull", pull, meta }] : [];
    });
  }

  #update(number: number, now: number, assignments: string, ...values: unknown[]): Row[] {
    return this.#rows(
      `UPDATE issues SET ${assignments && `${assignments}, `}version = version + 1, updated_at = ?
       WHERE number = ? RETURNING *`,
      ...values,
      now,
      number,
    );
  }

  #emit(
    event: string,
    issue: IssueRecord,
    actor: RefActor | null,
    data: Record<string, unknown> | null = null,
    deleted = false,
  ): void {
    const { authorAct: _act, duplicateKind: _kind, version, ...fields } = issue;
    const row = deleted ? fields : { ...fields, ...this.deps.meta.snapshot(issue.number) };
    this.deps.events.emitEntity(
      `issue.${event}`,
      actor,
      { type: ISSUE_ENTITY, id: `${this.deps.repoId()}#${issue.number}`, version, row },
      data,
      deleted,
    );
    if (
      event === "opened" ||
      (event === "edited" && data?.changes && "body" in (data.changes as object))
    )
      this.deps.meta.described(issue.number, issue.body, actor);
  }

  #record(row: Row): IssueRecord {
    return {
      number: row.number,
      title: row.title,
      body: row.body,
      state: row.state,
      stateReason: row.state_reason,
      duplicateOf: row.duplicate_of,
      duplicateKind: row.duplicate_of === null ? null : (this.kindOf(row.duplicate_of) ?? null),
      locked: row.locked === 1,
      lockReason: row.lock_reason,
      authorId: row.author_id,
      authorRoot: row.author_root,
      authorAct: row.author_act ? (JSON.parse(row.author_act) as string[]) : [],
      closedAt: row.closed_at,
      closedBy: row.closed_by,
      milestone: row.milestone,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    };
  }

  #rows(query: string, ...bindings: unknown[]): Row[] {
    return this.#exec<Row>(query, ...bindings);
  }

  #exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.deps.git.context.storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "issues.write" },
        cursor.rowsWritten,
      );
    return rows;
  }
}
