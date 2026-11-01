import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  type ApprovalInput,
  type ApprovalSettings,
  atLeast,
  type CommentSide,
  checkAnchor,
  lineCount,
  MAX_REQUESTED_REVIEWERS,
  type MergeContext,
  ownershipCandidates,
  type ReviewFact,
  rootIdentity,
} from "@fyrden/domain";
import { type BlockCache, oidFromHex, oidToHex } from "@fyrden/git-core";
import type { TeamAudience } from "../OrgDO.js";
import { ACTIVE_BATCH, MAX_ACTIVITY_PRINCIPALS, type RepoAuthority } from "./authority.js";
import { type BrowseFailure, RepoBrowse } from "./browse.js";
import type { CodeOwnerFacts } from "./code-owner-facts.js";
import { rawFile } from "./contents.js";
import type { PullView } from "./mergeability.js";
import { mergeBaseOf } from "./pull-files.js";
import type { PullCaller, PullRecord, RepoPulls } from "./pulls.js";
import type { Reacted } from "./reactions.js";
import {
  type Comparison,
  needsMergeBase,
  type RepoReviewComments,
  type ReviewCommentFailure,
  type ReviewCommentRecord,
  type ThreadAnchor,
} from "./review-comments.js";
import type { RepoReviews, ReviewFailure } from "./reviews.js";

/*
 * What a pull request's reviewers do through the repository object: review
 * requests checked against each reviewer's access, threads on its diff at
 * anchors checked against the files they name (answered with what the diff
 * compares now, so a client can tell an outdated one), and the standing
 * the rulesets judge a merge by. Each change runs under the object's
 * authorization of pull request changes (`PullChange`).
 */

/** Why a change of pull requests or reviews was not attempted. */
export type PullChangeRefusal = "repo_not_found" | "repo_transferring" | "access_lost";

/**
 * Runs a change of pull requests or reviews for `actor`, as one measured
 * invocation: anything `prepare` reads is worked out first, then
 * everything else the change needs (its feed's), then `last` (when given:
 * its answer goes to `change`), then, with no await before `change`,
 * whether the repository takes changes and the caller's role now.
 */
export type PullChange = <R, P = undefined, L = undefined>(
  method: string,
  actor: RefActor,
  change: (caller: PullCaller, prepared: P, last: L) => R,
  prepare?: () => Promise<P>,
  /** Texts the change writes, whose mentions its activity-feed entries name. */
  texts?: readonly (string | null | undefined)[],
  last?: () => Promise<L>,
) => Promise<R | { ok: false; code: PullChangeRefusal }>;

/** Whether a team audience was read with the ACL the repository decides by now. */
export type AudienceFit = "same" | "older" | "newer" | "unavailable";

/** Times a team request reads its teams again when they were read with another ACL. */
const AUDIENCE_ATTEMPTS = 3;

/** The largest file a diff comment's anchor is checked against. */
const ANCHOR_MAX_BYTES = 1024 * 1024;

/** What a pull request's diff compares, with the base it was worked out from. */
interface Compared {
  readonly comparison: Comparison;
  readonly baseRef: string;
  /** The base tip it was worked out from, as `RepoPulls.comparedBase` gave it. */
  readonly baseTip: string;
}

/** What the fence compares: the pull request's reviews, threads, eligible reviewers and code owners. */
export interface MergeStamps {
  readonly reviews: string;
  readonly threads: string;
  readonly eligible: string;
  /** Reviewers (principals) with write access themselves, when an enforced code-owner requirement reads them; empty otherwise. */
  readonly principals: string;
  /** The code owners' result an enforced requirement was judged by; empty without one. */
  readonly codeOwners: string;
  /** Reviewers left out for want of write access who have it now (none when read). */
  readonly promoted: string;
}

