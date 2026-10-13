import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import { TokenCache } from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { REPO_NAME_PATTERN } from "@fyrden/api-contract";
import {
  evaluate,
  isValidHandle,
  ownsUserAccount,
  PERMISSIONS,
  type RepoPermission,
  type RepoRole,
} from "@fyrden/domain";
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
  /** How many times the repository was renamed. */
  readonly nameGen: number;
  /** The repository it was forked from; null when it is not a fork. */
  readonly parentId: string | null;
  /** Whether new repositories can be generated from it. */
  readonly isTemplate: boolean;
  /** When it is deleted (Unix ms); null to keep it. */
  readonly expiresAt: number | null;
}

/** The columns of a repository entry (`repos r` joined with its owner, `principals p`). */
export const REPO_COLUMNS = `r.id, r.owner_id, p.handle, r.name, r.network_id, r.visibility,
  r.created_at, r.name_gen, r.parent_id, r.is_template, r.expires_at`;

export type RepoRow = {
  id: string;
  owner_id: string;
  handle: string;
  name: string;
  network_id: string;
  visibility: RepoEntry["visibility"];
  created_at: number;
  name_gen: number;
  parent_id: string | null;
  is_template: number;
  expires_at: number | null;
};

// Found repositories, per isolate, for 30 s (the token cache's bound): a
// renamed repository can be reported by its old name for that long. A
// transfer (not built yet) must take effect within that bound.
const found = new TokenCache<RepoEntry>(clock);

// Repositories this isolate marked for deletion, for as long as a cached
// entry for them can live: any name it was cached under misses at once.
const deleted = new TokenCache<true>(clock);

const cacheKey = (owner: string, name: string) => `${owner.toLowerCase()}/${name.toLowerCase()}`;

/**
 * Resolves `owner/name` to its active repository, or to the one a rename
 * gave that name up (a redirect); names compare ignoring case, as handles
 * and repo names do. `consistency: "primary"` reads the
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
    if (cached && !deleted.get(cached.id)) return cached;
  }
  const lookup = async (session: D1DatabaseSession) => {
    options.metrics?.count("d1.query", { db: "directory", op: "repo_resolve" });
    // Two index seeks: the repository with the name, else a redirect's.
    // `state <> 'deleted'` lets the partial (owner_id, name) index serve it.
    return session
      .prepare(
        `SELECT ${REPO_COLUMNS}, 0 AS redirected
         FROM principals p JOIN repos r ON r.owner_id = p.id
         WHERE p.handle = ?1 COLLATE NOCASE AND p.disabled_at IS NULL
           AND r.name = ?2 COLLATE NOCASE AND r.state <> 'deleted' AND r.state = 'active'
         UNION ALL
         SELECT ${REPO_COLUMNS}, 1
         FROM principals p JOIN repo_redirects d ON d.owner_id = p.id
           JOIN repos r ON r.id = d.repo_id AND r.owner_id = d.owner_id
         WHERE p.handle = ?1 COLLATE NOCASE AND p.disabled_at IS NULL
           AND d.name = ?2 AND r.state = 'active'
         ORDER BY redirected LIMIT 1`,
      )
      .bind(owner, name)
      .first<RepoRow>();
  };
  const checkedAt = clock();
  let row = primary ? null : await lookup(env.DIRECTORY.withSession());
  row ??= await lookup(env.DIRECTORY.withSession("first-primary"));
  // A replica may not know yet of a deletion this isolate started.
  if (!row || deleted.get(row.id)) return undefined;
  const entry = entryOf(row);
  found.set(key, entry, checkedAt);
  return entry;
}

export function entryOf(row: RepoRow): RepoEntry {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerHandle: row.handle,
    name: row.name,
    networkId: row.network_id,
    visibility: row.visibility,
    createdAt: row.created_at,
    nameGen: row.name_gen,
    parentId: row.parent_id ?? null,
    isTemplate: row.is_template === 1,
    expiresAt: row.expires_at,
  };
}

/**
 * The active forks of repository `parentId` that `ownerId` owns (and, when
 * given, among `onlyIds`: a token's repository list), oldest first (by
 * creation time, then id), the first `limit` after `after`, from the D1
 * primary.
 */
