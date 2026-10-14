import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { evaluate, isValidHandle, type OrgRole, type Permission } from "@fyrden/domain";
import type { AclChange } from "../do/OrgDO.js";
import { OperationError } from "../ops/execute.js";

/** A user or an organization: a namespace that owns repositories. */
export interface Account {
  readonly id: string;
  readonly type: "user" | "org";
  readonly handle: string;
}

/**
 * The user or organization with `handle` (ignoring case), from the D1
 * primary; a disabled one only with `includeDisabled` (to remove it from
 * where it still is).
 */
export async function findAccount(
  env: Env,
  handle: string,
  options: { metrics?: Metrics; includeDisabled?: boolean } = {},
): Promise<Account | undefined> {
  if (!isValidHandle(handle)) return undefined;
  options.metrics?.count("d1.query", { db: "directory", op: "account_find" });
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT id, type, handle FROM principals
       WHERE handle = ? COLLATE NOCASE AND type IN ('user', 'org')
         AND (?2 OR disabled_at IS NULL)`,
    )
    .bind(handle, options.includeDisabled ? 1 : 0)
    .first<Account>();
  return row ?? undefined;
}

/**
 * `principalId`'s role in `account`: an account owns itself (a user its own
 * namespace); in an organization, the role its object records (the source
 * of truth).
 */
export async function accountRoleOf(
  env: Env,
  account: Account,
  principalId: string,
  metrics?: Metrics,
): Promise<OrgRole | null> {
  if (account.id === principalId) return "owner";
  if (account.type === "user") return null;
  metrics?.count("do.request", { class: "OrgDO", method: "accountRole" });
  return env.ORG.getByName(account.id).accountRole(principalId);
}

/**
 * The role a token acts with in `account`: its principal's, capped by each
 * acting agent's owner's (an agent never exceeds its owner).
 */
export async function actingRoleIn(
  env: Env,
  account: Account,
  auth: Pick<TokenRecord, "principalId" | "ceilingIds">,
  metrics?: Metrics,
): Promise<OrgRole | null> {
  let role = await accountRoleOf(env, account, auth.principalId, metrics);
  for (const owner of new Set(auth.ceilingIds)) {
    if (role === null) break;
    const ceiling = await accountRoleOf(env, account, owner, metrics);
    role = ceiling === null ? null : role === "owner" && ceiling === "owner" ? "owner" : "member";
  }
  return role;
}

/** Whether a token may use the account permission `permission` with role `role` in the account. */
export function canUseAccount(
  auth: Pick<TokenRecord, "principalType" | "scopes" | "repoIds">,
  role: OrgRole | null,
  permission: Permission,
): boolean {
  return evaluate({
    permission,
    actorType: auth.principalType,
    rights: { isInstanceAdmin: false, accountRole: role, repoRole: null },
    token: { scopes: auth.scopes, repoIds: auth.repoIds },
  }).allow;
}

/**
 * The organization `handle`, if the caller may use `permission` there. An
 * organization the caller does not belong to answers 404, like a missing
 * one; a member without the permission gets 403.
 */
export async function orgFor(
  ctx: { env: Env; auth: TokenRecord; metrics: Metrics },
  handle: string,
  permission: Permission,
): Promise<Account> {
  const org = await findAccount(ctx.env, handle, { metrics: ctx.metrics });
  const role = org?.type === "org" ? await actingRoleIn(ctx.env, org, ctx.auth, ctx.metrics) : null;
  if (org?.type !== "org" || role === null)
    throw new OperationError(404, "org_not_found", `No organization ${handle} was found.`);
  if (!canUseAccount(ctx.auth, role, permission))
    throw new OperationError(403, "forbidden", `You may not use ${permission} in ${org.handle}.`);
  return org;
}

/** Repositories one ACL change tells of its new version at most; the rest catch up within the snapshot window. Proposed. */
export const INVALIDATE_MAX = 100;

/**
 * Tells the account's repositories that ACL `version` (of restore
 * generation `epochGen`) was committed, so
 * they stop using older snapshots at once. Best effort: correctness rests
 * on the snapshot window, so failures are ignored.
 */
export async function invalidateAccountRepos(
  env: Env,
  accountId: string,
  acl: { readonly epochGen: number; readonly version: number },
  metrics?: Metrics,
): Promise<void> {
  metrics?.count("d1.query", { db: "directory", op: "acl_invalidate" });
  // Best effort: the change stands whatever happens here.
  const listed = await env.DIRECTORY.prepare(
    "SELECT id FROM repos WHERE owner_id = ? AND state <> 'deleted' AND state = 'active' LIMIT ?",
  )
    .bind(accountId, INVALIDATE_MAX)
    .all<{ id: string }>()
    .catch(() => undefined);
  if (!listed) return;
  const { results } = listed;
  metrics?.count("do.request", { class: "RepoDO", method: "invalidateAcl" }, results.length);
  await Promise.allSettled(
    results.map(({ id }) =>
      env.REPO.getByName(id).invalidateAcl(accountId, acl.epochGen, acl.version),
    ),
  );
}

/** An account object's answer to a change, as the API answers it. */
export function applied(change: AclChange): Extract<AclChange, { ok: true }> {
  if (change.ok) return change;
  switch (change.code) {
    case "forbidden":
      throw new OperationError(403, change.code, change.error);
    case "not_an_org":
    case "not_recorded":
    case "team_not_found":
      throw new OperationError(404, change.code, change.error);
    case "repo_gone":
      throw new OperationError(404, "repo_not_found", change.error);
    case "not_a_member":
      throw new OperationError(422, change.code, change.error);
    default:
      throw new OperationError(409, change.code, change.error);
  }
}

/**
 * Tells the repositories a change named (or, without a list, the account's)
 * its version, unchanged too: a retry repeats a notice that was lost. Best
 * effort, like `invalidateAccountRepos`.
 */
export function invalidateChange(
  env: Env,
  accountId: string,
  change: Extract<AclChange, { ok: true }>,
  metrics?: Metrics,
): Promise<void> {
  if (change.repos === undefined) return invalidateAccountRepos(env, accountId, change, metrics);
  const ids = change.repos.slice(0, INVALIDATE_MAX);
  metrics?.count("do.request", { class: "RepoDO", method: "invalidateAcl" }, ids.length);
  return Promise.allSettled(
    ids.map((id) =>
      env.REPO.getByName(id).invalidateAcl(accountId, change.epochGen, change.version),
    ),
  ).then(() => undefined);
}

/** The enabled user `handle` (or, with `includeDisabled`, a disabled one), or 404. */
export async function userFor(
  ctx: { env: Env; metrics: Metrics },
  handle: string,
  includeDisabled = false,
): Promise<Account> {
  const user = await findAccount(ctx.env, handle, { metrics: ctx.metrics, includeDisabled });
  if (user?.type !== "user")
    throw new OperationError(404, "user_not_found", `No user ${handle} was found.`);
  return user;
}
