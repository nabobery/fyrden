import { auditStatement } from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { principalTypeOf } from "@fyrden/domain";
import {
  createAgentOperation,
  createAgentTokenOperation,
  disableAgentOperation,
  getAgentOperation,
  listAgentsOperation,
} from "../accounts/agents.js";
import {
  createGrantOperation,
  listGrantsOperation,
  revokeGrantOperation,
} from "../accounts/delegation.js";
import {
  createTeamOperation,
  listCollaboratorsOperation,
  listTeamsOperation,
  removeCollaboratorOperation,
  removeTeamMembershipOperation,
  removeTeamRepoOperation,
  setCollaboratorOperation,
  setTeamMembershipOperation,
  setTeamRepoOperation,
} from "../accounts/grants.js";
import { createOrgRepoOperation, listOrgReposOperation } from "../accounts/org-repos.js";
import {
  createOrgOperation,
  listMembersOperation,
  removeMembershipOperation,
  setMembershipOperation,
  updateOrgOperation,
} from "../accounts/orgs.js";
import {
  getOrgQuotaOperation,
  getUserQuotaOperation,
  setQuotaOperation,
} from "../accounts/quotas.js";
import {
  createSshSigningKeyOperation,
  deleteSshSigningKeyOperation,
  getSshSigningKeyOperation,
  listSshSigningKeysOperation,
} from "../accounts/signing-keys.js";
import {
  abortUploadSession,
  completeUploadSession,
  createUploadSession,
  getUploadSession,
} from "../git/chunked/operations.js";
import { getRepoImport, startImport } from "../git/import/operations.js";
import { forkRepoOperation, listForksOperation } from "../network/operations.js";
import {
  compareCommitsOperation,
  getArchiveOperation,
  getBranchOperation,
  getCommitOperation,
  getContentsOperation,
  getReadmeOperation,
  getRootContentsOperation,
  getTreeOperation,
  listBranchesOperation,
  listCommitsOperation,
  listTagsOperation,
} from "../repos/browse.js";
import { checkedExpiry, createRepository } from "../repos/create.js";
import { deleteRepoOperation, deleteReposOperation } from "../repos/delete.js";
import { authorize, defaultBranchOf, ownListable, resolveRepo } from "../repos/directory.js";
import {
  createFileCommitOperation,
  deleteContentsOperation,
  putContentsOperation,
} from "../repos/file-writes.js";
import { generateRepoOperation } from "../repos/generate.js";
import { listAccountRepos } from "../repos/listing.js";
import { repoOutput, starCounts, visibleParents } from "../repos/output.js";
import {
  createRulesetOperation,
  deleteRulesetOperation,
  getRulesetOperation,
  listRulesetsOperation,
  updateRulesetOperation,
} from "../repos/rulesets.js";
import { listStarredOperation, starRepoOperation, unstarRepoOperation } from "../repos/stars.js";
import { transferRepoOperation } from "../repos/transfer.js";
import { updateRepoOperation } from "../repos/update.js";
import { clock, newId, tokenStore } from "../services.js";
import { platformKeys } from "../signing/platform-key.js";
import { type Handlers, OperationError } from "./execute.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// D1 reports a unique-index violation in the error message.
const UNIQUE_VIOLATION = /UNIQUE constraint failed/i;

