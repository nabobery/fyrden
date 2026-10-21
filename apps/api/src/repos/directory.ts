import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import { TokenCache } from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { REPO_NAME_PATTERN } from "@fyrden/api-contract";
import {
  evaluate,
  isValidHandle,
  ownsUserAccount,
  PERMISSIONS,
  principalTypeOf,
  type RepoPermission,
  type RepoRole,
} from "@fyrden/domain";
import { OperationError } from "../ops/execute.js";
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
// renamed or transferred repository can be reported by its old name and
// owner for that long (access is not decided from a cached owner).
const found = new TokenCache<RepoEntry>(clock);

// Repositories this isolate marked for deletion, for as long as a cached
// entry for them can live: any name it was cached under misses at once.
const deleted = new TokenCache<true>(clock);

/**
 * Entries read from the directory's primary just now: their owner is the
 * repository's owner, not one a transfer replaced (a cached or replica
 * answer, or a copy of an entry, may name a former owner).
 */
const currentOwner = new WeakSet<Pick<RepoEntry, "ownerId">>();

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
    // Two index seeks: the repository with the name, else a redirect's
    // (a rename's, or a transfer's to the repository's owner now).
    // `state <> 'deleted'` lets the partial (owner_id, name) index serve it.
    return session
      .prepare(
        `SELECT ${REPO_COLUMNS}, 0 AS redirected
         FROM principals p JOIN repos r ON r.owner_id = p.id
         WHERE p.handle = ?1 COLLATE NOCASE AND p.lifecycle IN ('active', 'suspended')
           AND r.name = ?2 COLLATE NOCASE AND r.state <> 'deleted' AND r.state = 'active'
         UNION ALL
         SELECT ${REPO_COLUMNS}, 1
         FROM principals o JOIN repo_redirects d ON d.owner_id = o.id
           JOIN repos r ON r.id = d.repo_id JOIN principals p ON p.id = r.owner_id
         WHERE o.handle = ?1 COLLATE NOCASE AND o.lifecycle IN ('active', 'suspended')
           AND d.name = ?2 AND r.state = 'active' AND p.lifecycle IN ('active', 'suspended')
         ORDER BY redirected LIMIT 1`,
      )
      .bind(owner, name)
      .first<RepoRow>();
  };
  const checkedAt = clock();
  let row = primary ? null : await lookup(env.DIRECTORY.withSession());
  const fromPrimary = !row;
  row ??= await lookup(env.DIRECTORY.withSession("first-primary"));
  // A replica may not know yet of a deletion this isolate started.
  if (!row || deleted.get(row.id)) return undefined;
  const entry = entryOf(row);
  // The cache keeps a copy: only this answer, read from the primary, names its owner for sure.
  found.set(key, { ...entry }, checkedAt);
  if (fromPrimary) currentOwner.add(entry);
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
         AND p.lifecycle IN ('active', 'suspended')
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
/**
 * The repositories an account holds now, in one read: those it owns (but
 * deleted ones) and those a transfer has moved away from it in the
 * directory that it has not let go of yet (the `grants` step).
 */
export const HELD_REPOS = `SELECT id FROM repos WHERE owner_id = ?1 AND state <> 'deleted'
  UNION SELECT repo_id FROM repo_transfers WHERE from_owner = ?1 AND step = 'grants'`;

