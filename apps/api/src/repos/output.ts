import type { getRepo, Output } from "@fyrden/api-contract";
import type { RepoEntry } from "./directory.js";

/** A repository as the API answers it: its directory entry and the details its object holds. */
export function repoOutput(
  repo: RepoEntry,
  details: { defaultBranch: string; description: string | null },
): Output<typeof getRepo> {
  return {
    id: repo.id,
    owner: repo.ownerHandle,
    name: repo.name,
    full_name: `${repo.ownerHandle}/${repo.name}`,
    visibility: repo.visibility,
    description: details.description,
    default_branch: details.defaultBranch,
    created_at: repo.createdAt,
  };
}
