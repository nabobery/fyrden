/** Repository roles, weakest first; each can do everything the ones before it can (GitHub's five). */
export const REPO_ROLES = ["read", "triage", "write", "maintain", "admin"] as const;
export type RepoRole = (typeof REPO_ROLES)[number];

/** Organization roles. An owner administers every repository of the organization. */
export const ORG_ROLES = ["member", "owner"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Whether account role `role` is `min` or stronger; no role is never enough. */
export function atLeastInAccount(role: OrgRole | null, min: OrgRole): boolean {
  return role !== null && ORG_ROLES.indexOf(role) >= ORG_ROLES.indexOf(min);
}

/** Whether `role` is `min` or stronger; no role is never enough. */
export function atLeast(role: RepoRole | null, min: RepoRole): boolean {
  return role !== null && REPO_ROLES.indexOf(role) >= REPO_ROLES.indexOf(min);
}

/** The strongest of the roles a principal gets from several sources (direct, team, org); null for none. */
export function strongestRole(roles: Iterable<RepoRole | null>): RepoRole | null {
  let strongest: RepoRole | null = null;
  for (const role of roles) if (role !== null && !atLeast(strongest, role)) strongest = role;
  return strongest;
}

/**
 * The role an organization role gives on each of the organization's
 * repositories: owners administer them, members get the organization's base
 * role (none when the organization sets no base role).
 */
export function orgRepoRole(orgRole: OrgRole | null, baseRole: RepoRole | null): RepoRole | null {
  if (orgRole === "owner") return "admin";
  return orgRole === "member" ? baseRole : null;
}
