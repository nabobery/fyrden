import type { RefActor } from "@fyrden/adapters-cloudflare/git";
import {
  atLeast,
  type CommitIdentity,
  coAuthorTrailers,
  decidePullAction,
  rootIdentity,
} from "@fyrden/domain";
import {
  appendTrailers,
  isAncestor,
  type Oid,
  oidFromHex,
  oidToHex,
  WalkLimitError,
} from "@fyrden/git-core";
import { ZERO_ID } from "./authority.js";
import { type Browsed, fail } from "./browse.js";
import type { FeedActor, RepoFeed } from "./feed.js";
import { BUSY } from "./file-writes.js";
import { type MergeMade, type MergePolicy, mergePull, PULL_CHANGED } from "./merge.js";
import type { MergeStamps, PullDiscussion } from "./pull-discussion.js";
import type { PullRecord } from "./pulls.js";
import { type RebasePolicy, rebaseCommits } from "./rebase-replay.js";
import { type RebaseSagas, rebaseJobId, type SagaView } from "./rebase-saga.js";
import type { ReviewerConfirmations } from "./reviewer-confirmation.js";
import type { WriteContext } from "./write-context.js";

/*
 * A pull request merged into its base branch through the push path, as a
 * merge commit or one squashed commit made in the request, or rebased by
 * a saga (`RebaseSagas`) the request starts or takes up and drives as far
 * as it may. Each is judged by the rulesets with the pull request's
 * standing, and committed only while the pull request, its standing and
 * the base tip are as the request read them.
 */

/** A merge of a pull request, as the Worker asks for it. */
export interface MergePullInput {
  readonly number: number;
  readonly method: "merge" | "squash" | "rebase";
  /** The head the caller reviewed (GitHub's `sha`): the merge fails if the pull request is elsewhere. */
  readonly expectedHead?: string;
  readonly commitTitle?: string;
  readonly commitMessage?: string;
  /** The head branch's repository's owner's handle (a fork's, or this one's), for the default merge message. */
  readonly ownerHandle: string;
  /** Who a merge commit is by: the merger. */
  readonly mergerIdentity: CommitIdentity;
  /** Who a squashed commit is by: the pull request's author. */
  readonly pullAuthorIdentity: CommitIdentity;
}

/** `text` without the line breaks it ends with (a loop: a regex would backtrack on many). */
function withoutTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") end--;
  return text.slice(0, end);
}

/** A merge refused while the pull request's rebase merge is under way. */
const MERGE_IN_PROGRESS = fail(
  409,
  "merge_in_progress",
  "A rebase merge of this pull request is under way; wait for it, or send the rebase request again.",
);

/** A merge refused because the pull request changed while the request worked it out. */
const PULL_CHANGED_REFUSAL = fail(
  409,
  "pull_changed",
  "The pull request changed while it was being merged; review it and try the merge again.",
);

/** Why a request gave up the rebase running before it (another head or base tip, or no driver). */
const REBASE_REPLACED = fail(
  409,
  "pull_changed",
  "The pull request or its base branch changed while it was being rebased; a new rebase was started.",
);

export interface MergingDeps extends WriteContext {
  readonly rebases: RebaseSagas;
  readonly discussion: PullDiscussion;
  readonly feed: RepoFeed;
  readonly mergePolicy: () => MergePolicy;
  readonly rebasePolicy: () => RebasePolicy;
  /** Confirms, at the commit, the reviewers whose approvals the merge counts. */
  readonly reviewers: ReviewerConfirmations;
  /** For tests: runs before a merge is committed. */
  readonly hooks: () => { readonly beforeFinish?: () => Promise<void> };
}

export class PullMerging {
  constructor(private readonly deps: MergingDeps) {}