/** `HELD_REPOS` of `ownerId`, from the D1 primary. */
export async function heldRepos(env: Env, ownerId: string, metrics?: Metrics): Promise<string[]> {
  metrics?.count("d1.query", { db: "directory", op: "held_repos" });
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(HELD_REPOS)
    .bind(ownerId)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

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
         AND p.lifecycle IN ('active', 'suspended')`,
    )
    .bind(JSON.stringify(ids))
    .all<RepoRow>();
  return results.map(entryOf);
}

/** The repositories of one owner in a fork network a pull request's head is looked for among. Proposed. */
export const MAX_HEAD_CANDIDATES = 10;

/**
 * The active repositories of fork network `networkId` that the principal
 * with `handle` owns (a pull request's head is a branch of one), named
 * `name` when given; the first `MAX_HEAD_CANDIDATES` by name. From the D1
 * primary, so a fork made a moment ago is found.
 */
export async function networkReposOf(
  env: Env,
  networkId: string,
  handle: string,
  name: string | undefined,
  metrics?: Metrics,
): Promise<RepoEntry[]> {
  if (!isValidHandle(handle) || (name !== undefined && !isValidRepoName(name))) return [];
  metrics?.count("d1.query", { db: "directory", op: "network_repos" });
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT ${REPO_COLUMNS}
       FROM repos r JOIN principals p ON p.id = r.owner_id
       WHERE r.network_id = ? AND p.handle = ? COLLATE NOCASE AND r.state = 'active'
         AND p.lifecycle IN ('active', 'suspended') AND (?3 IS NULL OR r.name = ?3 COLLATE NOCASE)
       ORDER BY r.name LIMIT ?4`,
    )
    .bind(networkId, handle, name ?? null, MAX_HEAD_CANDIDATES)
    .all<RepoRow>();
  return results.map(entryOf);
}

/** The active repository fork network `networkId` grew from (forked from none), if any. */
export async function findNetworkSource(
  env: Env,
  networkId: string,
  metrics?: Metrics,
): Promise<RepoEntry | undefined> {
  metrics?.count("d1.query", { db: "directory", op: "network_source" });
  const row = await env.DIRECTORY.prepare(
    `SELECT ${REPO_COLUMNS}
     FROM repos r JOIN principals p ON p.id = r.owner_id
     WHERE r.network_id = ? AND r.parent_id IS NULL AND r.state = 'active'
       AND p.lifecycle IN ('active', 'suspended')
     LIMIT 1`,
  )
    .bind(networkId)
    .first<RepoRow>();
  return row ? entryOf(row) : undefined;
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

/** A repository row a create or a fork inserts. */
export interface NewRepoRow {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly networkId: string;
  readonly orgShard: string;
  readonly visibility: RepoEntry["visibility"];
  readonly parentId: string | null;
  readonly expiresAt: number | null;
  readonly now: number;
  /** Set for a repository generated from a template, until its first commit is made. */
  readonly generatingSince?: number | null;
  /** The agent creating it acting for its owner, and that agent's limit of active repositories. */
  readonly createdBy?: { readonly agentId: string; readonly maxRepos: number } | null;
}

/** Hooks into repository publication (a create, generation or fork). For tests. */
export const publishHooks: { before?: () => Promise<void> } = {};

/**
 * An SQL condition: the account bound at `owner` may own repositories (not
 * a user being deleted or deleted: a deletion that began meanwhile wins).
 */
export const OWNER_REMAINS = (owner: string) =>
  `EXISTS (SELECT 1 FROM principals WHERE id = ${owner} AND lifecycle IN ('active', 'suspended'))`;

/**
 * The statements of one directory batch that publishes a new repository:
 * its row, taking the name from any redirect holding it, and its audit
 * row, all only while the owner has fewer than `maxRepos` active
 * repositories and none of that name (checked in the batch, so concurrent
 * creates cannot pass the limit or take the name twice). Pass the batch's
 * results to `heldBack` for why it was held back, read in the same
 * transaction. Never for an owner being deleted (`OWNER_REMAINS`).
 */
export function newRepoStatements(
  db: D1Database,
  row: NewRepoRow,
  audit: {
    readonly actorId: string;
    readonly requestId?: string;
    readonly action: string;
    readonly details: Record<string, unknown>;
    /** The agents acting, the current one first. */
    readonly act?: readonly string[];
  },
  maxRepos: number,
): D1PreparedStatement[] {
  const inserted = "EXISTS (SELECT 1 FROM repos WHERE id = ?)";
  const agent = row.createdBy ?? null;
  return [
    // What the insert below sees: the name taken, the active repositories (the agent's too).
    db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM repos WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE
                  AND state <> 'deleted') AS taken,
                (SELECT count(*) FROM repos WHERE owner_id = ?1 AND state <> 'deleted'
                  AND state = 'active') AS repos,
                (SELECT count(*) FROM repos WHERE created_by = ?3 AND state = 'active')
                  AS agent_repos,
                ${OWNER_REMAINS("?1")} AS owner`,
      )
      .bind(row.ownerId, row.name, agent?.agentId ?? null),
    db
      .prepare(
        `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, parent_id,
           expires_at, created_at, updated_at, generating_since, created_by)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?11, ?12
         WHERE (SELECT count(*) FROM repos WHERE owner_id = ?2 AND state <> 'deleted'
           AND state = 'active') < ?10
           AND NOT EXISTS (SELECT 1 FROM repos WHERE owner_id = ?2 AND name = ?3 COLLATE NOCASE
             AND state <> 'deleted')
           AND (?12 IS NULL
             OR (SELECT count(*) FROM repos WHERE created_by = ?12 AND state = 'active') < ?13)
           AND ${OWNER_REMAINS("?2")}`,
      )
      .bind(
        row.id,
        row.ownerId,
        row.name,
        row.networkId,
        row.orgShard,
        row.visibility,
        row.parentId,
        row.expiresAt,
        row.now,
        maxRepos,
        row.generatingSince ?? null,
        agent?.agentId ?? null,
        agent?.maxRepos ?? 0,
      ),
    db
      .prepare(`DELETE FROM repo_redirects WHERE owner_id = ? AND name = ? AND ${inserted}`)
      .bind(row.ownerId, row.name, row.id),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id, act_chain)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${inserted}`,
      )
      .bind(
        row.now,
        audit.actorId,
        audit.action,
        row.id,
        JSON.stringify(audit.details),
        audit.requestId ?? null,
        actChain(audit.act),
        row.id,
      ),
  ];
}

