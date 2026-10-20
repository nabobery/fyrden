import type {
  createIssue,
  deleteIssue,
  getIssue,
  Input,
  listIssues,
  lockIssue,
  Output,
  unlockIssue,
  updateIssue,
} from "@fyrden/api-contract";
import type { IssueRecord, Subject, SubjectBoundary, SubjectKind } from "../do/repo/issues.js";
import type { PullRecord } from "../do/repo/pulls.js";
import type { SubjectMeta } from "../do/repo/subject-meta.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeBytesCursor, encodeBytesCursor, invalidCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import type { RepoEntry } from "./directory.js";
import { actorOf, failure } from "./pulls.js";
import { sortingFailure, sortingInput, sortingOutput } from "./sorting.js";
import { subjectAccess, subjectNotFound, tokenKinds } from "./subjects.js";

type IssueOutput = Output<typeof getIssue>;

const repo = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

/** An issue as the API answers it; its duplicate target only when the caller reads that kind. */
function issueOutput(
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
    ...sortingOutput(meta, readable),
    pull_request: { merged_at: pull.mergedAt },
  };
}

/** An issue, or a pull request as the issue endpoints answer one. */
export const subjectOutput = (subject: Subject, readable: readonly SubjectKind[]) =>
  subject.kind === "issue"
    ? issueOutput(subject.issue, readable, subject.meta)
    : pullAsIssue(subject.pull, subject.meta, readable);

/** The problem for an issue refusal; the codes issues share with pull requests map as theirs do. */
function issueFailure(entry: RepoEntry, code: string, number: number): OperationError {
  switch (code) {
    case "not_found":
      return subjectNotFound(number);
    case "forbidden":
      return new OperationError(
        403,
        "forbidden",
        "Your role on the repository does not allow this (on someone else's issue, or labels, assignees and milestones without triage).",
      );
    case "wrong_state":
      return new OperationError(422, "wrong_state", "The issue's state does not allow this.");
    case "reason_not_for_state":
      return new OperationError(
        422,
        "reason_not_for_state",
        "state_reason does not go with that state: reopened is for open, the others for closed.",
      );
    case "duplicate_target_required":
      return new OperationError(
        422,
        "duplicate_target_required",
        "Closing as a duplicate needs duplicate_of.",
      );
    case "duplicate_of_itself":
      return new OperationError(422, "duplicate_of_itself", "An issue cannot duplicate itself.");
    case "duplicate_target_without_reason":
      return new OperationError(
        422,
        "duplicate_target_without_reason",
        "duplicate_of goes with state_reason duplicate only.",
      );
    case "repo_not_ready":
      return new OperationError(
        409,
        "repo_not_ready",
        "The repository predates the records issues need, so it takes none.",
      );
    case "duplicate_target_not_found":
      return new OperationError(
        422,
        "duplicate_target_not_found",
        "duplicate_of names no issue or pull request you can read here.",
      );
    default:
      return sortingFailure(code) ?? failure(entry, code, number);
  }
}

/**
 * A listing cursor: `base64url({v:1,r,s,d,st,t,k,n})`, the repository and
 * the listing's filters (normalized) with the last item's sort key and
 * number. Not signed, like every cursor here: one for another repository
 * or other filters is refused, and every page is authorized again and made
 * of what the caller may read, so a forged one can only skip, never show.
 */
type ListingContext = Pick<Input<typeof listIssues>, "state" | "sort" | "direction"> & {
  readonly repoId: string;
  readonly type: "issues" | "pulls" | "both";
};

function encodeListingCursor(context: ListingContext, at: SubjectBoundary): string {
  const value = {
    v: 1,
    r: context.repoId,
    s: context.sort,
    d: context.direction,
    st: context.state,
    t: context.type,
    k: at.key,
    n: at.number,
  };
  return encodeBytesCursor(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeListingCursor(
  cursor: string | undefined,
  context: ListingContext,
): SubjectBoundary | null {
  if (cursor === undefined) return null;
  let value: Record<string, unknown> | undefined;
  try {
    const bytes = decodeBytesCursor(cursor);
    value =
      bytes && JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw invalidCursor();
  }
  const fits =
    value?.v === 1 &&
    value.r === context.repoId &&
    value.s === context.sort &&
    value.d === context.direction &&
    value.st === context.state &&
    value.t === context.type &&
    Number.isSafeInteger(value.k) &&
    (value.k as number) >= 0 &&
    Number.isSafeInteger(value.n) &&
    (value.n as number) > 0;
  if (!fits) throw invalidCursor();
  return { key: value?.k as number, number: value?.n as number };
}

/** The `issues.list` operation. */
export async function listIssuesOperation(
  ctx: OpContext,
  input: Input<typeof listIssues>,
): Promise<Output<typeof listIssues>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "read");
  const type = input.type ?? "both";
  const context: ListingContext = { ...input, repoId: entry.id, type };
  const after = decodeListingCursor(input.cursor, context);
  const wanted = kinds.filter(
    (kind) => type === "both" || (type === "issues" ? kind === "issue" : kind === "pull"),
  );
  if (wanted.length === 0) return { issues: [], next_cursor: null };
  const subjects = await repo(ctx, entry, "listSubjects").listSubjects({
    kinds: wanted,
    state: input.state,
    sort: input.sort,
    direction: input.direction,
    after,
    limit: input.per_page + 1,
  });
  if (subjects === null) throw failure(entry, "repo_not_found");
  const page = subjects.slice(0, input.per_page);
  const last = page.at(-1);
  const boundary = (s: Subject): SubjectBoundary => {
    const record = s.kind === "issue" ? s.issue : s.pull;
    return {
      key: input.sort === "created" ? record.number : record.updatedAt,
      number: record.number,
    };
  };
  return {
    issues: page.map((s) => subjectOutput(s, kinds)),
    next_cursor:
      subjects.length > input.per_page && last
        ? encodeListingCursor(context, boundary(last))
        : null,
  };
}

