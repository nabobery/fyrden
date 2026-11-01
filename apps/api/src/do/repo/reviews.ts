import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  decideDismissal,
  decideReview,
  decideReviewRequest,
  MAX_PULL_TEAM_REVIEWERS,
  MAX_REQUESTED_REVIEWERS,
  principalTypeOf,
  type RepoRole,
  type ReviewEvent,
  type ReviewFact,
  type ReviewState,
  reviewStateOf,
} from "@fyrden/domain";
import { reviewOutput } from "../../repos/shapes.js";
import { capturable, userOf } from "../../webhooks/captures.js";
import type { TeamAudience } from "../OrgDO.js";
import type { RepoEvents } from "./events.js";
import type { RepoFeed } from "./feed.js";
import type { PullCaller, PullRecord, RepoPulls } from "./pulls.js";
import {
  MANUAL,
  OWNERS,
  type RepoTeamRequests,
  type TeamRequest,
  type TeamToAsk,
} from "./team-requests.js";

/** The entity type review snapshots travel as in events. */
export const REVIEW_ENTITY = "pull_request_review";

/**
 * One seek for one reviewer's last review in `filter`, by itself or by an
 * agent acting for it (`k`: a delegation's reviews are its user's).
 */
const latest = (filter: string) =>
  `SELECT (SELECT review_id FROM reviews
     WHERE pr_number = ?1 AND reviewer_id = k.id AND by_agent = k.by_agent
       AND dismissed_at IS NULL AND ${filter}
     ORDER BY review_id DESC LIMIT 1) FROM keys k`;

/**
 * What `standing` reads (?1 the pull request, ?2 its head, ?3 the last
 * review before its retarget): the reviewers one seek at a time (each next
 * principal after the last), then for each, by itself and by an agent
 * acting for it, its last request for changes and its last approval since
 * the retarget, of any head and of the head. Per reviewer, so code owners
 * tell a person's agents apart; a root's standing review, the latest of
 * its reviewers' picks, is among them. The index's order is submission
 * order.
 */
export const STANDING_REVIEWS_SQL = `
  WITH RECURSIVE reviewers(id) AS (
    SELECT (SELECT reviewer_id FROM reviews WHERE pr_number = ?1 AND dismissed_at IS NULL
            ORDER BY reviewer_id LIMIT 1)
    UNION ALL
    SELECT (SELECT reviewer_id FROM reviews WHERE pr_number = ?1 AND dismissed_at IS NULL
              AND reviewer_id > reviewers.id ORDER BY reviewer_id LIMIT 1)
    FROM reviewers WHERE reviewers.id IS NOT NULL
  ),
  keys(id, by_agent) AS (
    SELECT id, 0 FROM reviewers WHERE id IS NOT NULL
    UNION ALL
    SELECT id, 1 FROM reviewers WHERE id IS NOT NULL
  ),
  picks(id) AS (
    ${latest("state = 'CHANGES_REQUESTED'")}
    UNION ALL ${latest("state = 'APPROVED' AND review_id > ?3")}
    UNION ALL ${latest("commit_sha = ?2 AND state = 'CHANGES_REQUESTED'")}
    UNION ALL ${latest("commit_sha = ?2 AND state = 'APPROVED' AND review_id > ?3")}
  )
  SELECT review_id, reviewer_id, reviewer_root, by_agent, act_chain, commit_sha, state,
    submitted_at
  FROM reviews WHERE review_id IN (SELECT id FROM picks)`;

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

/** What the repository asks of code owners on a pull request in one change (see `RepoReviews.askOwners`). */
export interface OwnersAsk {
  /** Principals to ask, each with the root identity it counts as. */
  readonly principals: readonly { readonly id: string; readonly root: string }[];
  /** Teams to ask, each through the members it asks (its pull request's author left out). */
  readonly teams: readonly TeamToAsk[];
  /** The teams' answer's account and restore generation (see `RepoTeamRequests.askedAt`). */
  readonly audience?: { readonly accountId: string; readonly epochGen: number };
  /** Standing requests asked of code owners too: principals' ids, teams' request ids. */
  readonly mark: { readonly principals: readonly string[]; readonly teams: readonly number[] };
  /** Code owners' requests taken back: principals' ids, teams' request ids. */
  readonly takeBack: { readonly principals: readonly string[]; readonly teams: readonly number[] };
}