/**
 * Why a `newRepoStatements` batch did not publish its repository (its
 * owner is being deleted, the name was taken, or the quota full), or
 * undefined when it did.
 */
export function heldBack(
  results: readonly D1Result[],
  /** The creating agent's limit, when an agent creates it. */
  agentMaxRepos?: number,
): "owner_gone" | "name_taken" | "quota_exceeded" | "agent_quota_exceeded" | undefined {
  if ((results[1]?.meta.changes ?? 0) > 0) return undefined;
  const seen = results[0]?.results[0] as
    | { taken: number; agent_repos: number; owner: number }
    | undefined;
  if (seen?.owner !== 1) return "owner_gone";
  if (seen.taken) return "name_taken";
  return agentMaxRepos !== undefined && (seen?.agent_repos ?? 0) >= agentMaxRepos
    ? "agent_quota_exceeded"
    : "quota_exceeded";
}

/**
 * Whether `ownerId` may create repository `name` now: not when it has one
 * of that name (409 `name_taken`), or has `maxRepos` active ones (403
 * `quota_exceeded`). Read from the D1 primary; the create's batch checks
 * the limit again.
 */
export async function checkNewRepo(
  env: Env,
  owner: { readonly id: string; readonly handle: string },
  name: string,
  maxRepos: number,
  metrics?: Metrics,
  createdBy?: NewRepoRow["createdBy"],
): Promise<void> {
  metrics?.count("d1.query", { db: "directory", op: "repo_name_check" });
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM repos WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE
                AND state <> 'deleted') AS taken,
              (SELECT count(*) FROM repos WHERE owner_id = ?1 AND state <> 'deleted'
                AND state = 'active') AS repos,
              (SELECT count(*) FROM repos WHERE created_by = ?3 AND state = 'active')
                AS agent_repos`,
    )
    .bind(owner.id, name, createdBy?.agentId ?? null)
    .first<{ taken: number; repos: number; agent_repos: number }>();
  if (row?.taken) throw nameTakenError(owner.handle, name);
  if ((row?.repos ?? 0) >= maxRepos) throw repoQuotaError(owner.handle, maxRepos);
  if (createdBy && (row?.agent_repos ?? 0) >= createdBy.maxRepos)
    throw agentRepoQuotaError(createdBy.maxRepos);
}

export const ownerGoneError = (handle: string) =>
  new OperationError(404, "owner_not_found", `No account ${handle} was found.`);

export const nameTakenError = (handle: string, name: string) =>
  new OperationError(409, "name_taken", `${handle} already has a repository named ${name}.`);

export const repoQuotaError = (handle: string, maxRepos: number) =>
  new OperationError(
    403,
    "quota_exceeded",
    `${handle} has ${maxRepos} repositories, as many as its quota allows; delete one first.`,
  );

export const agentRepoQuotaError = (maxRepos: number) =>
  new OperationError(
    403,
    "quota_exceeded",
    `This agent has created ${maxRepos} repositories, as many as its limit allows; delete one first.`,
  );

/** This isolate stops resolving `repoId` from its cache, under any name (its deletion started). */
export function forgetRepo(repoId: string): void {
  deleted.set(repoId, true);
}

/** Forgets what this isolate resolved `owner/name` to: the name now belongs to another repository, or none. */
export function forgetResolved(ownerHandle: string, name: string): void {
  found.delete(cacheKey(ownerHandle, name));
}

/** An audit row's act chain: JSON, or null when no agent acts. */
export const actChain = (act: readonly string[] | undefined): string | null =>
  act && act.length > 0 ? JSON.stringify(act) : null;

/** In a statement on `repos`: no transfer is moving the repository (renames, settings and deletions wait). */
export const NOT_TRANSFERRING = `NOT EXISTS (SELECT 1 FROM repo_transfers
  WHERE repo_transfers.repo_id = repos.id AND repo_transfers.step NOT IN ('done', 'failed'))`;

const TRANSFERRING = `SELECT EXISTS (SELECT 1 FROM repo_transfers
  WHERE repo_id = ?1 AND step NOT IN ('done', 'failed')) AS transferring`;

/**
 * Renames an active repository in the directory, in one batch: its old
 * name becomes a redirect to it, a redirect holding the new name goes, and
 * the rename is audited. Returns the name and the rename count to record
 * in the repository object, `"name_taken"` when another repository of the
 * owner has the name, `"transferring"` while a transfer moves it, or
 * undefined when the repository is not active or no longer belongs to
 * `repo.ownerId` (the owner the caller was authorized for). This
 * isolate forgets the old and new names, and `alias` (the name the caller
 * used, maybe one a redirect holds), at once; others within the cache's bound.
 */
export async function renameRepo(
  env: Env,
  repo: Pick<RepoEntry, "id" | "ownerId" | "ownerHandle" | "name">,
  name: string,
  options: {
    actorId: string;
    /** The agents acting for `actorId` (a delegated token's act chain), for the audit row. */
    act?: readonly string[];
    requestId?: string;
    alias?: string;
    metrics?: Metrics;
  },
): Promise<{ value: string; gen: number } | "name_taken" | "transferring" | undefined> {
  const db = env.DIRECTORY;
  const now = clock();
  options.metrics?.count("d1.query", { db: "directory", op: "repo_rename" }, 5);
  // Only while it belongs to the owner the caller was authorized for (parameter `?n`).
  const active = (n: number) => `state = 'active' AND ${NOT_TRANSFERRING} AND owner_id = ?${n}`;
  let results: D1Result<{
    name: string;
    name_gen: number;
    old_name: string;
    transferring: number;
  }>[];
  try {
    results = await db.batch([
      db.prepare(TRANSFERRING).bind(repo.id),
      // Only for an active repository: a failed rename keeps another one's redirect.
      db
        .prepare(
          `DELETE FROM repo_redirects WHERE owner_id = ?2 AND name = ?3
           AND EXISTS (SELECT 1 FROM repos WHERE id = ?1 AND ${active(2)})`,
        )
        .bind(repo.id, repo.ownerId, name),
      // The old name, read in the batch: a concurrent rename cannot make it stale.
      db
        .prepare(
          `INSERT INTO repo_redirects (owner_id, name, repo_id, created_at)
           SELECT owner_id, name, id, ?3 FROM repos
           WHERE id = ?1 AND ${active(4)} AND name <> ?2 COLLATE NOCASE
           ON CONFLICT (owner_id, name) DO UPDATE SET repo_id = excluded.repo_id,
             created_at = excluded.created_at`,
        )
        .bind(repo.id, name, now, repo.ownerId),
      db
        .prepare(
          `INSERT INTO audit_log (at, actor_id, act_chain, action, target_id, details, request_id)
           SELECT ?3, ?4, ?7, 'repo.rename', id, json_object('from', name, 'to', ?2), ?5 FROM repos
           WHERE id = ?1 AND ${active(6)}
           RETURNING json_extract(details, '$.from') AS old_name`,
        )
        .bind(
          repo.id,
          name,
          now,
          options.actorId,
          options.requestId ?? null,
          repo.ownerId,
          actChain(options.act),
        ),
      db
        .prepare(
          `UPDATE repos SET name = ?2, name_gen = name_gen + 1, updated_at = ?3
           WHERE id = ?1 AND ${active(4)} RETURNING name, name_gen`,
        )
        .bind(repo.id, name, now, repo.ownerId),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message))
      return "name_taken";
    throw error;
  }
  if (results[0]?.results[0]?.transferring) return "transferring";
  const previous = results[3]?.results[0]?.old_name ?? repo.name;
  for (const forgotten of [previous, repo.name, name, options.alias ?? name])
    forgetResolved(repo.ownerHandle, forgotten);
  const row = results[4]?.results[0];
  return row && { value: row.name, gen: row.name_gen };
}

/**
 * Why a change authorized for `ownerId` was not made to `repoId`: a
 * transfer is moving it, it moved to another owner since, or neither.
 */
export async function ownershipChange(
  env: Env,
  repoId: string,
  ownerId: string,
  metrics?: Metrics,
): Promise<"transferring" | "moved" | undefined> {
  metrics?.count("d1.query", { db: "directory", op: "ownership_change" });
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT owner_id, EXISTS (SELECT 1 FROM repo_transfers
         WHERE repo_id = ?1 AND step NOT IN ('done', 'failed')) AS transferring
       FROM repos WHERE id = ?1`,
    )
    .bind(repoId)
    .first<{ owner_id: string; transferring: number }>();
  if (row?.transferring) return "transferring";
  return row && row.owner_id !== ownerId ? "moved" : undefined;
}

