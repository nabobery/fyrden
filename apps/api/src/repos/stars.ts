import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { Input, listStarred, Output, starRepo, unstarRepo } from "@fyrden/api-contract";
import { repoFor } from "../git/chunked/operations.js";
import { decodeSeekCursor, encodeSeekCursor } from "../ops/cursor.js";
import type { OpContext } from "../ops/execute.js";
import { clock } from "../services.js";
import {
  authorize,
  defaultBranchOf,
  entryOf,
  REPO_COLUMNS,
  type RepoEntry,
  type RepoRow,
} from "./directory.js";
import { readModelDetails } from "./listing.js";
import { repoOutput, starCounts, visibleParents } from "./output.js";

/*
 * Stars: a user marks repositories it can read. A star is a directory row
 * (user, repository, when); a repository's count is its rows of enabled
 * users. Deleting a repository deletes its stars.
 */

/** The `stars.put` operation. Starring twice changes nothing. */
export async function starRepoOperation(
  ctx: OpContext,
  input: Input<typeof starRepo>,
): Promise<Output<typeof starRepo>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "metadata:read");
  ctx.metrics.count("d1.query", { db: "directory", op: "star_put" });
  // Only while the repository is active and the caller is: a deletion that started meanwhile,
  // of either, wins.
  await ctx.env.DIRECTORY.prepare(
    `INSERT INTO stars (user_id, repo_id, created_at)
     SELECT ?1, id, ?3 FROM repos WHERE id = ?2 AND state = 'active'
       AND EXISTS (SELECT 1 FROM principals WHERE id = ?1 AND lifecycle = 'active')
     ON CONFLICT (user_id, repo_id) DO NOTHING`,
  )
    .bind(ctx.auth.principalId, entry.id, clock())
    .run();
  return { repo: `${entry.ownerHandle}/${entry.name}`, starred: true };
}

/** The `stars.delete` operation. Unstarring one not starred changes nothing. */
export async function unstarRepoOperation(
  ctx: OpContext,
  input: Input<typeof unstarRepo>,
): Promise<Output<typeof unstarRepo>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "metadata:read");
  ctx.metrics.count("d1.query", { db: "directory", op: "star_delete" });
  await ctx.env.DIRECTORY.prepare("DELETE FROM stars WHERE user_id = ? AND repo_id = ?")
    .bind(ctx.auth.principalId, entry.id)
    .run();
  return { repo: `${entry.ownerHandle}/${entry.name}`, starred: false };
}

/**
 * The `stars.list` operation: the caller's stars, most recent first, of
 * repositories it may still see. The cursor is the last star the page
 * read, whether shown or not, so a page can be short.
 */
export async function listStarredOperation(
  ctx: OpContext,
  input: Input<typeof listStarred>,
): Promise<Output<typeof listStarred>> {
  const { env, auth, metrics } = ctx;
  const rows = await listStars(
    env,
    auth.principalId,
    {
      before: decodeSeekCursor(input.cursor),
      limit: input.per_page + 1,
      onlyIds: auth.repoIds,
    },
    metrics,
  );
  const page = rows.slice(0, input.per_page);
  const allowed = await Promise.all(
    page.map(({ entry }) => authorize(env, auth, entry, "metadata:read", metrics)),
  );
  const visible = page.filter((_, i) => allowed[i]);
  const ids = visible.map(({ entry }) => entry.id);
  const [details, stars, parents] = await Promise.all([
    readModelDetails(env, ids, metrics),
    starCounts(env, ids, metrics),
    visibleParents(
      env,
      auth,
      visible.map(({ entry }) => entry),
      metrics,
    ),
  ]);
  const last = page.at(-1);
  return {
    repos: visible.map(({ entry, starredAt }) => ({
      ...repoOutput(entry, {
        defaultBranch: defaultBranchOf(details.get(entry.id)?.default_branch ?? null),
        description: details.get(entry.id)?.description ?? null,
        parentVisible: parents.has(entry.parentId ?? ""),
        stars: stars.get(entry.id) ?? 0,
      }),
      starred_at: starredAt,
    })),
    next_cursor:
      rows.length > input.per_page && last
        ? encodeSeekCursor({ at: last.starredAt, id: last.entry.id })
        : null,
  };
}

/**
 * `userId`'s stars of active repositories (of enabled owners, and, when
 * given, among `onlyIds`: a token's repository list), most recent first
 * (by time, then repository id), the first `limit` before `before`, from
 * the D1 primary.
 */
async function listStars(
  env: Env,
  userId: string,
  page: {
    readonly before: { readonly at: number; readonly id: string } | null;
    readonly limit: number;
    readonly onlyIds: readonly string[] | null;
  },
  metrics?: Metrics,
): Promise<{ entry: RepoEntry; starredAt: number }[]> {
  metrics?.count("d1.query", { db: "directory", op: "stars_list" });
  const before = page.before ?? { at: Number.MAX_SAFE_INTEGER, id: "" };
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT ${REPO_COLUMNS}, s.created_at AS starred_at
       FROM stars s JOIN repos r ON r.id = s.repo_id JOIN principals p ON p.id = r.owner_id
       WHERE s.user_id = ? AND r.state = 'active' AND p.lifecycle IN ('active', 'suspended')
         AND (s.created_at, s.repo_id) < (?, ?)
         AND (? IS NULL OR s.repo_id IN (SELECT value FROM json_each(?)))
       ORDER BY s.created_at DESC, s.repo_id DESC LIMIT ?`,
    )
    .bind(
      userId,
      before.at,
      before.id,
      page.onlyIds === null ? null : 1,
      JSON.stringify(page.onlyIds ?? []),
      page.limit,
    )
    .all<RepoRow & { starred_at: number }>();
  return results.map((row) => ({ entry: entryOf(row), starredAt: row.starred_at }));
}
