import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import { TokenCache } from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { REPO_NAME_PATTERN } from "@fyrden/api-contract";
import { evaluate, isValidHandle, type RepoPermission } from "@fyrden/domain";
import { clock } from "../services.js";

/** A name `repos.create` would accept; anything else cannot exist. */
export function isValidRepoName(name: string): boolean {
  return REPO_NAME_PATTERN.test(name);
}

/** A row of the repo directory, with the owner's handle. */
export interface RepoEntry {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerHandle: string;
  readonly name: string;
  readonly networkId: string;
  readonly visibility: "public" | "internal" | "private";
  readonly createdAt: number;
}

type Row = {
  id: string;
  owner_id: string;
  handle: string;
  name: string;
  network_id: string;
  visibility: RepoEntry["visibility"];
  created_at: number;
};

// Found repositories, per isolate, for 30 s (the token cache's bound). A
// rename or transfer (not built yet) must take effect within that bound.
const found = new TokenCache<RepoEntry>(clock);

const cacheKey = (owner: string, name: string) => `${owner.toLowerCase()}/${name.toLowerCase()}`;

/**
 * Resolves `owner/name` to its active repository; names compare ignoring
 * case, as handles and repo names do. `consistency: "primary"` reads the
 * D1 primary and skips the cache (writes, and checks right after a create);
 * otherwise a cached or replica answer is used, falling back to the primary
 * on a miss so a repository created a moment ago is found.
 */
export async function resolveRepo(
  env: Env,
  owner: string,
  name: string,
  options: { consistency?: "primary" | "cached"; metrics?: Metrics } = {},
): Promise<RepoEntry | undefined> {
  if (!isValidHandle(owner) || !isValidRepoName(name)) return undefined;
  const key = cacheKey(owner, name);
  const primary = options.consistency === "primary";
  if (!primary) {
    const cached = found.get(key);
    if (cached) return cached;
  }
  const lookup = async (session: D1DatabaseSession) => {
    options.metrics?.count("d1.query", { db: "directory", op: "repo_resolve" });
    return session
      .prepare(
        `SELECT r.id, r.owner_id, p.handle, r.name, r.network_id, r.visibility, r.created_at
         FROM repos r JOIN principals p ON p.id = r.owner_id
         WHERE p.handle = ? COLLATE NOCASE AND r.name = ? COLLATE NOCASE
           AND r.state = 'active' AND p.disabled_at IS NULL`,
      )
      .bind(owner, name)
      .first<Row>();
  };
  const checkedAt = clock();
  let row = primary ? null : await lookup(env.DIRECTORY.withSession());
  row ??= await lookup(env.DIRECTORY.withSession("first-primary"));
  if (!row) return undefined;
  const entry: RepoEntry = {
    id: row.id,
    ownerId: row.owner_id,
    ownerHandle: row.handle,
    name: row.name,
    networkId: row.network_id,
    visibility: row.visibility,
    createdAt: row.created_at,
  };
  found.set(key, entry, checkedAt);
  return entry;
}

/** Access git asks for: fetch and clone read the contents, push writes them. */
export type RepoAccess = "read" | "write";

export const GIT_PERMISSION = {
  read: "contents:read",
  write: "contents:write",
} as const satisfies Record<RepoAccess, RepoPermission>;

/**
 * Whether a token may use `permission` on a repository. Until organizations
 * and collaborators exist, a principal's only role is admin of the
 * repositories it owns. Every repository is private for now: there is no
 * anonymous or public read.
 */
export function canAccess(
  auth: Pick<TokenRecord, "principalId" | "principalType" | "scopes" | "repoIds">,
  repo: Pick<RepoEntry, "id" | "ownerId">,
  permission: RepoPermission,
): boolean {
  const owner = auth.principalId === repo.ownerId;
  return evaluate({
    permission,
    actorType: auth.principalType,
    // Instance administration gives no repository role.
    rights: { isInstanceAdmin: false, ownsAccount: owner, repoRole: owner ? "admin" : null },
    token: { scopes: auth.scopes, repoIds: auth.repoIds },
    repoId: repo.id,
  }).allow;
}

/** Every repository starts with HEAD at this branch; the branch exists after the first push. */
export const INITIAL_BRANCH = "main";

/**
 * The default branch a repository reports: the branch its symbolic HEAD
 * names (an import or a fork takes the source's), or the initial branch
 * when HEAD is unset or names something other than a branch.
 */
export function defaultBranchOf(headTarget: string | null): string {
  const prefix = "refs/heads/";
  return headTarget?.startsWith(prefix) && headTarget.length > prefix.length
    ? headTarget.slice(prefix.length)
    : INITIAL_BRANCH;
}
