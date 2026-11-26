import { data, Form, Link } from "react-router";
import { RepoHeader } from "../components/repo-header.js";
import { At, duration, RunState, Who } from "../components/run-ui.js";
import { apiCall, apiCallBounded, apiGet, bodyOf, type Problem } from "../lib/api.server.js";
import {
  type FilterError,
  type RunFilters,
  type RunSummary,
  type RunsPage,
  runFilters,
  runFiltersQuery,
  runPath,
  runsApi,
  runsApiQuery,
  runsPath,
  STATUS_CHOICES,
  type WorkflowsPage,
  workflowRunsPath,
} from "../lib/runs.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.actions";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Actions · ${params.owner}/${params.repo} · Fyrden` }];
}

type Listing =
  | { kind: "runs"; runs: RunSummary[]; next: string | null }
  | { kind: "filter-errors"; errors: FilterError[] }
  | { kind: "refused"; detail: string }
  | { kind: "stale-cursor" };

const WORKFLOWS_PER_PAGE = 100;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const api = runsApi(params.owner, params.repo);
  const workflow = "workflow" in params ? workflowOf(url.pathname) : null;
  const cursor = url.searchParams.get("cursor");
  const { filters, errors } = runFilters(url);
  const workflowsCursor = url.searchParams.get("workflows_cursor");
  const repo = apiGet<Repo>(
    context,
    request,
    `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`,
  );
  const workflows = apiCall<WorkflowsPage>(
    context,
    request,
    "GET",
    `${api}/workflows?per_page=${WORKFLOWS_PER_PAGE}${workflowsCursor ? `&cursor=${encodeURIComponent(workflowsCursor)}` : ""}`,
  ).then(
    (r) => (r.status === 200 ? r.body : null),
    () => null,
  );
  const listing = async (): Promise<Listing> => {
    if (errors.length > 0) return { kind: "filter-errors", errors };
    const path =
      workflow === null ? `${api}/runs` : `${api}/workflows/${encodeURIComponent(workflow)}/runs`;
    const result = await apiCallBounded<RunsPage>(
      context,
      request,
      `${path}?${runsApiQuery(filters, cursor)}`,
    );
    const problem = result.body as unknown as Problem | null;
    if (result.status === 422 && problem?.code === "invalid_cursor")
      return { kind: "stale-cursor" };
    if (result.status === 422)
      return { kind: "refused", detail: problem?.detail ?? "The filters were refused." };
    const page = bodyOf(result, request);
    return { kind: "runs", runs: page.workflow_runs, next: page.next_cursor };
  };
  const [repoBody, listed, workflowsBody] = await Promise.all([repo, listing(), workflows]);
  return {
    repo: repoBody,
    origin: url.origin,
    search: url.search,
    workflow,
    filters,
    cursor,
    listing: listed,
    workflows: workflowsBody,
    workflowsCursor,
  };
}

/**
 * The workflow file named by the path's own last segment, decoded once: the
 * router's parameter is decoded twice for an escaped `%`, so a file named
 * `a%2Fb.yml` would read as `a/b.yml`. A client navigation's data request
 * ends in `.data` (measured), which no workflow file does: they end in `.yml` or `.yaml`.
 */
function workflowOf(pathname: string): string {
  const segment =
    pathname
      .replace(/\.data$/, "")
      .replace(/\/+$/, "")
      .split("/")
      .at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    throw data("No such workflow.", { status: 404 });
  }
}

function Filters({
  filters,
  errors,
  action,
  search,
}: {
  filters: RunFilters;
  errors: FilterError[];
  action: string;
  search: string;
}) {
  const error = (field: FilterError["field"]) => errors.find((e) => e.field === field);
  const field = (
    name: string,
    label: string,
    value: string | undefined,
    key: FilterError["field"],
    extra: Record<string, string> = {},
  ) => {
    const problem = error(key);
    return (
      <div>
        <label htmlFor={`f-${name}`}>{label}</label>
        <input
          id={`f-${name}`}
          name={name}
          className="run-filter-input"
          defaultValue={value ?? ""}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `f-${key}-error` : undefined}
          {...extra}
        />
      </div>
    );
  };
  return (
    <Form
      method="get"
      action={action}
      className="run-filters"
      aria-label="Filter runs"
      key={`${action}${search}`}
    >
      <div className="row">
        <div>
          <label htmlFor="f-status">Status</label>
          <select id="f-status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Any</option>
            {STATUS_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        {field("event", "Event", filters.event, "event", { placeholder: "push" })}
        {field("branch", "Branch", filters.branch, "branch")}
        {field("actor", "Triggered by", filters.actor, "actor", { placeholder: "handle" })}
        {field("sha", "Commit", filters.sha, "sha", { size: "12", spellCheck: "false" })}
        {field("created_from", "Created from", filters.createdFrom, "created", { type: "date" })}
        {field("created_to", "Created to", filters.createdTo, "created", { type: "date" })}
      </div>
      <div className="row">
        <button type="submit">Filter</button>
        <Link to={action}>Clear</Link>
      </div>
      {errors.length > 0 && (
        <div role="alert">
          {errors.map((e) => (
            <p key={e.field} id={`f-${e.field}-error`} className="error">
              {e.message}
            </p>
          ))}
        </div>
      )}
    </Form>
  );
}

function RunRow({ run, owner, repo }: { run: RunSummary; owner: string; repo: string }) {
  const took = duration(run.run_started_at, run.completed_at);
  return (
    <li className="run-row">
      <div className="row">
        <RunState status={run.status} conclusion={run.conclusion} />
        <Link to={runPath(owner, repo, run.id)} className="run-title">
          {run.display_title}
        </Link>
      </div>
      <p className="muted run-meta">
        {run.name}
        {run.run_number !== null && <> #{run.run_number}</>} · {run.event} ·{" "}
        {run.pull_request ? (
          <Link to={`/${owner}/${repo}/pull/${run.pull_request.number}`}>
            pull request #{run.pull_request.number}
          </Link>
        ) : (
          run.head_branch !== null && <code>{run.head_branch}</code>
        )}
        {run.fork && " (fork)"} ·{" "}
        <Link to={`/${owner}/${repo}/tree/${run.head_sha}`}>
          <code>{run.head_sha.slice(0, 7)}</code>
        </Link>{" "}
        · by <Who id={run.actor.id} /> · <At ms={run.created_at} />
        {took !== null && <> · took {took}</>}
      </p>
    </li>
  );
}

function Sidebar({
  workflows,
  owner,
  repo,
  current,
  filters,
  workflowsCursor,
}: {
  workflows: WorkflowsPage | null;
  owner: string;
  repo: string;
  current: string | null;
  filters: RunFilters;
  workflowsCursor: string | null;
}) {
  const withFilters = (path: string, sidebarCursor: string | null) => {
    const query = new URLSearchParams(runFiltersQuery(filters).slice(1));
    if (sidebarCursor) query.set("workflows_cursor", sidebarCursor);
    const text = query.toString();
    return text ? `${path}?${text}` : path;
  };
  if (workflows === null) return <p className="muted">The workflows could not be listed.</p>;
  return (
    <details className="run-workflows" open>
      <summary>
        Workflows with runs
        {workflows.next_cursor !== null || workflowsCursor ? " (100 a page)" : ""}
      </summary>
      {/* biome-ignore lint/a11y/noRedundantRoles: without markers, WebKit reads a list as a group unless told. */}
      <ul role="list">
        <li>
          <Link
            to={withFilters(runsPath(owner, repo), workflowsCursor)}
            aria-current={current === null ? "page" : undefined}
          >
            All runs
          </Link>
        </li>
        {workflows.workflows.map((w) => (
          <li key={w.path}>
            <Link
              to={withFilters(workflowRunsPath(owner, repo, w.id), workflowsCursor)}
              aria-current={current === w.id ? "page" : undefined}
            >
              {w.name ?? w.path}
            </Link>
          </li>
        ))}
      </ul>
      {(workflows.next_cursor !== null || workflowsCursor) && (
        <p className="row">
          {workflowsCursor && (
            <Link
              to={withFilters(
                current === null ? runsPath(owner, repo) : workflowRunsPath(owner, repo, current),
                null,
              )}
            >
              First workflows
            </Link>
          )}
          {workflows.next_cursor !== null && (
            <Link
              to={withFilters(
                current === null ? runsPath(owner, repo) : workflowRunsPath(owner, repo, current),
                workflows.next_cursor,
              )}
            >
              More workflows
            </Link>
          )}
        </p>
      )}
      <p className="muted">A workflow file that has not run yet is not listed.</p>
    </details>
  );
}

export default function Actions({ loaderData }: Route.ComponentProps) {
  const { repo, origin, search, workflow, filters, cursor, listing, workflows, workflowsCursor } =
    loaderData;
  const owner = repo.owner;
  const name = repo.name;
  const here = workflow === null ? runsPath(owner, name) : workflowRunsPath(owner, name, workflow);
  const shown = workflows?.workflows.find((w) => w.id === workflow);
  const newest = `${here}${runFiltersQuery(filters)}`;
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="actions" />
      <div className="runs-layout">
        <Sidebar
          workflows={workflows}
          owner={owner}
          repo={name}
          current={workflow}
          filters={filters}
          workflowsCursor={workflowsCursor}
        />
        <section aria-labelledby="runs-title">
          <h2 id="runs-title" className="run-wrap">
            {workflow === null ? "Runs" : <>Runs of {shown?.name ?? <code>{workflow}</code>}</>}
          </h2>
          <Filters
            filters={filters}
            errors={listing.kind === "filter-errors" ? listing.errors : []}
            action={here}
            search={search}
          />
          {listing.kind === "refused" && (
            <p role="alert" className="error">
              {listing.detail}
            </p>
          )}
          {listing.kind === "stale-cursor" && (
            <p className="muted">
              This page of runs is no longer valid. <Link to={newest}>Back to the newest runs</Link>
            </p>
          )}
          {listing.kind === "runs" &&
            (listing.runs.length === 0 ? (
              <p className="muted">
                {listing.next !== null
                  ? "No runs matched in this stretch of history."
                  : cursor
                    ? "No older runs."
                    : Object.keys(filters).length > 0
                      ? "No runs match these filters."
                      : "No runs yet. Workflows go in .github/workflows or .fyrden/workflows."}
              </p>
            ) : (
              // biome-ignore lint/a11y/noRedundantRoles: without markers, WebKit reads a list as a group unless told.
              <ul role="list" className="runs">
                {listing.runs.map((run) => (
                  <RunRow key={run.id} run={run} owner={owner} repo={name} />
                ))}
              </ul>
            ))}
          {listing.kind === "runs" && (cursor || listing.next !== null) && (
            <nav className="pager" aria-label="Run pages">
              {cursor && <Link to={newest}>Newest runs</Link>}
              {listing.next !== null && (
                <Link to={`${here}${runFiltersQuery(filters, listing.next)}`}>Older runs</Link>
              )}
            </nav>
          )}
        </section>
      </div>
    </main>
  );
}