/**
 * Changes the settings the directory holds for an active repository
 * (whether it is a template, when it expires) in one batch, auditing a
 * change. Returns the settings it now has, `"transferring"` while a
 * transfer moves it, or undefined when the repository is not active or no
 * longer belongs to `repo.ownerId` (the owner the caller was authorized for). This isolate forgets the repository's name at
 * once; others see the change within the cache's bound.
 */
export async function updateDirectorySettings(
  env: Env,
  repo: Pick<RepoEntry, "id" | "ownerId" | "ownerHandle" | "name">,
  change: { readonly isTemplate?: boolean; readonly expiresAt?: number | null },
  options: {
    actorId: string;
    /** The agents acting for `actorId` (a delegated token's act chain), for the audit row. */
    act?: readonly string[];
    requestId?: string;
    metrics?: Metrics;
  },
): Promise<Pick<RepoEntry, "isTemplate" | "expiresAt"> | "transferring" | undefined> {
  const db = env.DIRECTORY;
  const now = clock();
  // ?2 and ?3 are the new values, or null and 0 to keep the column.
  const template = change.isTemplate === undefined ? null : change.isTemplate ? 1 : 0;
  const expiry = change.expiresAt === undefined ? 0 : 1;
  const next = `coalesce(?2, is_template)`;
  const nextExpiry = `CASE WHEN ?3 THEN ?4 ELSE expires_at END`;
  // ?8: the owner the caller was authorized for.
  const active = `state = 'active' AND ${NOT_TRANSFERRING} AND owner_id = ?8`;
  options.metrics?.count("d1.query", { db: "directory", op: "repo_settings" }, 3);
  const [pending, , updated] = await db.batch<{
    is_template: number;
    expires_at: number | null;
    transferring: number;
  }>([
    db.prepare(TRANSFERRING).bind(repo.id),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, act_chain, action, target_id, details, request_id)
         SELECT ?5, ?6, ?9, 'repo.settings', id,
           json_object('is_template', ${next}, 'expires_at', ${nextExpiry}), ?7 FROM repos
         WHERE id = ?1 AND ${active}
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
        repo.ownerId,
        actChain(options.act),
      ),
    db
      .prepare(
        `UPDATE repos SET is_template = ${next}, expires_at = ${nextExpiry},
           updated_at = CASE WHEN is_template <> ${next} OR expires_at IS NOT ${nextExpiry}
             THEN ?5 ELSE updated_at END
         WHERE id = ?1 AND ${active} RETURNING is_template, expires_at`,
      )
      .bind(repo.id, template, expiry, change.expiresAt ?? null, now, null, null, repo.ownerId),
  ]);
  if (pending?.results[0]?.transferring) return "transferring";
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