/** The pull request's merge context and stamps, as `mergePull` works them out. */
export interface MergeStanding {
  readonly merge: MergeContext;
  /**
   * Each eligible reviewer's root and principal, and each agent owner, →
   * the owners capping it (an agent's owner), for its confirmation.
   */
  readonly ceilings: ReadonlyMap<string, readonly string[]>;
  /**
   * The ownership candidates of an enforced code-owner requirement (and
   * the users their agents are rooted in), whom its confirmation may ask
   * about; empty without one.
   */
  readonly ownerCandidates: readonly string[];
  /** Why the merge is refused before anything is stored (its code owners could not be prepared). */
  readonly refusal?: { readonly status: 409 | 422; readonly code: string; readonly error: string };
  /** The stamps now (called again in the commit's transaction). */
  readonly stamps: () => MergeStamps;
}

/** A pull request's reviews as they count now (see `PullDiscussion.reviewersNow`). */
export interface ReviewersNow {
  /** The reviews' stamp as read (`RepoReviews.stamp`). */
  readonly stamp: string;
  /** The reviews that can matter, each active or not. */
  readonly facts: readonly ReviewFact[];
  /** Active principals among their reviewers, roots and agents → the owners capping each. */
  readonly active: ReadonlyMap<string, readonly string[]>;
  readonly roots: ReadonlySet<string>;
  readonly principals: ReadonlySet<string>;
  /** Roots and reviewers with write access now (effective: an agent capped by its owner). */
  readonly eligibleRoots: ReadonlySet<string>;
  readonly eligiblePrincipals: ReadonlySet<string>;
  /** Of `of`, those active with write access now (read again in a commit's transaction). */
  readonly writers: (of: ReadonlySet<string>) => string[];
  /**
   * Of the roots and reviewers of the reviews left out (none could write),
   * those that write now: any is a review the decision did not weigh.
   */
  readonly promoted: () => string[];
}

/** The first comment of a new thread on a pull request's diff, as the Worker asks for it. */
export interface NewReviewComment {
  readonly body: string;
  readonly commitId: string;
  readonly path: string;
  readonly side: CommentSide;
  readonly line: number;
  readonly startLine?: number;
}

export interface DiscussionDeps {
  readonly git: RepoGitStorage;
  readonly pulls: RepoPulls;
  readonly reviews: RepoReviews;
  readonly reviewComments: RepoReviewComments;
  /** Diff comments as the API answers them, with their reactions counted. */
  readonly reacted: (comments: readonly ReviewCommentRecord[]) => Reacted<ReviewCommentRecord>[];
  readonly authority: RepoAuthority;
  /** A merge's code owners, resolved and qualified. */
  readonly codeOwnerFacts: CodeOwnerFacts;
  /** The stamp of a pull request's code owners now, read alone. */
  readonly codeOwnersStamp: (pull: PullRecord) => string;
  readonly memoryBlocks: () => BlockCache;
  /** A pull request with whether it merges, as far as that is known now. */
  readonly viewed: (pull: PullRecord) => PullView;
  readonly pullChange: PullChange;
  /**
   * The repository's organization's teams `slugs`, as a review request
   * asks them; `unavailable` when they could not be read.
   */
  readonly teamAudience: (slugs: readonly string[]) => Promise<TeamAudience | "unavailable">;
  /**
   * Synchronously: how `audience`'s ACL compares with the one the
   * repository decides by now (`unavailable`: another account's, or none).
   */
  readonly audienceFit: (audience: TeamAudience) => AudienceFit;
  /** The repository decides by `audience`'s ACL or a newer one from now on (pulled when used). */
  readonly adoptAudience: (audience: TeamAudience) => void;
}

/** A review request's answer when its teams could not be read with the ACL it decides by. */
export type AudienceRefusal = "team_audience_unavailable" | "team_owner_changed";

export class PullDiscussion {
  constructor(private readonly deps: DiscussionDeps) {}

