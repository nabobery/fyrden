import { data, Form, Link, redirect } from "react-router";
import { LabelChip } from "../components/label-chip.js";
import { apiCallBounded, signInUrl } from "../lib/api.server.js";
import { problemCode, problemDetail, when } from "../lib/pulls.js";
import {
  type IssueHit,
  type IssueResults,
  issueHit,
  type RepositoryHit,
  type RepositoryResults,
  repositoryHit,
  SEARCH_LIMITS,
  type SearchForm,
  type SearchPages,
  searchApiPath,
  searchFormOf,
  searchHref,
  searchPages,
  searchRequestOf,
} from "../lib/search.js";
import type { Route } from "./+types/search";

/*
 * Search: issues and pull requests, or repositories, within a scope (a
 * repository, an organization or a user, chosen here or written in the
 * query), a page of the API's ranked results at a time. Each navigation
 * makes one search call at most; nothing of it is cached, kept or
 * followed live (who may read what is decided afresh at each search).
 */

export function meta(): Route.MetaDescriptors {
  return [{ title: "Search · Fyrden" }];
}

/** Results are what the viewer may read now: no cache keeps the page, its data or its redirects. */
const NO_STORE = { "Cache-Control": "private, no-store" };

export function headers(): HeadersInit {
  return NO_STORE;
}

/**
 * Bytes of a search's answer read at most: the API refuses a page whose
 * items pass 1 MiB as JSON (`page_too_large`), so a little more than that
 * holds any page it sends.
 */
export const SEARCH_MAX_BYTES = 1024 * 1024 + 16 * 1024;

/** What the page says of each refusal the API names. */
const REFUSALS: Readonly<Record<string, string>> = {
  search_scope_too_broad:
    "That owner has more repositories than a search can look through. Name a repository (repo:owner/name).",
  prefix_too_broad: "A word ending in * stands for too many words here. Write more of it.",
  query_too_broad: "The query matches too much to rank. Add words, or narrow its scope.",
  sort_needs_scope:
    "A search without text, or sorted, needs one repository (repo:owner/name) and one state (is:open, is:closed or is:merged).",
  search_text_required: "A repository search needs words to match, besides its scope.",
  page_too_large: "This result is larger than a page can show, even alone.",
  repo_not_found: "No such repository, or you cannot read it.",
  search_rate_limited: "Too many searches just now. Try again in a minute.",
  search_budget: "Search has used its allowance for today. Try again tomorrow (UTC).",
  search_authorization_unavailable:
    "What you may read could not be checked just now. Try again shortly.",
  read_model_maintenance: "Search is under maintenance. Try again later.",
};

/** Refusals whose own detail says what to change, after the page's words. */
const DETAILED: Readonly<Record<string, string>> = {
  invalid_search_query: "The query could not be read:",
  unsupported_search_text: "The query holds text search cannot match:",
  invalid_input: "The search was refused:",
};

function refusal(status: number, body: unknown): string {
  const code = problemCode(body) ?? "";
  const known = Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined;
  if (known) return known;
  const detail = problemDetail(body, "");
  const lead = Object.hasOwn(DETAILED, code) ? DETAILED[code] : undefined;
  if (lead) return detail ? `${lead} ${detail}` : lead;
  return detail || `The search failed (${status}). Try again.`;
}

type Outcome =
  | { state: "idle" }
  | { state: "scope" }
  | { state: "invalid"; message: string }
  | { state: "refused"; message: string }
  | {
      state: "results";
      total: number;
      incomplete: boolean;
      issues: IssueHit[];
      repositories: RepositoryHit[];
      pages: SearchPages;
    };

export async function loader({ request, context }: Route.LoaderArgs) {
  const form = searchFormOf(new URL(request.url));
  const plan = searchRequestOf(form);
  const page = (outcome: Outcome) => data({ form, outcome }, { headers: NO_STORE });
  if (plan.state !== "ready") return page(plan);
  const asked = plan.request;
  const answer = await apiCallBounded<IssueResults | RepositoryResults>(
    context,
    request,
    searchApiPath(asked),
    SEARCH_MAX_BYTES,
  );
  // Signed out: sign in, then come back.
  if (answer.status === 401) throw redirect(signInUrl(request), { headers: NO_STORE });
  if (answer.status !== 200) {
    const code = problemCode(answer.body);
    // Fewer a page, from the first: the next navigation asks again (one search each).
    if (code === "page_too_large" && asked.perPage > 1)
      throw redirect(searchHref(form, 1, Math.max(1, Math.floor(asked.perPage / 2))), {
        headers: NO_STORE,
      });
    if (code === "search_scope_required") return page({ state: "scope" });
    return page({ state: "refused", message: refusal(answer.status, answer.body) });
  }
  const found = answer.body;
  return page({
    state: "results",
    total: found.total_count,
    incomplete: found.incomplete_results,
    issues: asked.type === "issues" ? (found as IssueResults).items.map(issueHit) : [],
    repositories:
      asked.type === "repositories" ? (found as RepositoryResults).items.map(repositoryHit) : [],
    pages: searchPages(form, asked, found.total_count),
  });
}

