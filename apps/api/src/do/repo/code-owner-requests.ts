import type { JobHandler, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  type ApprovalSettings,
  atLeast,
  type CodeOwnerFact,
  isId,
  MAX_PULL_TEAM_REVIEWERS,
  MAX_REQUESTED_REVIEWERS,
  type OwnershipCandidate,
  ownershipCandidates,
} from "@fyrden/domain";
import { oidToHex } from "@fyrden/git-core";
import type { CodeOwnerTeamFacts, OrgDO, TeamAudience } from "../OrgDO.js";
import type { RepoAccount, RepoAcl } from "./acl.js";
import { ACTIVE_BATCH, MAX_ACTIVITY_PRINCIPALS, type RepoAuthority } from "./authority.js";
import { type CodeOwnerFacts, HANDLE_BATCH } from "./code-owner-facts.js";
import type { MergeCodeOwners, RepoCodeOwners } from "./code-owners.js";
import { d1Room } from "./directory-budget.js";
import type { FeedActor } from "./feed.js";
import type { AudienceFit, ReviewersNow } from "./pull-discussion.js";
import type { PullRecord, RepoPulls } from "./pulls.js";
import type { OwnersAsk, RepoReviews } from "./reviews.js";
import { OWNERS, type RepoTeamRequests, type TeamRequest } from "./team-requests.js";

/*
 * Code owners asked to review, as GitHub asks them: once a ready pull
 * request's code owners are worked out for a new pair (a new head, a base
 * tip moving its merge base or CODEOWNERS, a retarget), when a draft is
 * marked ready, and when the repository moves, the owners of each rule
 * deciding a changed path are asked (users, agents, teams of the
 * repository's organization, qualified now as a merge qualifies them),
 * unless they wrote it, are asked already, were asked once before on it
 * (`code_owner_asked`), or one of the rule's owners approved its head, as
 * a merge judges ownership with no ruleset's settings (stale approvals
 * dismissed, agents' approvals counted). The pull request's author asks
 * (requester, actor, webhook sender); no permission of theirs is checked.
 * Requests made so carry `OWNERS` beside a person's `MANUAL`, and lose it
 * when their owner no longer owns a changed path (one with no reason left
 * is withdrawn); a person's request is never touched. Owners that do not
 * fit the pull request's places or team members' allowance wait for room.
 *
 * One job serves the pull requests queued (`code_owner_request_jobs`), one
 * slice of one pull request an invocation: rules in line order from where
 * the last slice stopped, within a slice's directory batches, teams and
 * membership probes, the slice admitted only when the invocation has room
 * for its directory queries. Partial work is bound to what it was read
 * under (the code owners' result, the reviews, the ACL, the candidates
 * probed, the organization's ACL version): any change starts the pull
 * request again from its first rule. What a slice decides is written in
 * one transaction, with no await since it was read, only while the pull
 * request, its requests, reviews, result, ownership and ACL are as read;
 * otherwise the slice runs again.
 */

export const CODE_OWNER_REQUESTS_JOB_ID = "code_owner_requests";

/** Proposed values (to be measured). */
export const CODE_OWNER_REQUEST_POLICY = {
  /** Directory batches of handles one slice resolves (90 a batch). */
  handleBatches: 3,
  /** Teams one slice reads (one organization call). */
  maxTeams: 16,
  /** Team memberships one slice probes (a candidate in a team, by an indexed lookup). */
  maxProbes: 4_096,
  /** Members a pull request's team requests may keep in all (as a person's requests). */
  maxAssociations: MAX_PULL_TEAM_REVIEWERS,
  /** The delay after a slice failed or was fenced off, doubling with each in a row, and its ceiling. */
  retryFirstMs: 1_000,
  retryMaxMs: 10 * 60_000,
};

export type CodeOwnerRequestPolicy = typeof CODE_OWNER_REQUEST_POLICY;

/** Test seams. */
export interface CodeOwnerRequestHooks {
  /** After a slice read its reviewers, right before it resolves the owners' handles. */
  readonly beforeResolve?: () => Promise<void>;
  /** After a slice read everything, right before its transaction. */
  readonly beforeApply?: () => Promise<void>;
  /** After a slice's transaction. */
  readonly afterSlice?: () => Promise<void>;
}

/**
 * How ownership is judged for asking: as a merge judges it, with no
 * ruleset's settings (stale approvals dismissed, agents' approvals
 * counted). `required` and the last push do not matter to it.
 */
const ASKING: ApprovalSettings = {
  required: 0,
  dismissStale: true,
  requireLastPushApproval: false,
  allowAgentApprovals: true,
};

