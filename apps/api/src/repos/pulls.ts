import type { RefActor } from "@fyrden/adapters-cloudflare/git";
import type {
  createPull,
  getPull,
  getPullConflicts,
  Input,
  listPullCommits,
  listPullFiles,
  listPulls,
  mergePull,
  Output,
  resolvePullConflicts,
  updatePull,
  updatePullBranch,
} from "@fyrden/api-contract";
import {
  MAX_PULL_TEAM_REVIEWERS,
  MAX_REQUESTED_REVIEWERS,
  MAX_TEAM_REVIEWERS,
} from "@fyrden/domain";
import { repoFor } from "../git/chunked/operations.js";
import { decodeBytesCursor, decodeCursor, encodeBytesCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { resolveVerification } from "../signing/verification.js";
import { authorize, findReposById, networkReposOf, type RepoEntry } from "./directory.js";
import { commitIdentityFor, commitIdentityOf } from "./file-writes.js";
import { pullOutput } from "./shapes.js";
import { tokenKinds } from "./subjects.js";

/** The kinds the caller reads in `entry` (its token's limits; both take the same role). */
export const readable = (ctx: OpContext, entry: RepoEntry) => tokenKinds(ctx, entry, "read");

/** The caller as the repository object records it. */
export function actorOf(ctx: OpContext): RefActor {
  return {
    principal: ctx.auth.principalId,
    tokenId: ctx.auth.id,
    grantId: ctx.auth.grantId,
    actChain: ctx.auth.act,
    requestId: ctx.requestId ?? null,
    via: "api",
  };
}

const repoNotFound = (entry: RepoEntry) =>
  new OperationError(
    404,
    "repo_not_found",
    `No repository ${entry.ownerHandle}/${entry.name} was found.`,
  );
const pullNotFound = (number: number) =>
  new OperationError(404, "pull_not_found", `The repository has no pull request ${number}.`);

/** The problem for a refusal the repository object answered with. */
export function failure(entry: RepoEntry, code: string, number?: number): OperationError {
  switch (code) {
    case "not_found":
      return pullNotFound(number ?? 0);
    case "base_not_found":
      return new OperationError(422, "base_not_found", "The base branch does not exist.");
    case "head_not_found":
      return new OperationError(422, "head_not_found", "The head branch does not exist.");
    case "same_branches":
      return new OperationError(
        422,
        "same_branches",
        "The head and base must be different branches.",
      );
    case "too_expensive":
      return new OperationError(
        422,
        "too_expensive",
        "The head's history is too far from the base's to import here.",
      );
    case "view_full":
      return new OperationError(
        422,
        "view_full",
        "The base repository borrows as many packs from its fork network as it can hold, and they are too large to merge.",
      );
    case "no_commits":
      return new OperationError(
        422,
        "no_commits",
        "The head has no commits the base does not have.",
      );
    case "already_exists":
      return new OperationError(
        422,
        "pull_exists",
        `A pull request between these branches is already open${number ? `: #${number}` : ""}.`,
      );
    case "forbidden":
      return new OperationError(
        403,
        "forbidden",
        "Your role on the repository does not allow this on someone else's pull request.",
      );
    case "wrong_state":
      return new OperationError(
        422,
        "wrong_state",
        "The pull request's state does not allow this.",
      );
    case "head_ref_deleted":
      return new OperationError(
        422,
        "head_ref_deleted",
        "The head branch was deleted; restore it to reopen the pull request.",
      );
    case "repo_transferring":
      return new OperationError(
        409,
        "repo_transferring",
        "The repository is being transferred; its pull requests change once it lands.",
      );
    case "review_not_found":
      return new OperationError(404, "review_not_found", "The pull request has no such review.");
    case "own_pull_request":
      return new OperationError(
        422,
        "own_pull_request",
        "You cannot approve or request changes on your own pull request; comment instead.",
      );
    case "body_required":
      return new OperationError(
        422,
        "body_required",
        "Requesting changes or commenting needs a body.",
      );
    case "commit_not_in_pull":
      return new OperationError(
        422,
        "commit_not_in_pull",
        "commit_id is not a head this pull request has had; read it again for its head.sha.",
      );
    case "reviewer_no_access":
      return new OperationError(
        422,
        "reviewer_no_access",
        "A reviewer cannot read this repository.",
      );
    case "reviewer_is_author":
      return new OperationError(
        422,
        "reviewer_is_author",
        "A review cannot be requested of the pull request's author.",
      );
    case "too_many_reviewers":
      return new OperationError(
        422,
        "too_many_reviewers",
        `A pull request may have at most ${MAX_REQUESTED_REVIEWERS} reviews requested at once, a team counting as one.`,
      );
    case "team_not_found":
      return new OperationError(
        422,
        "team_not_found",
        "A team named is not one of the repository's organization's teams that can read it.",
      );
    case "team_too_large":
      return new OperationError(
        422,
        "team_too_large",
        `A team may be asked with at most ${MAX_TEAM_REVIEWERS} members, and a pull request's teams with ${MAX_PULL_TEAM_REVIEWERS} in all.`,
      );
    case "team_audience_unavailable":
      return new OperationError(
        409,
        "team_audience_unavailable",
        "The teams' members could not be read just now; try again.",
      );
    case "locked":
      return new OperationError(
        403,
        "conversation_locked",
        "The conversation is locked: only write access and above may comment or review.",
      );
    case "busy":
      return new OperationError(409, "busy", "The repository is busy; try again.");
    default:
      return repoNotFound(entry);
  }
}

/** The `pulls.list` operation. */
export async function listPullsOperation(
  ctx: OpContext,
  input: Input<typeof listPulls>,
): Promise<Output<typeof listPulls>> {
  // The cursor is the last pull request's number.
  const after = decodeCursor(input.cursor, (n) => /^[1-9][0-9]{0,15}$/.test(n));
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "listPulls" });
  const pulls = await ctx.env.REPO.getByName(entry.id).listPulls(
    input.state,
    after === "" ? undefined : Number(after),
    input.per_page + 1,
  );
  if (!pulls) throw repoNotFound(entry);
  const page = pulls.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    pull_requests: page.map((p) => pullOutput(p, readable(ctx, entry))),
    next_cursor: pulls.length > input.per_page && last ? encodeCursor(String(last.number)) : null,
  };
}

