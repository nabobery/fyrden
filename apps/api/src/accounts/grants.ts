import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type {
  createTeam,
  Input,
  listCollaborators,
  listTeams,
  Output,
  removeCollaborator,
  removeTeamMembership,
  removeTeamRepo,
  setCollaborator,
  setTeamMembership,
  setTeamRepo,
} from "@fyrden/api-contract";
import { isValidHandle, type RepoRole } from "@fyrden/domain";
import { allocateEpoch } from "../events/epochs.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { ownershipChange, type RepoEntry, resolveRepo } from "../repos/directory.js";
import { applied, invalidateChange, orgFor, userFor } from "./account.js";

type PermissionName = "pull" | "triage" | "push" | "maintain" | "admin";

/** GitHub's role names and ours. */
const ROLE_OF: Record<PermissionName, RepoRole> = {
  pull: "read",
  triage: "triage",
  push: "write",
  maintain: "maintain",
  admin: "admin",
};
const NAME_OF = Object.fromEntries(
  Object.entries(ROLE_OF).map(([name, role]) => [role, name]),
) as Record<RepoRole, PermissionName>;

const fullName = (repo: RepoEntry) => `${repo.ownerHandle}/${repo.name}`;

/**
 * Refuses a grant change made by an agent acting for a user (it may not
 * widen who has access for the user), while a transfer moves the
 * repository (the accounts hand its grants over then; a change in between
 * would be lost or undone), or once it belongs to another owner than the
 * one found.
 */
async function checkOwnership(ctx: OpContext, repo: RepoEntry): Promise<void> {
  if (ctx.auth.act.length > 0)
    throw new OperationError(
      403,
      "delegated_token",
      "A token issued under a delegation grant cannot change who has access.",
    );
  const change = await ownershipChange(ctx.env, repo.id, repo.ownerId, ctx.metrics);
  if (change === "transferring")
    throw new OperationError(
      409,
      "repo_transferring",
      "The repository is being transferred; change its access once it lands.",
    );
  if (change === "moved")
    throw new OperationError(404, "repo_not_found", `No repository ${fullName(repo)} was found.`);
}

/**
 * The repository's account object, recorded if it is a user's that nothing
 * needed before (an organization's is recorded when it is created).
 */
function accountOf(ctx: OpContext, repo: RepoEntry) {
  return recordedAccount(ctx.env, { id: repo.ownerId, handle: repo.ownerHandle }, ctx.metrics);
}

/** An account's object, recorded first if it is a user's that nothing needed before. */
export async function recordedAccount(
  env: Env,
  account: { readonly id: string; readonly handle: string },
  metrics?: Metrics,
) {
  const stub = env.ORG.getByName(account.id);
  metrics?.count("do.request", { class: "OrgDO", method: "isRecorded" });
  if (!(await stub.isRecorded())) {
    const epochGen = await allocateEpoch(env.DIRECTORY, account.id, metrics);
    const init = await stub.init({
      accountId: account.id,
      kind: "user",
      owner: { id: account.id, handle: account.handle },
      epochGen,
    });
    if (!init.ok) throw new Error(`recording the account failed: ${init.error}`);
  }
  return stub;
}

/** The `repos.collaborators.set` operation: the account object checks the caller administers the repository. */
export async function setCollaboratorOperation(
  ctx: OpContext,
  input: Input<typeof setCollaborator>,
): Promise<Output<typeof setCollaborator>> {
  const repo = await repoFor(ctx, input.owner, input.repo, "administration:write");
  const user = await userFor(ctx, input.username);
  await checkOwnership(ctx, repo);
  const stub = await accountOf(ctx, repo);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "setCollaborator" });
  const change = applied(
    await stub.setCollaborator(
      { principalId: ctx.auth.principalId, requestId: ctx.requestId },
      repo.id,
      { id: user.id, handle: user.handle },
      ROLE_OF[input.permission],
    ),
  );
  ctx.waitUntil(stub.deliverAudit());
  await invalidateChange(ctx.env, repo.ownerId, change, ctx.metrics);
  return { repo: fullName(repo), user: user.handle, permission: input.permission };
}

/** The `repos.collaborators.remove` operation; removing one who is not a collaborator answers the same. */
export async function removeCollaboratorOperation(
  ctx: OpContext,
  input: Input<typeof removeCollaborator>,
): Promise<Output<typeof removeCollaborator>> {
  const repo = await repoFor(ctx, input.owner, input.repo, "administration:write");
  const user = await userFor(ctx, input.username, true);
  await checkOwnership(ctx, repo);
  const stub = await accountOf(ctx, repo);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "removeCollaborator" });
  const change = applied(
    await stub.removeCollaborator(
      { principalId: ctx.auth.principalId, requestId: ctx.requestId },
      repo.id,
      user.id,
    ),
  );
  ctx.waitUntil(stub.deliverAudit());
  await invalidateChange(ctx.env, repo.ownerId, change, ctx.metrics);
  return { repo: fullName(repo), user: user.handle, state: "removed" };
}

/** The `repos.collaborators.list` operation. */
export async function listCollaboratorsOperation(
  ctx: OpContext,
  input: Input<typeof listCollaborators>,
): Promise<Output<typeof listCollaborators>> {
  const repo = await repoFor(ctx, input.owner, input.repo, "metadata:read");
  const after = decodeCursor(input.cursor, isValidHandle);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "collaborators" });
  const rows = await ctx.env.ORG.getByName(repo.ownerId).collaborators(
    repo.id,
    after,
    input.per_page + 1,
  );
  const page = rows.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    collaborators: page.map((c) => ({ id: c.id, login: c.handle, permission: NAME_OF[c.role] })),
    next_cursor: rows.length > input.per_page && last ? encodeCursor(last.handle) : null,
  };
}

