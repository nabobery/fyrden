import { PRINCIPAL_TYPES, type PrincipalType } from "../principals/principal.js";
import type { OrgRole, RepoRole } from "./roles.js";

/**
 * An operation that only needs an authenticated caller (whoami). Not a
 * permission: no role grants it and no token scope names it.
 */
export const AUTHENTICATED = "authenticated";

interface PermissionBase {
  summary: string;
  /** Principal types that may ever hold it. */
  principals: readonly PrincipalType[];
  /** Permissions that come with it (a write permission includes its read); names from this table. */
  implies: readonly string[];
  /** Granting it lets the holder change state, so checks for it read the primary. */
  writes: boolean;
}

/** Who holds a permission depends on the resource it is checked against. */
export type PermissionDef = PermissionBase &
  (
    | { resource: "instance" } // instance administrators
    | { resource: "account"; minAccountRole: OrgRole } // that role in the account (a user owns its own namespace)
    | { resource: "repo"; minRole: RepoRole } // that role on the repository, or stronger
  );

/**
 * Every permission. Operations, roles, token scopes and the authorization
 * matrix are all checked against this one table. Names follow GitHub's
 * fine-grained token permissions where one exists, so a client written
 * for GitHub reads them without a mapping.
 */
export const PERMISSIONS = {
  "instance:admin": {
    resource: "instance",
    summary: "Administer this instance: create users and mint their tokens.",
    principals: ["user"],
    implies: [],
    writes: true,
  },
  "repos:create": {
    resource: "account",
    // GitHub's default: members of an organization may create its repositories.
    minAccountRole: "member",
    summary: "Create repositories in an account, including forks.",
    principals: PRINCIPAL_TYPES,
    implies: [],
    writes: true,
  },
  "members:read": {
    resource: "account",
    minAccountRole: "member",
    summary: "See an account's quota, and an organization's members and teams.",
    principals: PRINCIPAL_TYPES,
    implies: [],
    writes: false,
  },
  "members:write": {
    resource: "account",
    minAccountRole: "owner",
    summary: "Add and remove an organization's members, and manage its teams.",
    principals: ["user"],
    implies: ["members:read"],
    writes: true,
  },
  "starring:read": {
    resource: "account",
    minAccountRole: "owner",
    summary: "See the repositories the user starred.",
    principals: ["user"],
    implies: [],
    writes: false,
  },
  "starring:write": {
    resource: "account",
    minAccountRole: "owner",
    summary: "Star and unstar repositories as the user.",
    principals: ["user"],
    implies: ["starring:read"],
    writes: true,
  },
  "watching:read": {
    resource: "account",
    minAccountRole: "owner",
    summary: "See the repositories the user (or an agent, itself) watches or ignores.",
    principals: ["user", "agent"],
    implies: [],
    writes: false,
  },
  "watching:write": {
    resource: "account",
    minAccountRole: "owner",
    summary: "Watch, ignore and stop watching repositories as the user (or an agent, itself).",
    principals: ["user", "agent"],
    implies: ["watching:read"],
    writes: true,
  },
  "notifications:read": {
    resource: "account",
    minAccountRole: "owner",
    summary: "See the user's (or an agent's own) notification threads.",
    principals: ["user", "agent"],
    implies: [],
    writes: false,
  },
  "notifications:write": {
    resource: "account",
    minAccountRole: "owner",
    summary: "Mark the user's (or an agent's own) notification threads read or done.",
    principals: ["user", "agent"],
    implies: ["notifications:read"],
    writes: true,
  },
  "ssh_signing_keys:read": {
    resource: "account",
    minAccountRole: "owner",
    summary: "See the SSH keys the user (or an agent, its own) signs commits with.",
    principals: ["user", "agent"],
    implies: [],
    writes: false,
  },
  "ssh_signing_keys:write": {
    resource: "account",
    minAccountRole: "owner",
    summary: "Add and remove the SSH keys the user (or an agent, its own) signs commits with.",
    principals: ["user", "agent"],
    implies: ["ssh_signing_keys:read"],
    writes: true,
  },
  "tokens:read": {
    resource: "account",
    minAccountRole: "owner",
    summary: "See the user's own personal access and git tokens.",
    principals: ["user"],
    implies: [],
    writes: false,
  },
  "tokens:write": {
    resource: "account",
    minAccountRole: "owner",
    summary: "Create and revoke the user's own personal access and git tokens.",
    principals: ["user"],
    implies: ["tokens:read"],
    writes: true,
  },
  "agents:read": {
    resource: "account",
    minAccountRole: "owner",
    summary: "See an account's agents.",
    principals: ["user"],
    implies: [],
    writes: false,
  },
  "agents:write": {
    resource: "account",
    minAccountRole: "owner",
    summary: "Create and disable an account's agents, and mint their tokens.",
    principals: ["user"],
    implies: ["agents:read"],
    writes: true,
  },
  "grants:read": {
    resource: "account",
    minAccountRole: "owner",
    summary: "See the delegation grants the user made, or the agent holds.",
    principals: ["user", "agent"],
    implies: [],
    writes: false,
  },
  "grants:write": {
    resource: "account",
    minAccountRole: "owner",
    summary:
      "Let an agent act for the user (a delegation grant), pass a narrower grant to a sub-agent, and revoke them.",
    principals: ["user", "agent"],
    implies: ["grants:read"],
    writes: true,
  },
  "metadata:read": {
    resource: "repo",
    minRole: "read",
    summary: "See that a repository exists and read its details.",
    principals: PRINCIPAL_TYPES,
    implies: [],
    writes: false,
  },
  "contents:read": {
    resource: "repo",
    minRole: "read",
    summary: "Clone, fetch and read files, uploads and imports.",
    principals: PRINCIPAL_TYPES,
    implies: ["metadata:read"],
    writes: false,
  },
  "contents:write": {
    resource: "repo",
    minRole: "write",
    summary: "Push, upload packs and import into the repository.",
    principals: PRINCIPAL_TYPES,
    implies: ["contents:read"],
    writes: true,
  },
  "pull_requests:read": {
    resource: "repo",
    minRole: "read",
    summary: "Read pull requests.",
    principals: PRINCIPAL_TYPES,
    implies: ["metadata:read"],
    writes: false,
  },
  "pull_requests:write": {
    resource: "repo",
    // Anyone who reads a repository may open pull requests; what it may do
    // to someone else's depends on its role (the pull request matrix).
    minRole: "read",
    summary:
      "Open pull requests, and edit, retarget, close and reopen your own (others' as your role allows).",
    principals: PRINCIPAL_TYPES,
    implies: ["pull_requests:read"],
    writes: true,
  },
  "issues:read": {
    resource: "repo",
    minRole: "read",
    summary: "Read issues.",
    principals: PRINCIPAL_TYPES,
    implies: ["metadata:read"],
    writes: false,
  },
  "issues:write": {
    resource: "repo",
    // Anyone who reads a repository may open issues; what it may do to
    // someone else's depends on its role (the issue matrix).
    minRole: "read",
    summary: "Open issues, and edit, close and reopen your own (others' as your role allows).",
    principals: PRINCIPAL_TYPES,
    implies: ["issues:read"],
    writes: true,
  },
  "administration:write": {
    resource: "repo",
    minRole: "admin",
    summary: "Change settings, visibility and access; delete or transfer the repository.",
    principals: PRINCIPAL_TYPES,
    implies: ["metadata:read"],
    writes: true,
  },
  "repository_hooks:read": {
    resource: "repo",
    minRole: "admin",
    summary: "Read the repository's webhooks and their deliveries.",
    principals: PRINCIPAL_TYPES,
    implies: ["metadata:read"],
    writes: false,
  },
  "repository_hooks:write": {
    resource: "repo",
    minRole: "admin",
    summary: "Create, change, ping and delete the repository's webhooks; rotate their secrets.",
    principals: PRINCIPAL_TYPES,
    implies: ["repository_hooks:read"],
    writes: true,
  },
} as const satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;

