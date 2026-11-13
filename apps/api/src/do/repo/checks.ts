import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  advanceCheck,
  atLeast,
  CHECK_CONCLUSIONS,
  CHECK_STATUSES,
  type CheckConclusion,
  type CheckSource,
  type CheckStatus,
  type CheckSummary,
  checkNameKey,
  checkText,
  countedByDefault,
  digestOf,
  FYRDEN_CI_SOURCE,
  isFailing,
  isFullSha,
  MAX_CHECK_ATTEMPTS,
  MAX_CHECK_BATCH,
  MAX_CHECK_NAME_LENGTH,
  MAX_FAILING_SHOWN,
  MAX_STATUS_DESCRIPTION_LENGTH,
  MAX_STATUSES_PER_CONTEXT,
  MAX_STATUSES_PER_SHA,
  MAX_SUMMARIES_PER_SHA,
  MAX_TRIGGER_HOLDERS,
  STATUS_STATES,
  type StatusState,
  settleStatus,
  summaryOfStatus,
  targetUrl,
} from "@fyrden/domain";
import { type Oid, oidFromHex } from "@fyrden/git-core";
import type { RepoEvents } from "./events.js";
import type { PullCaller } from "./pulls.js";

/*
 * Commit statuses and check summaries. A status is kept as posted; each
 * publisher's latest one of a context is also its summary of that check.
 * Fyrden's runs (`ci`) start check attempts here, so this object decides
 * which attempt is current: a start is answered once per caller key, and an
 * update from any other attempt is refused. Calls hold no await, so each is
 * one transaction.
 */

export interface StatusInput {
  readonly state: StatusState;
  readonly context: string;
  readonly description: string | null;
  readonly targetUrl: string | null;
}

export interface StatusRecord {
  readonly id: number;
  readonly sha: string;
  readonly state: StatusState;
  readonly context: string;
  readonly description: string | null;
  readonly targetUrl: string | null;
  /** The principal that posted it (an agent, not the user it acted for). */
  readonly creator: string;
  readonly createdAt: number;
}

/** A page of a commit's statuses, newest first; `next` the id to continue before. */
export interface StatusPage {
  readonly statuses: StatusRecord[];
  readonly next: number | null;
}

/** A commit's combined status: the roll-up over every context, and a page of them in key order. */
export interface CombinedStatus {
  readonly state: "pending" | "success" | "failure";
  readonly totalCount: number;
  readonly statuses: StatusRecord[];
  /** The context key to continue after. */
  readonly next: string | null;
}

export type StatusFailure =
  | "forbidden"
  | "invalid_status"
  | "commit_not_found"
  | "status_limit"
  | "check_limit";

export type StatusAnswer =
  | { readonly ok: true; readonly status: StatusRecord }
  | { readonly ok: false; readonly code: StatusFailure };

/** A check attempt asked for: `startKey` is the caller's stable id for it (a run, job and run attempt). */
export interface CheckStart {
  readonly name: string;
  readonly startKey: string;
  /** Who triggered the run, told when the attempt fails. */
  readonly actor?: string | null;
}

export type CheckStartAnswer =
  | { readonly ok: true; readonly attempt: number; readonly current: boolean }
  | {
      readonly ok: false;
      readonly code:
        | "commit_not_found"
        | "invalid_check"
        | "duplicate_check"
        | "check_limit"
        | "attempt_limit";
    };

export interface CheckUpdate {
  readonly sha: string;
  readonly name: string;
  readonly attempt: number;
  readonly status: CheckStatus;
  /** Set exactly when completed; absent reads as null. */
  readonly conclusion?: CheckConclusion | null;
  /** Absent or null keeps the one the check has. */
  readonly detailsUrl?: string | null;
}

export type CheckUpdateResult =
  | "applied"
  | "unchanged"
  | "stale_attempt"
  | "unknown_attempt"
  | "invalid_transition"
  | "invalid_update";

type SummaryRow = {
  sha: string;
  name_key: string;
  source: string;
  name: string;
  kind: "status" | "check";
  attempt: number | null;
  status: CheckStatus;
  conclusion: CheckConclusion | null;
  settled: CheckConclusion | null;
  settled_attempt: number | null;
  settled_actor_id: string | null;
  status_id: number | null;
  actor_id: string | null;
  details_url: string | null;
  updated_at: number;
};

