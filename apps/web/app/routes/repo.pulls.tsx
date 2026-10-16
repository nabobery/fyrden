import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { Pager } from "../components/pager.js";
import { BranchName, PullStatusBadge } from "../components/pull-header.js";
import { RepoHeader } from "../components/repo-header.js";
import { apiCall, apiGet, assertSameOrigin, readForm, signedInUser } from "../lib/api.server.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import {
  field,
  type PullRequest,
  problemDetail,
  pullPage,
  rawField,
  repoApiPath,
  when,
  who,
} from "../lib/pulls.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.pulls";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Pull requests · ${params.owner}/${params.repo} · Fyrden` }];
}

const STATES = ["open", "closed", "all"] as const;
type StateFilter = (typeof STATES)[number];

/** The listing's state filter from the page's URL (open unless it names another). */
function stateFilter(url: URL): StateFilter {
  const state = url.searchParams.get("state");
  return STATES.find((s) => s === state) ?? "open";
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const base = repoApiPath(params.owner, params.repo);
  const state = stateFilter(url);
  const [repo, page, branches, user] = await Promise.all([
    apiGet<Repo>(context, request, base),
    apiGet<{ pull_requests: PullRequest[]; next_cursor: string | null }>(
      context,
      request,
      `${base}/pulls?state=${state}&${pageQuery(url, "cursor", 30)}`,
    ),
    // Suggestions for the form only: a failure leaves the fields free text.
    apiCall<{ branches: { name: string }[] }>(
      context,
      request,
      "GET",
      `${base}/branches?per_page=100`,
    ),
    signedInUser(context, request),
  ]);
  return {
    repo,
    origin: url.origin,
    state,
    pulls: page.pull_requests,
    pages: pageLinks(url, "cursor", page.next_cursor),
    branches: branches.status === 200 ? branches.body.branches.map((b) => b.name) : [],
    viewer: user?.id ?? null,
    // A link may open the form with its branches chosen.
    proposed: {
      open: url.searchParams.get("new") === "1",
      head: url.searchParams.get("head") ?? "",
      base: url.searchParams.get("base") ?? "",
    },
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request);
  const head = field(form, "head");
  const headRepo = field(form, "head_repo");
  const body = rawField(form, "body");
  const forked = head.includes(":");
  const made = await apiCall<PullRequest>(
    context,
    request,
    "POST",
    `${repoApiPath(params.owner, params.repo)}/pulls`,
    {
      title: field(form, "title"),
      ...(body.trim() && { body }),
      head,
      base: field(form, "base"),
      draft: form.get("draft") === "on",
      // Only meaningful for a head in a fork (the API keeps it false otherwise).
      ...(forked && { maintainer_can_modify: form.get("maintainer_can_modify") === "on" }),
      ...(forked && headRepo && { head_repo: headRepo }),
    },
  );
  if (made.status !== 201)
    return { error: problemDetail(made.body, "The pull request was not opened.") };
  return redirect(pullPage(params.owner, params.repo, made.body.number));
}

export default function Pulls({ loaderData }: Route.ComponentProps) {
  const failed = useActionData<typeof action>();
  const navigation = useNavigation();
  const { repo, origin, state, pulls, pages, branches, viewer, proposed } = loaderData;
  const base = `/${repo.owner}/${repo.name}`;
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="pulls" />
      <nav aria-label="Filter pull requests" className="row">
        {STATES.map((s) => (
          <Link
            key={s}
            to={s === "open" ? `${base}/pulls` : `${base}/pulls?state=${s}`}
            aria-current={state === s ? "page" : undefined}
          >
            {s === "open" ? "Open" : s === "closed" ? "Closed" : "All"}
          </Link>
        ))}
      </nav>
      {pulls.length === 0 ? (
        <p className="muted">
          {state === "all" ? "No pull requests yet." : `No ${state} pull requests.`}
        </p>
      ) : (
        <ul className="pull-list" aria-label="Pull requests">
          {pulls.map((p) => (
            <li key={p.number}>
              <PullStatusBadge pull={p} />{" "}
              <Link to={pullPage(repo.owner, repo.name, p.number)}>{p.title}</Link>{" "}
              <span className="muted">
                #{p.number} · <BranchName name={p.head.ref} fork={p.head_repo_id !== null} /> into{" "}
                <BranchName name={p.base.ref} /> · by {who(p.user.id, viewer)} · opened{" "}
                {when(p.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Pager links={pages} label="Pull request" />
      <details className="panel" open={proposed.open || failed !== undefined}>
        <summary>New pull request</summary>
        <Form method="post">
          <datalist id="branches">
            {branches.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
          <label htmlFor="pr-base">Base branch (merge into)</label>
          <input
            id="pr-base"
            name="base"
            list="branches"
            required
            defaultValue={proposed.base || repo.default_branch}
          />
          <label htmlFor="pr-head">Head branch (with the changes)</label>
          <input
            id="pr-head"
            name="head"
            list="branches"
            required
            defaultValue={proposed.head}
            aria-describedby="pr-head-help"
          />
          <p id="pr-head-help" className="muted">
            A branch of this repository, or <code>owner:branch</code> for a branch of a fork.
          </p>
          <label htmlFor="pr-head-repo">Fork's repository name (optional)</label>
          <input id="pr-head-repo" name="head_repo" aria-describedby="pr-head-repo-help" />
          <p id="pr-head-repo-help" className="muted">
            Only when the fork's owner has several repositories in this network.
          </p>
          <label htmlFor="pr-title">Title</label>
          <input id="pr-title" name="title" required maxLength={256} size={60} />
          <label htmlFor="pr-body">Description (Markdown, optional)</label>
          <textarea id="pr-body" name="body" className="short" />
          <p>
            <input id="pr-draft" name="draft" type="checkbox" />{" "}
            <label htmlFor="pr-draft" className="inline">
              Open as a draft
            </label>
          </p>
          <p>
            <input
              id="pr-maintainer"
              name="maintainer_can_modify"
              type="checkbox"
              aria-describedby="pr-maintainer-help"
            />{" "}
            <label htmlFor="pr-maintainer" className="inline">
              Allow edits by maintainers
            </label>
          </p>
          <p id="pr-maintainer-help" className="muted">
            For a head branch in a fork: those with write access here may update it, resolve its
            conflicts and apply suggestions to it.
          </p>
          <p>
            <button className="primary" type="submit" disabled={navigation.state === "submitting"}>
              Open pull request
            </button>
          </p>
          {failed?.error && (
            <p className="error" role="alert">
              {failed.error}
            </p>
          )}
        </Form>
      </details>
    </main>
  );
}
