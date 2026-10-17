import { apiGet } from "../lib/api.server.js";
import type { PullFilesPage } from "../lib/pulls.js";
import { pullApiOf } from "../lib/pulls.server.js";
import type { Route } from "./+types/repo.pull.patches";

/** Files a page of the files view lists (the API's default page). */
export const FILES_PER_PAGE = 30;

/** One page's patches, as the files view's renderer reads them. */
export interface PagePatches {
  head_sha: string;
  merge_base_sha: string;
  /** Each file's hunks (unified diff text), null when the API left them out. */
  patches: { filename: string; patch: string | null }[];
}

/**
 * The patches of one page of a pull request's files (the page `cursor`
 * names, else the first), for the files view to render after its first
 * paint: the server renders the file list, the browser the hunks.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const cursor = new URL(request.url).searchParams.get("cursor");
  const query = new URLSearchParams({ per_page: String(FILES_PER_PAGE) });
  if (cursor) query.set("cursor", cursor);
  const page = await apiGet<PullFilesPage>(
    context,
    request,
    `${pullApiOf(params)}/files?${query.toString()}`,
  );
  const body: PagePatches = {
    head_sha: page.head_sha,
    merge_base_sha: page.merge_base_sha,
    patches: page.files.map((f) => ({ filename: f.filename, patch: f.patch ?? null })),
  };
  return Response.json(body, {
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
