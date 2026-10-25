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
import { issueOutput, labelOutput, milestoneOutput } from "../../repos/shapes.js";
import { ALL_KINDS, capturable, userOf } from "../../webhooks/captures.js";
import type { RepoEvents } from "./events.js";
import type { ExportEntry, ExportedEntity } from "./export.js";
import type { PullCaller, PullRecord, RepoPulls } from "./pulls.js";
import type {
  MetaPlan,
  MetaSubject,
  MilestoneRecord,
  SnapshotMeta,
  SubjectEvent,
  SubjectMeta,
  SubjectTouched,
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
  /** What every listed item must match; none when absent. */
  readonly filter?: SubjectFilter | undefined;
}

/** A listing's filters: each given one must hold. */
export interface SubjectFilter {
  /** Label names (as names compare): all of them; a name the repository lacks matches nothing. */
  readonly labelNames?: readonly string[] | undefined;
  /** Label ids: all of them. */
  readonly labelIds?: readonly number[] | undefined;
  /** An assignee's principal id, or none or any. */
  readonly assignee?: { readonly principal: string } | "none" | "any" | undefined;
  /** A milestone's number, or none or any. */
  readonly milestone?: number | "none" | "any" | undefined;
  /** The principal that opened it (the user an agent opened it for, or the agent). */
  readonly creator?: string | undefined;
}

/** A listing page, and where the next one starts (null when it is the last). */
export interface SubjectPage {
  readonly subjects: Subject[];
  readonly next: SubjectBoundary | null;
}

/**
 * Rows a filtered page reads at most in each index range (the range's
 * index and table rows and its filter's lookups, as the storage counts
 * them): a filter is checked on rows as the range's index yields them, and
 * a range stops once it has enough matches or has read this much, so a
 * page may hold fewer matches than asked for (with a continuation) but
 * never reads much more than this a range, however rare its matches or
 * however many labels its filter names.
 */