function SearchControls({ form }: { form: SearchForm }) {
  return (
    <Form method="get" action="/search" className="panel" role="search" aria-label="Search">
      <label htmlFor="search-q">Query</label>
      <input
        id="search-q"
        name="q"
        type="search"
        size={60}
        defaultValue={form.q}
        aria-describedby="search-q-help"
      />
      <p id="search-q-help" className="muted">
        Words, "quoted phrases" and qualifiers such as is:open, label:bug or author:handle. A scope
        may be written here too: repo:owner/name, org:handle or user:handle.
      </p>
      <div className="row search-options">
        <p>
          <label htmlFor="search-type">Search for</label>
          <select id="search-type" name="type" defaultValue={form.type}>
            <option value="issues">Issues and pull requests</option>
            <option value="repositories">Repositories</option>
          </select>
        </p>
        <p>
          <label htmlFor="search-scope">Scope</label>
          <select id="search-scope" name="scope" defaultValue={form.scope}>
            <option value="">Written in the query</option>
            <option value="repo">Repository</option>
            <option value="org">Organization</option>
            <option value="user">User</option>
          </select>
        </p>
        <p>
          <label htmlFor="search-scope-value">Repository (owner/name) or handle</label>
          <input id="search-scope-value" name="scope_value" defaultValue={form.scopeValue} />
        </p>
        <p>
          <label htmlFor="search-per-page">Results a page</label>
          <input
            id="search-per-page"
            name="per_page"
            type="number"
            min={1}
            max={SEARCH_LIMITS.perPage}
            defaultValue={form.perPage}
          />
        </p>
        {form.type === "issues" && (
          <>
            <p>
              <label htmlFor="search-sort">Sort</label>
              <select id="search-sort" name="sort" defaultValue={form.sort}>
                <option value="">Best match</option>
                <option value="created">Opened</option>
                <option value="updated">Updated</option>
              </select>
            </p>
            <p>
              <label htmlFor="search-order">Order</label>
              <select id="search-order" name="order" defaultValue={form.order}>
                <option value="desc">Newest first</option>
                <option value="asc">Oldest first</option>
              </select>
            </p>
          </>
        )}
      </div>
      <p>
        <button className="primary" type="submit">
          Search
        </button>
      </p>
    </Form>
  );
}

function SearchPager({ pages }: { pages: SearchPages }) {
  if (!pages.previous && !pages.next && pages.numbers.length === 0) return null;
  return (
    <nav className="pager" aria-label="Result pages">
      {pages.previous && (
        <Link to={pages.previous} rel="prev">
          Previous page
        </Link>
      )}
      {pages.numbers.length > 0 && (
        <ol className="page-numbers">
          {pages.numbers.map((n, i) =>
            n === null ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: a gap has no identity but its place
              <li key={`gap-${i}`} aria-hidden="true">
                …
              </li>
            ) : (
              <li key={n.page}>
                {n.page === pages.page ? (
                  <span aria-current="page">
                    <span className="visually-hidden">Page </span>
                    {n.page}
                  </span>
                ) : (
                  <Link to={n.href} aria-label={`Page ${n.page}`}>
                    {n.page}
                  </Link>
                )}
              </li>
            ),
          )}
        </ol>
      )}
      {pages.next && (
        <Link to={pages.next} rel="next">
          Next page
        </Link>
      )}
    </nav>
  );
}

function IssueList({ hits }: { hits: IssueHit[] }) {
  return (
    <ul className="pull-list" aria-label="Results">
      {hits.map((hit) => (
        <li key={hit.key}>
          <span className={`badge ${hit.status.className}`}>{hit.status.label}</span>{" "}
          <Link className="pull-title" to={hit.href}>
            {hit.title}
          </Link>{" "}
          {hit.labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
          <br />
          <span className="muted">
            <Link to={hit.repository.href}>{hit.repository.fullName}</Link>{" "}
            {hit.pull ? "pull request" : "issue"} #{hit.number} · by {hit.author} · updated{" "}
            {when(hit.updatedAt)}
          </span>
          {hit.excerpt && <p className="excerpt">{hit.excerpt}</p>}
        </li>
      ))}
    </ul>
  );
}

function RepositoryList({ hits }: { hits: RepositoryHit[] }) {
  return (
    <ul className="pull-list" aria-label="Results">
      {hits.map((hit) => (
        <li key={hit.key}>
          <Link className="pull-title" to={hit.href}>
            {hit.fullName}
          </Link>{" "}
          <span className="badge">{hit.visibility}</span>
          {hit.description && <p className="excerpt">{hit.description}</p>}
        </li>
      ))}
    </ul>
  );
}

export default function Search({ loaderData }: Route.ComponentProps) {
  const { form, outcome } = loaderData;
  return (
    <main>
      <h1>Search</h1>
      {/* Keyed by what was asked: its fields always show the search the page answers. */}
      <SearchControls key={JSON.stringify(form)} form={form} />
      {outcome.state === "scope" && (
        <p className="error" role="alert">
          Choose where to search: a repository, an organization or a user, with Scope above or in
          the query (repo:owner/name, org:handle or user:handle).
        </p>
      )}
      {(outcome.state === "invalid" || outcome.state === "refused") && (
        <p className="error" role="alert">
          {outcome.message}
        </p>
      )}
      {outcome.state === "results" && (
        <>
          <p role="status">
            {outcome.total === 0
              ? "No results."
              : outcome.total >= SEARCH_LIMITS.depth
                ? `${SEARCH_LIMITS.depth.toLocaleString("en")} or more results.`
                : `${outcome.total} ${outcome.total === 1 ? "result" : "results"}.`}
          </p>
          {outcome.incomplete && (
            <p className="notice">
              Results may be missing: search is not up to date for all of this scope just now, or
              more matched than a search counts.
            </p>
          )}
          {outcome.total > 0 &&
            outcome.issues.length === 0 &&
            outcome.repositories.length === 0 && <p className="muted">None on this page.</p>}
          {outcome.issues.length > 0 && <IssueList hits={outcome.issues} />}
          {outcome.repositories.length > 0 && <RepositoryList hits={outcome.repositories} />}
          <SearchPager pages={outcome.pages} />
        </>
      )}
    </main>
  );
}
