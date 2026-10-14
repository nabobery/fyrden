import { Link } from "react-router";
import { RepoHeader } from "../components/repo-header.js";
import { apiGet } from "../lib/api.server.js";
import type { Commit, Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.commits";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Commits · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const base = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
  const url = new URL(request.url);
  const repo = await apiGet<Repo>(context, request, base);
  const cursor = url.searchParams.get("cursor");
  const page = await apiGet<{ commits: Commit[]; next_cursor: string | null } | Commit[]>(
    context,
    request,
    `${base}/commits?per_page=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  ).catch(() => ({ commits: [], next_cursor: null }));
  const commits = Array.isArray(page) ? page : page.commits;
  const next = Array.isArray(page) ? null : page.next_cursor;
  return { repo, origin: url.origin, commits, next };
}

export default function Commits({ loaderData }: Route.ComponentProps) {
  const { repo, origin, commits, next } = loaderData;
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="commits" />
      {commits.length === 0 ? (
        <p className="muted">No commits yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Commit</th>
              <th scope="col">Message</th>
              <th scope="col">Author</th>
              <th scope="col">Signature</th>
            </tr>
          </thead>
          <tbody>
            {commits.map((c) => (
              <tr key={c.sha}>
                <td>
                  <code>{c.sha.slice(0, 7)}</code>
                </td>
                <td>{c.commit.message.split("\n")[0]}</td>
                <td>
                  {c.commit.author.name}
                  <br />
                  <span className="muted">{c.commit.author.date}</span>
                </td>
                <td>
                  {c.commit.verification.verified ? (
                    <span className="badge verified">Verified</span>
                  ) : (
                    <span className="badge" title={c.commit.verification.reason}>
                      {c.commit.verification.reason === "unsigned" ? "Unsigned" : "Unverified"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && (
        <p>
          <Link to={`?cursor=${encodeURIComponent(next)}`}>Older commits</Link>
        </p>
      )}
    </main>
  );
}
