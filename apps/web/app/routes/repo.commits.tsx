import { Link } from "react-router";
import { RepoHeader } from "../components/repo-header.js";
import { apiCall, apiGet, bodyOf, type Problem } from "../lib/api.server.js";
import { refAndPath } from "../lib/target.js";
import { type CommitsPage, encodePath, type Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.commits";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Commits · ${params.owner}/${params.repo} · Fyrden` }];
}

/** What a page of history has to say: rows, or why it has none. */
type HistoryState =
  | "commits"
  | "repo-empty"
  | "none-here"
  | "none-at-revision"
  | "no-older"
  | "stretch-empty"
  | "too-wide"
  | "stale-cursor";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const base = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
  const url = new URL(request.url);
  const at = "ref" in params ? refAndPath(request) : null;
  const ref = at?.ref ?? null;
  const path = at?.path || null;
  const repo = await apiGet<Repo>(context, request, base);
  const cursor = url.searchParams.get("cursor");
  const query = [
    "per_page=50",
    ...(ref !== null ? [`sha=${encodeURIComponent(ref)}`] : []),
    // A cursor says where to go on from, and wins over `sha`: all three go together.
    ...(path !== null ? [`path=${encodeURIComponent(path)}`] : []),
    ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : []),
  ].join("&");
  const result = await apiCall<CommitsPage>(context, request, "GET", `${base}/commits?${query}`);
  const firstPage = `/${params.owner}/${params.repo}/commits${
    ref !== null ? `/${encodeURIComponent(ref)}${path !== null ? `/${encodePath(path)}` : ""}` : ""
  }`;
  const shared = { repo, origin: url.origin, owner: params.owner, ref, path, firstPage };
  const refused = (result.body as unknown as Problem | null)?.code;
  const none = (history: HistoryState) => ({ ...shared, history, commits: [], next: null });
  // An empty repository has no history; a page that can't be read says so and leads back.
  if (result.status === 409 && refused === "repo_empty") return none("repo-empty");
  if (result.status === 422 && refused === "history_too_wide") return none("too-wide");
  if (result.status === 422 && refused === "invalid_cursor") return none("stale-cursor");
  // Any other failure is shown as one.
  const page = bodyOf(result, request);
  const history: HistoryState =
    page.commits.length > 0
      ? "commits"
      : page.next_cursor
        ? "stretch-empty"
        : cursor
          ? "no-older"
          : path !== null
            ? "none-here"
            : ref !== null
              ? "none-at-revision"
              : "repo-empty";
  return { ...shared, history, commits: page.commits, next: page.next_cursor };
}

/** What a page without rows says. The pager's link goes on from an empty stretch. */
function NoRows({ history, firstPage }: { history: HistoryState; firstPage: string }) {
  const start = <Link to={firstPage}>Back to the newest commits</Link>;
  switch (history) {
    case "repo-empty":
      return <p className="muted">No commits yet.</p>;
    case "none-here":
      return <p className="muted">No commits changed this path at this revision.</p>;
    case "none-at-revision":
      return <p className="muted">No commits at this revision.</p>;
    case "stretch-empty":
      return <p className="muted">No changes in this stretch of history.</p>;
    case "no-older":
      return <p className="muted">No older changes. {start}</p>;
    case "too-wide":
      return <p className="muted">This history is too branched to walk further. {start}</p>;
    case "stale-cursor":
      return <p className="muted">This page of history is no longer valid. {start}</p>;
    default:
      return null;
  }
}

export default function Commits({ loaderData }: Route.ComponentProps) {
  const { repo, origin, commits, next, history, ref, path, firstPage } = loaderData;
  const base = `/${repo.owner}/${repo.name}`;
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="commits" />
      {ref !== null && (
        <h2>
          {path !== null ? (
            <>
              History of <code>{path}</code> at <code>{ref}</code>
            </>
          ) : (
            <>
              History at <code>{ref}</code>
            </>
          )}
        </h2>
      )}
      {path !== null && <p className="muted">Renames aren't followed.</p>}
      {commits.length === 0 ? (
        <NoRows history={history} firstPage={firstPage} />
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
                  <Link to={`${base}/tree/${c.sha}`} aria-label={`Files at ${c.sha.slice(0, 7)}`}>
                    <code>{c.sha.slice(0, 7)}</code>
                  </Link>
                  {path !== null && (
                    <>
                      <br />
                      <Link to={`${base}/blob/${c.sha}/${encodePath(path)}`}>View file</Link>
                    </>
                  )}
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
          <Link to={`${firstPage}?cursor=${encodeURIComponent(next)}`}>
            {commits.length === 0 ? "Continue" : "Older commits"}
          </Link>
        </p>
      )}
    </main>
  );
}