  /**
   * A pull request's reviews as they count now, from the repository's own
   * records: its picked reviews (`RepoReviews.standing`) that can matter
   * (whose root or reviewer writes by its own role), whose reviewers,
   * roots and the agents a delegation's review went through are active,
   * read once here (each with the owner capping it), and who of them has
   * write access now, by root for counting and by reviewer for code
   * owners (`writers` asks again, in the commit's transaction). Undefined
   * when more of them matter than one read of their activity covers.
   */
  async reviewersNow(number: number): Promise<ReviewersNow | undefined> {
    const { reviews, authority } = this.deps;
    const standing = reviews.standing(number);
    const read = await authority.reviewerActivity(standing.reviews);
    if (!read) return undefined;
    const { kept, left, active } = read;
    const writers = (of: ReadonlySet<string>) => {
      const roles = authority.rolesNow();
      return [...active]
        .filter(([id, owners]) => of.has(id) && atLeast(roles(id, owners), "write"))
        .map(([id]) => id);
    };
    const roots = new Set(kept.map((r) => r.reviewerRoot));
    const principals = new Set(kept.map((r) => r.reviewerId));
    return {
      stamp: standing.stamp,
      facts: kept.map(({ actChain, ...r }) => ({
        ...r,
        active: active.has(r.reviewerId) && actChain.every((agent) => active.has(agent)),
      })),
      active,
      roots,
      principals,
      eligibleRoots: new Set(writers(roots)),
      eligiblePrincipals: new Set(writers(principals)),
      writers,
      promoted: () => {
        const writes = authority.writersNow();
        return left.filter(writes);
      },
    };
  }

  /**
   * The directory queries `standing` runs for `pull` at most, worked out
   * before it runs: its reviewers' activity (a query a thousand), its code
   * owners' handles (`CodeOwnerFacts.queriesFor`), and the last pusher's
   * and the merger's owners (a query each).
   */
  standingQueries(number: number, pull: PullRecord): { queries: number; codeOwners: string } {
    const picks = this.deps.reviews.standing(number).reviews;
    const principals = new Set(picks.flatMap((r) => [r.reviewerRoot, r.reviewerId, ...r.actChain]));
    return {
      queries:
        Math.ceil(Math.min(principals.size, MAX_ACTIVITY_PRINCIPALS) / ACTIVE_BATCH) +
        this.deps.codeOwnerFacts.queriesFor(pull) +
        2,
      // The code owners' result the bound was worked out for (`standing` holds to it).
      codeOwners: this.deps.codeOwnersStamp(pull),
    };
  }

