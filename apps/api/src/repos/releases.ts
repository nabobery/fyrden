import type {
  createRelease,
  deleteRelease,
  getLatestRelease,
  getRelease,
  getReleaseByTag,
  Input,
  listReleases,
  Output,
  updateRelease,
} from "@fyrden/api-contract";
import { isWellFormedTagName } from "@fyrden/domain";
import { isValidRefname } from "@fyrden/git-core";
import type { ReleaseCursor, ReleaseRecord } from "../do/repo/releases.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeBytesCursor, encodeBytesCursor, invalidCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { pageOf } from "../ops/pages.js";
import { authorize, type RepoEntry } from "./directory.js";
import { actorOf, failure, refusedVersion, staleError } from "./pulls.js";
import { releaseOutput } from "./shapes.js";
import { sortingFailure } from "./sorting.js";

const repo = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

const notFound = () =>
  new OperationError(404, "release_not_found", "The repository has no such release.");

/** The problem for a refusal of a release's change. */
function releaseFailure(entry: RepoEntry, code: string): OperationError {
  switch (code) {
    case "release_not_found":
      return notFound();
    case "release_exists":
      return new OperationError(422, code, "The repository has a release of that tag already.");
    case "release_published":
      return new OperationError(
        422,
        code,
        "A published release can't go back to draft or change its tag. Delete it and create another.",
      );
    case "too_many_releases":
      return new OperationError(422, code, "The repository has as many releases as it can hold.");
    case "tag_not_found":
      return new OperationError(422, code, "The tag doesn't exist. Push it first.");
    case "tag_not_a_commit":
      return new OperationError(422, code, "The tag isn't, and doesn't peel to, a commit.");
    case "tag_moving":
      return new OperationError(409, code, "The tag moved meanwhile. Send this again.");
    case "forbidden":
      return new OperationError(403, code, "Changing releases takes write access.");
    default:
      return sortingFailure(code) ?? failure(entry, code);
  }
}

/** git's rules for the whole ref, the form git itself would check: `refUpdateProblem` takes names git refuses. */
function checkedTag(tag: string): string {
  if (!isWellFormedTagName(tag) || !isValidRefname(new TextEncoder().encode(`refs/tags/${tag}`)))
    throw new OperationError(422, "invalid_tag_name", "That isn't a tag name git takes.");
  return tag;
}

/** A listing cursor: `base64url({v:1,r,d,p,i})`, unsigned as every cursor here; another repository's is refused. */
function encodeListingCursor(repoId: string, last: ReleaseRecord): string {
  const value = { v: 1, r: repoId, d: last.draft, p: last.publishedAt, i: last.id };
  return encodeBytesCursor(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeListingCursor(cursor: string | undefined, repoId: string): ReleaseCursor | null {
  if (cursor === undefined) return null;
  let value: Record<string, unknown> | undefined;
  try {
    const bytes = decodeBytesCursor(cursor);
    value =
      bytes && JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw invalidCursor();
  }
  const fits =
    value?.v === 1 &&
    value.r === repoId &&
    typeof value.d === "boolean" &&
    Number.isSafeInteger(value.i) &&
    (value.d ? value.p === null : Number.isSafeInteger(value.p));
  if (!fits) throw invalidCursor();
  return {
    draft: value?.d as boolean,
    publishedAt: value?.p as number | null,
    id: value?.i as number,
  };
}

/** Whether the caller sees drafts: `contents:write`, the token's scopes included. */
const seesDrafts = (ctx: OpContext, entry: RepoEntry) =>
  authorize(ctx.env, ctx.auth, entry, "contents:write", ctx.metrics);

/** A read's answer, once the caller may have it; a draft is as missing as no release. */
async function shown(
  ctx: OpContext,
  entry: RepoEntry,
  release: ReleaseRecord | null | undefined,
): Promise<Output<typeof getRelease>> {
  if (release === null) throw failure(entry, "repo_not_found");
  if (!release || (release.draft && !(await seesDrafts(ctx, entry)))) throw notFound();
  return releaseOutput(release, entry);
}

/** The `releases.list` operation. */
export async function listReleasesOperation(
  ctx: OpContext,
  input: Input<typeof listReleases>,
): Promise<Output<typeof listReleases>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:read");
  const after = decodeListingCursor(input.cursor, entry.id);
  const releases = await repo(ctx, entry, "listReleases").listReleases({
    drafts: await seesDrafts(ctx, entry),
    after,
    limit: input.per_page + 1,
  });
  if (releases === null) throw failure(entry, "repo_not_found");
  const page = pageOf(releases, input.per_page, (release) => releaseOutput(release, entry));
  return {
    releases: page.shown,
    next_cursor: page.more && page.last ? encodeListingCursor(entry.id, page.last) : null,
  };
}

/** The `releases.get` operation. */
export async function getReleaseOperation(
  ctx: OpContext,
  input: Input<typeof getRelease>,
): Promise<Output<typeof getRelease>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:read");
  return shown(ctx, entry, await repo(ctx, entry, "getRelease").getRelease(input.release_id));
}

/** The `releases.get_by_tag` operation. */
export async function getReleaseByTagOperation(
  ctx: OpContext,
  input: Input<typeof getReleaseByTag>,
): Promise<Output<typeof getReleaseByTag>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:read");
  return shown(ctx, entry, await repo(ctx, entry, "getReleaseByTag").getReleaseByTag(input.tag));
}

/** The `releases.latest` operation. */
export async function getLatestReleaseOperation(
  ctx: OpContext,
  input: Input<typeof getLatestRelease>,
): Promise<Output<typeof getLatestRelease>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:read");
  return shown(ctx, entry, await repo(ctx, entry, "getLatestRelease").getLatestRelease());
}

/** The `releases.create` operation. */
export async function createReleaseOperation(
  ctx: OpContext,
  input: Input<typeof createRelease>,
): Promise<Output<typeof createRelease>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const result = await repo(ctx, entry, "createRelease").createRelease(
    {
      tagName: checkedTag(input.tag_name),
      name: input.name ?? null,
      body: input.body ?? null,
      draft: input.draft,
      prerelease: input.prerelease,
    },
    actorOf(ctx),
  );
  if (!result.ok) throw releaseFailure(entry, result.code);
  return releaseOutput(result.release, entry);
}

/** The `releases.update` operation. */
export async function updateReleaseOperation(
  ctx: OpContext,
  input: Input<typeof updateRelease>,
): Promise<Output<typeof updateRelease>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const result = await repo(ctx, entry, "updateRelease").updateRelease(
    input.release_id,
    {
      ...(input.tag_name !== undefined && { tagName: checkedTag(input.tag_name) }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.body !== undefined && { body: input.body }),
      ...(input.draft !== undefined && { draft: input.draft }),
      ...(input.prerelease !== undefined && { prerelease: input.prerelease }),
    },
    actorOf(ctx),
    input.expected_version,
  );
  if (!result.ok && result.code === "stale") throw staleError(refusedVersion(result));
  if (!result.ok) throw releaseFailure(entry, result.code);
  return releaseOutput(result.release, entry);
}

/** The `releases.delete` operation. */
export async function deleteReleaseOperation(
  ctx: OpContext,
  input: Input<typeof deleteRelease>,
): Promise<Output<typeof deleteRelease>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const result = await repo(ctx, entry, "deleteRelease").deleteRelease(
    input.release_id,
    actorOf(ctx),
  );
  if (!result.ok) throw releaseFailure(entry, result.code);
  return { id: input.release_id, state: "deleted" };
}
