import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { getRepo, Output } from "@fyrden/api-contract";
import { expiryProblem } from "@fyrden/domain";
import { accountLimits } from "../accounts/quotas.js";
import { allocateEpoch } from "../events/epochs.js";
import { DEFAULT_ORG_SHARD } from "../events/read-model.js";
import { OperationError } from "../ops/execute.js";
import { clock, newId } from "../services.js";
import {
  checkNewRepo,
  forgetResolved,
  heldBack,
  INITIAL_BRANCH,
  nameTakenError,
  newRepoStatements,
  repoQuotaError,
} from "./directory.js";
import { repoOutput } from "./output.js";

/** An expiry a request gives, checked against the clock; null without one. */
export function checkedExpiry(expiresAt: number | undefined): number | null {
  if (expiresAt === undefined) return null;
  const problem = expiryProblem(expiresAt, clock());
  if (problem) throw new OperationError(422, "invalid_expiry", problem);
  return expiresAt;
}

// D1 reports a unique-index violation in the error message.
const UNIQUE_VIOLATION = /UNIQUE constraint failed/i;

/**
 * Creates an empty private repository owned by `owner` (a user, or an
 * organization). Storage first: if the directory insert then fails, the new
 * object is unreachable and empty, never a listed repository without
 * storage.
 */
export async function createRepository(
  env: Env,
  owner: { readonly id: string; readonly handle: string },
  name: string,
  request: {
    readonly actorId: string;
    readonly requestId?: string;
    readonly metrics: Metrics;
    /** The template it will be generated from: it takes no other write until then. */
    readonly templateId?: string;
    /** When it is deleted (Unix ms, checked by `checkedExpiry`); null to keep it. */
    readonly expiresAt?: number | null;
  },
): Promise<Output<typeof getRepo>> {
  const { metrics } = request;
  const expiresAt = request.expiresAt ?? null;
  const { maxRepos } = await accountLimits(env, owner.id, metrics);
  await checkNewRepo(env, owner, name, maxRepos, metrics);

  const id = newId("rep");
  const networkId = newId("net");
  const epochGen = await allocateEpoch(env.DIRECTORY, id, metrics);
  metrics.count("do.request", { class: "RepoDO", method: "initGitStorage" });
  const init = await env.REPO.getByName(id).initGitStorage(
    networkId,
    `refs/heads/${INITIAL_BRANCH}`,
    { ownerId: owner.id, name, visibility: "private", epochGen, actor: request.actorId },
    request.templateId,
  );
  if (!init.ok) throw new Error(`initializing repository storage failed: ${init.error}`);

  const now = clock();
  const db = env.DIRECTORY;
  metrics.count("d1.query", { db: "directory", op: "repo_create" }, 4);
  let refused: ReturnType<typeof heldBack>;
  try {
    refused = heldBack(
      await db.batch(
        newRepoStatements(
          db,
          {
            id,
            ownerId: owner.id,
            name,
            networkId,
            orgShard: DEFAULT_ORG_SHARD,
            visibility: "private",
            parentId: null,
            expiresAt,
            now,
            generatingSince: request.templateId === undefined ? null : now,
          },
          {
            actorId: request.actorId,
            ...(request.requestId ? { requestId: request.requestId } : {}),
            action: "repo.create",
            details: { name, owner_id: owner.id },
          },
          maxRepos,
        ),
      ),
    );
  } catch (error) {
    // Lost a race with another create of the same name.
    if (error instanceof Error && UNIQUE_VIOLATION.test(error.message))
      throw nameTakenError(owner.handle, name);
    throw error;
  }
  // Lost a race with another create of the name or of the last repository the
  // quota allows; the new object stays unreachable and empty.
  if (refused === "name_taken") throw nameTakenError(owner.handle, name);
  if (refused) throw repoQuotaError(owner.handle, maxRepos);
  // The name may have redirected to another repository here.
  forgetResolved(owner.handle, name);
  return repoOutput(
    {
      id,
      ownerId: owner.id,
      ownerHandle: owner.handle,
      name,
      networkId,
      visibility: "private",
      createdAt: now,
      nameGen: 0,
      parentId: null,
      isTemplate: false,
      expiresAt,
    },
    { defaultBranch: INITIAL_BRANCH, description: null, stars: 0 },
  );
}