/** The `pulls.get` operation. */
export async function getPullOperation(
  ctx: OpContext,
  input: Input<typeof getPull>,
): Promise<Output<typeof getPull>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "getPull" });
  const pull = await ctx.env.REPO.getByName(entry.id).getPull(input.pull_number);
  if (pull === null) throw repoNotFound(entry);
  if (!pull) throw pullNotFound(input.pull_number);
  return pullOutput(pull, readable(ctx, entry));
}

/** The `pulls.create` operation. */
export async function createPullOperation(
  ctx: OpContext,
  input: Input<typeof createPull>,
): Promise<Output<typeof createPull>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  const fields = {
    title: input.title,
    body: input.body ? input.body : null,
    draft: input.draft,
    maintainerCanModify: input.maintainer_can_modify,
    baseRef: input.base,
  };
  const repo = ctx.env.REPO.getByName(entry.id);
  const head = await headRepoOf(ctx, entry, input.head, input.head_repo);
  let result:
    | Awaited<ReturnType<typeof repo.createPull>>
    | Awaited<ReturnType<typeof repo.createForkPull>>;
  if (head.repo === null) {
    ctx.metrics.count("do.request", { class: "RepoDO", method: "createPull" });
    result = await repo.createPull({ ...fields, headRef: head.branch }, actorOf(ctx));
  } else {
    ctx.metrics.count("do.request", { class: "RepoDO", method: "createForkPull" });
    result = await repo.createForkPull(
      { ...fields, headRef: head.branch, headRepoId: head.repo.id },
      actorOf(ctx),
    );
  }
  if (!result.ok) throw failure(entry, result.code, "number" in result ? result.number : undefined);
  return pullOutput(result.record, readable(ctx, entry));
}

/**
 * The repository and branch `head` names: a branch of the base itself, or
 * GitHub's `owner:branch`, a branch of that owner's repository in the
 * base's fork network (`headRepo` names it when the owner has several the
 * caller reads), which the caller must be able to read. A repository the
 * caller cannot read is not there for it: it neither makes the name
 * ambiguous nor is told of.
 */