export async function listOwnedForks(
  env: Env,
  parentId: string,
  ownerId: string,
  page: {
    readonly after: { readonly at: number; readonly id: string } | null;
    readonly limit: number;
    readonly onlyIds: readonly string[] | null;
  },
  metrics?: Metrics,
): Promise<RepoEntry[]> {
  metrics?.count("d1.query", { db: "directory", op: "repo_forks" });
  const after = page.after ?? { at: -1, id: "" };
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT ${REPO_COLUMNS}
       FROM repos r JOIN principals p ON p.id = r.owner_id
       WHERE r.parent_id = ? AND r.owner_id = ? AND r.state = 'active'
         AND p.disabled_at IS NULL
         AND (r.created_at, r.id) > (?, ?)
         AND (? IS NULL OR r.id IN (SELECT value FROM json_each(?)))
       ORDER BY r.created_at, r.id LIMIT ?`,
    )
    .bind(
      parentId,
      ownerId,
      after.at,
      after.id,
      page.onlyIds === null ? null : 1,
      JSON.stringify(page.onlyIds ?? []),
      page.limit,
    )
    .all<RepoRow>();
  return results.map(entryOf);
}

/** The active repositories among `ids` (of enabled owners), in one query, from the D1 primary. */
export async function findReposById(
  env: Env,
  ids: readonly string[],
  metrics?: Metrics,
): Promise<RepoEntry[]> {
  if (ids.length === 0) return [];
  metrics?.count("d1.query", { db: "directory", op: "repos_by_id" });
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT ${REPO_COLUMNS}
       FROM repos r JOIN principals p ON p.id = r.owner_id
       WHERE r.id IN (SELECT value FROM json_each(?)) AND r.state = 'active'
         AND p.disabled_at IS NULL`,
    )
    .bind(JSON.stringify(ids))
    .all<RepoRow>();
  return results.map(entryOf);
}

/**
 * A principal's active repositories in name order (ignoring case), the
 * first `limit` after `after` and, when given, among `onlyIds` (a token's
 * repository list), from the D1 primary so a repository created a moment
 * ago is listed.
 */
export async function listOwnedRepos(
  env: Env,
  ownerId: string,
  options: { after: string; limit: number; onlyIds: readonly string[] | null },
  metrics?: Metrics,
): Promise<RepoEntry[]> {
  metrics?.count("d1.query", { db: "directory", op: "repo_list" });
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      // `state <> 'deleted'` lets the partial (owner_id, name) index serve the query.
      `SELECT ${REPO_COLUMNS}
       FROM repos r JOIN principals p ON p.id = r.owner_id
       WHERE r.owner_id = ?1 AND r.state <> 'deleted' AND r.state = 'active'
         AND r.name > ?2 COLLATE NOCASE
         AND (?3 IS NULL OR r.id IN (SELECT value FROM json_each(?3)))
       ORDER BY r.name COLLATE NOCASE LIMIT ?4`,
    )
    .bind(ownerId, options.after, options.onlyIds && JSON.stringify(options.onlyIds), options.limit)
    .all<RepoRow>();
  return results.map(entryOf);
}

