import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { getRepo, Output } from "@fyrden/api-contract";
import { authorize, findReposById, type RepoEntry } from "./directory.js";

/**
 * A repository as the API answers it: its directory entry and the details
 * its object holds. `parentVisible`: whether the caller may see the
 * repository it was forked from; otherwise `parent_id` is null (`fork`
 * still says it is one).
 */
export function repoOutput(
  repo: RepoEntry,
  details: {
    defaultBranch: string;
    description: string | null;
    parentVisible?: boolean;
    /** How many users starred it (0 for a new repository). */
    stars: number;
  },
): Output<typeof getRepo> {
  return {
    id: repo.id,
    owner: repo.ownerHandle,
    name: repo.name,
    full_name: `${repo.ownerHandle}/${repo.name}`,
    visibility: repo.visibility,
    description: details.description,
    default_branch: details.defaultBranch,
    fork: repo.parentId !== null,
    is_template: repo.isTemplate,
    stargazers_count: details.stars,
    parent_id: details.parentVisible ? repo.parentId : null,
    created_at: repo.createdAt,
  };
}

/** Which of the parents of `repos` the caller may see (its metadata), by id. */
export async function visibleParents(
  env: Env,
  auth: Parameters<typeof authorize>[1],
  repos: readonly RepoEntry[],
  metrics?: Metrics,
): Promise<Set<string>> {
  // Parents a token's repository list leaves out are not looked up at all.
  const ids = [...new Set(repos.flatMap((r) => (r.parentId ? [r.parentId] : [])))].filter(
    (id) => auth.repoIds === null || auth.repoIds.includes(id),
  );
  const parents = await findReposById(env, ids, metrics);
  const allowed = await Promise.all(
    parents.map((parent) => authorize(env, auth, parent, "metadata:read", metrics)),
  );
  return new Set(parents.filter((_, i) => allowed[i]).map((p) => p.id));
}

/** How many enabled users starred each of `ids`, in one query (a repository no one starred is absent). */
export async function starCounts(
  env: Env,
  ids: readonly string[],
  metrics?: Metrics,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  metrics?.count("d1.query", { db: "directory", op: "star_counts" });
  const { results } = await env.DIRECTORY.prepare(
    `SELECT s.repo_id, count(*) AS n FROM stars s JOIN principals p ON p.id = s.user_id
     WHERE s.repo_id IN (SELECT value FROM json_each(?)) AND p.disabled_at IS NULL
     GROUP BY s.repo_id`,
  )
    .bind(JSON.stringify(ids))
    .all<{ repo_id: string; n: number }>();
  return new Map(results.map((r) => [r.repo_id, r.n]));
}
