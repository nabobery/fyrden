import type { Input, Output, updateRepo } from "@fyrden/api-contract";
import { repoFor } from "../git/chunked/operations.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { defaultBranchOf, renameRepo, setTemplate } from "./directory.js";
import { repoOutput, starCounts, visibleParents } from "./output.js";

const branchNotFound = (branch: string) =>
  new OperationError(422, "branch_not_found", `The repository has no branch ${branch}.`);

/**
 * The `repos.update` operation. A rename goes to the directory first (it
 * owns names and refuses a taken one); then the repository object records
 * the directory's name with the other settings and emits one snapshot.
 * Every update hands the object the directory's current name, so one that
 * missed a rename (a failure in between) catches up on the next update;
 * the old name redirects, so a retry still finds the repository.
 */
export async function updateRepoOperation(
  ctx: OpContext,
  input: Input<typeof updateRepo>,
): Promise<Output<typeof updateRepo>> {
  const { env, auth, metrics } = ctx;
  const entry = await repoFor(ctx, input.owner, input.repo, "administration:write");
  const stub = env.REPO.getByName(entry.id);
  let name = { value: entry.name, gen: entry.nameGen };
  if (input.name !== undefined && input.name !== entry.name) {
    // Checked first, so a missing branch leaves the name as it was.
    if (input.default_branch !== undefined) {
      metrics.count("do.request", { class: "RepoDO", method: "hasBranch" });
      if (!(await stub.hasBranch(input.default_branch))) throw branchNotFound(input.default_branch);
    }
    const renamed = await renameRepo(env, entry, input.name, {
      actorId: auth.principalId,
      requestId: ctx.requestId,
      alias: input.repo,
      metrics,
    });
    if (renamed === "name_taken")
      throw new OperationError(
        409,
        "name_taken",
        `You already have a repository named ${input.name}.`,
      );
    if (!renamed)
      throw new OperationError(
        404,
        "repo_not_found",
        `No repository ${input.owner}/${input.repo} was found.`,
      );
    name = renamed;
  }
  metrics.count("do.request", { class: "RepoDO", method: "updateSettings" });
  const result = await stub.updateSettings({
    name,
    ...(input.description !== undefined && { description: input.description || null }),
    ...(input.default_branch !== undefined && { defaultBranch: input.default_branch }),
    actor: { principal: auth.principalId, tokenId: auth.id, via: "api" },
  });
  if (!result.ok && (result.code === "repo_deleted" || result.code === "access_lost"))
    throw new OperationError(
      404,
      "repo_not_found",
      `No repository ${input.owner}/${input.repo} was found.`,
    );
  if (!result.ok) throw branchNotFound(input.default_branch ?? "");
  // Last: a refused update (a missing branch, access lost) leaves the flag as it was.
  let isTemplate = entry.isTemplate;
  if (input.is_template !== undefined) {
    const set = await setTemplate(env, { ...entry, name: name.value }, input.is_template, {
      actorId: auth.principalId,
      requestId: ctx.requestId,
      metrics,
    });
    if (set === undefined)
      throw new OperationError(
        404,
        "repo_not_found",
        `No repository ${input.owner}/${input.repo} was found.`,
      );
    isTemplate = set;
  }
  const parents = await visibleParents(env, auth, [entry], metrics);
  const stars = await starCounts(env, [entry.id], metrics);
  return repoOutput(
    { ...entry, name: name.value, nameGen: name.gen, isTemplate },
    {
      stars: stars.get(entry.id) ?? 0,
      defaultBranch: defaultBranchOf(result.details.headTarget),
      description: result.details.description,
      parentVisible: parents.has(entry.parentId ?? ""),
    },
  );
}