export const FILTER_RANGE_READS = 1_000;

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
        /** Its labels, assignees, milestone and reactions as they stand (for webhook captures). */
        readonly of: (number: number) => SubjectMeta;
        /** A milestone as it stands (its counts after a change), for webhook captures. */
        readonly milestone: (number: number) => MilestoneRecord | undefined;
      };
    },
  ) {}

  get(number: number): IssueRecord | undefined {
    const row = this.#rows("SELECT * FROM issues WHERE number = ?", number)[0];
    return row && this.#record(row);
  }

  /**
   * The numbers after `after` of issues, pull requests and deleted issues
   * (one sequence), in order, at most `limit`, each with what it is now.
   */
  exportKeys(after: number, limit: number): ExportEntry[] {
    return this.#exec<{ number: number; kind: "issue" | "pull" | "deleted" }>(
      `SELECT number, kind FROM (
         SELECT * FROM (SELECT number, 'issue' AS kind FROM issues WHERE number > ?1
           ORDER BY number LIMIT ?2)
         UNION ALL SELECT * FROM (SELECT number, 'pull' FROM pull_requests WHERE number > ?1
           ORDER BY number LIMIT ?2)
         UNION ALL SELECT * FROM (SELECT number, 'deleted' FROM issue_tombstones
           WHERE number > ?1 ORDER BY number LIMIT ?2))
       ORDER BY number LIMIT ?2`,
      after,
      limit,
    ).map(({ number, kind }) => ({
      key: number,
      load: () =>
        kind === "pull"
          ? this.deps.pulls.exportOne(number)
          : kind === "issue"
            ? this.#exportIssue(number)
            : this.#exportTombstone(number),
    }));
  }

  /** A live issue as its events carry it. */
  #exportIssue(number: number): ExportedEntity {
    const issue = this.get(number);
    if (!issue) throw new Error(`no issue ${number}`);
    return {
      type: ISSUE_ENTITY,
      id: `${this.deps.repoId()}#${number}`,
      version: issue.version,
      deleted: false,
      row: this.#snapshotRow(issue),
    };
  }

  /** A deleted issue's tombstone, with where its deletion is (when recorded). */
  #exportTombstone(number: number): ExportedEntity {
    const [tombstone] = this.#exec<{
      version: number;
      deleted_epoch: number | null;
      deleted_seq: number | null;
    }>("SELECT version, deleted_epoch, deleted_seq FROM issue_tombstones WHERE number = ?", number);
    if (!tombstone) throw new Error(`no tombstone ${number}`);
    const { version, deleted_epoch: epochGen, deleted_seq: sourceSeq } = tombstone;
    return {
      type: ISSUE_ENTITY,
      id: `${this.deps.repoId()}#${number}`,
      version,
      deleted: true,
      row: null,
      deletedAt: epochGen === null || sourceSeq === null ? null : { epochGen, sourceSeq },
    };
  }

  /** The issue as its events carry it: with its labels, assignees and milestone. */
  #snapshotRow(issue: IssueRecord): Record<string, unknown> {
    const { authorAct: _act, duplicateKind: _kind, version: _version, ...fields } = issue;
    return { ...fields, ...this.deps.meta.snapshot(issue.number) };
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

  /** The issue or pull request numbered `number` with its labels, assignees, milestone and reactions. */
  subject(number: number): Subject | undefined {
    const issue = this.get(number);
    if (issue) return { kind: "issue", issue, meta: this.deps.meta.of(number) };
    const pull = this.deps.pulls.get(number);
    return pull && { kind: "pull", pull, meta: this.deps.meta.of(number) };
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
    for (const { event, data, touched } of events)
      this.#emit(event, record, actor, data, false, { touched });
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
      // What its deletion's webhook tells of it, read before it goes.
      const meta = this.deps.meta.of(number);
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
        { meta },
      );
      // The position of the deletion's event, just appended.
      this.#exec(
        `UPDATE issue_tombstones SET (deleted_epoch, deleted_seq) =
           (SELECT epoch_gen, source_seq FROM repo_meta WHERE id = 1)
         WHERE number = ?`,
        number,
      );
      this.deps.events.auditChange(ISSUE_ACTION_RULES.delete.audit, caller.actor, { number });
    });
    return { ok: true };
  }

  /**
   * A page of the repository's issues and pull requests of `kinds`, in the
   * listing's order, at most `limit`. Each kind and state is its own index
   * range (a continuation splits its boundary into two, so a page never
   * walks rows sharing one sort key), and the ranges are merged here.
   * Without a filter each range takes `limit + 1` rows; with one, each
   * examines rows until it has `limit + 1` matches or has read
   * `FILTER_RANGE_READS`, and the page stops at the earliest point a range
   * stopped examining (what lies past it is not known yet): a page reads a
   * bounded number of rows a range, whatever the repository holds and
   * however rare the matches.
   */
  list(query: SubjectQuery): SubjectPage {
    const { sort, direction, after, limit } = query;
    const desc = direction === "desc";
    const cmp = desc ? "<" : ">";
    const order = desc ? "DESC" : "ASC";
    const keyColumn = sort === "created" ? "number" : "updated_at";
    const before = (a: SubjectBoundary, b: SubjectBoundary) =>
      a.key !== b.key
        ? desc
          ? a.key > b.key
          : a.key < b.key
        : desc
          ? a.number > b.number
          : a.number < b.number;
    const test = query.filter && this.#filterTest(query.filter);
    if (test === null) return { subjects: [], next: null };
    const found: { kind: SubjectKind; number: number; key: number }[] = [];
    /** The earliest last row of a range that may hold more past it. */
    let frontier: SubjectBoundary | null = null;
    for (const kind of query.kinds) {
      const table = TABLES[kind];
      const matches = test ? `, (${test.sql}) AS hit` : "";
      for (const state of STATES[kind][query.state]) {
        const select = `SELECT number, ${keyColumn} AS key${matches} FROM ${table} AS t WHERE state = ?`;
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
        for (const [sql, ...bindings] of ranges) {
          // Unfiltered: a page and one more. Filtered: rows as the index yields them (no LIMIT),
          // until the range has a page and one more of matches or has read its budget.
          const cursor = this.deps.git.context.storage.sql.exec<{
            number: number;
            key: number;
            hit?: number;
          }>(
            test ? sql.replace(/ LIMIT \?$/, "") : sql,
            ...(test ? test.bindings : []),
            ...bindings,
            ...(test ? [] : [limit + 1]),
          );
          let examined = 0;
          let hits = 0;
          let last: SubjectBoundary | null = null;
          let stopped = false;
          for (const row of cursor) {
            examined++;
            last = { key: row.key, number: row.number };
            if (!test || row.hit) {
              hits++;
              found.push({ kind, number: row.number, key: row.key });
            }
            if (test ? hits > limit || cursor.rowsRead >= FILTER_RANGE_READS : examined > limit) {
              stopped = true;
              break;
            }
          }
          if (stopped && last && (frontier === null || before(last, frontier))) frontier = last;
        }
      }
    }
    found.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
    // Only what precedes the frontier is known to be in order with everything unread.
    const known = frontier ? found.filter((f) => !before(frontier as SubjectBoundary, f)) : found;
    const pageRows = known.slice(0, limit);
    const lastRow = pageRows.at(-1);
    // A full page goes on after its last item; a short one after the frontier (nothing up to it
    // matched beyond the page), or ends.
    const next =
      known.length > limit && lastRow ? { key: lastRow.key, number: lastRow.number } : frontier;
    return { subjects: this.#hydrate(pageRows), next };
  }

  /**
   * `filter` as an SQL expression over a listed row `t` (with its
   * bindings): undefined when it asks nothing, null when nothing can match
   * (a label name the repository lacks).
   */
  #filterTest(filter: SubjectFilter): { sql: string; bindings: unknown[] } | null | undefined {
    const terms: string[] = [];
    const bindings: unknown[] = [];
    let labelIds = filter.labelIds ? [...filter.labelIds] : [];
    for (const name of filter.labelNames ?? []) {
      const [row] = this.#exec<{ id: number }>(
        "SELECT id FROM labels WHERE name = ? COLLATE NOCASE",
        name,
      );
      if (!row) return null;
      labelIds.push(row.id);
    }
    labelIds = [...new Set(labelIds)];
    // A deleted label leaves its associations behind (read as nothing): an id that is not a
    // live label's matches nothing.
    if (
      labelIds.length > 0 &&
      this.#exec<{ n: number }>(
        "SELECT count(*) AS n FROM labels WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify(labelIds),
      )[0]?.n !== labelIds.length
    )
      return null;
    if (labelIds.length > 0) {
      terms.push(
        `(SELECT count(*) FROM subject_labels AS l WHERE l.number = t.number
           AND l.label_id IN (SELECT value FROM json_each(?))) = ?`,
      );
      bindings.push(JSON.stringify(labelIds), labelIds.length);
    }
    const assigned = "SELECT 1 FROM subject_assignees AS a WHERE a.number = t.number";
    if (filter.assignee === "none") terms.push(`NOT EXISTS (${assigned})`);
    else if (filter.assignee === "any") terms.push(`EXISTS (${assigned})`);
    else if (filter.assignee) {
      terms.push(`EXISTS (${assigned} AND a.principal = ?)`);
      bindings.push(filter.assignee.principal);
    }
    // A deleted milestone leaves its references behind (read as none).
    const live = "SELECT 1 FROM milestones AS m WHERE m.number = t.milestone";
    if (filter.milestone === "none") terms.push(`NOT EXISTS (${live})`);
    else if (filter.milestone === "any") terms.push(`EXISTS (${live})`);
    else if (filter.milestone !== undefined) {
      if (this.#exec("SELECT 1 FROM milestones WHERE number = ?", filter.milestone).length === 0)
        return null;
      terms.push("t.milestone = ?");
      bindings.push(filter.milestone);
    }
    if (filter.creator !== undefined) {
      terms.push("t.author_id = ?");
      bindings.push(filter.creator);
    }
    return terms.length === 0 ? undefined : { sql: terms.join(" AND "), bindings };
  }

  /** The page's subjects with their records and labels, assignees and milestone. */
  #hydrate(page: readonly { kind: SubjectKind; number: number }[]): Subject[] {
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

  /**
   * Emits the issue's event; its webhook capture is the issue as the API
   * shows it (with its labels, assignees and milestone: `meta`, read
   * before a deletion), what a metadata action `touched`, and an edit's
   * changes.
   */
  #emit(
    event: string,
    issue: IssueRecord,
    actor: RefActor | null,
    data: Record<string, unknown> | null = null,
    deleted = false,
    capture: { readonly meta?: SubjectMeta; readonly touched?: SubjectTouched } = {},
  ): void {
    const { authorAct: _act, duplicateKind: _kind, version, ...fields } = issue;
    const row = deleted ? fields : this.#snapshotRow(issue);
    const { touched } = capture;
    this.deps.events.emitEntity(
      `issue.${event}`,
      actor,
      { type: ISSUE_ENTITY, id: `${this.deps.repoId()}#${issue.number}`, version, row },
      data,
      deleted,
      () => ({
        issue: capturable(
          issueOutput(issue, ALL_KINDS, capture.meta ?? this.deps.meta.of(issue.number)),
        ),
        ...(touched?.label && { label: capturable(labelOutput(touched.label)) }),
        ...(touched?.assignee !== undefined && { assignee: userOf(touched.assignee) }),
        // The milestone set or left, its counts as the change left them.
        ...(touched?.milestone && {
          milestone: capturable(
            milestoneOutput(
              this.deps.meta.milestone(touched.milestone.number) ?? touched.milestone,
              ALL_KINDS,
            ),
          ),
        }),
        ...(data?.changes !== undefined && { changes: capturable(data.changes) }),
      }),
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