/** An owner's active repositories with `names` (current names, ignoring case), from the D1 primary. */
export async function findOwnedRepos(
  env: Env,
  ownerId: string,
  names: readonly string[],
  metrics?: Metrics,
): Promise<RepoEntry[]> {
  metrics?.count("d1.query", { db: "directory", op: "repo_find" });
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT ${REPO_COLUMNS}
       FROM repos r JOIN principals p ON p.id = r.owner_id
       WHERE r.owner_id = ?1 AND r.state <> 'deleted' AND r.state = 'active'
         AND r.name COLLATE NOCASE IN (SELECT value FROM json_each(?2))`,
    )
    .bind(ownerId, JSON.stringify(names))
    .all<RepoRow>();
  return results.map(entryOf);
}

/**
 * A statement that frees `name` in an owner's namespace of redirects, for the
 * batch that gives a repository that name (a create, a fork). The batch must
 * fail as a whole if the name is not taken after all (a unique violation).
 */
export function claimNameStatement(db: D1Database, ownerId: string, name: string) {
  return db
    .prepare("DELETE FROM repo_redirects WHERE owner_id = ? AND name = ?")
    .bind(ownerId, name);
}

/** This isolate stops resolving `repoId` from its cache, under any name (its deletion started). */
export function forgetRepo(repoId: string): void {
  deleted.set(repoId, true);
}

/** Forgets what this isolate resolved `owner/name` to: the name now belongs to another repository, or none. */
export function forgetResolved(ownerHandle: string, name: string): void {
  found.delete(cacheKey(ownerHandle, name));
}

/**
 * Renames an active repository in the directory, in one batch: its old
 * name becomes a redirect to it, a redirect holding the new name goes, and
 * the rename is audited. Returns the name and the rename count to record
 * in the repository object, `"name_taken"` when another repository of the
 * owner has the name, or undefined when the repository is not active. This
 * isolate forgets the old and new names, and `alias` (the name the caller
 * used, maybe one a redirect holds), at once; others within the cache's bound.
 */
export async function renameRepo(
  env: Env,
  repo: Pick<RepoEntry, "id" | "ownerId" | "ownerHandle" | "name">,
  name: string,
  options: { actorId: string; requestId?: string; alias?: string; metrics?: Metrics },
): Promise<{ value: string; gen: number } | "name_taken" | undefined> {
  const db = env.DIRECTORY;
  const now = clock();
  options.metrics?.count("d1.query", { db: "directory", op: "repo_rename" }, 4);
  let results: D1Result<{ name: string; name_gen: number; old_name: string }>[];
  try {
    results = await db.batch<{ name: string; name_gen: number; old_name: string }>([
      // Only for an active repository: a failed rename keeps another one's redirect.
      db
        .prepare(
          `DELETE FROM repo_redirects WHERE owner_id = ?2 AND name = ?3
           AND EXISTS (SELECT 1 FROM repos WHERE id = ?1 AND state = 'active')`,
        )
        .bind(repo.id, repo.ownerId, name),
      // The old name, read in the batch: a concurrent rename cannot make it stale.
      db
        .prepare(
          `INSERT INTO repo_redirects (owner_id, name, repo_id, created_at)
           SELECT owner_id, name, id, ?3 FROM repos
           WHERE id = ?1 AND state = 'active' AND name <> ?2 COLLATE NOCASE
           ON CONFLICT (owner_id, name) DO UPDATE SET repo_id = excluded.repo_id,
             created_at = excluded.created_at`,
        )
        .bind(repo.id, name, now),
      db
        .prepare(
          `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
           SELECT ?3, ?4, 'repo.rename', id, json_object('from', name, 'to', ?2), ?5 FROM repos
           WHERE id = ?1 AND state = 'active'
           RETURNING json_extract(details, '$.from') AS old_name`,
        )
        .bind(repo.id, name, now, options.actorId, options.requestId ?? null),
      db
        .prepare(
          `UPDATE repos SET name = ?2, name_gen = name_gen + 1, updated_at = ?3
           WHERE id = ?1 AND state = 'active' RETURNING name, name_gen`,
        )
        .bind(repo.id, name, now),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message))
      return "name_taken";
    throw error;
  }
  const previous = results[2]?.results[0]?.old_name ?? repo.name;
  for (const forgotten of [previous, repo.name, name, options.alias ?? name])
    forgetResolved(repo.ownerHandle, forgotten);
  const row = results[3]?.results[0];
  return row && { value: row.name, gen: row.name_gen };
}

/**
 * Changes the settings the directory holds for an active repository
 * (whether it is a template, when it expires) in one batch, auditing a
 * change. Returns the settings it now has, or undefined when the
 * repository is not active. This isolate forgets the repository's name at
 * once; others see the change within the cache's bound.
 */
export async function updateDirectorySettings(
  env: Env,
  repo: Pick<RepoEntry, "id" | "ownerHandle" | "name">,
  change: { readonly isTemplate?: boolean; readonly expiresAt?: number | null },
  options: { actorId: string; requestId?: string; metrics?: Metrics },
): Promise<Pick<RepoEntry, "isTemplate" | "expiresAt"> | undefined> {
  const db = env.DIRECTORY;
  const now = clock();
  // ?2 and ?3 are the new values, or null and 0 to keep the column.
  const template = change.isTemplate === undefined ? null : change.isTemplate ? 1 : 0;
  const expiry = change.expiresAt === undefined ? 0 : 1;
  const next = `coalesce(?2, is_template)`;
  const nextExpiry = `CASE WHEN ?3 THEN ?4 ELSE expires_at END`;
  options.metrics?.count("d1.query", { db: "directory", op: "repo_settings" }, 2);
  const [, updated] = await db.batch<{ is_template: number; expires_at: number | null }>([
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?5, ?6, 'repo.settings', id,
           json_object('is_template', ${next}, 'expires_at', ${nextExpiry}), ?7 FROM repos
         WHERE id = ?1 AND state = 'active'
           AND (is_template <> ${next} OR expires_at IS NOT ${nextExpiry})`,
      )
      .bind(
        repo.id,
        template,
        expiry,
        change.expiresAt ?? null,
        now,
        options.actorId,
        options.requestId ?? null,
      ),
    db
      .prepare(
        `UPDATE repos SET is_template = ${next}, expires_at = ${nextExpiry},
           updated_at = CASE WHEN is_template <> ${next} OR expires_at IS NOT ${nextExpiry}
             THEN ?5 ELSE updated_at END
         WHERE id = ?1 AND state = 'active' RETURNING is_template, expires_at`,
      )
      .bind(repo.id, template, expiry, change.expiresAt ?? null, now),
  ]);
  forgetResolved(repo.ownerHandle, repo.name);
  const row = updated?.results[0];
  return row && { isTemplate: row.is_template === 1, expiresAt: row.expires_at };
}

