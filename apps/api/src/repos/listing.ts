import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { listRepos, Output } from "@fyrden/api-contract";
import type { RepoRole } from "@fyrden/domain";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { allowedWithRole, defaultBranchOf, isValidRepoName, listOwnedRepos } from "./directory.js";
import { repoOutput } from "./output.js";

type ProjectedDetails = { default_branch: string | null; description: string | null };

/** The details the read model has for `ids` (a repository not projected yet is absent). */
async function readModelDetails(
  env: Env,
  ids: readonly string[],
  metrics: Metrics,
): Promise<Map<string, ProjectedDetails>> {
  if (ids.length === 0) return new Map();
  metrics.count("d1.query", { db: "org", op: "repo_details" });
  const { results } = await readModelFor(env, DEFAULT_ORG_SHARD)
    .prepare(
      `SELECT repo_id, default_branch, description FROM repos
       WHERE repo_id IN (SELECT value FROM json_each(?)) AND deleted = 0`,
    )
    .bind(JSON.stringify(ids))
    .all<ProjectedDetails & { repo_id: string }>();
  return new Map(results.map((row) => [row.repo_id, row]));
}

/**
 * One page of an account's repositories that `auth` may see, where its
 * role is the same on all of them (`role`: the owner of a user account, or
 * an organization role turned into a repository role). Only repositories
 * the token may see are read (its repository list is in the query), so
 * neither a page nor its cursor reveals another one's name; one more than a
 * page tells whether another page follows.
 */
export async function listAccountRepos(
  env: Env,
  auth: Pick<TokenRecord, "principalId" | "principalType" | "scopes" | "repoIds">,
  account: { readonly id: string; readonly role: RepoRole | null },
  page: { readonly perPage: number; readonly cursor: string | undefined },
  metrics: Metrics,
): Promise<Output<typeof listRepos>> {
  const after = decodeCursor(page.cursor, isValidRepoName);
  const scanned = await listOwnedRepos(
    env,
    account.id,
    { after, limit: page.perPage + 1, onlyIds: auth.repoIds },
    metrics,
  );
  const visible = scanned
    .slice(0, page.perPage)
    .filter((entry) => allowedWithRole(auth, entry, "metadata:read", account.role));
  const projected = await readModelDetails(
    env,
    visible.map((entry) => entry.id),
    metrics,
  );
  const last = visible.at(-1);
  return {
    repos: visible.map((entry) => {
      const details = projected.get(entry.id);
      return repoOutput(entry, {
        defaultBranch: defaultBranchOf(details?.default_branch ?? null),
        description: details?.description ?? null,
      });
    }),
    next_cursor: scanned.length > page.perPage && last ? encodeCursor(last.name) : null,
  };
}
