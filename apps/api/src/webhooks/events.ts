import type { DomainEvent } from "@fyrden/domain";

/*
 * Which repository events make webhook deliveries, and what each delivery
 * says of its event. A body is built from the event alone (the snapshot
 * of the entity it carries, as the change left it), in Fyrden's own
 * shape: no later lookup adds to it.
 */

/** A webhook event and its action (null for those without one). */
export interface WebhookEventName {
  readonly event: string;
  readonly action: string | null;
}

/** The actions of each entity's events that make deliveries. */
const ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  pull_request: new Set([
    "opened",
    "edited",
    "closed",
    "reopened",
    "synchronize",
    "ready_for_review",
    "converted_to_draft",
    "review_requested",
    "review_request_removed",
    "head_ref_deleted",
    "head_ref_restored",
    "labeled",
    "unlabeled",
    "assigned",
    "unassigned",
    "milestoned",
    "demilestoned",
    "locked",
    "unlocked",
  ]),
  pull_request_review: new Set(["submitted", "dismissed"]),
  pull_request_review_comment: new Set(["created", "edited", "deleted"]),
  issue_comment: new Set(["created", "edited", "deleted"]),
  issues: new Set([
    "opened",
    "edited",
    "deleted",
    "closed",
    "reopened",
    "assigned",
    "unassigned",
    "labeled",
    "unlabeled",
    "locked",
    "unlocked",
    "milestoned",
    "demilestoned",
  ]),
  label: new Set(["created", "edited", "deleted"]),
  milestone: new Set(["created", "edited", "opened", "closed", "deleted"]),
};

/** GitHub's name for an entity's webhook event where it differs from the entity's. */
const EVENT_NAMES: Readonly<Record<string, string>> = { issue: "issues" };

/** The webhook event a repository event of `type` makes, if any. */
export function webhookEventOf(type: string): WebhookEventName | undefined {
  if (type === "refs.updated") return { event: "push", action: null };
  if (type === "webhook.ping") return { event: "ping", action: null };
  const dot = type.indexOf(".");
  if (dot < 0) return undefined;
  const entity = type.slice(0, dot);
  const event = EVENT_NAMES[entity] ?? entity;
  const action = type.slice(dot + 1);
  return ACTIONS[event]?.has(action) ? { event, action } : undefined;
}

/** Milliseconds since the epoch as an ISO 8601 time, or null. */
function time(ms: unknown): string | null {
  // A time no date can hold (recorded before inputs were bounded) is shown as none, not thrown.
  if (typeof ms !== "number") return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

type Row = Record<string, unknown>;

/** The labels, assignees and milestone a snapshot holds (as ids: their objects are not kept). */
function metaOf(row: Row): Row {
  return {
    labels: ((row.labels ?? []) as number[]).map((id) => ({ id })),
    assignees: ((row.assignees ?? []) as string[]).map((id) => ({ id })),
    milestone:
      row.milestone === null || row.milestone === undefined ? null : { number: row.milestone },
  };
}

/** A pull request as its event's snapshot has it. */
function pullOf(row: Row): Row {
  return {
    number: row.number,
    state: row.state === "open" ? "open" : "closed",
    merged: row.state === "merged",
    draft: row.draft,
    title: row.title,
    body: row.body,
    user: { id: row.authorId },
    locked: row.locked ?? false,
    active_lock_reason: row.lockReason ?? null,
    ...metaOf(row),
    head: { ref: row.headRef, sha: row.headSha, repo_id: row.headRepoId },
    base: { ref: row.baseRef, sha: row.baseSha },
    head_ref_deleted: row.headRefDeleted,
    maintainer_can_modify: row.maintainerCanModify,
    merge_commit_sha: row.mergeCommitSha,
    merged_by: row.mergedBy === null ? null : { id: row.mergedBy },
    created_at: time(row.createdAt),
    updated_at: time(row.updatedAt),
    closed_at: time(row.closedAt),
    merged_at: time(row.mergedAt),
  };
}

/** An issue as its event's snapshot has it. */
function issueOf(row: Row): Row {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    state_reason: row.stateReason ?? null,
    locked: row.locked,
    active_lock_reason: row.lockReason ?? null,
    user: { id: row.authorId },
    ...metaOf(row),
    created_at: time(row.createdAt),
    updated_at: time(row.updatedAt),
    closed_at: time(row.closedAt),
    closed_by: row.closedBy === null || row.closedBy === undefined ? null : { id: row.closedBy },
  };
}

function labelOf(row: Row): Row {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description ?? null,
    default: row.isDefault ?? false,
  };
}

