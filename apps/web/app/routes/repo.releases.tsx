import { Link } from "react-router";
import { Pager } from "../components/pager.js";
import { RepoHeader } from "../components/repo-header.js";
import { apiCallBounded, apiGet, bodyOf } from "../lib/api.server.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import { repoApiPath } from "../lib/pulls.js";
import { type ReleasesPage, releaseKind, releasePage, tagNotice } from "../lib/releases.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.releases";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Releases · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const base = repoApiPath(params.owner, params.repo);
  const [repo, page] = await Promise.all([
    apiGet<Repo>(context, request, base),
    apiCallBounded<ReleasesPage>(
      context,
      request,
      `${base}/releases?${pageQuery(url, "cursor", 30)}`,
    ),
  ]);
  const listed = bodyOf(page, request);
  return {
    repo,
    origin: url.origin,
    releases: listed.releases,
    pages: pageLinks(url, "cursor", listed.next_cursor),
  };
}

export default function Releases({ loaderData }: Route.ComponentProps) {
  const { repo, origin, releases, pages } = loaderData;
  const base = `/${repo.owner}/${repo.name}`;
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="releases" />
      {repo.permissions?.push === true && (
        <p className="row">
          <Link className="button" to={`${base}/releases/new`}>
            New release
          </Link>
        </p>
      )}
      {releases.length === 0 ? (
        <p className="muted">{pages.first ? "No more releases." : "No releases yet."}</p>
      ) : (
        <ul className="label-list" aria-label="Releases">
          {releases.map((release) => {
            const notice = tagNotice(release);
            return (
              <li key={release.id} className="panel">
                <h2 className="pull-title">
                  <Link to={releasePage(repo.owner, repo.name, release.tag_name)}>
                    {release.name || release.tag_name}
                  </Link>{" "}
                  <span className="badge">{releaseKind(release)}</span>
                </h2>
                <p className="muted">{release.tag_name}</p>
                {notice && <p className="muted">{notice}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <Pager links={pages} label="Release" />
    </main>
  );
}