export interface CodeOwnerRequestsDeps {
  readonly git: RepoGitStorage;
  readonly pulls: RepoPulls;
  readonly reviews: RepoReviews;
  readonly teams: RepoTeamRequests;
  readonly codeOwners: RepoCodeOwners;
  readonly facts: CodeOwnerFacts;
  readonly reviewersNow: (number: number) => Promise<ReviewersNow | undefined>;
  readonly authority: RepoAuthority;
  readonly acl: () => RepoAcl;
  readonly account: () => RepoAccount | undefined;
  /** Calls (D1 queries among them) one invocation may make: the deployment's. */
  readonly invocationCalls: () => number;
  /** The organization's facts about the teams `slugs` (see `OrgDO.codeOwnerTeamFacts`). */
  readonly teamFacts: (
    accountId: string,
    slugs: readonly string[],
    probe: Parameters<OrgDO["codeOwnerTeamFacts"]>[2],
  ) => Promise<CodeOwnerTeamFacts>;
  readonly teamAudience: (slugs: readonly string[]) => Promise<TeamAudience | "unavailable">;
  readonly audienceFit: (audience: TeamAudience) => AudienceFit;
  readonly adoptAudience: (audience: TeamAudience) => void;
  /** Access read for the feeds the requests tell, before the transaction. */
  readonly prepareFeed: () => Promise<void>;
  readonly withFeed: <R>(actor: FeedActor, change: () => R) => R;
  /** Whether the repository takes changes and can emit events now. */
  readonly writable: () => boolean;
  /** After a transaction that emitted events. */
  readonly committed: () => void;
  readonly policy: () => CodeOwnerRequestPolicy;
  readonly hooks: () => CodeOwnerRequestHooks;
  readonly metrics: Metrics;
  readonly log: () => Logger;
}

type Job = { pr_number: number; seq: number; state: string | null };

/** An owner as a slice found it, by its token lowercased. */
type Owners = Record<string, CodeOwnerFact>;

/** Where a pull request's pass through its rules is, and what it was read under. */
interface Pass {
  /** What the partial work rests on: the result, the reviews, the ACL, the candidates probed. */
  readonly basis: string;
  /** The organization's `(epochGen, version)` its team facts were read at, once read. */
  teams: { readonly accountId: string; readonly epochGen: number; readonly version: number } | null;
  /** The next rule (an index into the result's rules). */
  rule: number;
  /** Within that rule, when it is under way: the next team to read, the candidate to probe from, whether satisfied, its owners so far. */
  part: {
    team: number;
    from: number;
    satisfied: boolean;
    /** Satisfied by a user or agent owner's approval (judged again each slice), not a team's. */
    byUsers?: boolean;
    owners: Owners;
    /** Its agent owners → the users they are rooted in (resolved where the rule began). */
    roots: Record<string, string>;
  } | null;
  /** Code owners' standing requests whose owner owns a changed path still (principal ids, team ids). */
  kept: { principals: string[]; teams: string[] };
  /** Whether owners waited for room in this pass. */
  waited: boolean;
}

/** An owner to ask, in rule order. */
type Ask =
  | { readonly kind: "principal"; readonly id: string; readonly root: string }
  | { readonly kind: "team"; readonly id: string; readonly slug: string };

export class CodeOwnerRequests {
  /** Failed or fenced-off slices in a row (in memory: a restart starts the delays over). */
  #failures = 0;
  /** Whether the slice just run read the directory (it then ends its invocation). */
  #readDirectory = false;

  constructor(private readonly deps: CodeOwnerRequestsDeps) {}

