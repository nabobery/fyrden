import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { evaluate, isValidHandle, type OrgRole, type Permission } from "@fyrden/domain";
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
 * `principalId`'s role in `account`: a user owns its own account; in an
 * organization, the role its object records (the source of truth).
 */
export async function accountRoleOf(
  env: Env,
  account: Account,
  principalId: string,
  metrics?: Metrics,
): Promise<OrgRole | null> {
  if (account.type === "user") return account.id === principalId ? "owner" : null;
  metrics?.count("do.request", { class: "OrgDO", method: "accountRole" });
  return env.ORG.getByName(account.id).accountRole(principalId);
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
  const role =
    org?.type === "org"
      ? await accountRoleOf(ctx.env, org, ctx.auth.principalId, ctx.metrics)
      : null;
  if (org?.type !== "org" || role === null)
    throw new OperationError(404, "org_not_found", `No organization ${handle} was found.`);
  if (!canUseAccount(ctx.auth, role, permission))
    throw new OperationError(403, "forbidden", `You may not use ${permission} in ${org.handle}.`);
  return org;
}