  /**
   * Merges a pull request into its base branch (a merge commit, or one
   * squashed commit) for a caller with write access, through the push path:
   * built from the base branch's tip and the head recorded now, judged by
   * the rulesets with the pull request's reviews and last push, and
   * committed only while the pull request, its reviews and the base tip
   * are as they were (the commit marks it merged).
   */
  async merge(input: MergePullInput, actor: RefActor): Promise<Browsed<MergeMade>> {
    const { git, pulls, rebases, authority } = this.deps;
    await this.deps.checkEpoch();
    const ceilings = await authority.rolesPulled(actor.principal, actor.grantId ?? null);
    // Who hears of the merge is decided with it: from access as it is now.
    const feedActor = await this.feedActor(actor);
    const refusedWrite = this.deps.writeRefusal();
    if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
    const { number, method } = input;
    const pull = pulls.get(number);
    if (!pull) return fail(404, "pull_not_found", `The repository has no pull request ${number}.`);
    // A rebase that finished after its request answered: the same answer, merged.
    const saga = method === "rebase" ? rebases.view(number) : undefined;
    if (
      saga?.state === "done" &&
      pull.state === "merged" &&
      pull.mergeCommitSha === saga.resultSha &&
      saga.resultSha !== null &&
      atLeast(authority.roleNow(actor.principal, ceilings), "write")
    )
      return { ok: true, value: { sha: saga.resultSha } };
    const decision = decidePullAction("merge", {
      state: pull.state,
      headRefDeleted: false,
      isAuthor: false,
      role: authority.roleNow(actor.principal, ceilings),
    });
    if (!decision.ok)
      return decision.refusal === "forbidden"
        ? fail(403, "forbidden", "Merging a pull request takes write access.")
        : fail(405, "not_mergeable", `Pull request ${number} is not open.`);
    if (
      method !== "rebase" &&
      rebases.view(number)?.state === "running" &&
      !rebases.undriven(number)
    )
      return MERGE_IN_PROGRESS;
    if (pull.draft)
      return fail(
        405,
        "not_mergeable",
        `Pull request ${number} is a draft; mark it ready for review first.`,
      );
    if (input.expectedHead !== undefined && input.expectedHead !== pull.headSha)
      return fail(409, "head_moved", "The head branch was modified; review it and try again.");
    const baseTip = pulls.branchTip(pull.baseRef);
    if (!baseTip) return fail(422, "base_not_found", "The base branch does not exist.");
    const head = oidFromHex(pull.headSha);
    const walk = { maxCommits: this.deps.mergePolicy().maxCommits };
    let upToDate: boolean;
    try {
      if (await isAncestor(git.commitGraph, "verified", head, baseTip, walk))
        return fail(405, "not_mergeable", "The base branch already contains the head.");
      upToDate = await isAncestor(git.commitGraph, "verified", baseTip, head, walk);
    } catch (error) {
      if (!(error instanceof WalkLimitError)) throw error;
      return fail(
        422,
        "too_expensive",
        "The base branch and the head are too far apart to merge here.",
      );
    }

    const standing = await this.deps.discussion.standing(number, pull, method, upToDate, {
      principal: actor.principal,
      grantId: actor.grantId ?? null,
    });
    const { merge, asRead, stamps } = standing;
    // Bound, with no await since, to the ownership the reviewers were just judged under.
    const confirm = this.deps.reviewers.for(standing.ceilings);
    if (standing.refusal)
      return fail(standing.refusal.status, standing.refusal.code, standing.refusal.error);
    // More than the commit's confirmation reads: refused before anything is stored.
    const tooMany = this.deps.reviewers.tooMany(standing);
    if (tooMany) return fail(422, tooMany.code, tooMany.error);
    const baseRef = `refs/heads/${pull.baseRef}`;
    const precheck = await authority.precheckUpdates(
      actor.principal,
      [{ ref: baseRef, old: oidToHex(baseTip), new: ZERO_ID }],
      actor.grantId ?? null,
      undefined,
      merge,
    );
    if (precheck) return fail(405, "merge_refused", precheck);
    if (method === "rebase")
      return this.#rebase(input, actor, { pull, baseRef, baseTip, head, upToDate, asRead });

    // GitHub's default messages; a squash is the pull request author's.
    const identity: CommitIdentity =
      method === "squash" ? input.pullAuthorIdentity : input.mergerIdentity;
    const title =
      input.commitTitle ??
      (method === "merge"
        ? `Merge pull request #${number} from ${input.ownerHandle}/${pull.headRef}`
        : `${pull.title} (#${number})`);
    const body = input.commitMessage ?? (method === "merge" ? pull.title : (pull.body ?? ""));
    const text =
      body.trim() === "" ? `${title}\n` : `${title}\n\n${withoutTrailingNewlines(body)}\n`;
    // A title or body may hold NUL; git stops reading a message there.
    if (text.includes("\0"))
      return fail(
        422,
        "invalid_input",
        "The pull request's title or body contains NUL; give commit_title and commit_message.",
      );
    const message = appendTrailers(text, coAuthorTrailers(text, identity.coAuthors));
    const made = await mergePull(
      await this.deps.writeDeps(),
      {
        writer: {
          principal: actor.principal,
          tokenId: actor.tokenId ?? "",
          grantId: actor.grantId ?? null,
          repoId: this.deps.repoId(),
          requestId: actor.requestId ?? null,
        },
        method,
        baseRef,
        baseTip,
        head,
        upToDate,
        author: identity.author,
        committer: identity.committer,
        message,
        merge,
        confirm,
        fence: () =>
          pulls.mergeFence(number, pull) && JSON.stringify(stamps()) === JSON.stringify(asRead)
            ? undefined
            : PULL_CHANGED,
        inCommit: (sha) =>
          this.deps.feed.within(feedActor, () =>
            pulls.markMerged(
              number,
              // The branch moves from `baseTip` only (its compare-and-set).
              { sha, base: baseTip, method },
              { ...actor, via: "merge" },
              git.context.now(),
            ),
          ),
        ...(this.deps.hooks().beforeFinish && { beforeFinish: this.deps.hooks().beforeFinish }),
      },
      this.deps.mergePolicy(),
    );
    this.deps.committed();
    return made;
  }

