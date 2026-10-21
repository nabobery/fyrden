import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  atLeast,
  type CommentSide,
  checkAnchor,
  lineCount,
  MAX_REQUESTED_REVIEWERS,
  type MergeContext,
  rootIdentity,
} from "@fyrden/domain";
import { type BlockCache, oidFromHex, oidToHex } from "@fyrden/git-core";
import type { RepoAuthority } from "./authority.js";
import { type BrowseFailure, RepoBrowse } from "./browse.js";
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
 * invocation: anything `prepare` reads is worked out first, then, with no
 * await before `change`, whether the repository takes changes and the
 * caller's role now.
 */
export type PullChange = <R, P = undefined>(
  method: string,
  actor: RefActor,
  change: (caller: PullCaller, prepared: P) => R,
  prepare?: () => Promise<P>,
  /** Texts the change writes, whose mentions its activity-feed entries name. */
  texts?: readonly (string | null | undefined)[],
) => Promise<R | { ok: false; code: PullChangeRefusal }>;

/** The largest file a diff comment's anchor is checked against. */
const ANCHOR_MAX_BYTES = 1024 * 1024;

/** What a pull request's diff compares, with the base it was worked out from. */
interface Compared {
  readonly comparison: Comparison;
  readonly baseRef: string;
  /** The base tip it was worked out from, as `RepoPulls.comparedBase` gave it. */
  readonly baseTip: string;
}

/** What the fence compares: the pull request's reviews, threads and eligible reviewers. */
export interface MergeStamps {
  readonly reviews: string;
  readonly threads: string;
  readonly eligible: string;
}

/** The pull request's merge context and stamps, as `mergePull` works them out. */
export interface MergeStanding {
  readonly merge: MergeContext;
  /** The stamps now (called again in the commit's transaction). */
  readonly stamps: () => MergeStamps;
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
  readonly memoryBlocks: () => BlockCache;
  /** A pull request with whether it merges, as far as that is known now. */
  readonly viewed: (pull: PullRecord) => PullView;
  readonly pullChange: PullChange;
}

export class PullDiscussion {
  constructor(private readonly deps: DiscussionDeps) {}

  /**
   * What the rulesets judge a merge by, from the repository's own records:
   * the pull request's reviews, whose of them count (active reviewers'
   * with write access now), its last push and threads; `then` stamps them
   * as read (before any wait), `stamps` as they are when called (in the
   * commit's transaction).
   */
  async standing(
    number: number,
    pull: PullRecord,
    method: MergeContext["method"],
    upToDate: boolean,
  ): Promise<MergeStanding & { readonly asRead: MergeStamps }> {
    const { reviews, reviewComments, authority } = this.deps;
    const standing = reviews.standing(number);
    const threadsThen = reviewComments.stamp(number);
    // Whose reviews count: an active reviewer's (read once, here) with write access now (checked
    // again in the commit's transaction).
    const reviewerOwners = await authority.activeOwnersPulled([
      ...new Set(standing.reviews.map((r) => r.reviewerRoot)),
    ]);
    const eligible = () =>
      [...reviewerOwners]
        .filter(([root, owners]) => atLeast(authority.roleNow(root, owners), "write"))
        .map(([root]) => root);
    const eligibleRoots = new Set(eligible());
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
    const merge: MergeContext = {
      number,
      method,
      approvals: {
        reviews: standing.reviews,
        headSha: pull.headSha,
        authorRoot: pull.authorRoot,
        lastPush,
        eligibleRoots,
      },
      unresolvedThreads: reviewComments.unresolved(number),
      upToDate,
    };
    return {
      merge,
      asRead: {
        reviews: standing.stamp,
        threads: threadsThen,
        eligible: [...eligibleRoots].join(" "),
      },
      stamps: () => ({
        reviews: reviews.stamp(number),
        threads: reviewComments.stamp(number),
        eligible: eligible().join(" "),
      }),
    };
  }

  /**
   * Requests reviews of principals (users and agents, found by the
   * Worker); each one's access is checked here, an agent's capped by its
   * owner's, before the change.
   */
  async requestReviewers(number: number, reviewerIds: readonly string[], actor: RefActor) {
    const { authority } = this.deps;
    // Whether an attempt read the reviewers being deleted.
    let read = false;
    const attempt = (readDeleted: boolean) =>
      this.deps.pullChange(
        "requestReviewers",
        actor,
        (caller, prepared) =>
          this.#withView(
            this.deps.reviews.request(
              number,
              [...prepared.ceilings].map(([id, owners]) => ({
                id,
                root: rootIdentity({ principalId: id, grantId: null, ceilingIds: owners }),
                role: authority.roleNow(id, owners),
              })),
              caller,
              prepared.deleted,
            ),
          ),
        async () => {
          const ceilings = new Map<string, string[]>();
          for (const id of new Set(reviewerIds))
            ceilings.set(id, await authority.rolesPulled(id, null));
          // Past the limit, the requested reviewers being deleted (their places are given up).
          const requested = this.deps.reviews.requested(number);
          const asked = new Set(requested);
          const adding = [...ceilings.keys()].filter((id) => !asked.has(id)).length;
          read = readDeleted || requested.length + adding > MAX_REQUESTED_REVIEWERS;
          const deleted = read ? await authority.deletedOf(requested) : new Set<string>();
          return { ceilings, deleted };
        },
      );
    const first = await attempt(false);
    // Others were requested meanwhile, past the limit this one judged by: once more, with the
    // reviewers being deleted read.
    if (!first.ok && first.code === "too_many_reviewers" && !read) return attempt(true);
    return first;
  }

  /** Withdraws review requests. */
  removeRequestedReviewers(number: number, reviewerIds: readonly string[], actor: RefActor) {
    return this.deps.pullChange("removeRequestedReviewers", actor, (caller) =>
      this.#withView(this.deps.reviews.unrequest(number, reviewerIds, caller)),
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
      (caller, checked) =>
        checked.ok
          ? this.#withComparison(
              this.deps.reviewComments.start(number, checked.value.anchor, input.body, caller),
              checked.value.compared,
            )
          : checked,
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
      (caller, compared) =>
        this.#withComparison(reviewComments.reply(number, to, body, caller), compared),
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
      (caller, compared) => this.#withComparison(reviewComments.edit(id, body, caller), compared),
      () => {
        const comment = reviewComments.get(id);
        return comment ? this.#comparedFor(comment.number, comment.anchor) : Promise.resolve(null);
      },
      [body],
    );
  }

  /** A diff comment's change, with what its pull request's diff compares now (whether it is outdated). */
  #withComparison(
    result: { ok: true; comment: ReviewCommentRecord } | { ok: false; code: ReviewCommentFailure },
    compared: Compared | null,
  ) {
    return result.ok
      ? {
          ...result,
          comment: (this.deps.reacted([result.comment]) as [Reacted<ReviewCommentRecord>])[0],
          comparison: this.#comparisonNow(result.comment.number, compared),
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
