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
  details: { defaultBranch: string; description: string | null; parentVisible?: boolean },
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
