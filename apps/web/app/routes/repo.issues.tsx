import { useRef } from "react";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { LabelChip } from "../components/label-chip.js";
import { Pager } from "../components/pager.js";
import { RepoHeader } from "../components/repo-header.js";
import {
  apiCall,
  apiCallBounded,
  apiGet,
  assertSameOrigin,
  bodyOf,
  checkSession,
  readForm,
} from "../lib/api.server.js";
import {
  ISSUE_FILTERS,
  ISSUE_FORM_MAX_BYTES,
  ISSUE_STATES,
  type Issue,
  type IssuesPage,
  issuePage,
  issueStatus,
  listingOf,
} from "../lib/issues.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import { field, problemDetail, rawField, repoApiPath, when, who } from "../lib/pulls.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.issues";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Issues · ${params.owner}/${params.repo} · Fyrden` }];
}

const FILTER_LABEL = {
  labels: "Labels (names, comma-separated)",
  label_ids: "Label ids (comma-separated, for names holding a comma)",
  assignee: "Assignee (a handle, none or *)",
  milestone: "Milestone (a number, none or *)",
  creator: "Author (a handle)",
} as const;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const base = repoApiPath(params.owner, params.repo);
  const { state, filters } = listingOf(url);
  const query = new URLSearchParams({ state, type: "issues", ...filters });
  const [repo, page, session] = await Promise.all([
    apiGet<Repo>(context, request, base),
    apiCallBounded<IssuesPage>(
      context,
      request,
      `${base}/issues?${query}&${pageQuery(url, "cursor", 30)}`,
    ),
    checkSession(context, request),
  ]);
  const listed = bodyOf(page, request);
  return {
    repo,
    origin: url.origin,
    state,
    filters,
    issues: listed.issues,
    pages: pageLinks(url, "cursor", listed.next_cursor),
    viewer: session.state === "signed-in" ? session.user.id : null,
    // A session check that failed says nothing of who is viewing: the page keeps the last known.
    viewerKnown: session.state !== "unknown",
    proposed: url.searchParams.get("new") === "1",
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request, ISSUE_FORM_MAX_BYTES);
  const body = rawField(form, "body");
  // The form was made for one viewer: another signed in since (another tab) sends nothing.
  const session = await checkSession(context, request);
  const draft = (viewer: string) => ({ title: field(form, "title"), body, viewer });
  if (session.state === "unknown")
    // Not known who is signed in: nothing is sent; the text comes back to the form's viewer.
    return {
      error: "Your session could not be checked just now: nothing was sent; send it again.",
      draft: draft(field(form, "viewer")),
    };
  if (session.state !== "signed-in" || session.user.id !== field(form, "viewer"))
    return { error: "You are signed in as someone else now: reload the page.", draft: undefined };
  let made: Awaited<ReturnType<typeof apiCall<Issue>>>;
  try {
    made = await apiCall<Issue>(
      context,
      request,
      "POST",
      `${repoApiPath(params.owner, params.repo)}/issues`,
      { title: field(form, "title"), ...(body.trim() && { body }) },
    );
  } catch {
    return {
      error:
        "Fyrden could not be reached, or its answer read: the issue may or may not have been opened. Check the list before sending again (your text is kept below).",
      draft: draft(session.user.id),
    };
  }
  if (made.status !== 201)
    return {
      error: problemDetail(made.body, "The issue was not opened."),
      draft: draft(session.user.id),
    };
  return redirect(issuePage(params.owner, params.repo, made.body.number));
}