  get #sql() {
    return this.deps.git.context.storage.sql;
  }

  #now(): number {
    return this.deps.git.context.now();
  }

  /** In a transaction: pull request `number`'s owners are to be asked again (an open, ready one). */
  queue(number: number): void {
    const pull = this.deps.pulls.get(number);
    if (pull?.state !== "open" || pull.draft) return;
    this.#run(
      `INSERT INTO code_owner_request_jobs (pr_number, seq, requested_at, state) VALUES (?, 1, ?, NULL)
       ON CONFLICT (pr_number) DO UPDATE SET seq = seq + 1, state = NULL,
         requested_at = min(requested_at, excluded.requested_at)`,
      number,
      this.#now(),
    );
    this.#ensureJob();
  }

  /**
   * In the transaction publishing pull request `number`'s new result: its
   * owners are asked when a rule names owners, or its code owners'
   * requests taken back when one is left; nothing else is to do.
   */
  published(number: number): void {
    const pull = this.deps.pulls.get(number);
    if (pull?.state !== "open" || pull.draft) return;
    const result = this.deps.codeOwners.shownFor(pull);
    if (result === undefined || result.state === "refused") return;
    if ((result.state === "complete" && result.rules.length > 0) || this.#ownersRequested(number))
      this.queue(number);
  }

  /** Whether pull request `number` has a code owners' request standing. */
  #ownersRequested(number: number): boolean {
    return (
      this.#rows(
        "SELECT 1 FROM review_requests WHERE pr_number = ? AND reasons & ? LIMIT 1",
        number,
        OWNERS,
      ).length > 0 || this.deps.teams.live(number).some((r) => (r.reasons & OWNERS) !== 0)
    );
  }

  /** In a transaction: every open, ready pull request is (the repository moved). */
  queueAll(): void {
    const queued = this.#sql.exec(
      `INSERT INTO code_owner_request_jobs (pr_number, seq, requested_at, state)
       SELECT number, 1, ?1, NULL FROM pull_requests WHERE state = 'open' AND draft = 0
       ON CONFLICT (pr_number) DO UPDATE SET seq = seq + 1, state = NULL,
         requested_at = min(requested_at, excluded.requested_at)`,
      this.#now(),
    );
    this.#count(queued.rowsWritten);
    if (queued.rowsWritten > 0) this.#ensureJob();
  }

  /** In a transaction: pull request `number` closed; nothing is asked for it any more. */
  closed(number: number): void {
    this.#run("DELETE FROM code_owner_request_jobs WHERE pr_number = ?", number);
    this.#run("DELETE FROM code_owner_waiting WHERE pr_number = ?", number);
  }

  /** In the transaction of a request's end: owners waiting for room are asked again. */
  freed(number: number): void {
    this.#wake(number, "room");
  }

  /** In the transaction of a review's change: owners waiting until fewer reviewers matter are. */
  reviewed(number: number): void {
    this.#wake(number, "reviewers");
  }

  #wake(number: number, reason: "room" | "reviewers"): void {
    const waiting = this.#rows<{ reason: string }>(
      "SELECT reason FROM code_owner_waiting WHERE pr_number = ?",
      number,
    )[0];
    if (waiting?.reason === reason) this.queue(number);
  }

  handler(): JobHandler {
    return {
      runSlice: async () => {
        if (!this.deps.writable()) return { done: false, cursor: null, runAfterMs: 60_000 };
        const job = this.#rows<Job>(
          `SELECT pr_number, seq, state FROM code_owner_request_jobs WHERE requested_at <= ?
           ORDER BY requested_at, pr_number LIMIT 1`,
          this.#now(),
        )[0];
        if (!job) return this.#after();
        // Its directory queries, all of them, in this invocation, or it waits for the next.
        if (!d1Room(sliceQueries(this.deps.policy()), this.deps.invocationCalls()))
          return { done: false, cursor: null, runAfterMs: 0, endInvocation: true };
        this.#readDirectory = false;
        try {
          if (await this.#work(job)) this.#failures = 0;
          else this.#retry(job);
        } catch (error) {
          this.deps.log().warn("asking code owners to review failed", { error });
          this.#retry(job);
        }
        await this.deps.hooks().afterSlice?.();
        // One slice that read the directory an invocation: the next runs in another, with all
        // of its queries.
        return { ...this.#after(), endInvocation: this.#readDirectory };
      },
    };
  }

  /** The job's state once no slice is due now: done, or when the next is. */
  #after(): { done: true } | { done: false; cursor: null; runAfterMs: number } {
    const at = this.#rows<{ at: number | null }>(
      "SELECT min(requested_at) AS at FROM code_owner_request_jobs",
    )[0]?.at;
    return at === null || at === undefined
      ? { done: true }
      : { done: false, cursor: null, runAfterMs: Math.max(0, at - this.#now()) };
  }

  /** A slice failed or fenced off: its pull request is tried again after a delay. */
  #retry(job: Job): void {
    this.#failures++;
    const { retryFirstMs, retryMaxMs } = this.deps.policy();
    const delay = Math.min(retryFirstMs * 2 ** (this.#failures - 1), retryMaxMs);
    this.#run(
      "UPDATE code_owner_request_jobs SET requested_at = ? WHERE pr_number = ? AND seq = ?",
      this.#now() + delay,
      job.pr_number,
      job.seq,
    );
  }

  /**
   * One slice of pull request `job`'s pass; false when what it read changed
   * before it could write, or could not be read now (it runs again).
   */
  async #work(job: Job): Promise<boolean> {
    const number = job.pr_number;
    const pull = this.deps.pulls.get(number);
    if (pull?.state !== "open" || pull.draft) {
      this.#done(job);
      return true;
    }
    const result = this.deps.codeOwners.shownFor(pull);
    // Pending, or one that cannot be judged: nothing is asked or taken back.
    if (result === undefined || result.state === "refused") {
      this.#done(job);
      return true;
    }
    // The result and the base tip it was shown for, read together: the fence holds to them.
    const tip = this.deps.pulls.branchTip(pull.baseRef);
    const shown = { codeOwners: result.stamp, baseTip: tip ? oidToHex(tip) : null };
    // Decided by a snapshot within the write window; none to be had: tried again.
    await this.deps.acl().pullForWrite();
    if (result.state === "none" || result.rules.length === 0) {
      // No rule decides a changed path with owners: every code owners' request is taken back.
      const read = this.#read(pull, shown, "", () => []);
      if (!read) return false;
      await this.deps.prepareFeed();
      return this.#apply(job, pull, read, { asks: [], marks: [], pass: null, audience: undefined });
    }
    this.#readDirectory = true;
    // The reviews as the reviewers are read (`reviewersNow` reads them before its first await).
    const reviewsRead = this.deps.reviews.stamp(number);
    const reviewers = await this.deps.reviewersNow(number);
    if (!reviewers) {
      // More reviewers matter than one read covers: asked again once a review changes (unless
      // one changed while they were read: then at once).
      return this.deps.git.context.storage.transactionSync(() => {
        if (this.deps.reviews.stamp(number) !== reviewsRead) return false;
        this.deps.metrics.count("code_owners.request_skipped", { reason: "reviewers" });
        this.deps.log().warn("too many reviewers to ask code owners", { number });
        this.#setWaiting(number, "reviewers");
        this.#done(job);
        return true;
      });
    }
    this.#readDirectory = true;
    const read = this.#read(pull, shown, reviewers.stamp, reviewers.promoted);
    if (!read) return false;
    const candidates = probesOf(
      ownershipCandidates(
        {
          reviews: [...reviewers.facts].sort((a, b) => a.seq - b.seq),
          headSha: pull.headSha,
          authorRoot: pull.authorRoot,
          lastPush: null,
          eligibleRoots: reviewers.eligibleRoots,
          eligiblePrincipals: reviewers.eligiblePrincipals,
        },
        ASKING,
      ),
    );
    const basis = JSON.stringify([
      read.codeOwners,
      read.reviews,
      read.acl,
      await digest(candidates.probes),
    ]);
    const saved = job.state ? (JSON.parse(job.state) as Pass) : null;
    const pass: Pass = saved?.basis === basis ? saved : freshPass(basis);
    const decided = await this.#decide(pull, result.rules, pass, candidates, read.standing);
    if (decided === "restart") {
      // The organization changed under the partial work: from the first rule again.
      this.#saveState(job, null);
      return true;
    }
    // Every team to ask, read (a team waiting for members room does not keep one behind it
    // from being asked): at most the slice's teams and those of the rule it went on with.
    const teamsFirst = decided.asks.flatMap((a) => (a.kind === "team" ? [a.slug] : []));
    let audience: TeamAudience | undefined;
    if (teamsFirst.length > 0) {
      const answer = await this.deps.teamAudience(teamsFirst);
      if (answer === "unavailable") return false;
      const fit = this.deps.audienceFit(answer);
      if (fit !== "same") {
        // Read with a newer ACL than the repository's: that one is pulled for the next slice.
        if (fit === "newer") this.deps.adoptAudience(answer);
        return false;
      }
      audience = answer;
    }
    await this.deps.prepareFeed();
    return this.#apply(job, pull, read, { ...decided, pass, audience });
  }

  /**
   * Works through the rules from where `pass` is, within a slice's
   * budgets: resolves their owners, decides each rule (one of its owners
   * approved, or not), and returns, for the rules it decided, the owners
   * to ask and the standing requests to mark as code owners' too; `pass`
   * moves on (`finished` once past the last rule). `restart` when the
   * organization's answer is newer than the partial work's.
   */
  async #decide(
    pull: PullRecord,
    rules: Extract<MergeCodeOwners, { state: "complete" }>["rules"],
    pass: Pass,
    candidates: Probes,
    standing: Standing,
  ): Promise<{ asks: Ask[]; marks: Ask[] } | "restart"> {
    const policy = this.deps.policy();
    const account = this.deps.account();
    const plan = planSlice(rules, pass, policy);
    const handles = new Map<string, string>();
    for (const entry of plan)
      for (const token of entry.users) handles.set(token.toLowerCase(), token.slice(1));
    await this.deps.hooks().beforeResolve?.();
    const { facts, ownerCeilings, accountHandle } = await this.deps.facts.resolveHandles(handles);
    // Teams of the repository's own organization (`@org/slug` with its handle): their slugs. A
    // user's repository has none.
    const ours = (token: string): string | undefined => {
      const slash = token.indexOf("/");
      return account &&
        isId(account.accountId, "org") &&
        accountHandle !== undefined &&
        token.slice(1, slash).toLowerCase() === accountHandle
        ? token.slice(slash + 1).toLowerCase()
        : undefined;
    };
    const slugs = new Set<string>();
    /**
     * Whether a rule of the slice is satisfied so far: by its users' approvals (judged now) or
     * by a team member's approval a slice before found; `lost` when a user's it rested on
     * holds no more.
     */
    const holds = (entry: (typeof plan)[number]): "users" | "teams" | "lost" | false => {
      const users = usersSatisfy(entry.users, facts, candidates.list);
      if (!entry.continuing || !pass.part?.satisfied) return users ? "users" : false;
      if (pass.part.byUsers) return users ? "users" : "lost";
      return "teams";
    };
    // The rules still unsatisfied with teams of ours: their teams (as slugs, and as positions among the rule's teams) to probe.
    const groups: { index: number; slugs: string[]; positions: number[] }[] = [];
    for (const entry of plan) {
      const teams = teamsOf(rules, entry.index);
      const group = { index: entry.index, slugs: [] as string[], positions: [] as number[] };
      for (let at = entry.teams[0]; at < entry.teams[1]; at++) {
        const slug = ours(teams[at] as string);
        if (slug === undefined) continue;
        slugs.add(slug);
        group.slugs.push(slug);
        group.positions.push(at);
      }
      const held = holds(entry);
      // Satisfied by a user owner who no longer is (disabled, gone since): the teams it let
      // go unprobed are probed from the first rule again.
      if (held === "lost") return "restart";
      if (!held && group.slugs.length > 0) groups.push(group);
    }
    let answer: CodeOwnerTeamFacts | undefined;
    // Read whenever the slice has teams of ours, or a pass under way read the organization
    // before (its partial work holds only while that answer does, teams to read or not).
    if (account && (slugs.size > 0 || pass.teams !== null)) {
      const from =
        groups[0] && plan[0]?.continuing && groups[0].index === pass.rule
          ? (pass.part?.from ?? 0)
          : 0;
      this.deps.metrics.count("do.request", { class: "OrgDO", method: "codeOwnerTeamFacts" });
      answer = await this.deps.teamFacts(account.accountId, [...slugs], {
        groups: groups.map((g) => g.slugs),
        candidates: candidates.probes,
        start: { team: 0, from },
        probes: policy.maxProbes,
      });
      if (this.#stale(answer, pass)) return "restart";
    }
    const teamFact = (token: string): CodeOwnerFact => {
      const slug = ours(token);
      if (slug === undefined)
        return {
          kind: "team",
          token,
          qualified: false,
          reason: "not this repository's organization",
        };
      const team = answer?.teams[slug];
      if (!team) return { kind: "team", token, qualified: false, reason: "no such team" };
      if (!atLeast(team.role, "write"))
        return { kind: "team", token, qualified: false, reason: "no write access" };
      return { kind: "team", token, teamId: team.teamId, qualified: true };
    };

    const asks: Ask[] = [];
    const marks: Ask[] = [];
    const seen = new Set<string>();
    for (const entry of plan) {
      const rule = rules[entry.index] as { readonly owners: readonly string[] };
      const teams = teamsOf(rules, entry.index);
      const owners: Owners = entry.continuing ? { ...pass.part?.owners } : {};
      const roots: Record<string, string> = entry.continuing ? { ...pass.part?.roots } : {};
      for (const token of entry.users) {
        const owner = facts.get(token.toLowerCase());
        if (!owner?.qualified || owner.kind === "team") continue;
        const [root] = ownerCeilings.get(owner.principal) ?? [];
        if (root) roots[owner.principal] = root;
      }
      for (const token of entry.users)
        owners[token.toLowerCase()] = facts.get(token.toLowerCase()) as CodeOwnerFact;
      for (const token of teams.slice(...entry.teams))
        owners[token.toLowerCase()] = teamFact(token);
      const held = holds(entry);
      let satisfied = held === "users" || held === "teams";
      const g = groups.findIndex((group) => group.index === entry.index);
      if (!satisfied && g >= 0) {
        const outcome = answer?.groups[g];
        if (outcome === undefined) throw new Error("the organization left a rule's teams unread");
        if (outcome.outcome === "member") satisfied = true;
        else if (outcome.outcome === "stopped") {
          // Its probes ran out within this rule: it goes on from there in the next slice.
          const group = groups[g] as (typeof groups)[number];
          pass.part = {
            team: group.positions[outcome.team] ?? entry.teams[1],
            from: outcome.from,
            satisfied: false,
            owners,
            roots,
          };
          return { asks, marks };
        }
      }
      if (entry.teams[1] < teams.length) {
        // Its other teams are read in the next slice (whether it is satisfied is kept).
        pass.part = {
          team: entry.teams[1],
          from: 0,
          satisfied,
          byUsers: held === "users",
          owners,
          roots,
        };
        return { asks, marks };
      }
      // Decided: its qualified owners own a changed path still; unsatisfied, they are asked.
      for (const token of rule.owners) {
        const owner = owners[token.toLowerCase()];
        if (!owner?.qualified) continue;
        const ask: Ask =
          owner.kind === "team"
            ? { kind: "team", id: owner.teamId, slug: token.slice(token.indexOf("/") + 1) }
            : {
                kind: "principal",
                id: owner.principal,
                root: roots[owner.principal] ?? owner.principal,
              };
        keep(pass, ask, standing);
        const key = `${ask.kind}:${ask.id}`;
        if (satisfied || seen.has(key)) continue;
        seen.add(key);
        if (ask.kind === "principal" && ask.root === pull.authorRoot) continue;
        const reasons =
          ask.kind === "principal"
            ? standing.principals.get(ask.id)
            : standing.teams.get(ask.id)?.reasons;
        if (reasons !== undefined) {
          if (!(reasons & OWNERS)) marks.push(ask);
          continue;
        }
        if (!standing.asked.has(key)) asks.push(ask);
      }
      pass.rule = entry.index + 1;
      pass.part = null;
    }
    return { asks, marks };
  }

  /**
   * Whether the organization's `answer` is newer than what the partial
   * work was read under (it starts again; the repository's floor is
   * raised to it, so its next decisions read roles at least as new);
   * an answer of another account, or older, is refused (thrown: tried
   * again). Records the first answer of a pass.
   */
  #stale(answer: CodeOwnerTeamFacts, pass: Pass): boolean {
    const acl = this.deps.acl();
    if (answer.accountId !== this.deps.account()?.accountId)
      throw new Error("the answer is another account's");
    if (acl.isBelowFloor(answer.accountId, answer.epochGen, answer.version))
      throw new Error("the organization answered from an older ACL");
    const known = pass.teams;
    if (known && (known.epochGen !== answer.epochGen || known.version !== answer.version)) {
      if (below(answer, known)) throw new Error("the organization answered from an older ACL");
      acl.invalidate(answer.accountId, answer.epochGen, answer.version);
      return true;
    }
    pass.teams = {
      accountId: answer.accountId,
      epochGen: answer.epochGen,
      version: answer.version,
    };
    return false;
  }

  /**
   * In one transaction, if nothing it was decided on changed: asks what
   * fits of `asks` (in order; the rest wait for room), marks `marks`,
   * writes who was asked to the ledger, and saves the pass, or, once it
   * passed the last rule (or for no pass: no rule names owners), takes
   * back the code owners' requests no rule kept and ends the job. False
   * when fenced off.
   */
  async #apply(
    job: Job,
    pull: PullRecord,
    read: Read,
    decided: {
      readonly asks: readonly Ask[];
      readonly marks: readonly Ask[];
      readonly pass: Pass | null;
      readonly audience: TeamAudience | undefined;
    },
  ): Promise<boolean> {
    await this.deps.hooks().beforeApply?.();
    const number = pull.number;
    const { asks, marks, pass, audience } = decided;
    const applied = this.deps.git.context.storage.transactionSync(() => {
      if (!this.#fenced(job, pull, read)) return false;
      if (audience && this.deps.audienceFit(audience) !== "same") return false;
      const fitted = this.#fit(number, pull, asks, audience);
      const live = this.deps.teams.live(number);
      const finished = pass === null || pass.rule >= (this.#rulesOf(pull) ?? 0);
      if (pass) {
        // Asked or marked now: theirs are code owners' requests owning a changed path.
        for (const ask of [...fitted.asked, ...marks]) keepAsked(pass, ask);
      }
      const teamRequest = new Map(live.map((r) => [r.team.id, r.requestId]));
      const { withdrawn } = this.deps.withFeed(
        { root: pull.authorRoot, role: null, mentioned: new Map() },
        () =>
          this.deps.reviews.askOwners(
            number,
            {
              principals: fitted.principals,
              teams: fitted.teams,
              ...(audience && {
                audience: { accountId: audience.accountId, epochGen: audience.epochGen },
              }),
              mark: {
                principals: marks.flatMap((m) => (m.kind === "principal" ? [m.id] : [])),
                teams: marks.flatMap((m) =>
                  m.kind === "team" ? (teamRequest.get(m.id) ?? []) : [],
                ),
              },
              takeBack: finished
                ? takeBackOf(read.standing, live, pass)
                : { principals: [], teams: [] },
            },
            { principal: pull.authorId, via: "api" },
          ),
      );
      const now = this.#now();
      // Asked once: those asked now, too large to ask ever, and those whose standing requests
      // became code owners' too (a person withdrawing one does not get them asked again).
      for (const ask of [...fitted.ledger, ...marks])
        this.#run(
          "INSERT OR IGNORE INTO code_owner_asked (pr_number, kind, id, asked_at) VALUES (?, ?, ?, ?)",
          number,
          ask.kind,
          ask.id,
          now,
        );
      const waited = fitted.waited || pass?.waited === true;
      if (!finished) {
        if (pass) pass.waited = waited;
        // Waiting from the first owner left out: a place freed meanwhile starts the pass again.
        if (fitted.waited) this.#setWaiting(number, "room");
        this.#saveState(job, pass);
        return true;
      }
      this.#done(job);
      if (!waited) this.#run("DELETE FROM code_owner_waiting WHERE pr_number = ?", number);
      // Owners left waiting: asked again at once when taking back made room, else once a
      // place frees.
      else if (withdrawn > 0) this.queue(number);
      else this.#setWaiting(number, "room");
      return true;
    });
    if (applied) this.deps.committed();
    return applied;
  }

  /**
   * In the transaction: of `asks` (in rule order), those that fit the pull
   * request's places and team members' allowance and still qualify by the
   * snapshot the change is decided by; whether any had to wait; who goes
   * to the ledger (those asked, and teams too large to ask ever).
   */
  #fit(
    number: number,
    pull: PullRecord,
    asks: readonly Ask[],
    audience: TeamAudience | undefined,
  ): {
    principals: { id: string; root: string }[];
    teams: OwnersAsk["teams"][number][];
    asked: Ask[];
    ledger: Ask[];
    waited: boolean;
  } {
    const policy = this.deps.policy();
    let { places, associations } = this.#room(number);
    const byTeam = new Map((audience?.teams ?? []).map((t) => [t.id, t]));
    const author = new Set([pull.authorId, pull.authorRoot]);
    const fitted = {
      principals: [] as { id: string; root: string }[],
      teams: [] as OwnersAsk["teams"][number][],
      asked: [] as Ask[],
      ledger: [] as Ask[],
      waited: false,
    };
    for (const ask of asks) {
      if (ask.kind === "principal") {
        if (places === 0) {
          fitted.waited = true;
          continue;
        }
        // Qualified when resolved: still, an agent capped by its owner.
        const ceilings = ask.root === ask.id ? [] : [ask.root];
        if (!atLeast(this.deps.authority.roleNow(ask.id, ceilings), "write")) continue;
        places--;
        fitted.principals.push({ id: ask.id, root: ask.root });
        fitted.asked.push(ask);
        fitted.ledger.push(ask);
        continue;
      }
      const team = byTeam.get(ask.id);
      if (team?.members === null) {
        // More members than one request asks: not asked, now or later.
        this.deps.metrics.count("code_owners.request_skipped", { reason: "team_too_large" });
        this.deps.log().warn("a code owner team is too large to ask", { number, team: ask.id });
        fitted.ledger.push(ask);
        continue;
      }
      if (places === 0) {
        fitted.waited = true;
        continue;
      }
      // Gone since it was resolved: the next pass judges it again.
      if (!team) continue;
      // No longer readable by the answer read last: the next pass judges it again.
      if (!atLeast(team.role, "write")) continue;
      const members = (team.members ?? []).filter((id) => !author.has(id));
      if (associations + members.length > policy.maxAssociations) {
        fitted.waited = true;
        continue;
      }
      places--;
      associations += members.length;
      fitted.teams.push({ id: team.id, slug: team.slug, name: team.name, members });
      fitted.asked.push(ask);
      fitted.ledger.push(ask);
    }
    return fitted;
  }

  /**
   * What a slice decides by, as read: the pull request, the result it
   * works on with the base tip it was shown for (`shown`, read with the
   * result), the reviews' stamp as the reviewers were read (`reviews`), and,
   * read now with no await between, its requests (with their stamp) and
   * its ledger, the ownership and the ACL basis; undefined while no
   * snapshot is there to decide by.
   */
  #read(
    pull: PullRecord,
    shown: { readonly codeOwners: string; readonly baseTip: string | null },
    reviews: string,
    promoted: () => readonly string[],
  ): Read | undefined {
    const basis = this.deps.acl().basis();
    const account = this.deps.account();
    if (typeof basis === "string" || !account) return undefined;
    return {
      head: pull.headSha,
      baseRef: pull.baseRef,
      baseTip: shown.baseTip,
      codeOwners: shown.codeOwners,
      reviews,
      promoted,
      accountId: account.accountId,
      ownerGen: account.ownerGen,
      acl: `${basis.accountId}:${basis.epochGen}:${basis.version}`,
      standing: this.#standing(pull.number),
    };
  }

  /** The pull request's requests and ledger now, and their stamp. */
  #standing(number: number): Standing {
    const principals = new Map(
      this.#rows<{ reviewer_id: string; reasons: number }>(
        "SELECT reviewer_id, reasons FROM review_requests WHERE pr_number = ?",
        number,
      ).map((row) => [row.reviewer_id, row.reasons]),
    );
    const teams = new Map(this.deps.teams.live(number).map((r) => [r.team.id, r]));
    const asked = new Set(
      this.#rows<{ kind: string; id: string }>(
        "SELECT kind, id FROM code_owner_asked WHERE pr_number = ?",
        number,
      ).map((row) => `${row.kind}:${row.id}`),
    );
    return { principals, teams, asked, stamp: this.deps.reviews.requestsStamp(number) };
  }

  /**
   * In the transaction: whether the job is still this slice's, and the
   * pull request, its result, requests and reviews, its ownership and the
   * ACL are as `read` read them.
   */
  #fenced(job: Job, pull: PullRecord, read: Read): boolean {
    if (!this.deps.writable()) return false;
    const queued = this.#rows<{ seq: number }>(
      "SELECT seq FROM code_owner_request_jobs WHERE pr_number = ?",
      job.pr_number,
    )[0];
    if (queued?.seq !== job.seq) return false;
    const now = this.deps.pulls.get(pull.number);
    if (now?.state !== "open" || now.draft) return false;
    const tip = this.deps.pulls.branchTip(now.baseRef);
    const account = this.deps.account();
    const basis = this.deps.acl().basis();
    return (
      now.headSha === read.head &&
      now.baseRef === read.baseRef &&
      (tip ? oidToHex(tip) : null) === read.baseTip &&
      this.deps.codeOwners.stampFor(now) === read.codeOwners &&
      this.deps.reviews.requestsStamp(pull.number) === read.standing.stamp &&
      (read.reviews === "" || this.deps.reviews.stamp(pull.number) === read.reviews) &&
      // A reviewer left out who writes now may own: the slice is read again.
      read.promoted().length === 0 &&
      account?.accountId === read.accountId &&
      account.ownerGen === read.ownerGen &&
      typeof basis !== "string" &&
      `${basis.accountId}:${basis.epochGen}:${basis.version}` === read.acl
    );
  }

  /** How many rules `pull`'s shown result needs owners for (undefined: none shown). */
  #rulesOf(pull: PullRecord): number | undefined {
    const result = this.deps.codeOwners.shownFor(pull);
    return result?.state === "complete" ? result.rules.length : undefined;
  }

  /** The places and team members a pull request's requests leave. */
  #room(number: number): { places: number; associations: number } {
    const principals =
      this.#rows<{ n: number }>(
        "SELECT count(*) AS n FROM review_requests WHERE pr_number = ?",
        number,
      )[0]?.n ?? 0;
    const teams = this.deps.teams.live(number).length;
    return {
      places: Math.max(0, MAX_REQUESTED_REVIEWERS - principals - teams),
      associations: this.deps.teams.associations(number),
    };
  }

  #setWaiting(number: number, reason: "room" | "reviewers"): void {
    this.#run(
      `INSERT INTO code_owner_waiting (pr_number, reason) VALUES (?, ?)
       ON CONFLICT (pr_number) DO UPDATE SET reason = excluded.reason`,
      number,
      reason,
    );
  }

  /** Ends the job's pass for its pull request, unless queued again since. */
  #done(job: Job): void {
    this.#run(
      "DELETE FROM code_owner_request_jobs WHERE pr_number = ? AND seq = ?",
      job.pr_number,
      job.seq,
    );
  }

  /** Saves where the pass is (none: from the first rule), unless queued again since. */
  #saveState(job: Job, pass: Pass | null): void {
    this.#run(
      "UPDATE code_owner_request_jobs SET state = ? WHERE pr_number = ? AND seq = ?",
      pass ? JSON.stringify(pass) : null,
      job.pr_number,
      job.seq,
    );
  }

  #ensureJob(): void {
    this.deps.git.jobs.ensure("code_owner_requests", CODE_OWNER_REQUESTS_JOB_ID);
  }

  #run(query: string, ...bindings: SqlStorageValue[]): void {
    this.#count(this.#sql.exec(query, ...bindings).rowsWritten);
  }

  #rows<T extends Record<string, SqlStorageValue>>(
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
        { class: this.deps.git.context.doClass, op: "code_owner_requests.write" },
        written,
      );
  }
}

