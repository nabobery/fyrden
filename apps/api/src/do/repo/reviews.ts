import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  decideDismissal,
  decideReview,
  decideReviewRequest,
  MAX_REQUESTED_REVIEWERS,
  principalTypeOf,
  type RepoRole,
  type ReviewEvent,
  type ReviewState,
  reviewStateOf,
} from "@fyrden/domain";
import type { RepoEvents } from "./events.js";
import type { PullCaller, PullRecord, RepoPulls } from "./pulls.js";

/** The entity type review snapshots travel as in events. */
export const REVIEW_ENTITY = "pull_request_review";

export interface ReviewRecord {
  readonly id: number;
  readonly number: number;
  readonly reviewerId: string;
  /** The root identity it counts as (a person's own agents share the person's). */
  readonly reviewerRoot: string;
  /** Submitted by an agent, its own token or acting for a person. */
  readonly byAgent: boolean;
  /** The agents acting for `reviewerId`, the current one first. */
  readonly actChain: readonly string[];
  readonly state: ReviewState;
  readonly commitSha: string;
  readonly body: string | null;
  readonly submittedAt: number;
  readonly dismissedAt: number | null;
  readonly dismissedBy: string | null;
  readonly dismissalMessage: string | null;
  readonly version: number;
}

/** A principal a review may be requested of, with what the repository object found. */
export interface RequestedReviewer {
  readonly id: string;
  readonly root: string;
  /** Its role on the repository now (capped by its owner's, for an agent); null for none. */
  readonly role: RepoRole | null;
}

export type ReviewFailure =
  | "not_found"
  | "review_not_found"
  | "forbidden"
  | "wrong_state"
  | "own_pull_request"
  | "body_required"
  | "commit_not_in_pull"
  | "reviewer_no_access"
  | "reviewer_is_author"
  | "too_many_reviewers";

type Row = {
  review_id: number;
  pr_number: number;
  reviewer_id: string;
  reviewer_root: string;
  by_agent: number;
  act_chain: string | null;
  state: ReviewState;
  commit_sha: string;
  body: string | null;
  submitted_at: number;
  dismissed_at: number | null;
  dismissed_by: string | null;
  dismissal_message: string | null;
  version: number;
};

/**
 * Reviews of the repository's pull requests and the reviews requested of
 * people and agents. Each change commits with its event and audit row.
 */