/** The agents of an act chain, in its order, with their handles. */
async function actChainOf(
  env: Env,
  act: readonly string[],
  metrics: Metrics,
): Promise<{ id: string; handle: string | null }[]> {
  if (act.length === 0) return [];
  metrics.count("d1.query", { db: "directory", op: "act_handles" });
  const { results } = await env.DIRECTORY.prepare(
    "SELECT id, handle FROM principals WHERE id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(act))
    .all<{ id: string; handle: string | null }>();
  return act.map((id) => ({ id, handle: results.find((r) => r.id === id)?.handle ?? null }));
}

export const handlers: Handlers = {
  "meta.whoami": async ({ env, auth, metrics }) => ({
    id: auth.principalId,
    // A delegated token's principal is the user acted for; its type is the agent's.
    type: auth.act.length > 0 ? (principalTypeOf(auth.principalId) ?? "user") : auth.principalType,
    handle: auth.principalHandle,
    is_instance_admin: auth.isInstanceAdmin,
    act: await actChainOf(env, auth.act, metrics),
    token: {
      id: auth.id,
      type: auth.type,
      scopes: auth.scopes,
      expires_at: auth.expiresAt,
      grant_id: auth.grantId,
    },
  }),

  "orgs.update": updateOrgOperation,
  "agents.create": createAgentOperation,
  "agents.list": listAgentsOperation,
  "agents.get": getAgentOperation,
  "agents.disable": disableAgentOperation,
  "agents.tokens.create": createAgentTokenOperation,
  "grants.create": createGrantOperation,
  "grants.list": listGrantsOperation,
  "grants.revoke": revokeGrantOperation,

  "meta.signing_keys.list": async ({ env }) => ({
    keys: (await platformKeys(env)).map((k) => ({
      key_id: k.fingerprint,
      key: k.key,
      current: k.current,
    })),
  }),

  "users.ssh_signing_keys.list": listSshSigningKeysOperation,
  "users.ssh_signing_keys.create": createSshSigningKeyOperation,
  "users.ssh_signing_keys.get": getSshSigningKeyOperation,
  "users.ssh_signing_keys.delete": deleteSshSigningKeyOperation,

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

  "repos.create": ({ env, auth, requestId, metrics }, { name, expires_at }) =>
    createRepository(env, { id: auth.principalId, handle: auth.principalHandle ?? "" }, name, {
      actorId: auth.principalId,
      requestId,
      metrics,
      expiresAt: checkedExpiry(expires_at),
    }),

  // A user's own repositories: it administers them all.
  "repos.list": async ({ env, auth, metrics }, { per_page, cursor }) =>
    listAccountRepos(
      env,
      auth,
      { id: auth.principalId, role: "admin" },
      { perPage: per_page, cursor },
      metrics,
      // An agent of another owner acting for the user sees only what its owner's role allows.
      await ownListable(env, auth, metrics),
    ),

  "repos.get": async ({ env, auth, metrics }, { owner, repo }) => {
    const entry = await resolveRepo(env, owner, repo, { metrics });
    // Missing and not visible look the same, so private names do not leak.
    if (!entry || !(await authorize(env, auth, entry, "metadata:read", metrics)))
      throw new OperationError(404, "repo_not_found", `No repository ${owner}/${repo} was found.`);
    // HEAD is the repository object's (an import or a fork sets it from its source).
    metrics.count("do.request", { class: "RepoDO", method: "details" });
    const details = await env.REPO.getByName(entry.id).details();
    const parents = await visibleParents(env, auth, [entry], metrics);
    const stars = await starCounts(env, [entry.id], metrics);
    return repoOutput(entry, {
      defaultBranch: defaultBranchOf(details.headTarget),
      description: details.description,
      parentVisible: parents.has(entry.parentId ?? ""),
      stars: stars.get(entry.id) ?? 0,
    });
  },

  "repos.update": updateRepoOperation,
  "repos.delete": deleteRepoOperation,
  "repos.delete_many": deleteReposOperation,

  "admin.orgs.create": createOrgOperation,
  "orgs.memberships.set": setMembershipOperation,
  "orgs.memberships.remove": removeMembershipOperation,
  "orgs.members.list": listMembersOperation,
  "orgs.repos.create": createOrgRepoOperation,
  "orgs.repos.list": listOrgReposOperation,
  "repos.collaborators.set": setCollaboratorOperation,
  "repos.collaborators.remove": removeCollaboratorOperation,
  "repos.collaborators.list": listCollaboratorsOperation,
  "orgs.teams.create": createTeamOperation,
  "orgs.teams.list": listTeamsOperation,
  "orgs.teams.memberships.set": setTeamMembershipOperation,
  "orgs.teams.memberships.remove": removeTeamMembershipOperation,
  "orgs.teams.repos.set": setTeamRepoOperation,
  "orgs.teams.repos.remove": removeTeamRepoOperation,

  // Forks share the parent's packs in its fork network (network/).
  "repos.fork": forkRepoOperation,
  "repos.forks.list": listForksOperation,
  "repos.generate": generateRepoOperation,
  "repos.transfer": transferRepoOperation,

  // Rulesets live in the repository's object (repos/rulesets).
  "repos.rulesets.list": listRulesetsOperation,
  "repos.rulesets.get": getRulesetOperation,
  "repos.rulesets.create": createRulesetOperation,
  "repos.rulesets.update": updateRulesetOperation,
  "repos.rulesets.delete": deleteRulesetOperation,

  // Stars are the caller's own, of repositories it can read (repos/stars).
  "stars.put": starRepoOperation,
  "stars.delete": unstarRepoOperation,
  "stars.list": listStarredOperation,

  // Quotas live in each account's object (accounts/quotas).
  "quotas.user.get": getUserQuotaOperation,
  "quotas.org.get": getOrgQuotaOperation,
  "admin.quotas.set": setQuotaOperation,

  // Branches, tags, commits and comparisons (repos/browse).
  "repos.branches.list": listBranchesOperation,
  "repos.branches.get": getBranchOperation,
  "repos.tags.list": listTagsOperation,
  "repos.commits.list": listCommitsOperation,
  "repos.commits.get": getCommitOperation,
  "repos.compare": compareCommitsOperation,
  "repos.contents.get": getContentsOperation,
  "repos.contents.root": getRootContentsOperation,
  "repos.readme.get": getReadmeOperation,
  "repos.trees.get": getTreeOperation,
  "repos.archives.get": getArchiveOperation,

  // File writes (repos/file-writes).
  "repos.contents.put": putContentsOperation,
  "repos.contents.delete": deleteContentsOperation,
  "repos.file_commits.create": createFileCommitOperation,

  // Chunked pack uploads and server-side import (git/chunked, git/import).
  "uploads.create": createUploadSession,
  "uploads.get": getUploadSession,
  "uploads.complete": completeUploadSession,
  "uploads.abort": abortUploadSession,
  "imports.create": startImport,
  "imports.get": getRepoImport,
};