/** Access git asks for: fetch and clone read the contents, push writes them. */
export type RepoAccess = "read" | "write";

export const GIT_PERMISSION = {
  read: "contents:read",
  write: "contents:write",
} as const satisfies Record<RepoAccess, RepoPermission>;

type Caller = Pick<TokenRecord, "principalId" | "principalType" | "scopes" | "repoIds">;

/** The decision for `role` on the repository, with the token's own limits (type, scopes, repository list). */
export function allowedWithRole(
  auth: Caller,
  repo: Pick<RepoEntry, "id">,
  permission: RepoPermission,
  role: RepoRole | null,
): boolean {
  return evaluate({
    permission,
    actorType: auth.principalType,
    // Instance administration gives no repository role.
    rights: { isInstanceAdmin: false, accountRole: null, repoRole: role },
    token: { scopes: auth.scopes, repoIds: auth.repoIds },
    repoId: repo.id,
  }).allow;
}

/**
 * Whether a token may use `permission` on one of its principal's own
 * repositories (a user's own listing): no snapshot is needed. Any other
 * repository goes through `authorize`.
 */
export function canAccessOwn(
  auth: Caller,
  repo: Pick<RepoEntry, "id" | "ownerId">,
  permission: RepoPermission,
): boolean {
  return (
    ownsUserAccount(auth.principalId, repo.ownerId) &&
    allowedWithRole(auth, repo, permission, "admin")
  );
}

/**
 * Whether a token may use `permission` on a repository: the token's own
 * limits, then the principal's role there. The owner of a user's account
 * administers it outright; anyone else's role, and everyone's on an
 * organization's repository, comes from the repository object's ACL
 * snapshot (a write from one pulled within its window; fail closed). Every
 * repository is private for now: there is no anonymous or public read.
 */
export async function authorize(
  env: Env,
  auth: Caller,
  repo: Pick<RepoEntry, "id" | "ownerId">,
  permission: RepoPermission,
  metrics?: Metrics,
): Promise<boolean> {
  // The token's limits need no call: no role widens them.
  if (!allowedWithRole(auth, repo, permission, "admin")) return false;
  if (ownsUserAccount(auth.principalId, repo.ownerId)) return true;
  const purpose = PERMISSIONS[permission].writes ? "write" : "read";
  metrics?.count("do.request", { class: "RepoDO", method: "roleOf" });
  let role: RepoRole | null;
  try {
    role = await env.REPO.getByName(repo.id).roleOf(auth.principalId, purpose);
  } catch {
    // The repository object could not answer: deny (fail closed).
    role = null;
  }
  return allowedWithRole(auth, repo, permission, role);
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