/** The pull request's standing requests (reasons by principal, team requests by team id), ledger and stamp. */
interface Standing {
  readonly principals: ReadonlyMap<string, number>;
  readonly teams: ReadonlyMap<string, TeamRequest>;
  /** `principal:id` and `team:id` asked once before. */
  readonly asked: ReadonlySet<string>;
  readonly stamp: string;
}

/** What a slice read before deciding (see `#read`). */
interface Read {
  readonly head: string;
  readonly baseRef: string;
  readonly baseTip: string | null;
  readonly codeOwners: string;
  /** The reviews' stamp as the reviewers were read; empty when they were not. */
  readonly reviews: string;
  /** Reviewers left out for want of write access who have it now (see `ReviewersNow.promoted`). */
  readonly promoted: () => readonly string[];
  readonly accountId: string;
  readonly ownerGen: number;
  readonly acl: string;
  readonly standing: Standing;
}

/** The ownership candidates, and who to probe for a team's membership: each, and an agent's user. */
interface Probes {
  readonly list: readonly OwnershipCandidate[];
  readonly probes: readonly string[];
}

function probesOf(list: readonly OwnershipCandidate[]): Probes {
  const probes = new Set<string>();
  for (const c of list) {
    probes.add(c.principal);
    if (c.byAgent && c.root !== c.principal) probes.add(c.root);
  }
  return { list, probes: [...probes] };
}

