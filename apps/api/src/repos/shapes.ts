import type { getIssue, getLabel, getMilestone, Output } from "@fyrden/api-contract";
import type { IssueRecord, SubjectKind } from "../do/repo/issues.js";
import type { ReactionCounts } from "../do/repo/reactions.js";
import type { LabelRecord, MilestoneRecord, SubjectMeta } from "../do/repo/subject-meta.js";

/*
 * Issues, labels and milestones as the API answers them: pure functions of
 * the repository object's records, which webhook captures take too.
 */

type IssueOutput = Output<typeof getIssue>;

export function labelOutput(label: LabelRecord): Output<typeof getLabel> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    default: label.isDefault,
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
    ...sortingOutput(meta, readable),
  };
}