/** A milestone, its counts as GitHub's (issues and pull requests together). */
function milestoneOf(row: Row): Row {
  return {
    number: row.number,
    title: row.title,
    description: row.description ?? null,
    state: row.state,
    open_issues: Number(row.openIssues ?? 0) + Number(row.openPulls ?? 0),
    closed_issues: Number(row.closedIssues ?? 0) + Number(row.closedPulls ?? 0),
    creator: row.creator === undefined ? null : { id: row.creator },
    due_on: time(row.dueOn),
    created_at: time(row.createdAt),
    updated_at: time(row.updatedAt),
    closed_at: time(row.closedAt),
  };
}

/**
 * What a metadata action changed, beside the entity: the label added or
 * removed, the user assigned or unassigned, the milestone set or cleared
 * (as the event recorded them).
 */
function subjectOf(data: Row): Row {
  const label = data.label as Row | undefined;
  const milestone = data.milestone as Row | undefined;
  return {
    ...(label && { label: { id: label.id, name: label.name, color: label.color } }),
    ...(data.assignee !== undefined && { assignee: { id: data.assignee } }),
    ...(milestone && { milestone: { number: milestone.number, title: milestone.title } }),
  };
}

/** An edit's `changes`, its times as ISO 8601 as everywhere in deliveries. */
function changesOf(data: Row): Row {
  if (data.changes === undefined) return {};
  const changes = { ...(data.changes as Record<string, Row>) };
  for (const field of ["due_on"])
    if (changes[field] && typeof changes[field].from === "number")
      changes[field] = { from: time(changes[field].from) };
  return { changes };
}

function reviewOf(row: Row): Row {
  return {
    id: row.id,
    user: { id: row.reviewerId },
    performed_via_agents: row.actChain,
    // As the REST API shows it: a dismissed review's state is `DISMISSED`.
    state: row.dismissedAt === null ? row.state : "DISMISSED",
    commit_id: row.commitSha,
    body: row.body,
    submitted_at: time(row.submittedAt),
    dismissed_at: time(row.dismissedAt),
    dismissed_by: row.dismissedBy === null ? null : { id: row.dismissedBy },
    dismissal_message: row.dismissalMessage,
  };
}

function reviewCommentOf(row: Row): Row {
  const anchor = (row.anchor ?? {}) as Row;
  return {
    id: row.id,
    thread_id: row.threadId,
    in_reply_to_id: row.inReplyTo,
    user: { id: row.authorId },
    performed_via_agents: row.actChain,
    body: row.body,
    commit_id: anchor.commitSha,
    path: anchor.path,
    side: anchor.side,
    line: anchor.line,
    start_line: anchor.startLine,
    created_at: time(row.createdAt),
    updated_at: time(row.updatedAt),
  };
}

function issueCommentOf(row: Row): Row {
  return {
    id: row.id,
    user: { id: row.authorId },
    performed_via_agents: row.actChain,
    body: row.body,
    created_at: time(row.createdAt),
    updated_at: time(row.updatedAt),
  };
}

/**
 * What a delivery of a pull request, review or comment event says beyond
 * the fields every delivery has: the pull request's number, the entity
 * as the event left it (a deleted comment, its id only), and the changes
 * an edit made.
 */
export function entityBody(name: WebhookEventName, event: DomainEvent): Row {
  const row = (event.entity?.row ?? null) as Row | null;
  const data = (event.data ?? {}) as Row;
  const changes = data.changes === undefined ? {} : { changes: data.changes };
  switch (name.event) {
    case "pull_request":
      // A review request has no snapshot: the pull request's number and the reviewer.
      if (row === null) return { number: data.number, requested_reviewer: { id: data.reviewer } };
      return { number: row.number, pull_request: pullOf(row), ...subjectOf(data), ...changes };
    case "issues":
      // Deleted: what its event recorded of it.
      if (row === null)
        return { number: data.number, issue: { number: data.number, title: data.title ?? null } };
      return { number: row.number, issue: issueOf(row), ...subjectOf(data), ...changesOf(data) };
    case "label":
      return { label: labelOf(row ?? (data.label as Row) ?? {}), ...changesOf(data) };
    case "milestone":
      return {
        milestone: row === null ? (data.milestone ?? null) : milestoneOf(row),
        ...changesOf(data),
      };
    case "pull_request_review":
      return { number: row?.number ?? null, review: row && reviewOf(row) };
    case "pull_request_review_comment":
      return row === null
        ? { number: data.number, comment: { id: data.comment_id } }
        : { number: row.number, comment: reviewCommentOf(row), ...changes };
    default: {
      // What the comment is on, as it was then (GitHub's `issue`, marked for a pull request).
      const parent = data.parent as
        | { kind?: string; number?: number; title?: string; state?: string }
        | null
        | undefined;
      const issue = parent && {
        number: parent.number,
        title: parent.title,
        state: parent.state === "open" ? "open" : "closed",
        ...(parent.kind === "pull" && { pull_request: {} }),
      };
      return row === null
        ? { number: data.number, issue, comment: { id: data.comment_id } }
        : { number: row.number, issue, comment: issueCommentOf(row), ...changes };
    }
  }
}
