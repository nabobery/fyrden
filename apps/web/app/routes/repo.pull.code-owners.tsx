import type { getPullCodeOwners, Output } from "@fyrden/api-contract";
import { Link } from "react-router";
import { Pager } from "../components/pager.js";
import { PullHeader } from "../components/pull-header.js";
import { apiCall, apiGet, bodyOf, signedInUser } from "../lib/api.server.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import {
  type PullRequest,
  problemCode,
  problemDetail,
  pullApiPath,
  pullNumber,
  when,
} from "../lib/pulls.js";
import { encodePath } from "../lib/types.js";
import type { Route } from "./+types/repo.pull.code-owners";

type CodeOwners = Output<typeof getPullCodeOwners>;

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Code owners of #${params.number} · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const number = pullNumber(params.number);
  const api = pullApiPath(params.owner, params.repo, number);
  const read = (query: string) =>
    apiCall<CodeOwners>(context, request, "GET", `${api}/code-owners?${query}`);
  const [pull, first, user] = await Promise.all([
    apiGet<PullRequest>(context, request, api),
    read(pageQuery(url, "cursor", 30)),
    signedInUser(context, request),
  ]);
  let owners = first;
  let restarted = false;
  // A cursor of an evaluation since replaced: the rules are read again from the first page.
  if (
    owners.status === 422 &&
    problemCode(owners.body) === "invalid_cursor" &&
    url.searchParams.has("cursor")
  ) {
    owners = await read(pageQuery(new URL(url.pathname, url.origin), "cursor", 30));
    restarted = true;
  }
  // Closed: worked out for open pull requests only. Other refusals are shown as the API says.
  const refused =
    owners.status === 200
      ? null
      : problemCode(owners.body) === "pull_not_open"
        ? "Code owners are shown while the pull request is open."
        : problemDetail(owners.body, "Its code owners could not be read.");
  const view = owners.status === 200 ? bodyOf(owners, request) : null;
  return {
    at: { owner: params.owner, repo: params.repo, number },
    pull,
    view,
    refused,
    restarted,
    pages: pageLinks(
      restarted ? new URL(url.pathname, url.origin) : url,
      "cursor",
      view?.next_cursor ?? null,
    ),
    viewer: user?.id ?? null,
  };
}

/** What a state of the evaluation means, as the page says it. */
const STATE: Record<CodeOwners["state"], string> = {
  pending: "Being worked out for the current base and head; read this page again shortly.",
  complete: "Worked out for the current base and head.",
  none: "The base branch has no CODEOWNERS file: no changed path has code owners.",
  too_large: "Too large to work out; a merge that needs code owners' review is refused.",
  unreadable: "Could not be read just now.",
};

const TOO_LARGE: Record<NonNullable<CodeOwners["reason"]>, string> = {
  file: "the CODEOWNERS file is too large",
  tree: "a tree on the way is too large",
  depth: "the paths are too deep",
  scan: "the changes are too many to scan",
  work: "matching took more work than allowed",
  merge_base: "the merge base could not be found within its budget",
  stuck: "it did not finish",
  path: "a path is too long",
};

/**
 * Who owns what a pull request changes, under its base branch's
 * CODEOWNERS: the rules deciding its changed paths, their owners and how
 * many paths each decides. It says nothing of whether they approved: a
 * merge that needs their review is refused by the API, with why.
 */
export default function CodeOwnersPage({ loaderData }: Route.ComponentProps) {
  const { at, pull, view, refused, restarted, pages, viewer } = loaderData;
  const base = `/${encodeURIComponent(at.owner)}/${encodeURIComponent(at.repo)}`;
  return (
    <main>
      <PullHeader
        owner={at.owner}
        repo={at.repo}
        pull={pull}
        viewer={viewer}
        active="code-owners"
      />
      <section className="panel" aria-labelledby="code-owners">
        <h2 id="code-owners">Code owners</h2>
        {refused !== null ? (
          <p className="muted">{refused}</p>
        ) : (
          view && (
            <>
              <p>
                {STATE[view.state]}
                {view.state === "too_large" && view.reason && ` (${TOO_LARGE[view.reason]})`}
                {view.state === "unreadable" &&
                  view.retry_at !== null &&
                  ` It is tried again ${when(view.retry_at)}.`}
              </p>
              {restarted && (
                <p className="muted" role="status">
                  They were worked out again since that page: shown from the first rule.
                </p>
              )}
              {view.file && (
                <p>
                  {"From "}
                  <Link
                    to={`${base}/blob/${encodeURIComponent(pull.base.ref)}/${encodePath(view.file.path)}`}
                  >
                    <code>{view.file.path}</code>
                  </Link>
                  {" on "}
                  <code className="branch">{pull.base.ref}</code>
                  {view.errors > 0 && (
                    <span className="error">
                      {` · ${view.errors} invalid line${view.errors === 1 ? "" : "s"}: a merge that needs code owners' review is refused`}
                    </span>
                  )}
                </p>
              )}
              {view.rules.length > 0 && (
                <table>
                  <caption className="visually-hidden">Rules deciding its changed paths</caption>
                  <thead>
                    <tr>
                      <th scope="col">Line</th>
                      <th scope="col">Owners</th>
                      <th scope="col">Changed paths</th>
                      <th scope="col">The first</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.rules.map((rule) => (
                      <tr key={rule.line}>
                        <td>{rule.line}</td>
                        <td>
                          {rule.owners.length === 0 ? (
                            <span className="muted">none (no owner needed)</span>
                          ) : (
                            rule.owners.join(", ")
                          )}
                        </td>
                        <td>{rule.paths}</td>
                        <td>
                          <code className="pre-wrap">{rule.example_path}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Pager links={pages} label="Rule" />
              {(view.unmatched_paths > 0 || view.unmatchable_paths > 0) && (
                <p className="muted">
                  {view.unmatched_paths > 0 &&
                    `${view.unmatched_paths} changed path${view.unmatched_paths === 1 ? "" : "s"} no rule matches (no code owners). `}
                  {view.unmatchable_paths > 0 &&
                    `${view.unmatchable_paths} path${view.unmatchable_paths === 1 ? " is" : "s are"} not UTF-8 and never matched: a merge that needs code owners' review is refused.`}
                </p>
              )}
            </>
          )
        )}
      </section>
    </main>
  );
}
