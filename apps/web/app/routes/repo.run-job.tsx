import { useEffect, useState } from "react";
import { data, Link } from "react-router";
import { LogViewer } from "../components/log-viewer.js";
import { RepoHeader } from "../components/repo-header.js";
import { duration, RunState } from "../components/run-ui.js";
import { apiGet } from "../lib/api.server.js";
import {
  type Job,
  jobLogPath,
  jobRawPath,
  type Run,
  runPath,
  runsApi,
  type Step,
  waitingWords,
} from "../lib/runs.js";
import type { Repo } from "../lib/types.js";
import { useRunRefresh } from "../lib/use-run-refresh.js";
import type { Route } from "./+types/repo.run-job";

export function meta({ loaderData, params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${loaderData?.job.name ?? "Job"} · ${params.owner}/${params.repo} · Fyrden` }];
}

const JOB_ID = /^[1-9][0-9]{0,9}$/;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  if (!JOB_ID.test(params.job_id)) throw data("No such job.", { status: 404 });
  const url = new URL(request.url);
  const api = runsApi(params.owner, params.repo);
  const runId = encodeURIComponent(params.run_id);
  const [repo, run, job] = await Promise.all([
    apiGet<Repo>(
      context,
      request,
      `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`,
    ),
    apiGet<Run>(context, request, `${api}/runs/${runId}`),
    apiGet<Job>(context, request, `${api}/runs/${runId}/jobs/${params.job_id}`),
  ]);
  const asked = url.searchParams.get("attempt");
  if (asked !== null && asked !== String(job.run_attempt))
    throw data("The job is not of that attempt.", { status: 404 });
  return { repo, origin: url.origin, run, job };
}

const STAGE_WORDS: Record<Step["stage"], string | null> = {
  setup: "setup",
  containers: "containers",
  pre: "pre",
  main: null,
  post: "post",
  cleanup: "cleanup",
};

function Steps({ steps }: { steps: readonly Step[] }) {
  if (steps.length === 0)
    return <p className="muted">No steps reported yet. A runner reports them as the job runs.</p>;
  return (
    <ol className="run-steps">
      {steps.map((step) => {
        const took = duration(step.started_at, step.completed_at);
        const stage = STAGE_WORDS[step.stage];
        return (
          <li key={step.number} className="row">
            <RunState status={step.status} conclusion={step.conclusion} />
            <span className="run-step-name">{step.name}</span>
            {stage !== null && <span className="badge">{stage}</span>}
            {took !== null && <span className="muted">{took}</span>}
            {step.log !== null && (
              <span className="muted">
                lines {step.log.from + 1} to {step.log.from + step.log.rows}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default function JobPage({ loaderData }: Route.ComponentProps) {
  const { repo, origin, run, job } = loaderData;
  const owner = repo.owner;
  const name = repo.name;
  const current = job.run_attempt === run.run_attempt;
  const took = duration(job.started_at, job.completed_at);
  const waits = waitingWords(job.waiting_for);
  const state = `${job.status}/${job.conclusion}/${job.steps.map((s) => s.status).join()}`;
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const { stopped } = useRunRefresh(
    `${run.id}:${job.id}`,
    current && job.status !== "completed",
    state,
    loaderData,
  );
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="actions" />
      <p className="muted run-wrap">
        <Link to={runPath(owner, name, run.id, current ? undefined : job.run_attempt)}>
          {run.display_title}
        </Link>
      </p>
      <h2 className="row">
        <RunState status={job.status} conclusion={job.conclusion} />
        <span className="run-title">{job.name}</span>
      </h2>
      {!current && (
        <p className="panel" role="status">
          Attempt {job.run_attempt} of {run.run_attempt}.{" "}
          <Link to={runPath(owner, name, run.id)}>View the current attempt</Link>
        </p>
      )}
      <p className="muted">
        {took !== null && <>Took {took}. </>}
        {waits !== null && <>{waits}. </>}
        {job.log_complete === false && "Some of its log was lost. "}
      </p>
      {job.error !== null && (
        <p className="error" role="alert">
          {job.error}
        </p>
      )}
      {stopped && (
        <p className="muted">
          This page stopped updating itself.{" "}
          <Link to="." reloadDocument>
            Reload
          </Link>
        </p>
      )}
      <section aria-labelledby="steps-title">
        <h3 id="steps-title">Steps</h3>
        <Steps steps={job.steps} />
      </section>
      <section aria-labelledby="log-title">
        <h3 id="log-title">Log</h3>
        <p className="row">
          <Link to={jobLogPath(owner, name, run.id, job.id)}>Read the log as text</Link>
        </p>
        {hydrated ? (
          <LogViewer
            key={`${run.id}:${job.id}`}
            owner={owner}
            repo={name}
            runId={run.id}
            job={job}
          />
        ) : (
          <p className="muted">
            The log viewer needs JavaScript;{" "}
            <a href={jobRawPath(owner, name, run.id, job.id)}>raw text (one page)</a>.
          </p>
        )}
      </section>
    </main>
  );
}
