import type {
  createIssue,
  deleteIssue,
  getIssue,
  Input,
  listIssueReferences,
  listIssues,
  lockIssue,
  Output,
  unlockIssue,
  updateIssue,
} from "@fyrden/api-contract";
import type { SubjectBoundary, SubjectFilter, SubjectKind } from "../do/repo/issues.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeBytesCursor, encodeBytesCursor, invalidCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { authorize, findReposById, type RepoEntry } from "./directory.js";
import { actorOf, failure } from "./pulls.js";
import { principalsByLogin } from "./reviews.js";
import { subjectOutput } from "./shapes.js";
import { sortingFailure, sortingInput } from "./sorting.js";
import { subjectAccess, subjectNotFound, tokenKinds } from "./subjects.js";

const repo = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

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
  /** The filters, normalized (none: undefined): a cursor is valid only with the same ones. */
  readonly filters: string | undefined;
};

/** Label names a `labels` filter takes at most. */
const MAX_FILTER_LABELS = 20;

/**
 * The listing's filters as the repository object takes them (handles
 * found as principals, disabled ones too), and as a cursor binds them;
 * null when nothing can match (a handle that names no one).
 */
async function listingFilter(
  ctx: OpContext,
  input: Input<typeof listIssues>,
): Promise<{ filter: SubjectFilter; key: string | undefined } | null> {
  const labelNames =
    input.labels === undefined ? undefined : [...new Set(input.labels.split(",").map(asciiLower))];
  if (labelNames && (labelNames.length > MAX_FILTER_LABELS || labelNames.some((n) => n === "")))
    throw new OperationError(
      422,
      "invalid_filter",
      `labels takes 1 to ${MAX_FILTER_LABELS} names separated by commas.`,
    );
  const labelIds =
    input.label_ids === undefined
      ? undefined
      : [...new Set(input.label_ids.split(",").map(Number))].sort((a, b) => a - b);
  // `none` and `*` are the assignee filter's words; a creator is always a handle.
  const assigneeHandle =
    input.assignee === undefined || input.assignee === "none" || input.assignee === "*"
      ? undefined
      : input.assignee;
  const handles = [assigneeHandle, input.creator].filter((h): h is string => h !== undefined);
  const found = handles.length > 0 ? await principalsByLogin(ctx, handles, true) : new Map();
  const principal = (handle: string) => found.get(handle.toLowerCase()) as string | undefined;
  let assignee: SubjectFilter["assignee"];
  if (input.assignee === "none") assignee = "none";
  else if (input.assignee === "*") assignee = "any";
  else if (assigneeHandle !== undefined) {
    const id = principal(assigneeHandle);
    if (!id) return null;
    assignee = { principal: id };
  }
  let creator: string | undefined;
  if (input.creator !== undefined) {
    creator = principal(input.creator);
    if (!creator) return null;
  }
  const milestone =
    input.milestone === undefined
      ? undefined
      : input.milestone === "none"
        ? "none"
        : input.milestone === "*"
          ? "any"
          : Number(input.milestone);
  const filter: SubjectFilter = {
    ...(labelNames && { labelNames: [...labelNames].sort() }),
    ...(labelIds && { labelIds }),
    ...(assignee && { assignee }),
    ...(milestone !== undefined && { milestone }),
    ...(creator && { creator }),
  };
  // The cursor holds a digest of the filters, not the filters (20 long label names would not fit).
  return {
    filter,
    key: Object.keys(filter).length > 0 ? await digest(JSON.stringify(filter)) : undefined,
  };
}

