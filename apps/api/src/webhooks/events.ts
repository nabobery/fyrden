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
  ]),
  pull_request_review: new Set(["submitted", "dismissed"]),
  pull_request_review_comment: new Set(["created", "edited", "deleted"]),
  issue_comment: new Set(["created", "edited", "deleted"]),
};

/** The webhook event a repository event of `type` makes, if any. */
export function webhookEventOf(type: string): WebhookEventName | undefined {
  if (type === "refs.updated") return { event: "push", action: null };
  if (type === "webhook.ping") return { event: "ping", action: null };
  const dot = type.indexOf(".");
  if (dot < 0) return undefined;
  const event = type.slice(0, dot);
  const action = type.slice(dot + 1);
  return ACTIONS[event]?.has(action) ? { event, action } : undefined;
}

/** Milliseconds since the epoch as an ISO 8601 time, or null. */
function time(ms: unknown): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

type Row = Record<string, unknown>;

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
      return { number: row.number, pull_request: pullOf(row), ...changes };
    case "pull_request_review":
      return { number: row?.number ?? null, review: row && reviewOf(row) };
    case "pull_request_review_comment":
      return row === null
        ? { number: data.number, comment: { id: data.comment_id } }
        : { number: row.number, comment: reviewCommentOf(row), ...changes };
    default:
      return row === null
        ? { number: data.number, comment: { id: data.comment_id } }
        : { number: row.number, comment: issueCommentOf(row), ...changes };
  }
}