/** A team's slug from its name: lowercase letters and digits, other runs as one hyphen. */
export function teamSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/, "");
}

/** The `orgs.teams.create` operation. */
export async function createTeamOperation(
  ctx: OpContext,
  input: Input<typeof createTeam>,
): Promise<Output<typeof createTeam>> {
  const org = await orgFor(ctx, input.org, "members:write");
  const slug = teamSlug(input.name);
  if (!slug)
    throw new OperationError(422, "invalid_name", "A team's name needs a letter or a digit.");
  const stub = ctx.env.ORG.getByName(org.id);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "createTeam" });
  applied(
    await stub.createTeam(
      { principalId: ctx.auth.principalId, requestId: ctx.requestId },
      slug,
      input.name,
    ),
  );
  ctx.waitUntil(stub.deliverAudit());
  return { slug, name: input.name };
}

/** The `orgs.teams.list` operation. */
export async function listTeamsOperation(
  ctx: OpContext,
  input: Input<typeof listTeams>,
): Promise<Output<typeof listTeams>> {
  const org = await orgFor(ctx, input.org, "members:read");
  const after = decodeCursor(input.cursor, (slug) => teamSlug(slug) === slug && slug !== "");
  ctx.metrics.count("do.request", { class: "OrgDO", method: "teams" });
  const rows = await ctx.env.ORG.getByName(org.id).teams(after, input.per_page + 1);
  const page = rows.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    teams: page,
    next_cursor: rows.length > input.per_page && last ? encodeCursor(last.slug) : null,
  };
}

/** The `orgs.teams.memberships.set` operation. */
export async function setTeamMembershipOperation(
  ctx: OpContext,
  input: Input<typeof setTeamMembership>,
): Promise<Output<typeof setTeamMembership>> {
  const org = await orgFor(ctx, input.org, "members:write");
  const user = await userFor(ctx, input.username);
  const stub = ctx.env.ORG.getByName(org.id);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "setTeamMember" });
  const change = applied(
    await stub.setTeamMember(
      { principalId: ctx.auth.principalId, requestId: ctx.requestId },
      input.team_slug,
      user.id,
    ),
  );
  ctx.waitUntil(stub.deliverAudit());
  await invalidateChange(ctx.env, org.id, change, ctx.metrics);
  return { team: input.team_slug, user: user.handle, state: "active" };
}

/** The `orgs.teams.memberships.remove` operation. */
export async function removeTeamMembershipOperation(
  ctx: OpContext,
  input: Input<typeof removeTeamMembership>,
): Promise<Output<typeof removeTeamMembership>> {
  const org = await orgFor(ctx, input.org, "members:write");
  const user = await userFor(ctx, input.username, true);
  const stub = ctx.env.ORG.getByName(org.id);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "removeTeamMember" });
  const change = applied(
    await stub.removeTeamMember(
      { principalId: ctx.auth.principalId, requestId: ctx.requestId },
      input.team_slug,
      user.id,
    ),
  );
  ctx.waitUntil(stub.deliverAudit());
  await invalidateChange(ctx.env, org.id, change, ctx.metrics);
  return { team: input.team_slug, user: user.handle, state: "removed" };
}

/**
 * One of `org`'s repositories, or 404: another account's is not named, nor
 * one the token is not restricted to (the operation's permission is the
 * organization's, so the token's repository list is checked here).
 */
async function orgRepo(ctx: OpContext, orgId: string, owner: string, name: string) {
  const repo = await resolveRepo(ctx.env, owner, name, {
    consistency: "primary",
    metrics: ctx.metrics,
  });
  if (
    !repo ||
    repo.ownerId !== orgId ||
    (ctx.auth.repoIds !== null && !ctx.auth.repoIds.includes(repo.id))
  )
    throw new OperationError(404, "repo_not_found", `No repository ${owner}/${name} was found.`);
  return repo;
}

/** The `orgs.teams.repos.set` operation. */
export async function setTeamRepoOperation(
  ctx: OpContext,
  input: Input<typeof setTeamRepo>,
): Promise<Output<typeof setTeamRepo>> {
  const org = await orgFor(ctx, input.org, "members:write");
  const repo = await orgRepo(ctx, org.id, input.owner, input.repo);
  await checkOwnership(ctx, repo);
  const stub = ctx.env.ORG.getByName(org.id);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "setTeamRepo" });
  const change = applied(
    await stub.setTeamRepo(
      { principalId: ctx.auth.principalId, requestId: ctx.requestId },
      input.team_slug,
      repo.id,
      ROLE_OF[input.permission],
    ),
  );
  ctx.waitUntil(stub.deliverAudit());
  await invalidateChange(ctx.env, org.id, change, ctx.metrics);
  return { team: input.team_slug, repo: fullName(repo), permission: input.permission };
}

/** The `orgs.teams.repos.remove` operation. */
export async function removeTeamRepoOperation(
  ctx: OpContext,
  input: Input<typeof removeTeamRepo>,
): Promise<Output<typeof removeTeamRepo>> {
  const org = await orgFor(ctx, input.org, "members:write");
  const repo = await orgRepo(ctx, org.id, input.owner, input.repo);
  await checkOwnership(ctx, repo);
  const stub = ctx.env.ORG.getByName(org.id);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "removeTeamRepo" });
  const change = applied(
    await stub.removeTeamRepo(
      { principalId: ctx.auth.principalId, requestId: ctx.requestId },
      input.team_slug,
      repo.id,
    ),
  );
  ctx.waitUntil(stub.deliverAudit());
  await invalidateChange(ctx.env, org.id, change, ctx.metrics);
  return { team: input.team_slug, repo: fullName(repo), state: "removed" };
}
