import type { PrincipalType } from "../principals/principal.js";
import {
  AUTHENTICATED,
  isPermission,
  type Permission,
  type PermissionDef,
  permissionDef,
  scopesAllow,
} from "./permissions.js";
import { atLeast, atLeastInAccount, type OrgRole, type RepoRole } from "./roles.js";

/** What one principal holds where a request applies. */
export interface Rights {
  isInstanceAdmin: boolean;
  /**
   * Its role in the account the request targets: `owner` of its own
   * namespace or of an organization, `member` of an organization; null for none.
   */
  accountRole: OrgRole | null;
  /** Its role on the repository the request targets; null for none. */
  repoRole: RepoRole | null;
}

export const NO_RIGHTS: Rights = Object.freeze({
  isInstanceAdmin: false,
  accountRole: null,
  repoRole: null,
});

export interface AuthzRequest {
  permission: Permission;
  /**
   * The principal making the call: for an agent acting for a user, the
   * agent. Principal-type rules apply to it, never to the user.
   */
  actorType: PrincipalType;
  /** Rights the request uses: the token's principal's, or those of the user or org an agent acts for. */
  rights: Rights;
  /**
   * Rights that cap the request, each of which must allow it too: an
   * agent's owner (an agent never exceeds its owner), and every principal
   * of a delegation chain.
   */
  ceilings?: readonly Rights[];
  token: { scopes: readonly string[]; repoIds: readonly string[] | null };
  /** The repository a repository permission is checked against. */
  repoId?: string;
}

export type DenyReason =
  | "unknown_permission"
  | "principal_type"
  | "scope"
  | "no_repo"
  | "repo_not_in_token"
  | "rights"
  | "ceiling";

export type Decision = { allow: true } | { allow: false; reason: DenyReason };

const ALLOW: Decision = Object.freeze({ allow: true });
const deny = (reason: DenyReason): Decision => ({ allow: false, reason });

function holds(rights: Rights, def: PermissionDef): boolean {
  switch (def.resource) {
    case "instance":
      return rights.isInstanceAdmin;
    case "account":
      return atLeastInAccount(rights.accountRole, def.minAccountRole);
    case "repo":
      return atLeast(rights.repoRole, def.minRole);
  }
}

/** The checks that need no resource: the permission exists, the actor's type may hold it, the token's scopes allow it. */
function tokenMayUse(
  permission: Permission,
  actorType: PrincipalType,
  scopes: readonly string[],
): Decision {
  if (!isPermission(permission)) return deny("unknown_permission");
  if (!permissionDef(permission).principals.includes(actorType)) return deny("principal_type");
  if (!scopesAllow(scopes, permission)) return deny("scope");
  return ALLOW;
}

/**
 * Whether a request is allowed: the intersection of the actor's principal
 * type, the token's scopes and repository list, the rights used, and every
 * ceiling. Each layer can only take permissions away.
 */
export function evaluate(request: AuthzRequest): Decision {
  const { permission, token } = request;
  const first = tokenMayUse(permission, request.actorType, token.scopes);
  if (!first.allow) return first;
  const def = permissionDef(permission);
  if (def.resource === "repo") {
    if (request.repoId === undefined) return deny("no_repo");
    if (token.repoIds !== null && !token.repoIds.includes(request.repoId))
      return deny("repo_not_in_token");
  }
  if (!holds(request.rights, def)) return deny("rights");
  for (const ceiling of request.ceilings ?? []) if (!holds(ceiling, def)) return deny("ceiling");
  return ALLOW;
}

export interface Caller {
  actorType: PrincipalType;
  isInstanceAdmin: boolean;
  scopes: readonly string[];
}

/**
 * The check an operation's declared permission gets before its handler runs,
 * when the resource is not known yet. Instance permissions are checked
 * completely. Account and repository permissions are checked for principal
 * type and scopes only; the handler checks them again, completely, once it
 * has resolved the account or repository.
 */
export function checkOperation(
  permission: Permission | typeof AUTHENTICATED,
  caller: Caller,
): Decision {
  if (permission === AUTHENTICATED) return ALLOW;
  const first = tokenMayUse(permission, caller.actorType, caller.scopes);
  if (!first.allow) return first;
  if (permissionDef(permission).resource !== "instance") return ALLOW;
  return caller.isInstanceAdmin ? ALLOW : deny("rights");
}