/** What a pull request's checks are worked out from. */
export interface PullHead {
  readonly number: number;
  readonly state: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly authorId: string;
  readonly authorRoot: string;
}

/** A failing check as `pull_checks` and the feed event name it: the attempt that failed, for a check. */
interface Failing {
  readonly name: string;
  readonly source: CheckSource;
  readonly attempt: number | null;
}

/**
 * What `pull_checks.failing` holds: how many fail, a digest of all of them
 * (so a change past the shown ones is still a change), and the first few.
 */
interface FailingRecord {
  readonly count: number;
  readonly digest: string;
  readonly shown: readonly Failing[];
}

type PullChecksRow = { pr_number: number; head_sha: string; failing: string; holders: string };

type StatusRow = {
  id: number;
  sha: string;
  context: string;
  state: StatusState;
  description: string | null;
  target_url: string | null;
  creator_id: string;
  created_at: number;
};

export class RepoChecks {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: Pick<RepoEvents, "emitActivity">;
    },
  ) {}

  /** Posts a status as `caller`, who must still write here; its summary of the context follows it. */
  createStatus(sha: string, input: StatusInput, caller: PullCaller): StatusAnswer {
    // The change admits any role still held; posting needs write.
    if (!atLeast(caller.role, "write")) return { ok: false, code: "forbidden" };
    if (!validStatus(input)) return { ok: false, code: "invalid_status" };
    if (!this.#hasCommit(sha)) return { ok: false, code: "commit_not_found" };
    const key = checkNameKey(input.context);
    const source = caller.actor.principal;
    const count = (query: string, ...bindings: unknown[]) =>
      this.#exec<{ n: number }>("checks.read", query, ...bindings)[0]?.n ?? 0;
    if (
      count(
        "SELECT count(*) AS n FROM commit_statuses WHERE sha = ? AND context_key = ?",
        sha,
        key,
      ) >= MAX_STATUSES_PER_CONTEXT ||
      count("SELECT count(*) AS n FROM commit_statuses WHERE sha = ?", sha) >= MAX_STATUSES_PER_SHA
    )
      return { ok: false, code: "status_limit" };
    const before = this.#summary(sha, key, source);
    if (
      !before &&
      count("SELECT count(*) AS n FROM check_summaries WHERE sha = ? AND kind = 'status'", sha) >=
        MAX_SUMMARIES_PER_SHA
    )
      return { ok: false, code: "check_limit" };
    const status = this.#storage().transactionSync(() => {
      const now = this.#now();
      const [row] = this.#exec<StatusRow>(
        "checks.status",
        `INSERT INTO commit_statuses (sha, context, context_key, state, description, target_url,
           creator_id, creator_root, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        sha,
        input.context,
        key,
        input.state,
        input.description,
        input.targetUrl,
        source,
        caller.root,
        now,
      );
      const made = row as StatusRow;
      const { status: state, conclusion } = summaryOfStatus(input.state);
      this.#exec(
        "checks.summary",
        `INSERT INTO check_summaries (sha, name_key, source, name, kind, status, conclusion, settled,
           status_id, details_url, updated_at)
         VALUES (?, ?, ?, ?, 'status', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (sha, name_key, source) DO UPDATE SET name = excluded.name,
           status = excluded.status, conclusion = excluded.conclusion, settled = excluded.settled,
           status_id = excluded.status_id, details_url = excluded.details_url,
           updated_at = excluded.updated_at`,
        sha,
        key,
        source,
        input.context,
        state,
        conclusion,
        settleStatus(before?.settled ?? null, input.state),
        made.id,
        input.targetUrl,
        now,
      );
      this.reconcileHeads(sha, caller.actor);
      return statusRecord(made);
    });
    return { ok: true, status };
  }

  /**
   * Starts check attempts of Fyrden's runs on `sha`, one answer per item. A
   * key already started is answered with its attempt, current or not, and
   * changes nothing; a new key makes the next attempt current, keeping the
   * last outcome settled until it completes. A name repeated in the call
   * under another key is refused, so every key answered is recorded.
   */
  startCheckAttempts(sha: string, items: readonly CheckStart[]): CheckStartAnswer[] {
    if (items.length > MAX_CHECK_BATCH)
      throw new RangeError(`check starts come at most ${MAX_CHECK_BATCH} a call`);
    if (!this.#hasCommit(sha)) return items.map(() => ({ ok: false, code: "commit_not_found" }));
    return this.#storage().transactionSync(() => {
      const now = this.#now();
      const named = new Map<string, { startKey: string; answer: CheckStartAnswer }>();
      let summaries: number | undefined;
      return items.map((item): CheckStartAnswer => {
        if (!validStart(item)) return { ok: false, code: "invalid_check" };
        const key = checkNameKey(item.name);
        const earlier = named.get(key);
        if (earlier)
          return earlier.startKey === item.startKey
            ? earlier.answer
            : { ok: false, code: "duplicate_check" };
        const answer = this.#start(sha, key, item, now, () => {
          summaries ??=
            this.#exec<{ n: number }>(
              "checks.read",
              "SELECT count(*) AS n FROM check_summaries WHERE sha = ? AND kind = 'check'",
              sha,
            )[0]?.n ?? 0;
          if (summaries >= MAX_SUMMARIES_PER_SHA) return false;
          summaries++;
          return true;
        });
        named.set(key, { startKey: item.startKey, answer });
        return answer;
      });
    });
  }

  /**
   * Applies updates of Fyrden's runs' checks, one result per item. Each is
   * checked against the state the ones before it left; a check's row is
   * written once, with the last state. Only the current attempt moves, and
   * only forward.
   */
  recordCheckUpdates(updates: readonly CheckUpdate[]): CheckUpdateResult[] {
    if (updates.length > MAX_CHECK_BATCH)
      throw new RangeError(`check updates come at most ${MAX_CHECK_BATCH} a call`);
    return this.#storage().transactionSync(() => {
      // `settled` is indexed: a write that leaves it alone does not set it, so the index entry
      // is not rewritten (an intermediate state then costs one row).
      const states = new Map<
        string,
        { row: SummaryRow; dirty: boolean; settledMoved: boolean } | null
      >();
      const results = updates.map((update): CheckUpdateResult => {
        if (!validUpdate(update)) return "invalid_update";
        const conclusion = update.conclusion ?? null;
        const key = checkNameKey(update.name);
        const id = `${update.sha} ${key}`;
        if (!states.has(id)) {
          const row = this.#summary(update.sha, key, FYRDEN_CI_SOURCE);
          states.set(id, row ? { row, dirty: false, settledMoved: false } : null);
        }
        const state = states.get(id);
        if (!state || update.attempt > (state.row.attempt ?? 0)) return "unknown_attempt";
        if (update.attempt < (state.row.attempt ?? 0)) return "stale_attempt";
        const step = advanceCheck(state.row, { status: update.status, conclusion });
        if (step !== "applied") return step;
        const completed = update.status === "completed";
        state.row = {
          ...state.row,
          status: update.status,
          conclusion,
          details_url: update.detailsUrl ?? state.row.details_url,
          ...(completed && {
            settled: conclusion,
            settled_attempt: update.attempt,
            settled_actor_id: state.row.actor_id,
          }),
        };
        state.dirty = true;
        state.settledMoved ||= completed;
        return "applied";
      });
      const now = this.#now();
      // Only a completion moves what a pull request's failing checks are.
      const settledOn = new Set<string>();
      for (const state of states.values())
        if (state?.dirty) {
          if (state.settledMoved) settledOn.add(state.row.sha);
          const r = state.row;
          const where = [r.sha, r.name_key, r.source, r.attempt] as const;
          if (state.settledMoved)
            this.#exec(
              "checks.summary",
              `UPDATE check_summaries SET status = ?, conclusion = ?, settled = ?, settled_attempt = ?,
                 settled_actor_id = ?, details_url = ?, updated_at = ?
               WHERE sha = ? AND name_key = ? AND source = ? AND attempt = ?`,
              r.status,
              r.conclusion,
              r.settled,
              r.settled_attempt,
              r.settled_actor_id,
              r.details_url,
              now,
              ...where,
            );
          else
            this.#exec(
              "checks.summary",
              `UPDATE check_summaries SET status = ?, conclusion = ?, details_url = ?, updated_at = ?
               WHERE sha = ? AND name_key = ? AND source = ? AND attempt = ?`,
              r.status,
              r.conclusion,
              r.details_url,
              now,
              ...where,
            );
        }
      for (const sha of settledOn) this.reconcileHeads(sha, null);
      return results;
    });
  }

  /**
   * Which of the summaries on a pull request's head count toward its
   * failing checks: with no rule naming required checks, the latest status
   * of each name and every check of Fyrden's runs (the rows the combined
   * status reads). A required-checks rule narrows it to the rows it decides
   * by.
   */
  counts(_pull: Pick<PullHead, "number" | "baseRef">) {
    return (rows: readonly CheckSummary[]): readonly CheckSummary[] => countedByDefault(rows);
  }

  /** In the caller's transaction: reconciles each open pull request whose head is `sha`. */
  reconcileHeads(sha: string, actor: RefActor | null): void {
    const pulls = this.#exec<{
      number: number;
      state: string;
      head_sha: string;
      base_ref: string;
      author_id: string;
      author_root: string;
    }>(
      "checks.read",
      `SELECT number, state, head_sha, base_ref, author_id, author_root FROM pull_requests
       WHERE state = 'open' AND head_sha = ?`,
      sha,
    );
    for (const p of pulls)
      this.reconcile(
        {
          number: p.number,
          state: p.state,
          headSha: p.head_sha,
          baseRef: p.base_ref,
          authorId: p.author_id,
          authorRoot: p.author_root,
        },
        actor,
      );
  }

  /**
   * In the caller's transaction: works out what fails on the pull request's
   * current head (nothing once it is closed) and who holds it (its author,
   * the user its agent acted for, whoever triggered each failing attempt);
   * when that or the head changed, records it and tells the feed, which
   * opens the item for the holders and resolves it for those who left.
   */
  reconcile(pull: PullHead, actor: RefActor | null): void {
    const [before] = this.#exec<PullChecksRow>(
      "checks.read",
      "SELECT * FROM pull_checks WHERE pr_number = ?",
      pull.number,
    );
    let failing: Failing[] = [];
    let holders: string[] = [];
    if (pull.state === "open") {
      const rows = this.#exec<SummaryRow>(
        "checks.read",
        "SELECT * FROM check_summaries WHERE sha = ?",
        pull.headSha,
      );
      const byKey = new Map(rows.map((row) => [`${row.name_key} ${row.source}`, row]));
      const failed = this.counts(pull)(rows.map(summaryOf))
        .map((summary) => byKey.get(`${checkNameKey(summary.name)} ${summary.source}`))
        .filter((row): row is SummaryRow => row !== undefined && isFailing(row.settled))
        .sort((a, b) =>
          a.name_key === b.name_key
            ? a.source < b.source
              ? -1
              : 1
            : a.name_key < b.name_key
              ? -1
              : 1,
        );
      failing = failed.map((row) => ({
        name: row.name,
        source: row.source,
        attempt: row.settled_attempt,
      }));
      if (failing.length > 0) {
        // The author always; the runs' trigger actors up to a bound, the first by id.
        const actors = [
          ...new Set(failed.flatMap((row) => (row.settled_actor_id ? [row.settled_actor_id] : []))),
        ]
          .sort()
          .slice(0, MAX_TRIGGER_HOLDERS);
        holders = [...new Set([pull.authorId, pull.authorRoot, ...actors])].sort();
      }
    }
    // Bounded, so the record fits a row and the event a queue message whatever names fail.
    const record: FailingRecord = {
      count: failing.length,
      digest: failing.length > 0 ? digestOf(JSON.stringify(failing)) : "",
      shown: failing.slice(0, MAX_FAILING_SHOWN),
    };
    const failingJson = JSON.stringify(record);
    const holdersJson = JSON.stringify(holders);
    // A new head always replaces the row: a status has no attempt, so the same failing entries
    // can stand on two heads.
    const unchanged = before
      ? before.head_sha === pull.headSha &&
        before.failing === failingJson &&
        before.holders === holdersJson
      : record.count === 0;
    if (unchanged) return;
    const previous: string[] = before ? (JSON.parse(before.holders) as string[]) : [];
    const released = previous.filter((id) => !holders.includes(id));
    if (record.count > 0)
      this.#exec(
        "checks.pull",
        `INSERT INTO pull_checks (pr_number, head_sha, failing, holders) VALUES (?, ?, ?, ?)
         ON CONFLICT (pr_number) DO UPDATE SET head_sha = excluded.head_sha,
           failing = excluded.failing, holders = excluded.holders`,
        pull.number,
        pull.headSha,
        failingJson,
        holdersJson,
      );
    else this.#exec("checks.pull", "DELETE FROM pull_checks WHERE pr_number = ?", pull.number);
    this.deps.events.emitActivity("pull_request.checks", actor, {
      number: pull.number,
      sha: pull.headSha,
      failing: record.shown,
      failingCount: record.count,
      holders,
      released,
    });
  }

  /** A pull request's failing checks as a feed item shows them, read live; null when none fail. */
  failingText(number: number): string | null {
    const [row] = this.#exec<PullChecksRow>(
      "checks.read",
      "SELECT * FROM pull_checks WHERE pr_number = ?",
      number,
    );
    if (!row) return null;
    const record = JSON.parse(row.failing) as FailingRecord;
    return `${record.count} failing on ${row.head_sha.slice(0, 7)}: ${record.shown.map((f) => f.name).join(", ")}`;
  }

  /** `sha`'s statuses, newest first, before id `before`. */
  listStatuses(sha: string, before: number | null, limit: number): StatusPage {
    const rows = this.#exec<StatusRow>(
      "checks.read",
      "SELECT * FROM commit_statuses WHERE sha = ? AND id < ? ORDER BY id DESC LIMIT ?",
      sha,
      before ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
    );
    const shown = rows.slice(0, limit);
    return {
      statuses: shown.map(statusRecord),
      next: rows.length > limit ? (shown.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * `sha`'s combined status: each context's latest status, whoever posted it,
   * rolled up as GitHub does (failure if any is failure or error, else
   * pending if there is none or any is pending, else success); the page
   * after context key `after`.
   */
  combinedStatus(sha: string, after: string | null, limit: number): CombinedStatus {
    // Each publisher's summary points at its latest status of a context; the context's latest is
    // the greatest of them. At most the commit's 1,000 status summaries.
    const latest = this.#exec<StatusRow & { context_key: string }>(
      "checks.read",
      `SELECT s.* FROM commit_statuses s
       WHERE s.id IN (
         SELECT max(status_id) FROM check_summaries
         WHERE sha = ? AND kind = 'status' GROUP BY name_key)`,
      sha,
    );
    // Ordered and continued with one comparison (SQLite's would order UTF-8 bytes, which UTF-16
    // comparison does not follow past the Basic Multilingual Plane).
    latest.sort((a, b) =>
      a.context_key < b.context_key ? -1 : a.context_key > b.context_key ? 1 : 0,
    );
    const states = new Set(latest.map((row) => row.state));
    const state =
      states.has("failure") || states.has("error")
        ? "failure"
        : latest.length === 0 || states.has("pending")
          ? "pending"
          : "success";
    const rest = after === null ? latest : latest.filter((row) => row.context_key > after);
    const shown = rest.slice(0, limit);
    return {
      state,
      totalCount: latest.length,
      statuses: shown.map(statusRecord),
      next: rest.length > limit ? (shown.at(-1)?.context_key ?? null) : null,
    };
  }

  /** Every publisher's summary of every check on `sha`. */
  summariesOn(sha: string): CheckSummary[] {
    return this.#exec<SummaryRow>(
      "checks.read",
      "SELECT * FROM check_summaries WHERE sha = ? ORDER BY name_key, source",
      sha,
    ).map(summaryOf);
  }

  /** Every publisher's summary of each named check on `sha`, names compared folded. */
  summariesFor(sha: string, names: readonly string[]): CheckSummary[] {
    const keys = new Set(names.map(checkNameKey));
    return this.summariesOn(sha).filter((row) => keys.has(checkNameKey(row.name)));
  }

  /** In the start's transaction: one item's answer; `room` says whether a new summary fits. */
  #start(
    sha: string,
    key: string,
    item: CheckStart,
    now: number,
    room: () => boolean,
  ): CheckStartAnswer {
    const source = FYRDEN_CI_SOURCE;
    const row = this.#summary(sha, key, source);
    const [known] = this.#exec<{ attempt: number }>(
      "checks.read",
      `SELECT attempt FROM check_attempts
       WHERE sha = ? AND name_key = ? AND source = ? AND start_key = ?`,
      sha,
      key,
      source,
      item.startKey,
    );
    if (known) return { ok: true, attempt: known.attempt, current: row?.attempt === known.attempt };
    const attempt = (row?.attempt ?? 0) + 1;
    if (attempt > MAX_CHECK_ATTEMPTS) return { ok: false, code: "attempt_limit" };
    if (!row && !room()) return { ok: false, code: "check_limit" };
    this.#exec(
      "checks.attempt",
      `INSERT INTO check_attempts (sha, name_key, source, attempt, start_key) VALUES (?, ?, ?, ?, ?)`,
      sha,
      key,
      source,
      attempt,
      item.startKey,
    );
    this.#exec(
      "checks.summary",
      `INSERT INTO check_summaries (sha, name_key, source, name, kind, attempt, status, actor_id,
         updated_at)
       VALUES (?, ?, ?, ?, 'check', ?, 'queued', ?, ?)
       ON CONFLICT (sha, name_key, source) DO UPDATE SET name = excluded.name,
         attempt = excluded.attempt, status = 'queued', conclusion = NULL,
         actor_id = excluded.actor_id, details_url = NULL, updated_at = excluded.updated_at`,
      sha,
      key,
      source,
      item.name,
      attempt,
      item.actor ?? null,
      now,
    );
    return { ok: true, attempt, current: true };
  }

  #summary(sha: string, key: string, source: CheckSource): SummaryRow | undefined {
    return this.#exec<SummaryRow>(
      "checks.read",
      "SELECT * FROM check_summaries WHERE sha = ? AND name_key = ? AND source = ?",
      sha,
      key,
      source,
    )[0];
  }

  /** Whether `sha` names a commit this repository has (a fork pull request's head included). */
  #hasCommit(sha: string): boolean {
    if (!isFullSha(sha)) return false;
    const [row] = this.deps.git.commitGraph.readSync([oidFromHex(sha) as Oid], "verified");
    return row?.state === "verified";
  }

  #storage() {
    return this.deps.git.context.storage;
  }

  #now() {
    return this.deps.git.context.now();
  }

  #exec<T extends Record<string, SqlStorageValue>>(
    op: string,
    query: string,
    ...bindings: unknown[]
  ): T[] {
    const cursor = this.#storage().sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op },
        cursor.rowsWritten,
      );
    return rows;
  }
}

function validStatus(input: StatusInput): boolean {
  return (
    STATUS_STATES.includes(input.state) &&
    typeof input.context === "string" &&
    checkText(input.context, MAX_CHECK_NAME_LENGTH).ok &&
    // A description may be empty: clients send "" for none.
    (input.description === null ||
      input.description === "" ||
      (typeof input.description === "string" &&
        checkText(input.description, MAX_STATUS_DESCRIPTION_LENGTH).ok)) &&
    (input.targetUrl === null ||
      (typeof input.targetUrl === "string" && targetUrl(input.targetUrl).ok))
  );
}

function validStart(item: CheckStart): boolean {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof item.name === "string" &&
    checkText(item.name, MAX_CHECK_NAME_LENGTH).ok &&
    typeof item.startKey === "string" &&
    checkText(item.startKey, MAX_CHECK_NAME_LENGTH).ok &&
    (item.actor === undefined || item.actor === null || typeof item.actor === "string")
  );
}

/** Whether an item has the shape of an update; any other is refused alone, never thrown on. */
function validUpdate(update: CheckUpdate): boolean {
  if (typeof update !== "object" || update === null) return false;
  const { conclusion = null, detailsUrl = null } = update;
  return (
    typeof update.sha === "string" &&
    isFullSha(update.sha) &&
    typeof update.name === "string" &&
    checkText(update.name, MAX_CHECK_NAME_LENGTH).ok &&
    Number.isSafeInteger(update.attempt) &&
    update.attempt >= 1 &&
    CHECK_STATUSES.includes(update.status) &&
    (conclusion === null || CHECK_CONCLUSIONS.includes(conclusion)) &&
    (detailsUrl === null || (typeof detailsUrl === "string" && targetUrl(detailsUrl).ok))
  );
}

function summaryOf(row: SummaryRow): CheckSummary {
  return {
    name: row.name,
    source: row.source,
    kind: row.kind,
    attempt: row.attempt,
    statusId: row.status_id,
    status: row.status,
    conclusion: row.conclusion,
    detailsUrl: row.details_url,
    updatedAt: row.updated_at,
  };
}

function statusRecord(row: StatusRow): StatusRecord {
  return {
    id: row.id,
    sha: row.sha,
    state: row.state,
    context: row.context,
    description: row.description,
    targetUrl: row.target_url,
    creator: row.creator_id,
    createdAt: row.created_at,
  };
}
