import { auditStatement } from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { getRepo, Output } from "@fyrden/api-contract";
import { allocateEpoch } from "../events/epochs.js";
import { DEFAULT_ORG_SHARD } from "../events/read-model.js";
import { OperationError } from "../ops/execute.js";
import { clock, newId } from "../services.js";
import { claimNameStatement, forgetResolved, INITIAL_BRANCH } from "./directory.js";
import { repoOutput } from "./output.js";

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
  request: { readonly actorId: string; readonly requestId?: string; readonly metrics: Metrics },
): Promise<Output<typeof getRepo>> {
  const { metrics } = request;
  const taken = () =>
    new OperationError(
      409,
      "name_taken",
      `${owner.handle} already has a repository named ${name}.`,
    );
  metrics.count("d1.query", { db: "directory", op: "repo_name_check" });
  const existing = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      "SELECT 1 AS one FROM repos WHERE owner_id = ? AND name = ? COLLATE NOCASE AND state <> 'deleted'",
    )
    .bind(owner.id, name)
    .first();
  if (existing) throw taken();

  const id = newId("rep");
  const networkId = newId("net");
  const epochGen = await allocateEpoch(env.DIRECTORY, id, metrics);
  metrics.count("do.request", { class: "RepoDO", method: "initGitStorage" });
  const init = await env.REPO.getByName(id).initGitStorage(
    networkId,
    `refs/heads/${INITIAL_BRANCH}`,
    { ownerId: owner.id, name, visibility: "private", epochGen, actor: request.actorId },
  );
  if (!init.ok) throw new Error(`initializing repository storage failed: ${init.error}`);

  const now = clock();
  const db = env.DIRECTORY;
  metrics.count("d1.query", { db: "directory", op: "repo_create" }, 3);
  try {
    await db.batch([
      claimNameStatement(db, owner.id, name),
      db
        .prepare(
          `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'private', ?, ?)`,
        )
        .bind(id, owner.id, name, networkId, DEFAULT_ORG_SHARD, now, now),
      auditStatement(
        db,
        now,
        {
          actorId: request.actorId,
          ...(request.requestId ? { requestId: request.requestId } : {}),
        },
        "repo.create",
        id,
        { name, owner_id: owner.id },
      ),
    ]);
  } catch (error) {
    // Lost a race with another create of the same name.
    if (error instanceof Error && UNIQUE_VIOLATION.test(error.message)) throw taken();
    throw error;
  }
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
    },
    { defaultBranch: INITIAL_BRANCH, description: null },
  );
}
