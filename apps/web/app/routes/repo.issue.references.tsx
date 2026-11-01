import type { listIssueReferences, Output } from "@fyrden/api-contract";
import { Link } from "react-router";
import { Pager } from "../components/pager.js";
import { apiGet, signedInUser } from "../lib/api.server.js";
import { type Issue, issueApiPath, issuePage } from "../lib/issues.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import { pullNumber, pullPage, when } from "../lib/pulls.js";
import type { Route } from "./+types/repo.issue.references";

type References = Output<typeof listIssueReferences>;
type Reference = References["references"][number];

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `References to #${params.number} · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const number = pullNumber(params.number);
  const api = issueApiPath(params.owner, params.repo, number);
  const [subject, page, user] = await Promise.all([
    apiGet<Issue>(context, request, api),
    apiGet<References>(context, request, `${api}/references?${pageQuery(url, "cursor", 30)}`),
    signedInUser(context, request),
  ]);
  return {
    at: { owner: params.owner, repo: params.repo, number },
    subject,
    references: page.references,
    pages: pageLinks(url, "cursor", page.next_cursor),
    viewer: user?.id ?? null,
  };
}

/** Where a reference's source is: its issue or pull request, or the comment on it naming it. */
function sourcePage(source: Reference["source"]): string {
  const [owner = "", repo = ""] = source.repository.split("/");
  const page =
    source.kind === "pull_request"
      ? pullPage(owner, repo, source.number)
      : issuePage(owner, repo, source.number);
  return source.comment_id === null
    ? page
    : `${page}?comment=${source.comment_id}#comment-${source.comment_id}`;
}

/**
 * The issues, pull requests and comments whose text names this issue or
 * pull request (`#12`, or `owner/repo#12` from another repository), a
 * page at a time: only those the viewer may read both ends of.
 */
export default function IssueReferences({ loaderData }: Route.ComponentProps) {
  const { at, subject, references, pages } = loaderData;
  const back = subject.pull_request
    ? pullPage(at.owner, at.repo, at.number)
    : issuePage(at.owner, at.repo, at.number);
  return (
    <main>
      <p>
        <Link to={back}>
          {`Back to ${subject.pull_request ? "the pull request" : "the issue"}`}{" "}
          <span className="muted">#{at.number}</span>
        </Link>
      </p>
      <h1>
        What refers to <span className="pull-title">{subject.title}</span>
      </h1>
      {references.length === 0 ? (
        <p className="muted">
          {pages.first || pages.next
            ? "None on this page (a page checks a few repositories at most: go on)."
            : "Nothing you can read refers to it."}
        </p>
      ) : (
        <ul className="label-list" aria-label="References">
          {references.map((reference) => {
            const { source } = reference;
            const kind = source.kind === "pull_request" ? "pull request" : "issue";
            return (
              <li
                key={`${source.repository}#${source.number}:${source.comment_id ?? ""}`}
                className="row"
              >
                <Link to={sourcePage(source)}>{`${source.repository}#${source.number}`}</Link>
                <span className="muted">
                  {source.comment_id === null ? `the ${kind}` : `a comment on the ${kind}`}
                  {`, ${when(reference.created_at)}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Pager links={pages} label="Reference" />
    </main>
  );
}
