import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { createRepo, getRepo, Input, Output } from "@fyrden/api-contract";
import { expiryProblem } from "@fyrden/domain";
import { actingRoleIn, canUseAccount } from "../accounts/account.js";
import { accountLimits } from "../accounts/quotas.js";
import { allocateEpoch } from "../events/epochs.js";
import { DEFAULT_ORG_SHARD } from "../events/read-model.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { afterPublication } from "../search/published.js";
import { clock, newId } from "../services.js";
import { agentRepoLimits } from "./agent-limits.js";
import {
  agentRepoQuotaError,
  checkNewRepo,
  forgetResolved,
  heldBack,
  INITIAL_BRANCH,
  type NewRepoRow,
  nameTakenError,
  newRepoStatements,
  ownerGoneError,
  publishHooks,
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
    /** The agents acting for the owner, the current one first (its audit row names them). */
    readonly act?: readonly string[];
    /** The agent creating it for its owner, and that agent's limit. */
    readonly createdBy?: NewRepoRow["createdBy"];
  },
): Promise<Output<typeof getRepo>> {
  const { metrics } = request;
  const expiresAt = request.expiresAt ?? null;
  metrics.count("do.request", { class: "OrgDO", method: "defaultLabels" });
  const [{ maxRepos }, labels] = await Promise.all([
    accountLimits(env, owner.id, metrics),
    env.ORG.getByName(owner.id).defaultLabels(),
  ]);
  await checkNewRepo(env, owner, name, maxRepos, metrics, request.createdBy);

  const id = newId("rep");
  const networkId = newId("net");
  const epochGen = await allocateEpoch(env.DIRECTORY, id, metrics);
  const storageAt = clock();
  metrics.count("do.request", { class: "RepoDO", method: "initGitStorage" });
  const init = await env.REPO.getByName(id).initGitStorage(
    networkId,
    `refs/heads/${INITIAL_BRANCH}`,
    { ownerId: owner.id, name, visibility: "private", epochGen, actor: request.actorId },
    request.templateId,
    labels,
  );
  if (!init.ok) throw new Error(`initializing repository storage failed: ${init.error}`);

  const now = clock();
  const db = env.DIRECTORY;
  metrics.count("d1.query", { db: "directory", op: "repo_create" }, 4);
  let refused: ReturnType<typeof heldBack>;
  await publishHooks.before?.();
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
            createdBy: request.createdBy ?? null,
          },
          {
            actorId: request.actorId,
            ...(request.requestId ? { requestId: request.requestId } : {}),
            action: "repo.create",
            details: { name, owner_id: owner.id },
            ...(request.act && { act: request.act }),
          },
          maxRepos,
        ),
      ),
      request.createdBy?.maxRepos,
    );
  } catch (error) {
    // Lost a race with another create of the same name.
    if (error instanceof Error && UNIQUE_VIOLATION.test(error.message))
      throw nameTakenError(owner.handle, name);
    throw error;
  }
  // Lost a race with another create of the name or of the last repository the
  // quota allows; the new object stays unreachable and empty.
  if (refused === "owner_gone") throw ownerGoneError(owner.handle);
  if (refused === "name_taken") throw nameTakenError(owner.handle, name);
  if (refused === "agent_quota_exceeded")
    throw agentRepoQuotaError(request.createdBy?.maxRepos ?? 0);
  if (refused) throw repoQuotaError(owner.handle, maxRepos);
  // The name may have redirected to another repository here.
  forgetResolved(owner.handle, name);
  await afterPublication(env, { id, shard: DEFAULT_ORG_SHARD, storageAt }, metrics);
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

/** Who makes a new repository of the caller's own, and on what terms (see `ownNewRepo`). */
export interface OwnNewRepo {
  readonly owner: { readonly id: string; readonly handle: string };
  readonly actorId: string;
  readonly act?: readonly string[];
  readonly grantId?: string;
  readonly expiresAt: number | null;
  readonly createdBy?: NewRepoRow["createdBy"];
}

/**
 * A new repository of the caller's own (made or forked): the caller's. An
 * agent makes one only acting for a user under a grant: in the user's
 * account, within the rights of every acting agent's owner, expiring after
 * the agents' default unless it says when, and within its own limit.
 */
export async function ownNewRepo(
  ctx: OpContext,
  expiresAt: number | undefined,
): Promise<OwnNewRepo> {
  const { env, auth, metrics } = ctx;
  const owner = { id: auth.principalId, handle: auth.principalHandle ?? "" };
  if (auth.principalType !== "agent")
    return { owner, actorId: auth.principalId, expiresAt: checkedExpiry(expiresAt) };
  const agentId = auth.act[0];
  if (auth.grantId === null || agentId === undefined)
    throw new OperationError(
      403,
      "forbidden",
      "An agent creates repositories acting for a user, under a delegation grant (exchange its token at /oauth/token).",
    );
  // Its token could never reach the new repository.
  if (auth.repoIds !== null)
    throw new OperationError(
      403,
      "forbidden",
      "A token limited to repositories cannot create repositories (it could not reach the new one).",
    );
  const role = await actingRoleIn(env, { ...owner, type: "user" }, auth, metrics);
  if (!canUseAccount(auth, role, "repos:create"))
    throw new OperationError(
      403,
      "forbidden",
      `You may not create repositories for ${owner.handle}.`,
    );
  const limits = agentRepoLimits(env);
  return {
    owner,
    actorId: agentId,
    act: auth.act,
    grantId: auth.grantId,
    expiresAt: expiresAt === undefined ? clock() + limits.ttlMs : checkedExpiry(expiresAt),
    createdBy: { agentId, maxRepos: limits.maxRepos },
  };
}

/** The `repos.create` operation: a repository of the caller's own (see `ownNewRepo`). */
export async function createOwnRepoOperation(
  ctx: OpContext,
  input: Input<typeof createRepo>,
): Promise<Output<typeof createRepo>> {
  const made = await ownNewRepo(ctx, input.expires_at);
  return createRepository(ctx.env, made.owner, input.name, {
    actorId: made.actorId,
    ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
    metrics: ctx.metrics,
    expiresAt: made.expiresAt,
    ...(made.act && { act: made.act }),
    ...(made.createdBy && { createdBy: made.createdBy }),
  });
}
