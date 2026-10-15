import {
  NO_RIGHTS,
  PERMISSION_NAMES,
  type Permission,
  PRINCIPAL_TYPES,
  type PrincipalType,
  permissionDef,
  REPO_ROLES,
  type RepoRole,
  type Rights,
} from "@fyrden/domain";

/** One kind of holder: no rights, one repository role, an account member or owner, an instance administrator. */
export type Holder = "none" | RepoRole | "account-member" | "account-owner" | "instance-admin";

export const HOLDERS: readonly Holder[] = [
  "none",
  ...REPO_ROLES,
  "account-member",
  "account-owner",
  "instance-admin",
];

export function rightsOf(holder: Holder): Rights {
  if (holder === "none") return NO_RIGHTS;
  if (holder === "account-member") return { ...NO_RIGHTS, accountRole: "member" };
  if (holder === "account-owner") return { ...NO_RIGHTS, accountRole: "owner" };
  if (holder === "instance-admin") return { ...NO_RIGHTS, isInstanceAdmin: true };
  return { ...NO_RIGHTS, repoRole: holder };
}

export interface AuthzCell {
  actorType: PrincipalType;
  holder: Holder;
  permission: Permission;
  /** Whether a token without scopes or a repository list may do it. */
  allow: boolean;
}

function holderGrants(holder: Holder, permission: Permission): boolean {
  const def = permissionDef(permission);
  if (def.resource === "instance") return holder === "instance-admin";
  if (def.resource === "account")
    return (
      holder === "account-owner" || (holder === "account-member" && def.minAccountRole === "member")
    );
  const roles: readonly string[] = REPO_ROLES;
  return roles.indexOf(holder) >= roles.indexOf(def.minRole);
}

/**
 * Every (principal type × holder × permission) cell with its expected
 * outcome, read straight from the permission table, for tests that run
 * each cell against the evaluator.
 */
export function authzMatrix(): AuthzCell[] {
  const cells: AuthzCell[] = [];
  for (const actorType of PRINCIPAL_TYPES)
    for (const holder of HOLDERS)
      for (const permission of PERMISSION_NAMES) {
        const allow =
          permissionDef(permission).principals.includes(actorType) &&
          holderGrants(holder, permission);
        cells.push({ actorType, holder, permission, allow });
      }
  return cells;
}