/** Permissions checked against one repository. */
export type RepoPermission = {
  [P in Permission]: (typeof PERMISSIONS)[P]["resource"] extends "repo" ? P : never;
}[Permission];

export const PERMISSION_NAMES = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(name: string): name is Permission {
  return Object.hasOwn(PERMISSIONS, name);
}

/** The definition, typed as the union so callers can narrow on `resource`. */
export function permissionDef(permission: Permission): PermissionDef {
  return PERMISSIONS[permission];
}

const closure = new Map<Permission, ReadonlySet<Permission>>();

/** `permission` and everything it implies, transitively. */
export function impliedBy(permission: Permission): ReadonlySet<Permission> {
  let set = closure.get(permission);
  if (!set) {
    const found = new Set<Permission>();
    const visit = (p: Permission) => {
      if (found.has(p)) return;
      found.add(p);
      for (const q of permissionDef(p).implies) if (isPermission(q)) visit(q);
    };
    visit(permission);
    set = found;
    closure.set(permission, set);
  }
  return set;
}

/**
 * Whether a token's scopes allow `permission`: one of them is it or implies
 * it. A token without scopes is not narrowed (it acts with its principal's
 * full rights). A scope this table does not know grants nothing.
 */
export function scopesAllow(scopes: readonly string[], permission: Permission): boolean {
  if (scopes.length === 0) return true;
  return scopes.some((scope) => isPermission(scope) && impliedBy(scope).has(permission));
}
