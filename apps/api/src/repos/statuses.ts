import type {
  createStatus,
  getCombinedStatus,
  Input,
  listStatuses,
  Output,
} from "@fyrden/api-contract";
import type { StatusRecord } from "../do/repo/checks.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import type { RepoEntry } from "./directory.js";
import { actorOf, failure } from "./pulls.js";
import { sortingFailure } from "./sorting.js";

/*
 * The Worker side of the `statuses.*` operations. The repository object
 * owns statuses and the summaries they keep (`do/repo/checks.ts`).
 */

const repo = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

function statusOutput(status: StatusRecord) {
  return {
    id: status.id,
    state: status.state,
    context: status.context,
    description: status.description,
    target_url: status.targetUrl,
    created_at: status.createdAt,
    updated_at: status.createdAt,
    creator: { id: status.creator },
  };
}

/** The problem for a refusal of a status. */
function statusFailure(entry: RepoEntry, code: string): OperationError {
  switch (code) {
    case "commit_not_found":
      return new OperationError(422, code, "The repository has no such commit.");
    case "status_limit":
      return new OperationError(
        422,
        code,
        "The commit has as many statuses as it can hold: 1,000 of one context and 10,000 in all.",
      );
    case "check_limit":
      return new OperationError(
        422,
        code,
        "The commit has as many status contexts as it can hold (1,000).",
      );
    case "invalid_status":
      return new OperationError(422, code, "The status's fields are not ones a status takes.");
    case "forbidden":
      return new OperationError(403, code, "Posting statuses takes write access.");
    default:
      return sortingFailure(code) ?? failure(entry, code);
  }
}

/** The `statuses.create` operation. */
export async function createStatusOperation(
  ctx: OpContext,
  input: Input<typeof createStatus>,
): Promise<Output<typeof createStatus>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "statuses:write");
  const result = await repo(ctx, entry, "createStatus").createStatus(
    input.sha,
    {
      state: input.state,
      context: input.context,
      description: input.description ?? null,
      targetUrl: input.target_url ?? null,
    },
    actorOf(ctx),
  );
  if (!result.ok) throw statusFailure(entry, result.code);
  return statusOutput(result.status);
}

/** The `statuses.list` operation. The cursor is the last status's id. */
export async function listStatusesOperation(
  ctx: OpContext,
  input: Input<typeof listStatuses>,
): Promise<Output<typeof listStatuses>> {
  const before = decodeCursor(input.cursor, (id) => /^[1-9][0-9]{0,15}$/.test(id));
  const entry = await repoFor(ctx, input.owner, input.repo, "statuses:read");
  const result = await repo(ctx, entry, "listStatuses").listStatuses(
    input.ref,
    before === "" ? null : Number(before),
    input.per_page,
  );
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  return {
    statuses: result.value.statuses.map(statusOutput),
    next_cursor: result.value.next === null ? null : encodeCursor(String(result.value.next)),
  };
}

/** The `statuses.combined` operation. The cursor is the last context's folded name. */
export async function getCombinedStatusOperation(
  ctx: OpContext,
  input: Input<typeof getCombinedStatus>,
): Promise<Output<typeof getCombinedStatus>> {
  const after = decodeCursor(input.cursor, (key) => key.length > 0 && key.length <= 1_024);
  const entry = await repoFor(ctx, input.owner, input.repo, "statuses:read");
  const result = await repo(ctx, entry, "combinedStatus").combinedStatus(
    input.ref,
    after === "" ? null : after,
    input.per_page,
  );
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  const combined = result.value;
  return {
    state: combined.state,
    sha: combined.sha,
    total_count: combined.totalCount,
    statuses: combined.statuses.map(statusOutput),
    next_cursor: combined.next === null ? null : encodeCursor(combined.next),
  };
}