async function headRepoOf(
  ctx: OpContext,
  base: RepoEntry,
  head: string,
  headRepo: string | undefined,
): Promise<{ repo: RepoEntry | null; branch: string }> {
  const colon = head.indexOf(":");
  if (colon < 0) return { repo: null, branch: head };
  const owner = head.slice(0, colon);
  const branch = head.slice(colon + 1);
  if (branch === "")
    throw new OperationError(422, "invalid_input", "head names no branch after its owner.");
  const candidates = await networkReposOf(ctx.env, base.networkId, owner, headRepo, ctx.metrics);
  const notFound = new OperationError(
    422,
    "head_not_found",
    `${owner} has no repository in this repository's fork network to open a pull request from.`,
  );
  let found: RepoEntry | undefined;
  // One at a time, stopping at a second the caller reads: the calls are bounded by the candidates.
  for (const candidate of candidates) {
    const readable =
      candidate.id === base.id ||
      (await authorize(ctx.env, ctx.auth, candidate, "contents:read", ctx.metrics));
    if (!readable) continue;
    if (found)
      throw new OperationError(
        422,
        "head_repo_required",
        `${owner} has several repositories in this fork network; name one with head_repo.`,
      );
    found = candidate;
  }
  if (!found) throw notFound;
  return { repo: found.id === base.id ? null : found, branch };
}

/** The `pulls.update` operation. */
export async function updatePullOperation(
  ctx: OpContext,
  input: Input<typeof updatePull>,
): Promise<Output<typeof updatePull>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "changePull" });
  const result = await ctx.env.REPO.getByName(entry.id).changePull(
    input.pull_number,
    {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.body !== undefined && { body: input.body === "" ? null : input.body }),
      ...(input.state !== undefined && { state: input.state }),
      ...(input.base !== undefined && { base: input.base }),
      ...(input.draft !== undefined && { draft: input.draft }),
      ...(input.maintainer_can_modify !== undefined && {
        maintainerCanModify: input.maintainer_can_modify,
      }),
    },
    actorOf(ctx),
  );
  if (!result.ok)
    throw failure(entry, result.code, "number" in result ? result.number : input.pull_number);
  return pullOutput(result.record, readable(ctx, entry));
}

/** The `pulls.merge` operation. */
export async function mergePullOperation(
  ctx: OpContext,
  input: Input<typeof mergePull>,
): Promise<Output<typeof mergePull>> {
  // git stops reading a message at a NUL (and fsck warns of one).
  for (const text of [input.commit_title, input.commit_message])
    if (text?.includes("\0"))
      throw new OperationError(422, "invalid_input", "A commit message must not contain NUL.");
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const repo = ctx.env.REPO.getByName(entry.id);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "getPull" });
  const pull = await repo.getPull(input.pull_number);
  if (pull === null) throw repoNotFound(entry);
  if (!pull) throw pullNotFound(input.pull_number);
  const [mergerIdentity, pullAuthorIdentity, head] = await Promise.all([
    commitIdentityOf(ctx),
    commitIdentityFor(ctx, pull.authorId, pull.authorAct[0] ?? null),
    // A head branch in a fork: the default message names the fork's owner, as GitHub's does.
    pull.headRepoId ? findReposById(ctx.env, [pull.headRepoId], ctx.metrics) : [],
  ]);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "mergePull" });
  const result = await repo.mergePull(
    {
      number: input.pull_number,
      method: input.merge_method,
      ...(input.sha !== undefined && { expectedHead: input.sha }),
      ...(input.commit_title !== undefined && { commitTitle: input.commit_title }),
      ...(input.commit_message !== undefined && { commitMessage: input.commit_message }),
      ownerHandle: head[0]?.ownerHandle ?? entry.ownerHandle,
      mergerIdentity,
      pullAuthorIdentity,
    },
    actorOf(ctx),
  );
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  return { sha: result.value.sha, merged: true, message: "Pull Request successfully merged" };
}

/** A listing's cursor: the listing (an id the repository made) and where the next page starts. */
function decodeListingCursor(
  cursor: string | undefined,
): { listing: string; start: number } | null {
  if (cursor === undefined) return null;
  const bytes = decodeBytesCursor(cursor);
  const [listing = "", start = ""] = bytes ? new TextDecoder().decode(bytes).split(" ") : [];
  if (!/^[0-9a-f]{32}$/.test(listing) || !/^[1-9][0-9]{0,5}$/.test(start))
    throw new OperationError(422, "invalid_cursor", "The cursor is not one this API returned.");
  return { listing, start: Number(start) };
}

