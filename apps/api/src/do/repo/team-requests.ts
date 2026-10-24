import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { FeedBlock } from "@fyrden/domain";
import type { RepoEvents } from "./events.js";
import type { FeedPrincipal, RepoFeed } from "./feed.js";
import type { RepoPulls } from "./pulls.js";

/*
 * Reviews asked of teams of the repository's organization. A team's
 * request keeps the members the team had when asked (pages of ids), so
 * who it asks, who completes it and whom its end settles do not change
 * with the team afterwards; it stands only under the ownership it was
 * asked under (another owner's requests are no one's). Ending one settles
 * the review request items of its members no other request of the pull
 * request still asks, in entries carried by the event (`RepoFeed.settlements`).
 * A job settles the requests a transfer or restore left to an older owner,
 * and those of teams a restored organization no longer has.
 */

/** Members a page of a team request's members keeps. */
const AUDIENCE_PAGE = 1_000;
/** Members a slice of the job settles at most (a request whole, however many it has). */
const SLICE_MEMBERS = 2_000;
/** Teams one look at the organization names at most. */
const LOOKUP_TEAMS = 100;
/** Bit of a request's reasons: someone asked for it. */
export const MANUAL = 1;
/** Bit of a request's reasons: asked of a code owner by the repository (see `code-owner-requests.ts`). */
export const OWNERS = 2;

/** The event that settles team requests without a webhook of its own (a merge, a transfer). */
export const SETTLED_EVENT = "pull_request.review_requests_settled";

/** A team as a request names it. */
export interface RequestedTeam {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** A team's request, as kept. */
export interface TeamRequest {
  readonly requestId: number;
  readonly number: number;
  readonly team: RequestedTeam;
  /** How many members it asked. */
  readonly members: number;
  /** Whether its members are still kept (not after its pull request merged). */
  readonly audience: boolean;
  /** Why it was asked (`MANUAL`, `OWNERS`). */
  readonly reasons: number;
  readonly requestedBy: string;
  readonly requestedAt: number;
}

/** A team to ask, with the members to ask (its members when asked, its pull request's author left out). */
export interface TeamToAsk extends RequestedTeam {
  readonly members: readonly string[];
}

type Row = {
  request_id: number;
  pr_number: number;
  team_id: string;
  slug: string;
  name: string;
  members: number;
  audience: number;
  reasons: number;
  requested_by: string;
  requested_at: number;
};

type EpochRow = {
  account_id: string;
  owner_gen: number;
  observed: number;
  reconciled: number | null;
  cursor: number;
};

export interface TeamRequestsDeps {
  readonly git: RepoGitStorage;
  readonly events: RepoEvents;
  readonly feed: RepoFeed;
  readonly pulls: RepoPulls;
  /** Queues the job that settles requests no longer standing (see `settleSlice`). */
  readonly schedule: () => void;
  /** In the transaction of a request's end: pull request `number` has room it did not have. */
  readonly freed?: (number: number) => void;
}

export class RepoTeamRequests {
  constructor(private readonly deps: TeamRequestsDeps) {}

  get #sql() {
    return this.deps.git.context.storage.sql;
  }

  /** The ownership generation whose team requests stand: none while the repository moves. */
  liveGen(): number | null {
    if (this.deps.events.isTransferring()) return null;
    return this.deps.events.account()?.ownerGen ?? null;
  }