  /**
   * What the rulesets judge a merge by `merger`, from the repository's own
   * records: the pull request's reviews as they count now (`reviewersNow`),
   * its last push and threads, and its code owners when the merger's rules
   * ask for them; `asRead` stamps them as read (before any wait), `stamps`
   * as they are when called (in the commit's transaction).
   */
  async standing(
    number: number,
    pull: PullRecord,
    method: MergeContext["method"],
    upToDate: boolean,
    merger: { readonly principal: string; readonly grantId: string | null },
    /** The code owners' result a budget of its queries was worked out for (`standingQueries`). */
    budgeted?: string,
  ): Promise<MergeStanding & { readonly asRead: MergeStamps }> {
    const { reviews, reviewComments, authority } = this.deps;
    const threadsThen = reviewComments.stamp(number);
    const now = await this.reviewersNow(number);
    if (!now) return tooManyReviewers(number, pull, method, upToDate);
    const { active, roots, principals, eligibleRoots, eligiblePrincipals, writers } = now;
    const lastPush =
      pull.lastPusher === null || pull.lastPushAt === null
        ? null
        : {
            pusherRoot: rootIdentity({
              principalId: pull.lastPusher,
              grantId: pull.lastPusherGrant,
              ceilingIds: await authority.ceilingsOf(pull.lastPusher, pull.lastPusherGrant),
            }),
            at: pull.lastPushAt,
          };
    const asked = await authority.codeOwnerDemand(
      merger.principal,
      merger.grantId,
      `refs/heads/${pull.baseRef}`,
    );
    const demand = asked?.demand;
    const approvals: ApprovalInput = {
      reviews: now.facts,
      headSha: pull.headSha,
      authorRoot: pull.authorRoot,
      lastPush,
      eligibleRoots,
      eligiblePrincipals,
    };
    // Who may satisfy an owner team: the ownership candidates under the rules asking for code
    // owners, and the users their agents are rooted in. Those of enforcing rules must be read;
    // those only evaluated are read when they fit.
    const candidatesOf = (settings: readonly ApprovalSettings[]) => [
      ...new Set(
        settings.flatMap((s) =>
          ownershipCandidates(approvals, s).flatMap((c) =>
            c.byAgent ? [c.principal, c.root] : [c.principal],
          ),
        ),
      ),
    ];
    const required = asked
      ? candidatesOf(asked.demand === "enforced" ? asked.enforced : asked.evaluated)
      : [];
    const owners = asked
      ? await this.deps.codeOwnerFacts.prepare(
          pull,
          asked.demand,
          { required, optional: candidatesOf(asked.evaluated) },
          budgeted,
        )
      : undefined;
    const merge: MergeContext = {
      number,
      method,
      approvals,
      unresolvedThreads: reviewComments.unresolved(number),
      upToDate,
      ...(owners?.input && { codeOwners: owners.input }),
    };
    const ceilings = new Map<string, readonly string[]>([
      ...[...active].filter(([id]) => eligibleRoots.has(id) || eligiblePrincipals.has(id)),
      ...(owners?.ownerCeilings ?? []),
    ]);
    const ownersStamp = () => (demand === "enforced" ? this.deps.codeOwnersStamp(pull) : "");
    return {
      merge,
      ceilings,
      ownerCandidates: demand === "enforced" ? required : [],
      ...(owners?.refusal && { refusal: owners.refusal }),
      asRead: {
        reviews: now.stamp,
        threads: threadsThen,
        eligible: [...eligibleRoots].join(" "),
        // Reviewers' own access matters only to an enforced code-owner requirement.
        principals: demand === "enforced" ? [...eligiblePrincipals].join(" ") : "",
        codeOwners: demand === "enforced" ? (owners?.stamp ?? "") : "",
        promoted: "",
      },
      stamps: () => ({
        reviews: reviews.stamp(number),
        threads: reviewComments.stamp(number),
        eligible: writers(roots).join(" "),
        principals: demand === "enforced" ? writers(principals).join(" ") : "",
        codeOwners: ownersStamp(),
        promoted: now.promoted().join(" "),
      }),
    };
  }

