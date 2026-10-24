import type {
  createMilestone,
  deleteMilestone,
  getMilestone,
  Input,
  listMilestones,
  Output,
  updateMilestone,
} from "@fyrden/api-contract";
import { NO_DUE_DATE } from "../do/repo/subject-meta.js";
import { decodeBytesCursor, encodeBytesCursor, invalidCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { pageOf } from "../ops/pages.js";
import type { RepoEntry } from "./directory.js";
import { actorOf, failure, refusedVersion, staleError } from "./pulls.js";
import { milestoneOutput } from "./shapes.js";
import { sortingFailure } from "./sorting.js";
import { subjectAccess, tokenKinds } from "./subjects.js";

/*
 * Milestones serve issues and pull requests alike: reading them takes
 * either kind's read permission, managing them (write access) either
 * kind's write permission.
 */

const repo = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

const milestoneNotFound = (number: number) =>
  new OperationError(404, "milestone_not_found", `The repository has no milestone ${number}.`);

/** The problem for a refusal of a milestone's management. */
function milestoneFailure(entry: RepoEntry, code: string, number: number): OperationError {
  switch (code) {
    case "milestone_not_found":
      return milestoneNotFound(number);
    case "milestone_exists":
      return new OperationError(
        422,
        "milestone_exists",
        "The repository has a milestone with that title already.",
      );
    case "forbidden":
      return new OperationError(403, "forbidden", "Managing milestones takes write access.");
    default:
      return sortingFailure(code) ?? failure(entry, code);
  }
}

/**
 * A listing cursor: `base64url({v:1,r,st,d,k,n})`, the repository and the
 * listing's state and direction with the last milestone's due date (none
 * as the largest) and number. Unsigned, as every cursor here: one for
 * another repository or listing is refused.
 */
type ListingContext = {
  readonly repoId: string;
  readonly state: string;
  readonly direction: string;
};

function encodeListingCursor(context: ListingContext, key: number, number: number): string {
  const value = {
    v: 1,
    r: context.repoId,
    st: context.state,
    d: context.direction,
    k: key,
    n: number,
  };
  return encodeBytesCursor(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeListingCursor(
  cursor: string | undefined,
  context: ListingContext,
): { key: number; number: number } | null {
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
    value.st === context.state &&
    value.d === context.direction &&
    Number.isSafeInteger(value.k) &&
    (value.k as number) >= 0 &&
    Number.isSafeInteger(value.n) &&
    (value.n as number) > 0;
  if (!fits) throw invalidCursor();
  return { key: value?.k as number, number: value?.n as number };
}

/** The `milestones.list` operation. */
export async function listMilestonesOperation(
  ctx: OpContext,
  input: Input<typeof listMilestones>,
): Promise<Output<typeof listMilestones>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "read");
  const context = { repoId: entry.id, state: input.state, direction: input.direction };
  const after = decodeListingCursor(input.cursor, context);
  const milestones = await repo(ctx, entry, "listMilestones").listMilestones({
    state: input.state,
    direction: input.direction,
    after,
    limit: input.per_page + 1,
  });
  if (milestones === null) throw failure(entry, "repo_not_found");
  const page = pageOf(milestones, input.per_page, (m) => milestoneOutput(m, kinds));
  return {
    milestones: page.shown,
    next_cursor:
      page.more && page.last
        ? encodeListingCursor(context, page.last.dueOn ?? NO_DUE_DATE, page.last.number)
        : null,
  };
}

/** The `milestones.get` operation. */
export async function getMilestoneOperation(
  ctx: OpContext,
  input: Input<typeof getMilestone>,
): Promise<Output<typeof getMilestone>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "read");
  const milestone = await repo(ctx, entry, "getMilestone").getMilestone(input.milestone_number);
  if (milestone === null) throw failure(entry, "repo_not_found");
  if (!milestone) throw milestoneNotFound(input.milestone_number);
  return milestoneOutput(milestone, kinds);
}

/** The `milestones.create` operation. */
export async function createMilestoneOperation(
  ctx: OpContext,
  input: Input<typeof createMilestone>,
): Promise<Output<typeof createMilestone>> {
  const { entry } = await subjectAccess(ctx, input.owner, input.repo, "write");
  const result = await repo(ctx, entry, "createMilestone").createMilestone(
    {
      title: input.title,
      description: input.description ?? null,
      state: input.state,
      dueOn: input.due_on ?? null,
    },
    actorOf(ctx),
  );
  if (!result.ok) throw milestoneFailure(entry, result.code, 0);
  return milestoneOutput(result.milestone, tokenKinds(ctx, entry, "read"));
}

/** The `milestones.update` operation. */
export async function updateMilestoneOperation(
  ctx: OpContext,
  input: Input<typeof updateMilestone>,
): Promise<Output<typeof updateMilestone>> {
  const { entry } = await subjectAccess(ctx, input.owner, input.repo, "write");
  const patch = {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.state !== undefined && { state: input.state }),
    ...(input.due_on !== undefined && { dueOn: input.due_on }),
  };
  // With a precondition, through a method an earlier object lacks (it fails, never skips it).
  const result =
    input.expected_version === undefined
      ? await repo(ctx, entry, "updateMilestone").updateMilestone(
          input.milestone_number,
          patch,
          actorOf(ctx),
        )
      : await repo(ctx, entry, "updateMilestoneAt").updateMilestoneAt(
          input.expected_version,
          input.milestone_number,
          patch,
          actorOf(ctx),
        );
  if (!result.ok && result.code === "stale") throw staleError(refusedVersion(result));
  if (!result.ok) throw milestoneFailure(entry, result.code, input.milestone_number);
  return milestoneOutput(result.milestone, tokenKinds(ctx, entry, "read"));
}

/** The `milestones.delete` operation. */
export async function deleteMilestoneOperation(
  ctx: OpContext,
  input: Input<typeof deleteMilestone>,
): Promise<Output<typeof deleteMilestone>> {
  const { entry } = await subjectAccess(ctx, input.owner, input.repo, "write");
  const result = await repo(ctx, entry, "deleteMilestone").deleteMilestone(
    input.milestone_number,
    actorOf(ctx),
  );
  if (!result.ok) throw milestoneFailure(entry, result.code, input.milestone_number);
  return { number: input.milestone_number, state: "deleted" };
}