export default function Issues({ loaderData }: Route.ComponentProps) {
  const failed = useActionData<typeof action>();
  const navigation = useNavigation();
  const { repo, origin, state, filters, issues, pages, proposed } = loaderData;
  // A failed session check keeps the viewer last known (its draft with it); a confirmed one is taken.
  const known = useRef(loaderData.viewer);
  if (loaderData.viewerKnown) known.current = loaderData.viewer;
  const viewer = known.current;
  // A draft returned is shown only to the viewer it was written by.
  const draft = failed?.draft?.viewer === viewer ? failed?.draft : undefined;
  const base = `/${repo.owner}/${repo.name}`;
  const withState = (s: string) => {
    const query = new URLSearchParams({ ...(s !== "open" && { state: s }), ...filters });
    const search = query.toString();
    return search ? `${base}/issues?${search}` : `${base}/issues`;
  };
  const filtered = Object.keys(filters).length > 0;
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="issues" />
      <nav aria-label="Issues" className="row">
        <Link to={`${base}/issues`} aria-current="page">
          Issues
        </Link>
        <Link to={`${base}/labels`}>Labels</Link>
      </nav>
      <nav aria-label="Filter issues by state" className="row">
        {ISSUE_STATES.map((s) => (
          <Link key={s} to={withState(s)} aria-current={state === s ? "page" : undefined}>
            {s === "open" ? "Open" : s === "closed" ? "Closed" : "All"}
          </Link>
        ))}
      </nav>
      <details className="panel" open={filtered}>
        <summary>Filters</summary>
        {/* Keyed by the filters applied: its fields always show them (clearing clears them). */}
        <Form method="get" key={JSON.stringify(filters)}>
          {state !== "open" && <input type="hidden" name="state" value={state} />}
          {ISSUE_FILTERS.map((name) => (
            <p key={name}>
              <label htmlFor={`filter-${name}`}>{FILTER_LABEL[name]}</label>
              <input id={`filter-${name}`} name={name} defaultValue={filters[name] ?? ""} />
            </p>
          ))}
          <p className="row">
            <button type="submit">Filter</button>
            {filtered && (
              <Link to={state === "open" ? `${base}/issues` : `${base}/issues?state=${state}`}>
                Clear filters
              </Link>
            )}
          </p>
        </Form>
      </details>
      {issues.length === 0 ? (
        <p className="muted">
          {pages.first || pages.next
            ? "None on this page (filtered pages can be short)."
            : filtered
              ? "No issues match."
              : state === "all"
                ? "No issues yet."
                : `No ${state} issues.`}
        </p>
      ) : (
        <ul className="pull-list" aria-label="Issues">
          {issues.map((issue) => {
            const status = issueStatus(issue);
            return (
              <li key={issue.number}>
                <span className={`badge ${status.className}`}>{status.label}</span>{" "}
                <Link to={issuePage(repo.owner, repo.name, issue.number)}>{issue.title}</Link>{" "}
                {issue.labels.map((label) => (
                  <LabelChip key={label.id} label={label} />
                ))}{" "}
                <span className="muted">
                  #{issue.number} · by {who(issue.user.id, viewer)} · opened{" "}
                  {when(issue.created_at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Pager links={pages} label="Issue" />
      {!loaderData.viewerKnown && (
        <p className="muted" role="status">
          Your session could not be checked just now; your draft is kept.
        </p>
      )}
      {viewer !== null && (
        // Keyed by the repository and who writes: another viewer's page starts empty.
        <details
          key={`${repo.full_name}:${viewer}`}
          className="panel"
          open={proposed || draft !== undefined}
        >
          <summary>New issue</summary>
          <Form method="post">
            <input type="hidden" name="viewer" value={viewer} />
            <label htmlFor="issue-title">Title</label>
            <input
              id="issue-title"
              name="title"
              required
              maxLength={256}
              size={60}
              defaultValue={draft?.title ?? ""}
            />
            <label htmlFor="issue-body">Description (Markdown, optional)</label>
            <textarea
              id="issue-body"
              name="body"
              className="short"
              defaultValue={draft?.body ?? ""}
            />
            <p>
              <button
                className="primary"
                type="submit"
                disabled={navigation.state === "submitting"}
              >
                Open issue
              </button>
            </p>
            {failed?.error && (
              <p className="error" role="alert">
                {failed.error}
              </p>
            )}
          </Form>
        </details>
      )}
    </main>
  );
}
