import { data, Link } from "react-router";
import { Listing } from "../components/listing.js";
import { Markdown } from "../components/markdown.js";
import { RepoHeader } from "../components/repo-header.js";
import { apiCall, apiGet } from "../lib/api.server.js";
import { dirOf, renderMarkdown } from "../lib/markdown.js";
import { type Contents, decodeText, type Repo } from "../lib/types.js";
import type { Route } from "./+types/repo";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const base = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
  const repo = await apiGet<Repo>(context, request, base);
  const ref = encodeURIComponent(repo.default_branch);
  const cursor = new URL(request.url).searchParams.get("cursor");
  const page = `ref=${ref}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const [root, readme] = await Promise.all([
    apiCall<Contents>(context, request, "GET", `${base}/contents?${page}`),
    apiCall<Contents>(context, request, "GET", `${base}/readme?ref=${ref}`),
  ]);
  if (root.status !== 200 && root.status !== 404)
    throw data("The repository's files could not be listed; try again.", { status: root.status });
  const readmeText =
    readme.status === 200 && readme.body.type === "file" && readme.body.encoding === "base64"
      ? decodeText(readme.body.content)
      : undefined;
  return {
    repo,
    origin: new URL(request.url).origin,
    // An empty repository has no default branch to list (404); anything else failing is an error.
    entries: root.status === 200 && root.body.type === "dir" ? root.body.entries : null,
    next: root.status === 200 && root.body.type === "dir" ? root.body.next_cursor : null,
    readme:
      readmeText === undefined
        ? null
        : {
            name: readme.body.type === "file" ? readme.body.name : "README",
            html: renderMarkdown(readmeText, {
              base: `/${params.owner}/${params.repo}`,
              ref,
              dir: readme.body.type === "file" ? dirOf(readme.body.path) : "",
            }),
          },
  };
}

export default function RepoHome({ loaderData }: Route.ComponentProps) {
  const { repo, origin, entries, next, readme } = loaderData;
  const base = `/${repo.owner}/${repo.name}`;
  const ref = encodeURIComponent(repo.default_branch);
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="code" />
      <div className="row">
        <span>
          Branch <code>{repo.default_branch}</code>
        </span>
        <a className="button" href={`${base}/archive/tar.gz?ref=${ref}`}>
          Download .tar.gz
        </a>
        <a className="button" href={`${base}/archive/zip?ref=${ref}`}>
          Download .zip
        </a>
        <Link className="button" to={`${base}/edit/${ref}/?new=1`}>
          Add a file
        </Link>
      </div>
      {entries === null ? (
        <section className="panel">
          <h2>This repository is empty</h2>
          <p>Push to it, or add a file:</p>
          <pre>{`git remote add origin ${origin}${base}.git\ngit push -u origin ${repo.default_branch}`}</pre>
        </section>
      ) : (
        <>
          <Listing
            owner={repo.owner}
            repo={repo.name}
            gitRef={repo.default_branch}
            entries={entries}
          />
          {next && (
            <p>
              <Link to={`?cursor=${encodeURIComponent(next)}`}>More files</Link>
            </p>
          )}
        </>
      )}
      {readme && (
        <section className="panel" aria-labelledby="readme">
          <h2 id="readme">{readme.name}</h2>
          <Markdown html={readme.html} />
        </section>
      )}
    </main>
  );
}