/** A short digest of `text` (SHA-256, the first 16 bytes, hex). */
async function digest(text: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...hash.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `name` with ASCII letters lower-cased: label names compare so (SQLite's `NOCASE`). */
const asciiLower = (name: string) => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

function encodeListingCursor(context: ListingContext, at: SubjectBoundary): string {
  const value = {
    v: 1,
    r: context.repoId,
    s: context.sort,
    d: context.direction,
    st: context.state,
    t: context.type,
    f: context.filters,
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
    value.f === context.filters &&
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
  const filtering = await listingFilter(ctx, input);
  const context: ListingContext = {
    ...input,
    repoId: entry.id,
    type,
    filters: filtering?.key,
  };
  const after = decodeListingCursor(input.cursor, context);
  const wanted = kinds.filter(
    (kind) => type === "both" || (type === "issues" ? kind === "issue" : kind === "pull"),
  );
  if (wanted.length === 0 || filtering === null) return { issues: [], next_cursor: null };
  const listing = await repo(ctx, entry, "listSubjects").listSubjects({
    kinds: wanted,
    state: input.state,
    sort: input.sort,
    direction: input.direction,
    after,
    limit: input.per_page,
    filter: filtering.filter,
  });
  if (listing === null) throw failure(entry, "repo_not_found");
  return {
    issues: listing.subjects.map((s) => subjectOutput(s, kinds)),
    next_cursor: listing.next ? encodeListingCursor(context, listing.next) : null,
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

/** Other repositories one page of references checks at most (an authorization each). */
export const REFERENCE_REPOS_PER_PAGE = 10;

const KIND_READ = { issue: "issues:read", pull: "pull_requests:read" } as const;

/** Calls to the repository object one page of references makes at most (each passes a hidden group). */
const REFERENCE_ROUNDS = 2 * REFERENCE_REPOS_PER_PAGE + 2;

/**
 * The `issues.references.list` operation: each reference only when the
 * caller reads both ends (this issue's or pull request's kind, checked by
 * the object; the source's repository and kind, checked here, at most
 * `REFERENCE_REPOS_PER_PAGE` other repositories a page). A page holds only
 * references the caller sees: one whose repository and kind it may not
 * read is passed over with every other of that repository and kind, and a
 * continuation follows only a reference shown (or, past the page's checks,
 * the last group passed over: the page then ends early).
 */
export async function listIssueReferencesOperation(
  ctx: OpContext,
  input: Input<typeof listIssueReferences>,
): Promise<Output<typeof listIssueReferences>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "read");
  const object = repo(ctx, entry, "listReferences");
  const found = new Map<string, RepoEntry>();
  const readable = new Map<string, boolean>();
  const mayRead = async (repoId: string, kind: SubjectKind): Promise<boolean> => {
    if (repoId === entry.id) return kinds.includes(kind);
    const other = found.get(repoId);
    if (!other) return false;
    const key = `${repoId}:${kind}`;
    let allowed = readable.get(key);
    if (allowed === undefined) {
      allowed = await authorize(ctx.env, ctx.auth, other, KIND_READ[kind], ctx.metrics);
      readable.set(key, allowed);
    }
    return allowed;
  };
  const checked = new Set<string>();
  const page: Output<typeof listIssueReferences>["references"] = [];
  let cursor = input.cursor ?? null;
  // The position a continuation names: after the last reference shown, or group passed over.
  let at: string | null = null;
  let more = false;
  rounds: for (let round = 0; ; round++) {
    if (round === REFERENCE_ROUNDS) {
      more = at !== null;
      break;
    }
    const want = input.per_page + 1 - page.length;
    const rows = await object.listReferences(input.issue_number, kinds, cursor, want);
    if (rows === null) throw failure(entry, "repo_not_found");
    if (!rows) throw subjectNotFound(input.issue_number);
    if (rows === "invalid_cursor") throw invalidCursor();
    const unknown = [
      ...new Set(
        rows
          .map((r) => r.sourceRepo)
          .filter((id) => id !== entry.id && !checked.has(id) && !found.has(id)),
      ),
    ].slice(0, REFERENCE_REPOS_PER_PAGE - checked.size);
    for (const other of await findReposById(ctx.env, unknown, ctx.metrics))
      found.set(other.id, other);
    for (const row of rows) {
      if (row.sourceRepo !== entry.id && !checked.has(row.sourceRepo)) {
        // Past the repositories this page may check: the next page goes on from here.
        if (checked.size >= REFERENCE_REPOS_PER_PAGE) {
          more = at !== null;
          break rounds;
        }
        checked.add(row.sourceRepo);
      }
      if (!(await mayRead(row.sourceRepo, row.sourceKind))) {
        // Every reference of that repository and kind is passed over at once.
        cursor = row.groupEnd;
        at = row.groupEnd;
        continue rounds;
      }
      if (page.length === input.per_page) {
        more = true;
        break rounds;
      }
      const source = row.sourceRepo === entry.id ? entry : (found.get(row.sourceRepo) as RepoEntry);
      page.push({
        source: {
          repository: `${source.ownerHandle}/${source.name}`,
          number: row.sourceNumber,
          kind: row.sourceKind === "issue" ? "issue" : "pull_request",
          comment_id: row.sourceComment === 0 ? null : row.sourceComment,
        },
        created_at: row.createdAt,
      });
      cursor = row.cursor;
      at = row.cursor;
    }
    // Fewer than asked: nothing after them.
    if (rows.length < want) break;
  }
  return { references: page, next_cursor: more ? at : null };
}