export type ReviewFailure =
  | "not_found"
  | "review_not_found"
  | "forbidden"
  | "locked"
  | "wrong_state"
  | "own_pull_request"
  | "body_required"
  | "commit_not_in_pull"
  | "reviewer_no_access"
  | "reviewer_is_author"
  | "too_many_reviewers"
  | "team_not_found"
  | "team_too_large";

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
      readonly feed: RepoFeed;
      readonly teams: RepoTeamRequests;
      readonly repoId: () => string;
      /** In the transaction of a request's end: pull request `number` has room it did not have. */
      readonly freed?: (number: number) => void;
      /** In the transaction of a change of a review that can count on pull request `number`. */
      readonly reviewed?: (number: number) => void;
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

  /**
   * What a merge's approval check reads of the pull request's reviews,
   * and a stamp the merge's commit transaction compares, so a review
   * submitted or dismissed, or a retarget, meanwhile stops the merge. Of
   * the reviews that can count (not comments, not dismissed, not an
   * approval given before the pull request was retargeted), only each
   * person's last submitted request for changes and approval, by
   * themselves and by an agent, of the head and of any head: every choice
   * the rulesets make among them (stale reviews, agents, who has write
   * access) takes its review from these, as it would from all of them.
   * Found by seeking the indexes, so the work follows the reviewers, not
   * how often each reviewed.
   */
  standing(number: number): {
    /** Each with the agents it was submitted through (a delegation's), whose activity counts too. */
    reviews: (Omit<ReviewFact, "active"> & { readonly actChain: readonly string[] })[];
    stamp: string;
  } {
    const { sql } = this.deps.git.context.storage;
    const pull = sql
      .exec<{ head_sha: string; approvals_after: number }>(
        "SELECT head_sha, approvals_after FROM pull_requests WHERE number = ?",
        number,
      )
      .toArray()[0];
    const reviews = pull
      ? sql
          .exec<
            Pick<
              Row,
              | "review_id"
              | "reviewer_id"
              | "reviewer_root"
              | "by_agent"
              | "act_chain"
              | "commit_sha"
              | "state"
              | "submitted_at"
            >
          >(STANDING_REVIEWS_SQL, number, pull.head_sha, pull.approvals_after)
          .toArray()
          .map((row) => ({
            reviewerId: row.reviewer_id,
            reviewerRoot: row.reviewer_root,
            actChain: row.act_chain ? (JSON.parse(row.act_chain) as string[]) : [],
            byAgent: row.by_agent === 1,
            commitSha: row.commit_sha,
            state: row.state,
            submittedAt: row.submitted_at,
            seq: row.review_id,
            dismissed: false,
          }))
      : [];
    return { reviews, stamp: this.stamp(number) };
  }

  /**
   * Changes when a review that can count is submitted or dismissed, or the
   * pull request is retargeted; one row read.
   */
  stamp(number: number): string {
    const row = this.deps.git.context.storage.sql
      .exec<{ reviews_revision: number; approvals_after: number }>(
        "SELECT reviews_revision, approvals_after FROM pull_requests WHERE number = ?",
        number,
      )
      .toArray()[0];
    return row ? `${row.reviews_revision}:${row.approvals_after}` : "";
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
      locked: pull.locked,
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
      if (submitted.state !== "COMMENTED") this.#revised(number);
      // A review completes what was asked of its reviewer: its own request, and those of the
      // teams that asked it; their members no other request asks are settled with it.
      const { teams } = this.deps;
      this.#run(
        "DELETE FROM review_requests WHERE pr_number = ? AND reviewer_id = ?",
        number,
        actor.principal,
      );
      const members = teams.completeBy(number, actor.principal, caller.root);
      this.deps.freed?.(number);
      const asked = teams.addressed(number);
      const resolutions = this.deps.feed.settlements(
        number,
        [
          { id: actor.principal, root: caller.root },
          ...members.filter((id) => !asked.has(id)).map((id) => ({ id, root: id })),
        ],
        actor.principal,
        "review",
      );
      this.#emit("submitted", submitted, actor, resolutions.length > 0 ? { resolutions } : null);
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
      this.#revised(number);
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

  /** The teams a review is requested of, in the order requested (standing requests only). */
  requestedTeams(number: number): TeamRequest[] {
    return this.deps.teams.live(number);
  }

  /** The principals a review is requested of, in the order requested. */
  requested(number: number): string[] {
    return this.#requests(number).map((row) => row.reviewerId);
  }

  /** The requests of principals, in the order requested, with why each was asked. */
  #requests(number: number): { reviewerId: string; reasons: number; requestId: number }[] {
    return this.#rows<{ reviewer_id: string; reasons: number; request_id: number }>(
      `SELECT reviewer_id, reasons, request_id FROM review_requests WHERE pr_number = ?
       ORDER BY requested_at, reviewer_id`,
      number,
    ).map((row) => ({
      reviewerId: row.reviewer_id,
      reasons: row.reasons,
      requestId: row.request_id,
    }));
  }

  /**
   * Changes with any change of the pull request's standing requests (one
   * made, ended, or its reasons changed): each request's id and reasons,
   * of principals and of teams. A few rows (at most `MAX_REQUESTED_REVIEWERS`).
   */
  requestsStamp(number: number): string {
    return JSON.stringify([
      this.#requests(number).map((r) => [r.requestId, r.reasons]),
      this.deps.teams.live(number).map((r) => [r.requestId, r.reasons]),
    ]);
  }

  /**
   * Requests reviews of `reviewers`, each of whom must read the repository
   * and not be the author (by root identity), and of the teams `audience`
   * answers (the organization's, read with the ACL the caller checked:
   * each must be found and read the repository, and ask at most
   * `MAX_TEAM_REVIEWERS` members), each asking the members it has now,
   * the author left out. A team counts as one of the requests a pull
   * request may have; its members count toward `MAX_PULL_TEAM_REVIEWERS`.
   * Already requested reviewers and teams are left as they are (a team
   * keeps the members it asked). Past the limit, the requests of `deleted`
   * reviewers (being deleted: no one can withdraw them by name) give up
   * their places first, quietly (audited; no event, as no one is told).
   */
  request(
    number: number,
    reviewers: readonly RequestedReviewer[],
    caller: PullCaller,
    deleted: ReadonlySet<string> = new Set(),
    audience?: TeamAudience,
  ): { ok: true; pull: PullRecord } | { ok: false; code: ReviewFailure } {
    const pull = this.#requestable(number, caller);
    if (!pull.ok) return pull;
    for (const reviewer of reviewers) {
      if (reviewer.root === pull.pull.authorRoot) return { ok: false, code: "reviewer_is_author" };
      if (reviewer.role === null) return { ok: false, code: "reviewer_no_access" };
    }
    if (audience && audience.missing.length > 0) return { ok: false, code: "team_not_found" };
    const { teams } = this.deps;
    const standing = teams.live(number);
    const asked = new Set(standing.map((r) => r.team.id));
    for (const team of audience?.teams ?? []) {
      // One that cannot read the repository is answered as one not found: a caller outside the
      // organization learns no more of its teams than their names it asked with.
      if (team.role === null) return { ok: false, code: "team_not_found" };
      // Too large to ask now; one asked already keeps the members it asked (and becomes the
      // person's request too).
      if (team.members === null && !asked.has(team.id))
        return { ok: false, code: "team_too_large" };
    }
    const author = new Set([pull.pull.authorId, pull.pull.authorRoot]);
    const newTeams = [...new Map((audience?.teams ?? []).map((team) => [team.id, team])).values()]
      .filter((team) => !asked.has(team.id))
      .map((team) => ({
        id: team.id,
        slug: team.slug,
        name: team.name,
        members: (team.members ?? []).filter((id) => !author.has(id)),
      }));
    if (
      teams.associations(number) + newTeams.reduce((n, team) => n + team.members.length, 0) >
      MAX_PULL_TEAM_REVIEWERS
    )
      return { ok: false, code: "team_too_large" };
    const requests = this.#requests(number);
    const already = new Set(requests.map((r) => r.reviewerId));
    const added = [...new Set(reviewers.map((r) => r.id))].filter((id) => !already.has(id));
    // Asked already, by the repository only (a code owner): asked by a person now too.
    const wanted = new Set(reviewers.map((r) => r.id));
    const promoted = requests.filter((r) => wanted.has(r.reviewerId) && !(r.reasons & MANUAL));
    const teamsWanted = new Set((audience?.teams ?? []).map((team) => team.id));
    const teamsPromoted = standing.filter(
      (r) => teamsWanted.has(r.team.id) && !(r.reasons & MANUAL),
    );
    const places = already.size + standing.length + added.length + newTeams.length;
    const freed =
      places > MAX_REQUESTED_REVIEWERS ? [...already].filter((id) => deleted.has(id)) : [];
    if (places - freed.length > MAX_REQUESTED_REVIEWERS)
      return { ok: false, code: "too_many_reviewers" };
    this.deps.git.context.storage.transactionSync(() => {
      const now = this.deps.git.context.now();
      for (const id of freed)
        this.#run(
          "DELETE FROM review_requests WHERE pr_number = ? AND reviewer_id = ?",
          number,
          id,
        );
      if (freed.length > 0) {
        this.deps.events.auditChange("pull_request.prune_review_requests", caller.actor, {
          number,
          reviewers: freed,
        });
        this.deps.freed?.(number);
      }
      for (const id of added) {
        const root = reviewers.find((r) => r.id === id)?.root ?? id;
        this.#run(
          `INSERT INTO review_requests (pr_number, reviewer_id, requested_by, requested_at,
             reviewer_root, reasons, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          number,
          id,
          caller.actor.principal,
          now,
          root,
          MANUAL,
          teams.nextId(),
        );
        this.#emitRequest("review_requested", number, id, caller.actor, root);
      }
      for (const r of promoted)
        this.#run(
          "UPDATE review_requests SET reasons = reasons | ? WHERE request_id = ?",
          MANUAL,
          r.requestId,
        );
      for (const r of teamsPromoted) teams.setReasons(r.requestId, r.reasons | MANUAL);
      if (audience && newTeams.length > 0) teams.askedAt(audience.accountId, audience.epochGen);
      for (const team of newTeams) teams.ask(number, team, caller.actor, now);
      if (added.length > 0 || newTeams.length > 0)
        this.deps.events.auditChange("pull_request.request_reviewers", caller.actor, {
          number,
          reviewers: added,
          ...(newTeams.length > 0 && { teams: newTeams.map((team) => team.slug) }),
        });
    });
    return { ok: true, pull: pull.pull };
  }

  /**
   * Withdraws review requests of principals and of the teams `teamSlugs`
   * name (as asked) or `teamIds` are; ones not requested are ignored. Each
   * settles whom it asked unless another request still asks them.
   */
  unrequest(
    number: number,
    reviewerIds: readonly string[],
    caller: PullCaller,
    teamSlugs: readonly string[] = [],
    teamIds: readonly string[] = [],
  ): { ok: true; pull: PullRecord } | { ok: false; code: ReviewFailure } {
    const pull = this.#requestable(number, caller);
    if (!pull.ok) return pull;
    const requested = new Set(this.requested(number));
    const removed = [...new Set(reviewerIds)].filter((id) => requested.has(id));
    const { teams } = this.deps;
    this.deps.git.context.storage.transactionSync(() => {
      for (const id of removed) this.#withdrawPrincipal(number, id, caller.actor);
      const teamsRemoved = teams.withdraw(number, teamSlugs, caller.actor, teamIds);
      if (removed.length > 0 || teamsRemoved.length > 0)
        this.deps.events.auditChange("pull_request.remove_review_request", caller.actor, {
          number,
          reviewers: removed,
          ...(teamsRemoved.length > 0 && { teams: teamsRemoved.map((r) => r.team.slug) }),
        });
    });
    return { ok: true, pull: pull.pull };
  }

  /**
   * In a change's transaction: withdraws the request of `id`, settling
   * them unless another request still asks them, with its event.
   */
  #withdrawPrincipal(number: number, id: string, actor: RefActor): void {
    const [gone] = this.deps.git.context.storage.sql
      .exec<{ reviewer_root: string | null }>(
        "DELETE FROM review_requests WHERE pr_number = ? AND reviewer_id = ? RETURNING reviewer_root",
        number,
        id,
      )
      .toArray();
    this.#count(1);
    this.deps.freed?.(number);
    const root = gone?.reviewer_root ?? undefined;
    const resolutions = this.deps.teams.addressed(number).has(id)
      ? []
      : this.deps.feed.settlements(
          number,
          [{ id, root: root ?? id }],
          actor.principal,
          "review_request_removed",
        );
    this.#emitRequest("review_request_removed", number, id, actor, root, resolutions);
  }

  /**
   * In a change's transaction: what the repository asks of code owners on
   * pull request `number`, by `actor` (its author; no permission of theirs
   * is checked: the repository asks), as `ask` says: requests made for
   * `OWNERS` (each with its event, as a person's request has), requests
   * standing already marked as code owners' too, and code owners'
   * requests taken back (a person's request of the same reviewer stays,
   * as theirs; one with no reason left is withdrawn, as `unrequest` does).
   * Who may be asked and whether they fit was decided by the caller. How
   * many requests were withdrawn (places freed).
   */
  askOwners(number: number, ask: OwnersAsk, actor: RefActor): { withdrawn: number } {
    const { teams } = this.deps;
    const now = this.deps.git.context.now();
    const requests = new Map(this.#requests(number).map((r) => [r.reviewerId, r]));
    const live = new Map(teams.live(number).map((r) => [r.requestId, r]));
    for (const id of ask.mark.principals) {
      const r = requests.get(id);
      if (r && !(r.reasons & OWNERS))
        this.#run(
          "UPDATE review_requests SET reasons = ? WHERE request_id = ?",
          r.reasons | OWNERS,
          r.requestId,
        );
    }
    for (const requestId of ask.mark.teams) {
      const r = live.get(requestId);
      if (r && !(r.reasons & OWNERS)) teams.setReasons(requestId, r.reasons | OWNERS);
    }
    const withdrawn: string[] = [];
    for (const id of ask.takeBack.principals) {
      const r = requests.get(id);
      if (!r || !(r.reasons & OWNERS)) continue;
      if (r.reasons & MANUAL)
        this.#run(
          "UPDATE review_requests SET reasons = ? WHERE request_id = ?",
          MANUAL,
          r.requestId,
        );
      else {
        this.#withdrawPrincipal(number, id, actor);
        withdrawn.push(id);
      }
    }
    const teamsWithdrawn: TeamRequest[] = [];
    for (const requestId of ask.takeBack.teams) {
      const r = live.get(requestId);
      if (!r || !(r.reasons & OWNERS)) continue;
      if (r.reasons & MANUAL) teams.setReasons(requestId, MANUAL);
      else teamsWithdrawn.push(r);
    }
    teams.withdrawRequests(number, teamsWithdrawn, actor);
    if (withdrawn.length > 0 || teamsWithdrawn.length > 0)
      this.deps.events.auditChange("pull_request.remove_review_request", actor, {
        number,
        reviewers: withdrawn,
        ...(teamsWithdrawn.length > 0 && { teams: teamsWithdrawn.map((r) => r.team.slug) }),
        code_owners: true,
      });
    for (const { id, root } of ask.principals) {
      this.#run(
        `INSERT INTO review_requests (pr_number, reviewer_id, requested_by, requested_at,
           reviewer_root, reasons, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        number,
        id,
        actor.principal,
        now,
        root,
        OWNERS,
        teams.nextId(),
      );
      this.#emitRequest("review_requested", number, id, actor, root);
    }
    if (ask.audience && ask.teams.length > 0)
      teams.askedAt(ask.audience.accountId, ask.audience.epochGen);
    for (const team of ask.teams) teams.ask(number, team, actor, now, OWNERS);
    if (ask.principals.length > 0 || ask.teams.length > 0)
      this.deps.events.auditChange("pull_request.request_reviewers", actor, {
        number,
        reviewers: ask.principals.map((p) => p.id),
        ...(ask.teams.length > 0 && { teams: ask.teams.map((team) => team.slug) }),
        code_owners: true,
      });
    return { withdrawn: withdrawn.length + teamsWithdrawn.length };
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

  /**
   * Emits the review's event; its webhook capture is the review as the API
   * shows it (who dismissed it as a user) and its pull request as it stands.
   */
  #emit(
    event: string,
    review: ReviewRecord,
    actor: RefActor,
    data: Record<string, unknown> | null = null,
  ): void {
    const { version, ...row } = review;
    this.deps.events.emitEntity(
      `pull_request_review.${event}`,
      actor,
      {
        type: REVIEW_ENTITY,
        id: `${this.deps.repoId()}#${review.number}/reviews/${review.id}`,
        version,
        row: { ...row, actChain: [...row.actChain] },
      },
      data,
      false,
      () => {
        const shown = reviewOutput(review);
        const pull = this.deps.pulls.get(review.number);
        return {
          review: capturable({
            ...shown,
            dismissal: shown.dismissal && { ...shown.dismissal, by: { id: shown.dismissal.by } },
          }),
          pull_request: pull ? this.deps.pulls.captured(pull) : null,
        };
      },
    );
  }

  #emitRequest(
    event: string,
    number: number,
    reviewer: string,
    actor: RefActor,
    /** The root identity the reviewer counts as, when known (a user's agent: that user). */
    reviewerRoot?: string,
    /** Entries settling the request for whom no other request asks (`RepoFeed.settlements`). */
    resolutions?: readonly unknown[],
  ): void {
    this.deps.events.emitActivity(
      `pull_request.${event}`,
      actor,
      {
        number,
        reviewer,
        ...(reviewerRoot !== undefined && { reviewer_root: reviewerRoot }),
        ...(resolutions !== undefined && { resolutions }),
      },
      // The pull request as it stands, and the reviewer requested or no longer.
      () => {
        const pull = this.deps.pulls.get(number);
        return {
          number,
          pull_request: pull ? this.deps.pulls.captured(pull) : null,
          requested_reviewer: userOf(reviewer),
        };
      },
    );
  }

  /** In the transaction of a change of a review that can count: the merge's stamp changes. */
  #revised(number: number): void {
    this.#run(
      "UPDATE pull_requests SET reviews_revision = reviews_revision + 1 WHERE number = ?",
      number,
    );
    this.deps.reviewed?.(number);
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
