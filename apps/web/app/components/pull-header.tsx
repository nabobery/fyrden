import { Link } from "react-router";
import { type PullRequest, pullPage, statusOf, when, who } from "../lib/pulls.js";

const STATUS_LABEL = { open: "Open", draft: "Draft", closed: "Closed", merged: "Merged" } as const;

/** A pull request's state as a badge. */
export function PullStatusBadge({
  pull,
}: {
  pull: Pick<PullRequest, "state" | "merged" | "draft">;
}) {
  const status = statusOf(pull);
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

/** A branch name as code; a head in a fork says so (the API names the fork by id only). */
export function BranchName({ name, fork }: { name: string; fork?: boolean }) {
  return (
    <code className="branch">
      {fork ? "fork:" : ""}
      {name}
    </code>
  );
}

/**
 * A pull request's title, number, state and branches, and its pages:
 * the conversation, the files it changes, its requested reviewers, its
 * code owners and, while it conflicts, its conflicts.
 */
export function PullHeader({
  owner,
  repo,
  pull,
  viewer,
  active,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
  viewer: string | null;
  active: "conversation" | "files" | "conflicts" | "reviewers" | "code-owners";
}) {
  const page = pullPage(owner, repo, pull.number);
  return (
    <>
      <p>
        <Link to={`/${owner}/${repo}`}>
          {owner}/{repo}
        </Link>{" "}
        / <Link to={`/${owner}/${repo}/pulls`}>Pull requests</Link>
      </p>
      <h1>
        <span className="pull-title">{pull.title}</span>{" "}
        <span className="muted">#{pull.number}</span>
      </h1>
      <p className="row">
        <PullStatusBadge pull={pull} />
        <span>
          {who(pull.user.id, viewer)} {pull.user.id === viewer ? "want" : "wants"} to merge{" "}
          <BranchName name={pull.head.ref} fork={pull.head_repo_id !== null} /> into{" "}
          <BranchName name={pull.base.ref} />
        </span>
        <span className="muted">opened {when(pull.created_at)}</span>
        {pull.head_ref_deleted && <span className="badge">head branch deleted</span>}
      </p>
      <nav aria-label="Pull request" className="row tabs">
        <Link to={page} aria-current={active === "conversation" ? "page" : undefined}>
          Conversation
        </Link>
        <Link to={`${page}/files`} aria-current={active === "files" ? "page" : undefined}>
          Files changed
        </Link>
        <Link to={`${page}/reviewers`} aria-current={active === "reviewers" ? "page" : undefined}>
          Reviewers
        </Link>
        <Link
          to={`${page}/code-owners`}
          aria-current={active === "code-owners" ? "page" : undefined}
        >
          Code owners
        </Link>
        {(pull.mergeable_state === "dirty" || active === "conflicts") && pull.state === "open" && (
          <Link to={`${page}/conflicts`} aria-current={active === "conflicts" ? "page" : undefined}>
            Conflicts
          </Link>
        )}
      </nav>
    </>
  );
}