/** The `issues.get` operation. */
export async function getIssueOperation(
  ctx: OpContext,
  input: Input<typeof getIssue>,
): Promise<Output<typeof getIssue>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "read");
  const subject = await repo(ctx, entry, "getSubject").getSubject(input.issue_number, kinds);
  if (subject === null) throw failure(entry, "repo_not_found");
  if (!subject) throw subjectNotFound(input.issue_number);
  return subjectOutput(subject, kinds);
}

/** The `issues.create` operation. */
export async function createIssueOperation(
  ctx: OpContext,
  input: Input<typeof createIssue>,
): Promise<Output<typeof createIssue>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "issues:write");
  const result = await repo(ctx, entry, "createIssue").createIssue(
    { title: input.title, body: input.body ?? null },
    actorOf(ctx),
    await sortingInput(ctx, input),
  );
  if (!result.ok) throw issueFailure(entry, result.code, 0);
  return subjectOutput(result.subject, tokenKinds(ctx, entry, "read"));
}

/** The `issues.update` operation. */
export async function updateIssueOperation(
  ctx: OpContext,
  input: Input<typeof updateIssue>,
): Promise<Output<typeof updateIssue>> {
  // A pull request's number takes its labels, assignees and milestone here, with its kind's permission.
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "write");
  // Its role was checked for writing: the kinds it reads differ by its token only.
  const readable = tokenKinds(ctx, entry, "read");
  const result = await repo(ctx, entry, "changeIssue").changeIssue(
    input.issue_number,
    {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.body !== undefined && { body: input.body }),
      ...(input.state !== undefined && { state: input.state }),
      ...(input.state_reason != null && { stateReason: input.state_reason }),
      ...(input.duplicate_of !== undefined && { duplicateOf: input.duplicate_of }),
    },
    actorOf(ctx),
    readable,
    kinds,
    await sortingInput(ctx, input),
  );
  if (!result.ok) throw issueFailure(entry, result.code, input.issue_number);
  return subjectOutput(result.subject, readable);
}

async function setLock(
  ctx: OpContext,
  input: { owner: string; repo: string; issue_number: number },
  lock: { locked: boolean; reason: Input<typeof lockIssue>["lock_reason"] | null },
): Promise<Output<typeof lockIssue>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "write");
  const result = await repo(ctx, entry, "setConversationLock").setConversationLock(
    input.issue_number,
    { locked: lock.locked, reason: lock.reason ?? null },
    actorOf(ctx),
    kinds,
  );
  if (!result.ok) throw issueFailure(entry, result.code, input.issue_number);
  return { locked: result.locked, active_lock_reason: result.reason };
}

/** The `issues.lock` operation. */
export function lockIssueOperation(
  ctx: OpContext,
  input: Input<typeof lockIssue>,
): Promise<Output<typeof lockIssue>> {
  return setLock(ctx, input, { locked: true, reason: input.lock_reason ?? null });
}

/** The `issues.unlock` operation. */
export function unlockIssueOperation(
  ctx: OpContext,
  input: Input<typeof unlockIssue>,
): Promise<Output<typeof unlockIssue>> {
  return setLock(ctx, input, { locked: false, reason: null });
}

/** The `issues.delete` operation. */
export async function deleteIssueOperation(
  ctx: OpContext,
  input: Input<typeof deleteIssue>,
): Promise<Output<typeof deleteIssue>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "issues:write");
  const result = await repo(ctx, entry, "deleteIssue").deleteIssue(
    input.issue_number,
    actorOf(ctx),
  );
  if (!result.ok) throw issueFailure(entry, result.code, input.issue_number);
  return { number: input.issue_number, state: "deleted" };
}
