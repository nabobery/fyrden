import type {
  getComment,
  getIssue,
  getLabel,
  getMilestone,
  getPull,
  getReview,
  getReviewComment,
  Output,
} from "@fyrden/api-contract";
import type { CommentRecord } from "../do/repo/comments.js";
import type { IssueRecord, Subject, SubjectKind } from "../do/repo/issues.js";
import type { PullView } from "../do/repo/mergeability.js";
import type { PullRecord } from "../do/repo/pulls.js";
import type { Reacted, ReactionCounts } from "../do/repo/reactions.js";
import type { ReviewCommentRecord } from "../do/repo/review-comments.js";
import type { ReviewRecord } from "../do/repo/reviews.js";
import type { LabelRecord, MilestoneRecord, SubjectMeta } from "../do/repo/subject-meta.js";

/*
 * Issues, pull requests, reviews, comments, labels and milestones as the
 * API answers them: pure functions of the repository object's records,
 * which webhook captures take too.
 */

type IssueOutput = Output<typeof getIssue>;

export function labelOutput(label: LabelRecord): Output<typeof getLabel> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    default: label.isDefault,
    version: label.version,
  };
}

/**
 * A milestone as the API answers it: its counts of the kinds the caller
 * reads (`readable`) only, so they tell nothing of the other kind.
 */
export function milestoneOutput(
  milestone: MilestoneRecord,
  readable: readonly SubjectKind[],
): Output<typeof getMilestone> {
  const issues = readable.includes("issue");
  const pulls = readable.includes("pull");
  return {
    id: milestone.number,
    number: milestone.number,
    title: milestone.title,
    description: milestone.description,
    state: milestone.state,
    open_issues: (issues ? milestone.openIssues : 0) + (pulls ? milestone.openPulls : 0),
    closed_issues: (issues ? milestone.closedIssues : 0) + (pulls ? milestone.closedPulls : 0),
    creator: { id: milestone.creator },
    due_on: milestone.dueOn,
    created_at: milestone.createdAt,
    updated_at: milestone.updatedAt,
    closed_at: milestone.closedAt,
    version: milestone.version,
  };
}

/** A target's reactions as the API answers them (GitHub's rollup). */
export function reactionRollup(counts: ReactionCounts): Output<typeof getIssue>["reactions"] {
  return { total_count: Object.values(counts).reduce((a, b) => a + b, 0), ...counts };
}

/** An issue's or pull request's labels, assignees and milestone, as both answer them, for a caller reading `readable`. */
export function sortingOutput(
  meta: SubjectMeta,
  readable: readonly SubjectKind[],
): Pick<Output<typeof getIssue>, "labels" | "assignee" | "assignees" | "milestone" | "reactions"> {
  const assignees = meta.assignees.map((id) => ({ id }));
  return {
    labels: meta.labels.map(labelOutput),
    assignee: assignees[0] ?? null,
    assignees,
    milestone: meta.milestone && milestoneOutput(meta.milestone, readable),
    reactions: reactionRollup(meta.reactions),
  };
}

/** An issue as the API answers it; its duplicate target only when the caller reads that kind. */
export function issueOutput(
  issue: IssueRecord,
  readable: readonly SubjectKind[],
  meta: SubjectMeta,
): IssueOutput {
  return {
    id: issue.number,
    number: issue.number,
    state: issue.state,
    state_reason: issue.stateReason,
    duplicate_of:
      issue.duplicateKind !== null && readable.includes(issue.duplicateKind)
        ? issue.duplicateOf
        : null,
    title: issue.title,
    body: issue.body,
    user: { id: issue.authorId },
    performed_via_agents: [...issue.authorAct],
    locked: issue.locked,
    active_lock_reason: issue.lockReason,
    closed_by: issue.closedBy === null ? null : { id: issue.closedBy },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    version: issue.version,
    ...sortingOutput(meta, readable),
  };
}