/** The directory queries one slice runs at most: its reviewers' activity, its handles and the account's row. */
export function sliceQueries(policy: CodeOwnerRequestPolicy): number {
  return Math.ceil(MAX_ACTIVITY_PRINCIPALS / ACTIVE_BATCH) + policy.handleBatches + 1;
}

function freshPass(basis: string): Pass {
  return {
    basis,
    teams: null,
    rule: 0,
    part: null,
    kept: { principals: [], teams: [] },
    waited: false,
  };
}

/** A rule's owners as written: users and agents (`@handle`), and teams (`@org/slug`). */
function split(owners: readonly string[]): { users: string[]; teams: string[] } {
  return {
    users: owners.filter((t) => !t.includes("/")),
    teams: owners.filter((t) => t.includes("/")),
  };
}

function teamsOf(
  rules: readonly { readonly owners: readonly string[] }[],
  index: number,
): string[] {
  return split((rules[index] as { owners: readonly string[] }).owners).teams;
}

/**
 * The rules a slice works on, from where `pass` is: whole rules while
 * their new handles fit the slice's directory batches and their teams its
 * team budget, the last perhaps only in part (its teams from where it
 * stands); each with its users to resolve (again for one under way) and
 * the range of its teams to read.
 */
function planSlice(
  rules: readonly { readonly owners: readonly string[] }[],
  pass: Pass,
  policy: CodeOwnerRequestPolicy,
): { index: number; continuing: boolean; users: string[]; teams: [number, number] }[] {
  const plan: { index: number; continuing: boolean; users: string[]; teams: [number, number] }[] =
    [];
  const handles = new Set<string>();
  let teamsLeft = policy.maxTeams;
  for (let index = pass.rule; index < rules.length; index++) {
    const { users, teams } = split((rules[index] as { owners: readonly string[] }).owners);
    const continuing = index === pass.rule && pass.part !== null;
    // A rule under way resolves its users again: one disabled or gone since is not asked.
    const fresh = users.filter((t) => !handles.has(t.toLowerCase()));
    if (plan.length > 0 && handles.size + fresh.length > policy.handleBatches * HANDLE_BATCH) break;
    const start = continuing ? (pass.part?.team ?? 0) : 0;
    const end = Math.min(teams.length, start + teamsLeft);
    // Only the slice's first rule is read in part.
    if (plan.length > 0 && end < teams.length) break;
    for (const t of fresh) handles.add(t.toLowerCase());
    teamsLeft -= end - start;
    plan.push({ index, continuing, users, teams: [start, end] });
    if (end < teams.length || teamsLeft === 0) break;
  }
  return plan;
}

