import type { getIssue, getLabel, getMilestone, Output } from "@fyrden/api-contract";
import type { SubjectKind } from "../do/repo/issues.js";
import type {
  LabelRecord,
  MetaInput,
  MilestoneRecord,
  SubjectMeta,
} from "../do/repo/subject-meta.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { principalsByLogin } from "./reviews.js";

/*
 * What issues and pull requests are sorted by (labels, milestones,
 * assignees), as the API answers and takes it.
 */

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

/** An issue's or pull request's labels, assignees and milestone, as both answer them, for a caller reading `readable`. */
export function sortingOutput(
  meta: SubjectMeta,
  readable: readonly SubjectKind[],
): Pick<Output<typeof getIssue>, "labels" | "assignee" | "assignees" | "milestone"> {
  const assignees = meta.assignees.map((id) => ({ id }));
  return {
    labels: meta.labels.map(labelOutput),
    assignee: assignees[0] ?? null,
    assignees,
    milestone: meta.milestone && milestoneOutput(meta.milestone, readable),
  };
}

/**
 * Principal ids for `logins`, users and agents enabled now; one that names
 * none is refused (an assignee must exist to be checked for access).
 */
export async function assigneesByLogin(
  ctx: OpContext,
  logins: readonly string[],
): Promise<string[]> {
  const found = await principalsByLogin(ctx, logins);
  return [...new Set(logins.map((l) => l.toLowerCase()))].map((login) => {
    const id = found.get(login);
    if (!id) throw assigneeNoAccess(login);
    return id;
  });
}

/** Principal ids for `logins` to unassign: disabled ones too, ones that name none left out. */
export async function unassigneesByLogin(
  ctx: OpContext,
  logins: readonly string[],
): Promise<string[]> {
  return [...(await principalsByLogin(ctx, logins, true)).values()];
}

const assigneeNoAccess = (login?: string) =>
  new OperationError(
    422,
    "assignee_no_access",
    login === undefined
      ? "An assignee cannot read the repository."
      : `No user or agent ${login} can be assigned here.`,
  );

/**
 * What an issue's create or update input asks of its labels, assignees and
 * milestone (each replaces what it has), assignees found by handle.
 */
export async function sortingInput(
  ctx: OpContext,
  input: {
    readonly labels?: readonly string[] | undefined;
    readonly assignees?: readonly string[] | undefined;
    readonly milestone?: number | null | undefined;
  },
): Promise<MetaInput> {
  return {
    ...(input.labels !== undefined && { labels: { set: input.labels } }),
    ...(input.assignees !== undefined && {
      assignees: {
        set: input.assignees.length > 0 ? await assigneesByLogin(ctx, input.assignees) : [],
      },
    }),
    ...(input.milestone !== undefined && { milestone: input.milestone }),
  };
}

/** The problem for a refusal of a change of labels, assignees or a milestone; undefined for others. */
export function sortingFailure(code: string): OperationError | undefined {
  switch (code) {
    case "label_not_found":
      return new OperationError(
        422,
        "label_not_found",
        "A label named is not one of the repository's (create it first).",
      );
    case "too_many_labels":
      return new OperationError(
        422,
        "too_many_labels",
        "An issue or pull request holds at most 100 labels.",
      );
    case "assignee_no_access":
      return assigneeNoAccess();
    case "too_many_assignees":
      return new OperationError(
        422,
        "too_many_assignees",
        "An issue or pull request has at most 10 assignees.",
      );
    case "milestone_not_found":
      return new OperationError(
        422,
        "milestone_not_found",
        "The milestone named is not one of the repository's.",
      );
    case "repo_not_ready":
      return new OperationError(
        409,
        "repo_not_ready",
        "The repository predates the records labels, milestones and issues need, so it takes none.",
      );
    case "pull_request_fields":
      return new OperationError(
        422,
        "pull_request_fields",
        "A pull request's title, body and state change through pulls.update; here only its labels, assignees and milestone.",
      );
    default:
      return undefined;
  }
}
