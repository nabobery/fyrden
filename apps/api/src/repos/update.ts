import type { Input, Output, updateRepo } from "@fyrden/api-contract";
import { repoFor } from "../git/chunked/operations.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { checkedExpiry } from "./create.js";
import {
  defaultBranchOf,
  type RepoEntry,
  renameRepo,
  updateDirectorySettings,
} from "./directory.js";
import { repoOutput, starCounts, visibleParents } from "./output.js";

const branchNotFound = (branch: string) =>
  new OperationError(422, "branch_not_found", `The repository has no branch ${branch}.`);

const transferring = () =>
  new OperationError(
    409,
    "repo_transferring",
    "The repository is being transferred; its settings change once it lands.",
  );

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
  // Checked first, so an invalid expiry changes nothing.
  const expiresAt =
    input.expires_at === undefined || input.expires_at === null
      ? input.expires_at
      : checkedExpiry(input.expires_at);
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
      act: auth.act,
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
    if (renamed === "transferring") throw transferring();
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
    actor: {
      principal: auth.principalId,
      tokenId: auth.id,
      grantId: auth.grantId,
      actChain: auth.act,
      requestId: ctx.requestId ?? null,
      via: "api",
    },
  });
  if (!result.ok && result.code === "repo_transferring") throw transferring();
  if (!result.ok && (result.code === "repo_deleted" || result.code === "access_lost"))
    throw new OperationError(
      404,
      "repo_not_found",
      `No repository ${input.owner}/${input.repo} was found.`,
    );
  if (!result.ok) throw branchNotFound(input.default_branch ?? "");
  // Last: a refused update (a missing branch, access lost) leaves these as they were.
  let settings: Pick<RepoEntry, "isTemplate" | "expiresAt"> = {
    isTemplate: entry.isTemplate,
    expiresAt: entry.expiresAt,
  };
  if (input.is_template !== undefined || expiresAt !== undefined) {
    const updated = await updateDirectorySettings(
      env,
      { ...entry, name: name.value },
      {
        ...(input.is_template !== undefined && { isTemplate: input.is_template }),
        ...(expiresAt !== undefined && { expiresAt }),
      },
      { actorId: auth.principalId, act: auth.act, requestId: ctx.requestId, metrics },
    );
    if (updated === "transferring") throw transferring();
    if (updated === undefined)
      throw new OperationError(
        404,
        "repo_not_found",
        `No repository ${input.owner}/${input.repo} was found.`,
      );
    settings = updated;
  }
  const parents = await visibleParents(env, auth, [entry], metrics);
  const stars = await starCounts(env, [entry.id], metrics);
  return repoOutput(
    { ...entry, name: name.value, nameGen: name.gen, ...settings },
    {
      stars: stars.get(entry.id) ?? 0,
      defaultBranch: defaultBranchOf(result.details.headTarget),
      description: result.details.description,
      parentVisible: parents.has(entry.parentId ?? ""),
    },
  );
}
