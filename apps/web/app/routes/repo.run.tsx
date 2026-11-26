import { data, Form, Link } from "react-router";
import { RepoHeader } from "../components/repo-header.js";
import { JobGraph } from "../components/run-graph.js";
import { At, duration, RunState, Who } from "../components/run-ui.js";
import { apiCallBounded, apiGet, bodyOf } from "../lib/api.server.js";
import {
  attemptOf,
  type Run,
  type RunGraph,
  runPath,
  runsApi,
  runsPath,
  waitingWords,
  workflowRunsPath,
} from "../lib/runs.js";
import type { Repo } from "../lib/types.js";
import { useRunRefresh } from "../lib/use-run-refresh.js";
import type { Route } from "./+types/repo.run";

export function meta({ loaderData, params }: Route.MetaArgs): Route.MetaDescriptors {
  const title = loaderData?.run.display_title ?? "Run";
  return [{ title: `${title} · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const api = runsApi(params.owner, params.repo);
  const runId = encodeURIComponent(params.run_id);
  const [repo, run] = await Promise.all([
    apiGet<Repo>(
      context,
      request,
      `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`,
    ),
    apiGet<Run>(context, request, `${api}/runs/${runId}`),
  ]);
  const attempt = attemptOf(url.searchParams.get("attempt"), run.run_attempt);
  if (attempt === null) throw data("The run has no such attempt.", { status: 404 });
  let graph: RunGraph | null = null;
  try {
    graph = bodyOf(
      await apiCallBounded<RunGraph>(
        context,
        request,
        `${api}/runs/${runId}/graph?attempt=${attempt}`,
      ),
      request,
    );
  } catch (error) {
    if (!isTooLarge(error)) throw error;
  }
  return {
    repo,
    origin: url.origin,
    run,
    attempt,
    graph,
    canAct: repo.permissions?.push === true,
  };
}

function isTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "init" in error &&
    (error as { init?: { status?: number } }).init?.status === 502
  );
}

function Attempts({ run, attempt, path }: { run: Run; attempt: number; path: string }) {
  if (run.run_attempt === 1) return null;
  return (
    <Form method="get" action={path} className="row" key={`${run.id}:${attempt}`}>
      <label htmlFor="attempt">Attempt</label>
      <select id="attempt" name="attempt" defaultValue={String(attempt)}>
        {Array.from({ length: run.run_attempt }, (_, i) => run.run_attempt - i).map((n) => (
          <option key={n} value={n}>
            {n === run.run_attempt ? `${n} (current)` : String(n)}
          </option>
        ))}
      </select>
      <button type="submit">Show</button>
    </Form>
  );
}

function Header({ run, owner, repo }: { run: Run; owner: string; repo: string }) {
  const took = duration(run.run_started_at, run.completed_at);
  return (
    <header className="run-header">
      <p className="muted">
        <Link to={runsPath(owner, repo)}>Actions</Link> /{" "}
        <Link to={workflowRunsPath(owner, repo, run.path.split("/").pop() ?? run.path)}>
          {run.name}
        </Link>
      </p>
      <h2 className="row">
        <RunState status={run.status} conclusion={run.conclusion} />
        <span className="run-title">{run.display_title}</span>
      </h2>
      <dl className="run-facts">
        {run.run_number !== null && (
          <>
            <dt>Run</dt>
            <dd>#{run.run_number}</dd>
          </>
        )}
        <dt>Workflow file</dt>
        <dd>
          <code>{run.path}</code>
        </dd>
        <dt>Event</dt>
        <dd>{run.event}</dd>
        <dt>{run.pull_request ? "Pull request" : "Branch"}</dt>
        <dd>
          {run.pull_request ? (
            <Link to={`/${owner}/${repo}/pull/${run.pull_request.number}`}>
              #{run.pull_request.number}
            </Link>
          ) : run.head_branch !== null ? (
            <code>{run.head_branch}</code>
          ) : (
            "none (a tag)"
          )}
          {run.fork && " (from a fork)"}
        </dd>
        <dt>Commit</dt>
        <dd>
          <Link to={`/${owner}/${repo}/tree/${run.head_sha}`}>
            <code>{run.head_sha.slice(0, 7)}</code>
          </Link>
        </dd>
        <dt>Triggered by</dt>
        <dd>
          <Who id={run.actor.id} />
          {run.triggering_actor.id !== run.actor.id && (
            <>
              ; attempt {run.run_attempt} by <Who id={run.triggering_actor.id} />
            </>
          )}
        </dd>
        <dt>Created</dt>
        <dd>
          <At ms={run.created_at} />
        </dd>
        {took !== null && (
          <>
            <dt>Took</dt>
            <dd>{took}</dd>
          </>
        )}
      </dl>
    </header>
  );
}

function Notes({ run }: { run: Run }) {
  return (
    <>
      {run.approval?.state === "waiting" && (
        <p className="panel" role="status">
          This run waits for a maintainer's approval before it starts: it comes from a fork's
          first-time contributor.
        </p>
      )}
      {run.faults.length > 0 && (
        <p className="panel muted">Background work for this run failed and is being retried.</p>
      )}
      {run.errors.length > 0 && (
        <section className="panel" aria-labelledby="run-errors">
          <h3 id="run-errors">The workflow could not run</h3>
          {/* biome-ignore lint/a11y/noRedundantRoles: without markers, WebKit reads a list as a group unless told. */}
          <ul role="list">
            {run.errors.map((e) => (
              <li key={`${e.path}\u0000${e.line}\u0000${e.column}\u0000${e.code}`}>
                <code>
                  {run.path}
                  {e.line > 0 && `:${e.line}${e.column > 0 ? `:${e.column}` : ""}`}
                </code>{" "}
                {e.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export default function RunPage({ loaderData }: Route.ComponentProps) {
  const { repo, origin, run, attempt, graph } = loaderData;
  const owner = repo.owner;
  const name = repo.name;
  const path = runPath(owner, name, run.id);
  const past = attempt !== run.run_attempt;
  const shownState = `${run.status}/${run.conclusion}/${run.run_attempt}/${graph?.jobs.map((j) => `${j.status}${j.jobs.map((i) => i.status).join()}`).join() ?? ""}`;
  const { stopped } = useRunRefresh(
    `${run.id}:${attempt}`,
    !past && run.status !== "completed",
    shownState,
    loaderData,
  );
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="actions" />
      <Header run={run} owner={owner} repo={name} />
      <Attempts run={run} attempt={attempt} path={path} />
      {past && (
        <p className="panel" role="status">
          Attempt {attempt} of {run.run_attempt}: the run's state above is the current attempt's.{" "}
          <Link to={path}>View the current attempt</Link>
        </p>
      )}
      <Notes run={run} />
      {stopped && (
        <p className="muted">
          This page stopped updating itself.{" "}
          <Link to={`${path}?attempt=${attempt}`} reloadDocument>
            Reload
          </Link>
        </p>
      )}
      {graph === null ? (
        <p className="panel">
          This run has too much to draw here. Its jobs are listed by the API:{" "}
          <code>
            GET /api{runsApi(owner, name)}/runs/{run.id}/jobs?attempt={attempt}
          </code>
        </p>
      ) : (
        <JobGraph
          graph={graph}
          owner={owner}
          repo={name}
          runId={run.id}
          waitingWords={waitingWords}
        />
      )}
    </main>
  );
}