/** A pull request as the issue endpoints answer it (GitHub's shape: marked with `pull_request`). */
function pullAsIssue(
  pull: PullRecord,
  meta: SubjectMeta,
  readable: readonly SubjectKind[],
): IssueOutput {
  return {
    id: pull.number,
    number: pull.number,
    state: pull.state === "open" ? "open" : "closed",
    state_reason: null,
    duplicate_of: null,
    title: pull.title,
    body: pull.body,
    user: { id: pull.authorId },
    performed_via_agents: [...pull.authorAct],
    locked: pull.locked,
    active_lock_reason: pull.lockReason,
    closed_by: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    version: pull.version,
    ...sortingOutput(meta, readable),
    pull_request: { merged_at: pull.mergedAt },
  };
}

/** An issue, or a pull request as the issue endpoints answer one. */
export const subjectOutput = (subject: Subject, readable: readonly SubjectKind[]) =>
  subject.kind === "issue"
    ? issueOutput(subject.issue, readable, subject.meta)
    : pullAsIssue(subject.pull, subject.meta, readable);

/** A conversation comment as the API answers it. */
export function commentOutput(comment: Reacted<CommentRecord>): Output<typeof getComment> {
  return {
    id: comment.id,
    issue_number: comment.number,
    user: { id: comment.authorId },
    performed_via_agents: [...comment.actChain],
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    version: comment.version,
    reactions: reactionRollup(comment.reactions),
  };
}

/** A pull request as the API answers it, for a caller reading `readable` (its milestone's counts). */
export function pullOutput(
  pull: PullView,
  readable: readonly SubjectKind[],
): Output<typeof getPull> {
  return {
    number: pull.number,
    state: pull.state === "open" ? "open" : "closed",
    merged: pull.state === "merged",
    head_repo_id: pull.headRepoId,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeableState,
    mergeable_reason: pull.mergeableReason,
    draft: pull.draft,
    maintainer_can_modify: pull.maintainerCanModify,
    locked: pull.locked,
    active_lock_reason: pull.lockReason,
    title: pull.title,
    body: pull.body,
    user: { id: pull.authorId },
    performed_via_agents: [...pull.authorAct],
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    head_ref_deleted: pull.headRefDeleted,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    version: pull.version,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged_by: pull.mergedBy === null ? null : { id: pull.mergedBy },
    ...sortingOutput(pull.meta, readable),
  };
}

/** A review as the API answers it (a dismissed one's state `DISMISSED`). */
export function reviewOutput(review: ReviewRecord): Output<typeof getReview> {
  const dismissed = review.dismissedAt !== null;
  return {
    id: review.id,
    user: { id: review.reviewerId },
    performed_via_agents: [...review.actChain],
    state: dismissed ? "DISMISSED" : review.state,
    body: review.body,
    commit_id: review.commitSha,
    submitted_at: review.submittedAt,
    dismissal: dismissed
      ? {
          by: review.dismissedBy as string,
          message: review.dismissalMessage as string,
          at: review.dismissedAt as number,
        }
      : null,
  };
}

/**
 * A diff comment as the API answers it, `outdated` when what its pull
 * request's diff compares no longer has the lines it is on.
 */
export function reviewCommentOutput(
  comment: Reacted<ReviewCommentRecord>,
  outdated: boolean,
): Output<typeof getReviewComment> {
  const { anchor } = comment;
  return {
    id: comment.id,
    pull_request_review_id: null,
    ...(comment.inReplyTo !== null && { in_reply_to_id: comment.inReplyTo }),
    thread_id: comment.threadId,
    user: { id: comment.authorId },
    performed_via_agents: [...comment.actChain],
    body: comment.body,
    commit_id: anchor.commitSha,
    original_commit_id: anchor.commitSha,
    path: anchor.path,
    side: anchor.side,
    line: outdated ? null : anchor.line,
    original_line: anchor.line,
    start_line: anchor.startLine,
    start_side: anchor.startLine === null ? null : anchor.side,
    outdated,
    resolved: comment.resolved,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    reactions: reactionRollup(comment.reactions),
  };
}
