import { Link } from "react-router";
import { Listing } from "../components/listing.js";
import { apiGet } from "../lib/api.server.js";
import { refAndPath } from "../lib/target.js";
import { type Contents, encodePath } from "../lib/types.js";
import type { Route } from "./+types/repo.tree";

export function meta({ params, loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${loaderData?.path || "/"} · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { ref, path } = refAndPath(request);
  const base = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
  const cursor = new URL(request.url).searchParams.get("cursor");
  const at = `ref=${encodeURIComponent(ref)}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const contents = await apiGet<Contents>(
    context,
    request,
    path ? `${base}/contents/${encodePath(path)}?${at}` : `${base}/contents?${at}`,
  );
  if (contents.type !== "dir") throw new Response("Not a directory", { status: 404 });
  return {
    owner: params.owner,
    repo: params.repo,
    ref,
    path,
    entries: contents.entries,
    next: contents.next_cursor,
  };
}

export default function Tree({ loaderData }: Route.ComponentProps) {
  const { owner, repo, ref, path, entries, next } = loaderData;
  return (
    <main>
      <h1>
        <Link to={`/${owner}/${repo}`}>
          {owner}/{repo}
        </Link>{" "}
        <span className="muted">
          @ {ref} / {path}
        </span>
      </h1>
      <p>
        <Link
          className="button"
          to={`/${owner}/${repo}/edit/${encodeURIComponent(ref)}/${encodePath(path)}?new=1`}
        >
          Add a file here
        </Link>
      </p>
      <Listing owner={owner} repo={repo} gitRef={ref} entries={entries} />
      {next && (
        <p>
          <Link to={`?cursor=${encodeURIComponent(next)}`}>More files</Link>
        </p>
      )}
    </main>
  );
}
