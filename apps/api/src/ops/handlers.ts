import { auditStatement } from "@fyrden/adapters-cloudflare/auth";
import { allocateEpoch } from "../events/epochs.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import {
  abortUploadSession,
  completeUploadSession,
  createUploadSession,
  getUploadSession,
} from "../git/chunked/operations.js";
import { getRepoImport, startImport } from "../git/import/operations.js";
import { forkRepoOperation } from "../network/operations.js";
import {
  canAccess,
  claimNameStatement,
  defaultBranchOf,
  forgetResolved,
  INITIAL_BRANCH,
  isValidRepoName,
  listOwnedRepos,
  resolveRepo,
} from "../repos/directory.js";
import { repoOutput } from "../repos/output.js";
import { updateRepoOperation } from "../repos/update.js";
import { clock, newId, tokenStore } from "../services.js";
import { type Handlers, type OpContext, OperationError } from "./execute.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A page cursor: the last name of the page, opaque to clients. */
function encodeCursor(name: string): string {
  return btoa(name).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(cursor: string): string | undefined {
  try {
    const name = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    return isValidRepoName(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

type ProjectedDetails = { default_branch: string | null; description: string | null };

/** The details the read model has for `ids` (a repository not projected yet is absent). */
async function readModelDetails(
  env: Env,
  ids: readonly string[],
  metrics: OpContext["metrics"],
): Promise<Map<string, ProjectedDetails>> {
  if (ids.length === 0) return new Map();
  metrics.count("d1.query", { db: "org", op: "repo_details" });
  const { results } = await readModelFor(env, DEFAULT_ORG_SHARD)
    .prepare(
      `SELECT repo_id, default_branch, description FROM repos
       WHERE repo_id IN (SELECT value FROM json_each(?)) AND deleted = 0`,
    )
    .bind(JSON.stringify(ids))
    .all<ProjectedDetails & { repo_id: string }>();
  return new Map(results.map((row) => [row.repo_id, row]));
}

// D1 reports a unique-index violation in the error message.
const UNIQUE_VIOLATION = /UNIQUE constraint failed/i;

export const handlers: Handlers = {
  "meta.whoami": async ({ auth }) => ({
    id: auth.principalId,
    type: auth.principalType,
    handle: auth.principalHandle,
    is_instance_admin: auth.isInstanceAdmin,
    token: { id: auth.id, type: auth.type, scopes: auth.scopes, expires_at: auth.expiresAt },
  }),

  "admin.users.create": async ({ env, auth, requestId, metrics }, { handle }) => {
    const db = env.DIRECTORY;
    const id = newId("usr");
    const now = clock();
    metrics.count("d1.query", { db: "directory", op: "user_create" }, 2);
    try {
      // The user and its audit row are written together or not at all.
      await db.batch([
        db
          .prepare("INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'user', ?, ?)")
          .bind(id, handle, now),
        auditStatement(db, now, { actorId: auth.principalId, requestId }, "user.create", id, {
          handle,
        }),
      ]);
    } catch (error) {
      // Handles are unique ignoring case, across users, orgs and agents.
      if (error instanceof Error && UNIQUE_VIOLATION.test(error.message))
        throw new OperationError(409, "handle_taken", `The handle ${handle} is already taken.`);
      throw error;
    }
    return { id, handle, type: "user" as const, created_at: now };
  },

  "admin.tokens.create": async (ctx, input) => {
    const { env, auth, requestId, metrics } = ctx;
    // The primary: a user created a moment ago must be found.
    metrics.count("d1.query", { db: "directory", op: "user_lookup" });
    const user = await env.DIRECTORY.withSession("first-primary")
      .prepare("SELECT type, disabled_at FROM principals WHERE id = ?")
      .bind(input.user_id)
      .first<{ type: string; disabled_at: number | null }>();
    if (user?.type !== "user")
      throw new OperationError(404, "user_not_found", `No user has the id ${input.user_id}.`);
    if (user.disabled_at !== null)
      throw new OperationError(409, "user_disabled", "The user is disabled.");

    const store = tokenStore(env, { defer: (p) => ctx.waitUntil(p), metrics });
    const minted = await store.mint({
      principalId: input.user_id,
      type: input.type,
      scopes: input.scopes,
      ttlMs: input.expires_in_days * DAY_MS,
      audit: { actorId: auth.principalId, requestId },
    });
    return {
      id: minted.id,
      token: minted.token,
      type: input.type,
      user_id: input.user_id,
      scopes: input.scopes,
      expires_at: minted.expiresAt,
    };
  },

  "repos.create": async ({ env, auth, requestId, metrics }, { name }) => {
    const db = env.DIRECTORY.withSession("first-primary");
    const taken = () =>
      new OperationError(409, "name_taken", `You already have a repository named ${name}.`);
    metrics.count("d1.query", { db: "directory", op: "repo_name_check" });
    const existing = await db
      .prepare(
        "SELECT 1 AS one FROM repos WHERE owner_id = ? AND name = ? COLLATE NOCASE AND state <> 'deleted'",
      )
      .bind(auth.principalId, name)
      .first();
    if (existing) throw taken();

    // Storage first: if the directory insert then fails, the new object is
    // unreachable and empty, never a listed repository without storage.
    const id = newId("rep");
    const networkId = newId("net");
    const epochGen = await allocateEpoch(env.DIRECTORY, id, metrics);
    const init = await env.REPO.getByName(id).initGitStorage(
      networkId,
      `refs/heads/${INITIAL_BRANCH}`,
      { ownerId: auth.principalId, name, visibility: "private", epochGen, actor: auth.principalId },
    );
    if (!init.ok) throw new Error(`initializing repository storage failed: ${init.error}`);

    const now = clock();
    metrics.count("d1.query", { db: "directory", op: "repo_create" }, 3);
    try {
      await env.DIRECTORY.batch([
        claimNameStatement(env.DIRECTORY, auth.principalId, name),
        env.DIRECTORY.prepare(
          `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'private', ?, ?)`,
        ).bind(id, auth.principalId, name, networkId, DEFAULT_ORG_SHARD, now, now),
        auditStatement(
          env.DIRECTORY,
          now,
          { actorId: auth.principalId, requestId },
          "repo.create",
          id,
          { name },
        ),
      ]);
    } catch (error) {
      // Lost a race with another create of the same name.
      if (error instanceof Error && UNIQUE_VIOLATION.test(error.message)) throw taken();
      throw error;
    }
    // The name may have redirected to another repository here.
    forgetResolved(auth.principalHandle ?? "", name);
    return repoOutput(
      {
        id,
        ownerId: auth.principalId,
        ownerHandle: auth.principalHandle ?? "",
        name,
        networkId,
        visibility: "private",
        createdAt: now,
        nameGen: 0,
      },
      { defaultBranch: INITIAL_BRANCH, description: null },
    );
  },

  "repos.list": async ({ env, auth, metrics }, { per_page, cursor }) => {
    const after = cursor === undefined ? "" : decodeCursor(cursor);
    if (after === undefined)
      throw new OperationError(422, "invalid_cursor", "The cursor is not one this API returned.");
    // Only repositories the token may see are read (its repository list in the
    // query), so a page and its cursor never reveal another one's name. One
    // more than a page tells whether another page follows.
    const scanned = await listOwnedRepos(
      env,
      auth.principalId,
      { after, limit: per_page + 1, onlyIds: auth.repoIds },
      metrics,
    );
    const page = scanned
      .slice(0, per_page)
      .filter((entry) => canAccess(auth, entry, "metadata:read"));
    const projected = await readModelDetails(
      env,
      page.map((entry) => entry.id),
      metrics,
    );
    const last = page.at(-1);
    return {
      repos: page.map((entry) => {
        const details = projected.get(entry.id);
        return repoOutput(entry, {
          defaultBranch: defaultBranchOf(details?.default_branch ?? null),
          description: details?.description ?? null,
        });
      }),
      next_cursor: scanned.length > per_page && last ? encodeCursor(last.name) : null,
    };
  },

  "repos.get": async ({ env, auth, metrics }, { owner, repo }) => {
    const entry = await resolveRepo(env, owner, repo, { metrics });
    // Missing and not visible look the same, so private names do not leak.
    if (!entry || !canAccess(auth, entry, "metadata:read"))
      throw new OperationError(404, "repo_not_found", `No repository ${owner}/${repo} was found.`);
    // HEAD is the repository object's (an import or a fork sets it from its source).
    metrics.count("do.request", { class: "RepoDO", method: "details" });
    const details = await env.REPO.getByName(entry.id).details();
    return repoOutput(entry, {
      defaultBranch: defaultBranchOf(details.headTarget),
      description: details.description,
    });
  },

  "repos.update": updateRepoOperation,

  // Forks share the parent's packs in its fork network (network/).
  "repos.fork": forkRepoOperation,

  // Chunked pack uploads and server-side import (git/chunked, git/import).
  "uploads.create": createUploadSession,
  "uploads.get": getUploadSession,
  "uploads.complete": completeUploadSession,
  "uploads.abort": abortUploadSession,
  "imports.create": startImport,
  "imports.get": getRepoImport,
};