/** Whether one of `users` (qualified users and agents) approved as a candidate, as a merge judges ownership. */
function usersSatisfy(
  users: readonly string[],
  facts: ReadonlyMap<string, CodeOwnerFact>,
  candidates: readonly OwnershipCandidate[],
): boolean {
  return users.some((token) => {
    const owner = facts.get(token.toLowerCase());
    if (!owner?.qualified || owner.kind === "team") return false;
    return candidates.some(
      (c) =>
        c.principal === owner.principal ||
        (owner.kind === "user" && c.byAgent && c.root === owner.principal),
    );
  });
}

/** Marks `ask`'s standing code owners' request, if it has one, as owning a changed path still. */
function keep(pass: Pass, ask: Ask, standing: Standing): void {
  const reasons =
    ask.kind === "principal"
      ? standing.principals.get(ask.id)
      : standing.teams.get(ask.id)?.reasons;
  if (reasons !== undefined && reasons & OWNERS) keepAsked(pass, ask);
}

function keepAsked(pass: Pass, ask: Ask): void {
  const kept = ask.kind === "principal" ? pass.kept.principals : pass.kept.teams;
  if (!kept.includes(ask.id)) kept.push(ask.id);
}

/** The code owners' requests standing that no rule of `pass` kept (every one, with no pass). */
function takeBackOf(
  standing: Standing,
  live: readonly TeamRequest[],
  pass: Pass | null,
): OwnersAsk["takeBack"] {
  const principals = new Set(pass?.kept.principals ?? []);
  const teams = new Set(pass?.kept.teams ?? []);
  return {
    principals: [...standing.principals]
      .filter(([id, reasons]) => reasons & OWNERS && !principals.has(id))
      .map(([id]) => id),
    teams: live.filter((r) => r.reasons & OWNERS && !teams.has(r.team.id)).map((r) => r.requestId),
  };
}

function below(
  a: { readonly epochGen: number; readonly version: number },
  b: { readonly epochGen: number; readonly version: number },
): boolean {
  return a.epochGen < b.epochGen || (a.epochGen === b.epochGen && a.version < b.version);
}

/** A digest of `ids` in order (an offset into them is meaningful only for the same list). */
async function digest(ids: readonly string[]): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(ids))),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