export class RepoReviews {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
      readonly pulls: RepoPulls;
      readonly repoId: () => string;
    },
  ) {}

  /** A pull request's reviews in the order submitted, after review `after` when given. */
  list(number: number, after: number, limit: number): ReviewRecord[] {
    return this.#rows(
      "SELECT * FROM reviews WHERE pr_number = ? AND review_id > ? ORDER BY review_id LIMIT ?",
      number,
      after,
      limit,
    ).map(record);
  }

  get(number: number, id: number): ReviewRecord | undefined {
    const [row] = this.#rows(
      "SELECT * FROM reviews WHERE pr_number = ? AND review_id = ?",
      number,
      id,
    );
    return row && record(row);
  }

  /**
   * Submits a review of `commitSha`, which must be a head the pull request
   * has had: a review of an earlier head stays bound to it. Removes the
   * reviewer's pending request.
   */
  submit(
    number: number,
    input: {
      readonly event: ReviewEvent;
      readonly body: string | null;
      readonly commitSha: string;
    },
    caller: PullCaller,
  ): { ok: true; review: ReviewRecord } | { ok: false; code: ReviewFailure } {
    const pull = this.deps.pulls.get(number);
    if (!pull) return { ok: false, code: "not_found" };
    const decision = decideReview({
      event: input.event,
      body: input.body,
      pullState: pull.state,
      isAuthor: caller.root === pull.authorRoot,
      role: caller.role,
    });
    if (!decision.ok) return { ok: false, code: decision.refusal };
    if (!this.deps.pulls.hadHead(number, input.commitSha))
      return { ok: false, code: "commit_not_in_pull" };
    const { storage } = this.deps.git.context;
    const actor = caller.actor;
    const review = storage.transactionSync(() => {
      const now = this.deps.git.context.now();
      const [row] = this.#rows(
        `INSERT INTO reviews (pr_number, reviewer_id, reviewer_root, by_agent, act_chain, state,
           commit_sha, body, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        number,
        actor.principal,
        caller.root,
        byAgent(actor) ? 1 : 0,
        actor.actChain?.length ? JSON.stringify(actor.actChain) : null,
        reviewStateOf(input.event),
        input.commitSha,
        input.body,
        now,
      );
      const submitted = record(row as Row);
      this.#run(
        "DELETE FROM review_requests WHERE pr_number = ? AND reviewer_id = ?",
        number,
        actor.principal,
      );
      this.#emit("submitted", submitted, actor);
      this.deps.events.auditChange("pull_request.review", actor, {
        number,
        review: submitted.id,
        state: submitted.state,
      });
      return submitted;
    });
    return { ok: true, review };
  }

  /** Dismisses a standing approval or request for changes, with the reason kept. */
  dismiss(
    number: number,
    id: number,
    message: string,
    caller: PullCaller,
  ): { ok: true; review: ReviewRecord } | { ok: false; code: ReviewFailure } {
    const pull = this.deps.pulls.get(number);
    if (!pull) return { ok: false, code: "not_found" };
    const current = this.get(number, id);
    if (!current) return { ok: false, code: "review_not_found" };
    const decision = decideDismissal({
      reviewState: current.state,
      dismissed: current.dismissedAt !== null,
      pullState: pull.state,
      role: caller.role,
    });
    if (!decision.ok) return { ok: false, code: decision.refusal };
    const review = this.deps.git.context.storage.transactionSync(() => {
      const [row] = this.#rows(
        `UPDATE reviews SET dismissed_at = ?, dismissed_by = ?, dismissal_message = ?,
           version = version + 1
         WHERE review_id = ? RETURNING *`,
        this.deps.git.context.now(),
        caller.actor.principal,
        message,
        id,
      );
      const dismissed = record(row as Row);
      this.#emit("dismissed", dismissed, caller.actor);
      this.deps.events.auditChange("pull_request.dismiss_review", caller.actor, {
        number,
        review: id,
        message,
      });
      return dismissed;
    });
    return { ok: true, review };
  }

  /** The principals a review is requested of, in the order requested. */
  requested(number: number): string[] {
    return this.#rows<{ reviewer_id: string }>(
      "SELECT reviewer_id FROM review_requests WHERE pr_number = ? ORDER BY requested_at, reviewer_id",
      number,
    ).map((row) => row.reviewer_id);
  }

  /**
   * Requests reviews of `reviewers`, each of whom must read the repository
   * and not be the author (by root identity). Already requested ones are
   * left as they are.
   */
  request(
    number: number,
    reviewers: readonly RequestedReviewer[],
    caller: PullCaller,
  ): { ok: true; pull: PullRecord } | { ok: false; code: ReviewFailure } {
    const pull = this.#requestable(number, caller);
    if (!pull.ok) return pull;
    for (const reviewer of reviewers) {
      if (reviewer.root === pull.pull.authorRoot) return { ok: false, code: "reviewer_is_author" };
      if (reviewer.role === null) return { ok: false, code: "reviewer_no_access" };
    }
    const already = new Set(this.requested(number));
    const added = [...new Set(reviewers.map((r) => r.id))].filter((id) => !already.has(id));
    if (already.size + added.length > MAX_REQUESTED_REVIEWERS)
      return { ok: false, code: "too_many_reviewers" };
    this.deps.git.context.storage.transactionSync(() => {
      const now = this.deps.git.context.now();
      for (const id of added) {
        this.#run(
          "INSERT INTO review_requests (pr_number, reviewer_id, requested_by, requested_at) VALUES (?, ?, ?, ?)",
          number,
          id,
          caller.actor.principal,
          now,
        );
        this.#emitRequest("review_requested", number, id, caller.actor);
      }
      if (added.length > 0)
        this.deps.events.auditChange("pull_request.request_reviewers", caller.actor, {
          number,
          reviewers: added,
        });
    });
    return { ok: true, pull: pull.pull };
  }

  /** Withdraws review requests; ones not requested are ignored. */
  unrequest(
    number: number,
    reviewerIds: readonly string[],
    caller: PullCaller,
  ): { ok: true; pull: PullRecord } | { ok: false; code: ReviewFailure } {
    const pull = this.#requestable(number, caller);
    if (!pull.ok) return pull;
    const requested = new Set(this.requested(number));
    const removed = [...new Set(reviewerIds)].filter((id) => requested.has(id));
    this.deps.git.context.storage.transactionSync(() => {
      for (const id of removed) {
        this.#run(
          "DELETE FROM review_requests WHERE pr_number = ? AND reviewer_id = ?",
          number,
          id,
        );
        this.#emitRequest("review_request_removed", number, id, caller.actor);
      }
      if (removed.length > 0)
        this.deps.events.auditChange("pull_request.remove_review_request", caller.actor, {
          number,
          reviewers: removed,
        });
    });
    return { ok: true, pull: pull.pull };
  }

  #requestable(
    number: number,
    caller: PullCaller,
  ): { ok: true; pull: PullRecord } | { ok: false; code: ReviewFailure } {
    const pull = this.deps.pulls.get(number);
    if (!pull) return { ok: false, code: "not_found" };
    const decision = decideReviewRequest({
      pullState: pull.state,
      isAuthor: caller.root === pull.authorRoot,
      role: caller.role,
    });
    return decision.ok ? { ok: true, pull } : { ok: false, code: decision.refusal };
  }

  #emit(event: string, review: ReviewRecord, actor: RefActor): void {
    const { version, ...row } = review;
    this.deps.events.emitEntity(`pull_request_review.${event}`, actor, {
      type: REVIEW_ENTITY,
      id: `${this.deps.repoId()}#${review.number}/reviews/${review.id}`,
      version,
      row: { ...row, actChain: [...row.actChain] },
    });
  }

  #emitRequest(event: string, number: number, reviewer: string, actor: RefActor): void {
    this.deps.events.emitActivity(`pull_request.${event}`, actor, { number, reviewer });
  }

  #run(query: string, ...bindings: SqlStorageValue[]): void {
    const cursor = this.deps.git.context.storage.sql.exec(query, ...bindings);
    this.#count(cursor.rowsWritten);
  }

  #rows<T extends Record<string, SqlStorageValue> = Row>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    const cursor = this.deps.git.context.storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.#count(cursor.rowsWritten);
    return rows;
  }

  #count(written: number): void {
    if (written > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "reviews.write" },
        written,
      );
  }
}

/** Submitted by an agent: its own token, or a person's token an agent acts with. */
function byAgent(actor: RefActor): boolean {
  return principalTypeOf(actor.principal) === "agent" || (actor.actChain?.length ?? 0) > 0;
}

function record(row: Row): ReviewRecord {
  return {
    id: row.review_id,
    number: row.pr_number,
    reviewerId: row.reviewer_id,
    reviewerRoot: row.reviewer_root,
    byAgent: row.by_agent === 1,
    actChain: row.act_chain ? (JSON.parse(row.act_chain) as string[]) : [],
    state: row.state,
    commitSha: row.commit_sha,
    body: row.body,
    submittedAt: row.submitted_at,
    dismissedAt: row.dismissed_at,
    dismissedBy: row.dismissed_by,
    dismissalMessage: row.dismissal_message,
    version: row.version,
  };
}