const encodeListingCursor = (listing: string | null, next: number | null) =>
  listing === null || next === null
    ? null
    : encodeBytesCursor(new TextEncoder().encode(`${listing} ${next}`));

/** The `pulls.files.list` operation. */
export async function listPullFilesOperation(
  ctx: OpContext,
  input: Input<typeof listPullFiles>,
): Promise<Output<typeof listPullFiles>> {
  const from = decodeListingCursor(input.cursor);
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "listPullFiles" });
  const result = await ctx.env.REPO.getByName(entry.id).listPullFiles(
    input.pull_number,
    from,
    input.per_page,
  );
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  const page = result.value;
  return {
    files: page.files.map((f) => ({
      sha: f.sha,
      filename: f.filename,
      ...(f.previousFilename !== null && { previous_filename: f.previousFilename }),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.additions + f.deletions,
      ...(f.patch !== null && { patch: f.patch }),
      ...(f.patchOmitted !== null && { patch_omitted: f.patchOmitted }),
      ...(f.approximate && { approximate: true }),
    })),
    merge_base_sha: page.mergeBase,
    head_sha: page.head,
    truncated: page.truncated,
    next_cursor: encodeListingCursor(page.listing, page.next),
  };
}

/** The `pulls.commits.list` operation. */
export async function listPullCommitsOperation(
  ctx: OpContext,
  input: Input<typeof listPullCommits>,
): Promise<Output<typeof listPullCommits>> {
  const from = decodeListingCursor(input.cursor);
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "listPullCommits" });
  const result = await ctx.env.REPO.getByName(entry.id).listPullCommits(
    input.pull_number,
    from,
    input.per_page,
  );
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  return {
    commits: await resolveVerification(ctx, result.value.commits),
    next_cursor: encodeListingCursor(result.value.listing, result.value.next),
  };
}

/** The `pulls.conflicts.get` operation. */
export async function getPullConflictsOperation(
  ctx: OpContext,
  input: Input<typeof getPullConflicts>,
): Promise<Output<typeof getPullConflicts>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "pullConflicts" });
  const result = await ctx.env.REPO.getByName(entry.id).pullConflicts(input.pull_number);
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  const view = result.value;
  return {
    base_sha: view.baseSha,
    head_sha: view.headSha,
    conflict_snapshot: view.snapshot,
    files: view.files.map((f) => ({
      path: f.path,
      kind: f.kind,
      editable: f.editable,
      content: f.content,
      conflicts: f.conflicts,
    })),
  };
}

/** The `pulls.conflicts.resolve` operation. */
export async function resolvePullConflictsOperation(
  ctx: OpContext,
  input: Input<typeof resolvePullConflicts>,
): Promise<Output<typeof resolvePullConflicts>> {
  // git stops reading a message at a NUL (and fsck warns of one).
  if (input.commit_message?.includes("\0"))
    throw new OperationError(422, "invalid_input", "A commit message must not contain NUL.");
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:write");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "resolvePullConflicts" });
  const result = await ctx.env.REPO.getByName(entry.id).resolvePullConflicts(
    {
      number: input.pull_number,
      identity: await commitIdentityOf(ctx),
      snapshot: input.conflict_snapshot,
      files: input.files,
      ...(input.commit_message !== undefined && { message: input.commit_message }),
    },
    actorOf(ctx),
  );
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  return { sha: result.value.sha, markers: [...result.value.markers] };
}

/** The `pulls.branch.update` operation. */
export async function updatePullBranchOperation(
  ctx: OpContext,
  input: Input<typeof updatePullBranch>,
): Promise<Output<typeof updatePullBranch>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:write");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "updatePullBranch" });
  const result = await ctx.env.REPO.getByName(entry.id).updatePullBranch(
    {
      number: input.pull_number,
      identity: await commitIdentityOf(ctx),
      ...(input.expected_head_sha !== undefined && { expectedHead: input.expected_head_sha }),
    },
    actorOf(ctx),
  );
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  return {
    message: "Updating pull request branch.",
    url: `${ctx.requestOrigin}/api/repos/${entry.ownerHandle}/${entry.name}/pulls/${input.pull_number}`,
    sha: result.value.sha,
  };
}
