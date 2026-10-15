import type { RefActor } from "@fyrden/adapters-cloudflare/git";
import type {
  createPull,
  getPull,
  Input,
  listPulls,
  Output,
  updatePull,
} from "@fyrden/api-contract";
import type { PullRecord } from "../do/repo/pulls.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import type { RepoEntry } from "./directory.js";

type PullOutput = Output<typeof getPull>;

function output(pull: PullRecord): PullOutput {
  return {
    number: pull.number,
    state: pull.state === "open" ? "open" : "closed",
    merged: pull.state === "merged",
    draft: pull.draft,
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
  };
}

function actorOf(ctx: OpContext): RefActor {
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
function failure(entry: RepoEntry, code: string, number?: number): OperationError {
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
    pull_requests: page.map(output),
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
  return output(pull);
}

/** The `pulls.create` operation. */
export async function createPullOperation(
  ctx: OpContext,
  input: Input<typeof createPull>,
): Promise<Output<typeof createPull>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "createPull" });
  const result = await ctx.env.REPO.getByName(entry.id).createPull(
    {
      title: input.title,
      body: input.body ? input.body : null,
      draft: input.draft,
      baseRef: input.base,
      headRef: input.head,
    },
    actorOf(ctx),
  );
  if (!result.ok) throw failure(entry, result.code, "number" in result ? result.number : undefined);
  return output(result.record);
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
    },
    actorOf(ctx),
  );
  if (!result.ok)
    throw failure(entry, result.code, "number" in result ? result.number : input.pull_number);
  return output(result.record);
}