  /** The pull request's standing team requests, in the order asked. */
  live(number: number): TeamRequest[] {
    const gen = this.liveGen();
    if (gen === null) return [];
    return this.#rows(
      `SELECT * FROM review_team_requests WHERE pr_number = ? AND owner_gen = ?
       ORDER BY requested_at, request_id`,
      number,
      gen,
    ).map(record);
  }

  /** The members request `requestId` kept, in the order kept. */
  members(requestId: number): string[] {
    return this.#rows<{ members: string }>(
      "SELECT members FROM review_request_audiences WHERE request_id = ? ORDER BY page",
      requestId,
    ).flatMap((row) => JSON.parse(row.members) as string[]);
  }

  /** Members the pull request's standing team requests keep, counted per request. */
  associations(number: number): number {
    return this.live(number)
      .filter((r) => r.audience)
      .reduce((n, r) => n + r.members, 0);
  }

  /**
   * Who the pull request's standing requests ask now: the principals asked
   * themselves and the members its teams' requests keep.
   */
  addressed(number: number): Set<string> {
    const asked = new Set(
      this.#rows<{ reviewer_id: string }>(
        "SELECT reviewer_id FROM review_requests WHERE pr_number = ?",
        number,
      ).map((row) => row.reviewer_id),
    );
    for (const request of this.live(number))
      if (request.audience) for (const id of this.members(request.requestId)) asked.add(id);
    return asked;
  }

  /** In a change's transaction: a request id never used before. */
  nextId(): number {
    const [row] = this.#rows<{ id: number }>(
      "UPDATE review_request_ids SET next_id = next_id + 1 WHERE id = 1 RETURNING next_id - 1 AS id",
    );
    if (!row) throw new Error("the repository has no request ids to take");
    return row.id;
  }

  /**
   * In a change's transaction: asks `team` (under the ownership standing
   * now) through `team.members`, for `reasons`, and emits the request.
   */
  ask(number: number, team: TeamToAsk, actor: RefActor, now: number, reasons = MANUAL): void {
    const gen = this.liveGen();
    if (gen === null) throw new Error("no team is asked while the repository moves");
    const requestId = this.nextId();
    this.#run(
      `INSERT INTO review_team_requests (request_id, pr_number, team_id, slug, name, reasons,
         owner_gen, members, audience, requested_by, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      requestId,
      number,
      team.id,
      team.slug,
      team.name,
      reasons,
      gen,
      team.members.length,
      actor.principal,
      now,
    );
    for (let at = 0; at < team.members.length; at += AUDIENCE_PAGE)
      this.#run(
        "INSERT INTO review_request_audiences (request_id, page, members) VALUES (?, ?, ?)",
        requestId,
        at / AUDIENCE_PAGE + 1,
        JSON.stringify(team.members.slice(at, at + AUDIENCE_PAGE)),
      );
    const named = { id: team.id, slug: team.slug, name: team.name };
    this.deps.events.emitActivity(
      "pull_request.review_requested",
      actor,
      { number, team: named, request_id: requestId },
      () => this.#captured(number, named),
    );
  }

  /** In a change's transaction: sets request `requestId`'s reasons (no event: who it asks is the same). */
  setReasons(requestId: number, reasons: number): void {
    this.#run(
      "UPDATE review_team_requests SET reasons = ? WHERE request_id = ?",
      reasons,
      requestId,
    );
  }

  /**
   * In a change's transaction: withdraws the standing requests of the
   * teams `slugs` name (as asked) or `ids` are; one not asked is ignored.
   * Each one's event settles its members no other request still asks.
   */
  withdraw(
    number: number,
    slugs: readonly string[],
    actor: RefActor,
    ids: readonly string[] = [],
  ): readonly TeamRequest[] {
    const wanted = new Set(slugs);
    const byId = new Set(ids);
    return this.withdrawRequests(
      number,
      this.live(number).filter((r) => wanted.has(r.team.slug) || byId.has(r.team.id)),
      actor,
    );
  }

  /** In a change's transaction: withdraws `removed`, standing requests of pull request `number`, as `withdraw` does. */
  withdrawRequests(
    number: number,
    removed: readonly TeamRequest[],
    actor: RefActor,
  ): readonly TeamRequest[] {
    for (const request of removed)
      this.#settle(number, [request], actor, "review_request_removed", (resolutions) =>
        this.deps.events.emitActivity(
          "pull_request.review_request_removed",
          actor,
          { number, team: request.team, request_id: request.requestId, resolutions },
          () => this.#captured(number, request.team),
        ),
      );
    return removed;
  }

  /**
   * In the transaction of a review by `principal` (counting as `root`):
   * ends the standing requests of teams that kept either among their
   * members; the members they kept, to settle.
   */
  completeBy(number: number, principal: string, root: string): string[] {
    const completing = this.live(number).filter(
      (r) =>
        r.audience &&
        this.#rows(
          `SELECT 1 FROM review_request_audiences a, json_each(a.members) m
           WHERE a.request_id = ? AND m.value IN (?, ?) LIMIT 1`,
          r.requestId,
          principal,
          root,
        ).length > 0,
    );
    const members = completing.flatMap((r) => this.members(r.requestId));
    for (const r of completing) this.#remove(r.requestId);
    return members;
  }

  /**
   * In a merge's transaction: the pull request's teams' members are
   * settled and no longer kept (it cannot reopen); its requests stay listed.
   */
  releaseMerged(number: number, actor: RefActor): void {
    const kept = this.live(number).filter((r) => r.audience);
    if (kept.length === 0) return;
    const members = kept.flatMap((r) => this.members(r.requestId));
    for (const r of kept) {
      this.#run("DELETE FROM review_request_audiences WHERE request_id = ?", r.requestId);
      this.#run("UPDATE review_team_requests SET audience = 0 WHERE request_id = ?", r.requestId);
    }
    const resolutions = this.deps.feed.settlements(
      number,
      principals(members),
      actor.principal,
      "merged",
    );
    if (resolutions.length > 0)
      this.deps.events.emitActivity(SETTLED_EVENT, actor, {
        number,
        request_ids: kept.map((r) => r.requestId),
        resolutions,
      });
  }

  /**
   * One slice of the job: settles requests no longer standing, a pull
   * request at a time, in the slice's transaction; whether any are left.
   * First those of another ownership generation (a transfer or a restore
   * left them), then the teams a look at the organization found gone.
   */
  settleSlice(): boolean {
    const gen = this.liveGen();
    if (gen === null || !this.deps.events.canEmit()) return false;
    const stale = this.#rows(
      "SELECT * FROM review_team_requests WHERE owner_gen <> ? ORDER BY request_id LIMIT 50",
      gen,
    ).map(record);
    if (stale.length === 0) return false;
    let members = 0;
    const slice = stale.filter((r) => {
      const take = members === 0 || members + r.members <= SLICE_MEMBERS;
      if (take) members += r.members;
      return take;
    });
    this.deps.git.context.storage.transactionSync(() => {
      for (const number of new Set(slice.map((r) => r.number)))
        this.#settleQuietly(
          number,
          slice.filter((r) => r.number === number),
        );
    });
    return true;
  }

  /**
   * The account's restore generation `epochGen` was seen (an ACL snapshot,
   * a notice, an answer about teams): the standing team requests are to be
   * checked against it, from the start, unless it is not newer than the
   * one seen for the same ownership. Nothing is kept while no team is
   * asked: the first request records the generation it was asked under.
   */
  observe(accountId: string, epochGen: number): void {
    const account = this.deps.events.account();
    if (!account || account.accountId !== accountId) return;
    const row = this.#epochRow();
    const bound = row?.account_id === accountId && row.owner_gen === account.ownerGen;
    if (bound && epochGen <= row.observed) return;
    const asked =
      this.#rows("SELECT 1 FROM review_team_requests WHERE owner_gen = ? LIMIT 1", account.ownerGen)
        .length > 0;
    if (!asked) return;
    this.#run(
      `INSERT INTO review_team_epochs (id, account_id, owner_gen, observed, reconciled, cursor)
       VALUES (1, ?, ?, ?, ?, 0)
       ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id,
         owner_gen = excluded.owner_gen, observed = excluded.observed,
         reconciled = excluded.reconciled, cursor = 0`,
      accountId,
      account.ownerGen,
      epochGen,
      bound ? (row?.reconciled ?? null) : null,
    );
    this.deps.schedule();
  }

  /**
   * In the transaction of a request asked with teams read at `epochGen`:
   * when no other team request stands, nothing older is left to check, so
   * that generation is the one checked against.
   */
  askedAt(accountId: string, epochGen: number, othersStanding: boolean): void {
    const account = this.deps.events.account();
    if (!account || account.accountId !== accountId) return;
    const row = this.#epochRow();
    const bound = row?.account_id === accountId && row.owner_gen === account.ownerGen;
    if (othersStanding || (bound && epochGen < row.observed)) {
      this.observe(accountId, epochGen);
      return;
    }
    this.#run(
      `INSERT INTO review_team_epochs (id, account_id, owner_gen, observed, reconciled, cursor)
       VALUES (1, ?, ?, ?, ?, 0)
       ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id,
         owner_gen = excluded.owner_gen, observed = excluded.observed,
         reconciled = excluded.reconciled, cursor = 0`,
      accountId,
      account.ownerGen,
      epochGen,
      epochGen,
    );
  }

  /**
   * One slice of checking the standing team requests against the newest
   * restore generation seen: asks the organization which of a page of
   * their teams it has (`lookup`), then, with no await after, settles the
   * requests of those it no longer has. True while more is left. An
   * answer of an older generation is refused (thrown: tried again); one of
   * a newer generation starts the check again.
   */
  async reconcileSlice(
    lookup: (
      accountId: string,
      teamIds: readonly string[],
    ) => Promise<{ accountId: string; epochGen: number; present: readonly string[] }>,
  ): Promise<boolean> {
    const before = this.#pending();
    if (!before) return false;
    const { row, gen } = before;
    const batch = this.#rows(
      `SELECT * FROM review_team_requests WHERE owner_gen = ? AND request_id > ?
       ORDER BY request_id LIMIT ?`,
      gen,
      row.cursor,
      LOOKUP_TEAMS,
    ).map(record);
    if (batch.length === 0) {
      this.#run(
        "UPDATE review_team_epochs SET reconciled = observed WHERE id = 1 AND observed = ?",
        row.observed,
      );
      return false;
    }
    const answer = await lookup(row.account_id, [...new Set(batch.map((r) => r.team.id))]);
    // Read again after the await: a newer generation seen meanwhile starts the check again.
    const now = this.#pending();
    if (
      !now ||
      now.gen !== gen ||
      now.row.observed !== row.observed ||
      now.row.cursor !== row.cursor
    )
      return now !== undefined;
    if (answer.accountId !== row.account_id) throw new Error("the answer is another account's");
    if (answer.epochGen < row.observed)
      throw new Error("the organization answered from an older restore generation");
    if (answer.epochGen > row.observed) {
      this.observe(row.account_id, answer.epochGen);
      return true;
    }
    if (!this.deps.events.canEmit()) throw new Error("the repository takes no changes now");
    const present = new Set(answer.present);
    const gone = batch.filter((r) => !present.has(r.team.id));
    this.deps.git.context.storage.transactionSync(() => {
      for (const number of new Set(gone.map((r) => r.number))) {
        // Read again: one may have ended while the organization was asked.
        const still = this.live(number).filter((r) =>
          gone.some((g) => g.requestId === r.requestId),
        );
        this.#settleQuietly(number, still);
      }
      this.#run(
        "UPDATE review_team_epochs SET cursor = ? WHERE id = 1",
        (batch.at(-1) as TeamRequest).requestId,
      );
    });
    return true;
  }

  /**
   * Whether the job has anything to do now: requests of another ownership
   * generation to settle, or a check still to do. Nothing while the
   * repository moves (its landing or calling off schedules the job).
   */
  hasWork(): boolean {
    const gen = this.liveGen();
    if (gen === null) return false;
    return (
      this.#rows("SELECT 1 FROM review_team_requests WHERE owner_gen <> ? LIMIT 1", gen).length >
        0 || this.#pending() !== undefined
    );
  }

  /** The check still to do, under the ownership standing now; undefined for none. */
  #pending(): { row: EpochRow; gen: number } | undefined {
    const gen = this.liveGen();
    const account = this.deps.events.account();
    const row = this.#epochRow();
    if (gen === null || !account || !row) return undefined;
    if (row.account_id !== account.accountId || row.owner_gen !== gen) return undefined;
    if (row.reconciled !== null && row.reconciled >= row.observed) return undefined;
    return { row, gen };
  }

  #epochRow(): EpochRow | undefined {
    return this.#rows<EpochRow>(
      "SELECT account_id, owner_gen, observed, reconciled, cursor FROM review_team_epochs WHERE id = 1",
    )[0];
  }

  /**
   * In a transaction: ends `requests` of pull request `number` with no one
   * acting, settling their members no standing request still asks.
   */
  #settleQuietly(number: number, requests: readonly TeamRequest[]): void {
    if (requests.length === 0) return;
    this.#settle(number, requests, null, "review_request_removed", (resolutions) => {
      if (resolutions.length > 0)
        this.deps.events.emitActivity(SETTLED_EVENT, null, {
          number,
          request_ids: requests.map((r) => r.requestId),
          resolutions,
        });
    });
  }

  /**
   * In a transaction: deletes `requests` and their kept members, then
   * hands `emit` the entries settling the members no standing request of
   * the pull request still asks.
   */
  #settle(
    number: number,
    requests: readonly TeamRequest[],
    actor: RefActor | null,
    action: string,
    emit: (resolutions: FeedBlock[]) => void,
  ): void {
    const members = requests.flatMap((r) => this.members(r.requestId));
    for (const r of requests) this.#remove(r.requestId);
    this.deps.freed?.(number);
    const asked = this.addressed(number);
    emit(
      this.deps.feed.settlements(
        number,
        principals(members.filter((id) => !asked.has(id))),
        actor?.principal ?? null,
        action,
      ),
    );
  }

  #remove(requestId: number): void {
    this.#run("DELETE FROM review_request_audiences WHERE request_id = ?", requestId);
    this.#run("DELETE FROM review_team_requests WHERE request_id = ?", requestId);
  }

  /** A team request's webhook body: the pull request as it stands, and the team. */
  #captured(number: number, team: RequestedTeam) {
    const pull = this.deps.pulls.get(number);
    return {
      number,
      pull_request: pull ? this.deps.pulls.captured(pull) : null,
      requested_team: { id: team.id, slug: team.slug, name: team.name },
    };
  }

  #run(query: string, ...bindings: SqlStorageValue[]): void {
    const cursor = this.#sql.exec(query, ...bindings);
    this.#count(cursor.rowsWritten);
  }

  #rows<T extends Record<string, SqlStorageValue> = Row>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    const cursor = this.#sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.#count(cursor.rowsWritten);
    return rows;
  }

  #count(written: number): void {
    if (written > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "team_requests.write" },
        written,
      );
  }
}

/** Members as feed principals (users: each its own root identity), once each. */
function principals(ids: readonly string[]): FeedPrincipal[] {
  return [...new Set(ids)].map((id) => ({ id, root: id }));
}

function record(row: Row): TeamRequest {
  return {
    requestId: row.request_id,
    number: row.pr_number,
    team: { id: row.team_id, slug: row.slug, name: row.name },
    members: row.members,
    audience: row.audience === 1,
    reasons: row.reasons,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
  };
}