type Caller = Pick<TokenRecord, "principalId" | "principalType" | "scopes" | "repoIds"> &
  Partial<Pick<TokenRecord, "ceilingIds">>;

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
    // An agent acting is capped by its owner: only the user's own agents act on its own outright.
    (auth.ceilingIds ?? []).every((owner) => owner === auth.principalId) &&
    allowedWithRole(auth, repo, permission, "admin")
  );
}

/**
 * Which of the principal's own repositories `entries` a token may use
 * `permission` on: for the user itself and its own agents, at once
 * (`canAccessOwn`); for an agent of another owner acting for the user,
 * each one as `authorize` decides (the owner's role caps it).
 */
export async function ownAccessible<T extends Pick<RepoEntry, "id" | "ownerId">>(
  env: Env,
  auth: Caller,
  entries: readonly T[],
  permission: RepoPermission,
  metrics?: Metrics,
): Promise<T[]> {
  if ((auth.ceilingIds ?? []).every((owner) => owner === auth.principalId))
    return entries.filter((entry) => canAccessOwn(auth, entry, permission));
  const allowed = await Promise.all(
    entries.map((entry) => authorize(env, auth, entry, permission, metrics)),
  );
  return entries.filter((_, i) => allowed[i]);
}

/**
 * The repositories of the principal's own (user) account a listing may
 * show to `auth`: its token's repository list, narrowed, for an agent of
 * another owner acting for the user, to those every such owner
 * collaborates on (in a user's account, the only roles another principal
 * holds; an organization holds none there). In the query, so neither a
 * page nor its cursor names one it may not see.
 */