  /**
   * A rebase merge (see `RebaseSagas`): starts the pull request's saga, or
   * takes up the one running for the same head and base tip, and drives it
   * as far as this request may. Answers the merge when it is done, its
   * refusal when it failed, `merge_in_progress` while the alarm goes on.
   */
  async #rebase(
    input: MergePullInput,
    actor: RefActor,
    at: {
      readonly pull: PullRecord;
      readonly baseRef: string;
      readonly baseTip: Oid;
      readonly head: Oid;
      readonly upToDate: boolean;
      readonly asRead: MergeStamps;
    },
  ): Promise<Browsed<MergeMade>> {
    const { git, pulls, rebases } = this.deps;
    const { number } = input;
    const policy = this.deps.rebasePolicy();
    // A saga of what this request checked: its head, onto its base branch at its tip.
    const ours = (saga: SagaView) =>
      saga.head === at.pull.headSha &&
      saga.baseRef === at.baseRef &&
      saga.baseTip === oidToHex(at.baseTip);
    // The pull request and its base branch are still as this request saw them.
    const current = () =>
      pulls.mergeFence(number, at.pull) &&
      pulls.branchTip(at.pull.baseRef)?.every((b, i) => b === at.baseTip[i]) === true;
    let saga = rebases.view(number);
    // Finished while this request waited: its merge, when it was of what this one checked.
    if (saga?.state === "done" && saga.resultSha)
      return ours(saga) ? { ok: true, value: { sha: saga.resultSha } } : PULL_CHANGED_REFUSAL;
    // Failed after an earlier request answered: a request for the same attempt answers why, once
    // (the next one starts again); a current request for another one starts its own.
    if (saga?.state === "failed" && saga.failure && !saga.reported) {
      if (ours(saga)) {
        if (rebases.report(number, saga.sagaId)) return saga.failure;
      } else if (!current()) return PULL_CHANGED_REFUSAL;
      else rebases.report(number, saga.sagaId);
    }
    if (saga?.state === "running" && (!ours(saga) || rebases.undriven(number))) {
      // Only a request that is not itself behind replaces it (checked with no wait before).
      if (!current()) return PULL_CHANGED_REFUSAL;
      await rebases.abandon(number, saga.sagaId, REBASE_REPLACED);
      saga = rebases.view(number);
    }
    if (saga?.state !== "running") {
      const keyId = (await this.deps.writeDeps()).signer?.keyId;
      if (!keyId)
        return fail(
          422,
          "signing_unavailable",
          "Rebase merges sign every commit they make, and the server has no signing key.",
        );
      if (rebases.running() >= policy.maxRunning) return BUSY;
      const commits = await rebaseCommits(git.commitGraph, at.baseTip, at.head, {
        maxCommits: policy.maxCommits,
        maxWalk: this.deps.mergePolicy().maxCommits,
      });
      if (!commits.ok) return commits;
      const [base] = git.commitGraph.readSync([at.baseTip], "verified");
      if (!base) return fail(422, "unreadable", "An object the merge needs cannot be read.");
      // Checked again with the start: another request may have started or finished one, or the
      // pull request or base branch changed, while this one waited.
      const started = rebases.start(
        {
          number,
          pull: at.pull,
          stamps: at.asRead,
          actor: {
            principal: actor.principal,
            tokenId: actor.tokenId ?? null,
            grantId: actor.grantId ?? null,
            onBehalfOf: actor.onBehalfOf ?? null,
            actChain: actor.actChain ?? [],
            requestId: actor.requestId ?? null,
          },
          baseRef: at.baseRef,
          baseTip: at.baseTip,
          baseTree: base.tree,
          head: at.head,
          upToDate: at.upToDate,
          committer: input.mergerIdentity.committer,
          keyId,
          commits: commits.value,
        },
        current,
      );
      if (started === "busy") return BUSY;
      if (started === "changed") return PULL_CHANGED_REFUSAL;
    }
    // The saga this request answers for: one for the head and base tip it checked (another
    // request may have started one for a newer head meanwhile).
    const mine = rebases.view(number);
    if (!mine || !ours(mine)) return PULL_CHANGED_REFUSAL;
    await git.jobs.runJob(
      rebaseJobId(number),
      rebases.handler("request"),
      git.memory,
      git.context.now() + policy.requestMs,
    );
    this.deps.committed();
    const now = rebases.view(number);
    // Replaced while it ran (by a request for a newer head): not this request's answer.
    if (now?.sagaId !== mine.sagaId) return PULL_CHANGED_REFUSAL;
    if (now.state === "done" && now.resultSha) return { ok: true, value: { sha: now.resultSha } };
    if (now.state === "failed" && now.failure) {
      rebases.report(number, now.sagaId);
      return now.failure;
    }
    return fail(
      409,
      "merge_in_progress",
      `The rebase is under way (${now.next} of ${now.commits} commits replayed); send the request again, or watch the pull request, to see it merged.`,
    );
  }

  /** `actor` as feeds see the change it makes now (its root identity and role). */
  async feedActor(actor: Pick<RefActor, "principal" | "grantId">): Promise<FeedActor> {
    const { authority } = this.deps;
    const ceilings = await authority.rolesPulled(actor.principal, actor.grantId ?? null);
    await this.deps.feed.prepare();
    return {
      root: rootIdentity({
        principalId: actor.principal,
        grantId: actor.grantId ?? null,
        ceilingIds: ceilings,
      }),
      role: authority.roleNow(actor.principal, ceilings),
      mentioned: new Map(),
    };
  }
}