  /**
   * Requests reviews of principals (users and agents, found by the
   * Worker) and of teams of the repository's organization (`teamSlugs`);
   * each principal's access is checked here, an agent's capped by its
   * owner's, before the change. The teams are read last, with the ACL
   * their members' access is decided by: when the repository decides by
   * another one, the newer is taken and the change tried again, a few
   * times at most.
   */
  async requestReviewers(
    number: number,
    reviewerIds: readonly string[],
    actor: RefActor,
    teamSlugs: readonly string[] = [],
    /** The account whose teams `teamSlugs` are meant to be: another's are never asked. */
    teamAccount?: string,
  ) {
    const { authority } = this.deps;
    // Whether an attempt read the reviewers being deleted.
    let read = false;
    const attempt = (readDeleted: boolean) =>
      this.deps.pullChange(
        "requestReviewers",
        actor,
        (caller, prepared, read: TeamAudience | "unavailable" | undefined) => {
          if (read === "unavailable")
            return { ok: false as const, code: "team_audience_unavailable" as const };
          const audience = read;
          // Read of the repository's account as it is now (see `audienceFit`): the one meant, or
          // nothing is asked (a transfer since the request named it). With no account (a user's
          // repository) no team is found, and the request is refused for that as ever.
          if (
            teamAccount !== undefined &&
            audience &&
            audience.accountId !== "" &&
            audience.accountId !== teamAccount
          )
            return { ok: false as const, code: "team_owner_changed" as const };
          const fit = audience && this.deps.audienceFit(audience);
          if (audience && fit !== "same")
            return { ok: false as const, code: "audience_stale" as const, audience, fit };
          return this.#withView(
            this.deps.reviews.request(
              number,
              [...prepared.ceilings].map(([id, owners]) => ({
                id,
                root: rootIdentity({ principalId: id, grantId: null, ceilingIds: owners }),
                role: authority.roleNow(id, owners),
              })),
              caller,
              prepared.deleted,
              audience,
            ),
          );
        },
        async () => {
          const ceilings = new Map<string, string[]>();
          for (const id of new Set(reviewerIds))
            ceilings.set(id, await authority.rolesPulled(id, null));
          // Past the limit, the requested reviewers being deleted (their places are given up).
          const requested = this.deps.reviews.requested(number);
          const asked = new Set(requested);
          const adding = [...ceilings.keys()].filter((id) => !asked.has(id)).length;
          const teams = this.deps.reviews.requestedTeams(number).length + new Set(teamSlugs).size;
          read = readDeleted || requested.length + teams + adding > MAX_REQUESTED_REVIEWERS;
          const deleted = read ? await authority.deletedOf(requested) : new Set<string>();
          return { ceilings, deleted };
        },
        [],
        teamSlugs.length > 0 ? () => this.deps.teamAudience(teamSlugs) : undefined,
      );
    for (let tries = 1; ; tries++) {
      let result = await attempt(false);
      // Others were requested meanwhile, past the limit this one judged by: once more, with the
      // reviewers being deleted read.
      if (!result.ok && result.code === "too_many_reviewers" && !read) result = await attempt(true);
      if (result.ok || result.code !== "audience_stale")
        return result as Exclude<typeof result, { code: "audience_stale" }>;
      if (result.fit === "unavailable" || tries >= AUDIENCE_ATTEMPTS)
        return { ok: false as const, code: "team_audience_unavailable" as const };
      // Read with a newer ACL than the repository's: that one is pulled for the next attempt.
      if (result.fit === "newer") this.deps.adoptAudience(result.audience);
    }
  }

  /** Withdraws review requests, of principals and of teams (by the slugs they were asked by, or by id). */
  removeRequestedReviewers(
    number: number,
    reviewerIds: readonly string[],
    actor: RefActor,
    teamSlugs: readonly string[] = [],
    teamIds: readonly string[] = [],
  ) {
    return this.deps.pullChange("removeRequestedReviewers", actor, (caller) =>
      this.#withView(this.deps.reviews.unrequest(number, reviewerIds, caller, teamSlugs, teamIds)),
    );
  }

  /** A change's pull request with whether it merges. */
  #withView(
    result: { ok: true; pull: PullRecord } | { ok: false; code: ReviewFailure },
  ): { ok: true; pull: PullView } | { ok: false; code: ReviewFailure } {
    return result.ok ? { ok: true, pull: this.deps.viewed(result.pull) } : result;
  }

  /**
   * A pull request's diff comments, oldest first, with what its diff
   * compares now (whether each is outdated); undefined without the pull
   * request.
   */
  async reviewComments(number: number, after: number, limit: number) {
    const pull = this.deps.pulls.get(number);
    if (!pull) return undefined;
    const comments = this.deps.reacted(this.deps.reviewComments.list(number, after, limit));
    const { comparison } = await this.#compared(
      pull,
      comments.map((c) => c.anchor),
    );
    return { comparison, comments };
  }

  /** One diff comment, with what its pull request's diff compares now. */
  async reviewComment(id: number) {
    const found = this.deps.reviewComments.get(id);
    if (!found) return undefined;
    const [comment] = this.deps.reacted([found]) as [Reacted<ReviewCommentRecord>];
    const pull = this.deps.pulls.get(comment.number);
    const comparison = pull ? (await this.#compared(pull, [comment.anchor])).comparison : null;
    return { comparison, comment };
  }

  /** A pull request's threads, oldest first, as `reviewComments`. */
  async threads(number: number, after: number, limit: number) {
    const pull = this.deps.pulls.get(number);
    if (!pull) return undefined;
    const threads = this.deps.reviewComments.threads(number, after, limit);
    const { comparison } = await this.#compared(pull, threads);
    return { comparison, threads };
  }

  /**
   * What `pull`'s diff compares now: its head, and the merge base of its
   * base and head when one of `anchors` needs it (a base-side thread on
   * the head); one that cannot be worked out leaves those outdated. With
   * the base tip it was worked out from.
   */
  async #compared(pull: PullRecord, anchors: readonly ThreadAnchor[]): Promise<Compared> {
    const base = this.deps.pulls.comparedBase(pull);
    let mergeBaseSha: string | null = null;
    if (anchors.some((anchor) => needsMergeBase(anchor, pull.headSha))) {
      const found = await mergeBaseOf(this.deps.git.commitGraph, base, oidFromHex(pull.headSha));
      if (found.ok) mergeBaseSha = oidToHex(found.value);
    }
    return {
      comparison: { headSha: pull.headSha, mergeBaseSha },
      baseRef: pull.baseRef,
      baseTip: oidToHex(base),
    };
  }

  /**
   * In a change, with no await since `compared` was worked out: its
   * comparison when the pull request still compares the same base tip and
   * head, else the head now with the merge base unknown (a base-side
   * thread is then answered outdated, the cautious way).
   */
  #comparisonNow(number: number, compared: Compared | null): Comparison | null {
    const pull = this.deps.pulls.get(number);
    if (!pull) return null;
    return compared !== null &&
      pull.headSha === compared.comparison.headSha &&
      pull.baseRef === compared.baseRef &&
      oidToHex(this.deps.pulls.comparedBase(pull)) === compared.baseTip
      ? compared.comparison
      : { headSha: pull.headSha, mergeBaseSha: null };
  }

  /** What `#compared` works out for a change of the thread at `anchor`, before the change. */
  async #comparedFor(number: number, anchor: ThreadAnchor | undefined): Promise<Compared | null> {
    const pull = this.deps.pulls.get(number);
    return pull ? this.#compared(pull, anchor ? [anchor] : []) : null;
  }

  /**
   * Starts a thread on a pull request's diff, at an anchor checked against
   * the file it names: at the commit (a head the pull request has had) for
   * the head side, at the merge base of the base branch and that commit
   * for the base side.
   */
  createReviewComment(number: number, input: NewReviewComment, actor: RefActor) {
    return this.deps.pullChange(
      "createReviewComment",
      actor,
      (caller, checked) => {
        if (!checked.ok) return checked;
        const comparison = this.#comparisonNow(number, checked.value.compared);
        return this.#withComparison(
          this.deps.reviewComments.start(
            number,
            checked.value.anchor,
            input.body,
            caller,
            comparison,
          ),
          comparison,
        );
      },
      () => this.#checkedAnchor(number, input),
      [input.body],
    );
  }

  /** Replies in the thread of comment `to`. */
  replyReviewComment(number: number, to: number, body: string, actor: RefActor) {
    const { reviewComments } = this.deps;
    return this.deps.pullChange(
      "replyReviewComment",
      actor,
      (caller, compared) => {
        const comparison = this.#comparisonNow(number, compared);
        return this.#withComparison(
          reviewComments.reply(number, to, body, caller, comparison),
          comparison,
        );
      },
      () => this.#comparedFor(number, reviewComments.get(to)?.anchor),
      [body],
    );
  }

  /**
   * `input`'s anchor, if the file it names has the lines it names (a
   * base-side one records the merge base it was checked at), and what the
   * diff compares now.
   */
  async #checkedAnchor(
    number: number,
    input: NewReviewComment,
  ): Promise<
    | { ok: true; value: { anchor: ThreadAnchor; compared: Compared } }
    | BrowseFailure
    | { ok: false; code: string }
  > {
    const { git, pulls } = this.deps;
    const pull = pulls.get(number);
    if (!pull) return { ok: false, code: "not_found" };
    if (!pulls.hadHead(number, input.commitId)) return { ok: false, code: "commit_not_in_pull" };
    // An earlier head force-pushed away is kept only while the reflog keeps it.
    if (!git.commitGraph.readSync([oidFromHex(input.commitId)], "verified")[0])
      return { ok: false, code: "commit_unavailable" };
    // The left side the files listing shows (a merged one's from the base it was merged onto).
    const base = pulls.comparedBase(pull);
    let at = input.commitId;
    let mergeBaseSha: string | null = null;
    if (input.side === "LEFT") {
      const found = await mergeBaseOf(git.commitGraph, base, oidFromHex(input.commitId));
      if (!found.ok) return found;
      at = mergeBaseSha = oidToHex(found.value);
    }
    const browse = new RepoBrowse({ git, memoryBlocks: this.deps.memoryBlocks() });
    let file: Awaited<ReturnType<typeof rawFile>>;
    try {
      file = await rawFile(browse, at, input.path, ANCHOR_MAX_BYTES);
    } finally {
      browse.close();
    }
    // A missing file is a refused anchor (422); any other failure keeps its own status.
    if (!file.ok)
      return file.code === "path_not_found" ? { ok: false, code: "path_not_found" } : file;
    const lines = { side: input.side, line: input.line, startLine: input.startLine ?? null };
    const refused = checkAnchor(lines, lineCount(file.value.bytes));
    if (refused) return { ok: false, code: refused };
    const anchor = { commitSha: input.commitId, mergeBaseSha, path: input.path, ...lines };
    // The merge base worked out for the head is the comparison's own: no second walk.
    const compared: Compared = {
      comparison: {
        headSha: pull.headSha,
        mergeBaseSha: needsMergeBase(anchor, pull.headSha) ? mergeBaseSha : null,
      },
      baseRef: pull.baseRef,
      baseTip: oidToHex(base),
    };
    return { ok: true, value: { anchor, compared } };
  }

  editReviewComment(id: number, body: string, actor: RefActor) {
    const { reviewComments } = this.deps;
    return this.deps.pullChange(
      "editReviewComment",
      actor,
      (caller, compared) => {
        const number = reviewComments.get(id)?.number;
        const comparison = number === undefined ? null : this.#comparisonNow(number, compared);
        return this.#withComparison(reviewComments.edit(id, body, caller, comparison), comparison);
      },
      () => {
        const comment = reviewComments.get(id);
        return comment ? this.#comparedFor(comment.number, comment.anchor) : Promise.resolve(null);
      },
      [body],
    );
  }

  /**
   * A diff comment's change, with what its pull request's diff compares now
   * (whether it is outdated): `comparison`, worked out in the change (its
   * webhook judges the comment by it too).
   */
  #withComparison(
    result: { ok: true; comment: ReviewCommentRecord } | { ok: false; code: ReviewCommentFailure },
    comparison: Comparison | null,
  ) {
    return result.ok
      ? {
          ...result,
          comment: (this.deps.reacted([result.comment]) as [Reacted<ReviewCommentRecord>])[0],
          comparison,
        }
      : result;
  }

  /** Resolves a thread, or makes it unresolved again. */
  resolveReviewThread(number: number, threadId: number, resolved: boolean, actor: RefActor) {
    const { reviewComments } = this.deps;
    return this.deps.pullChange(
      "resolveReviewThread",
      actor,
      (caller, compared) => {
        const result = reviewComments.resolve(number, threadId, resolved, caller);
        return result.ok
          ? { ...result, comparison: this.#comparisonNow(number, compared) }
          : result;
      },
      () => this.#comparedFor(number, reviewComments.thread(number, threadId)),
    );
  }
}

/**
 * The standing of a merge refused before anything is read further: more of
 * its reviewers matter than one read of their activity covers.
 */
function tooManyReviewers(
  number: number,
  pull: PullRecord,
  method: MergeContext["method"],
  upToDate: boolean,
): MergeStanding & { readonly asRead: MergeStamps } {
  const none = {
    reviews: "",
    threads: "",
    eligible: "",
    principals: "",
    codeOwners: "",
    promoted: "",
  };
  return {
    merge: {
      number,
      method,
      approvals: {
        reviews: [],
        headSha: pull.headSha,
        authorRoot: pull.authorRoot,
        lastPush: null,
        eligibleRoots: new Set(),
        eligiblePrincipals: new Set(),
      },
      unresolvedThreads: 0,
      upToDate,
    },
    ceilings: new Map(),
    ownerCandidates: [],
    refusal: {
      status: 422,
      code: "too_many_reviewers",
      error: `More of the pull request's reviewers can count than a merge here reads (${MAX_ACTIVITY_PRINCIPALS} with their roots and agents).`,
    },
    asRead: none,
    stamps: () => none,
  };
}