export async function ownListable(
  env: Env,
  auth: Caller,
  metrics?: Metrics,
): Promise<readonly string[] | null> {
  let ids: readonly string[] | null = auth.repoIds;
  for (const owner of new Set(auth.ceilingIds ?? [])) {
    if (owner === auth.principalId) continue;
    metrics?.count("do.request", { class: "OrgDO", method: "collaboratorRepos" });
    const theirs: string[] =
      principalTypeOf(owner) === "user"
        ? await env.ORG.getByName(auth.principalId).collaboratorRepos(owner, "read")
        : [];
    ids = ids === null ? theirs : ids.filter((id) => theirs.includes(id));
  }
  return ids;
}

/**
 * Whether a token may use `permission` on a repository: the token's own
 * limits, then the principal's role there, then, for an agent acting
 * (with its own token, or for a user under a delegation grant), each
 * agent's owner's role: an agent never exceeds its owner. The owner of a
 * user's account administers it outright; anyone else's role, and
 * everyone's on an organization's repository, comes from the repository
 * object's ACL snapshot (a write from one pulled within its window; fail
 * closed). The owner is taken from `repo` only when it was read from the
 * directory's primary just now (a transfer may have replaced a cached
 * one); else the repository object, which knows its owner, decides. Every
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
  const purpose = PERMISSIONS[permission].writes ? "write" : "read";
  const roleOf = async (principalId: string): Promise<RepoRole | null> => {
    // Only from an answer that names the owner for sure; else the repository object decides.
    if (currentOwner.has(repo) && principalId === repo.ownerId) return "admin";
    metrics?.count("do.request", { class: "RepoDO", method: "roleOf" });
    try {
      return await env.REPO.getByName(repo.id).roleOf(principalId, purpose, repo.ownerId);
    } catch {
      // The repository object could not answer: deny (fail closed).
      return null;
    }
  };
  if (!allowedWithRole(auth, repo, permission, await roleOf(auth.principalId))) return false;
  for (const owner of new Set(auth.ceilingIds ?? []))
    if (!allowedWithRole(auth, repo, permission, await roleOf(owner))) return false;
  return true;
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
