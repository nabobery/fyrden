import { data, Link, redirect } from "react-router";
import { RepoHeader } from "../components/repo-header.js";
import { apiCall, apiGet, type Problem, signInUrl } from "../lib/api.server.js";
import { plainLogText } from "../lib/log-text.js";
import {
  type Job,
  jobLogPath,
  jobPath,
  jobRawPath,
  type LogPage,
  type LogRow,
  logRefusalWords,
  runsApi,
} from "../lib/runs.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.run-job-log";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Log · ${params.owner}/${params.repo} · Fyrden` }];
}

/** At most this much of a log page is escaped into the document. */
export const TEXT_PAGE_BYTES = 65_536;
const JOB_ID = /^[1-9][0-9]{0,9}$/;

type Reading =
  | { kind: "rows"; rows: LogRow[]; state: LogPage["state"]; next: string | null }
  | { kind: "refused"; words: string };

export async function loader({ request, context, params }: Route.LoaderArgs) {
  if (!JOB_ID.test(params.job_id)) throw data("No such job.", { status: 404 });
  const url = new URL(request.url);
  const api = runsApi(params.owner, params.repo);
  const runId = encodeURIComponent(params.run_id);
  const cursor = url.searchParams.get("cursor");
  const query = `max_bytes=${TEXT_PAGE_BYTES}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const [repo, job, read] = await Promise.all([
    apiGet<Repo>(
      context,
      request,
      `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`,
    ),
    apiGet<Job>(context, request, `${api}/runs/${runId}/jobs/${params.job_id}`),
    apiCall<LogPage>(
      context,
      request,
      "GET",
      `${api}/runs/${runId}/jobs/${params.job_id}/logs/rows?${query}`,
    ),
  ]);
  if (read.status === 401) throw redirect(signInUrl(request));
  let reading: Reading;
  if (read.status === 200)
    reading = {
      kind: "rows",
      rows: read.body.rows,
      state: read.body.state,
      next: read.body.next_cursor,
    };
  else {
    const problem = read.body as unknown as (Problem & { retry_at?: number }) | null;
    reading = {
      kind: "refused",
      words: logRefusalWords(read.status, problem?.code, problem?.retry_at),
    };
  }
  return { repo, origin: url.origin, runId: params.run_id, job, cursor, reading };
}

function Line({ row }: { row: LogRow }) {
  if ("omitted" in row)
    return (
      <>
        <span className="log-no">{row.i + 1}</span>
        {`[row omitted: ${row.bytes} bytes]\n`}
      </>
    );
  const continued = "o" in row && row.o > 0;
  const ends = !("end" in row) || row.end;
  return (
    <>
      <span className="log-no">{continued ? "" : row.i + 1}</span>
      {continued && <span className="muted">(continued) </span>}
      {plainLogText(row.c)}
      {ends ? "\n" : ""}
    </>
  );
}

export default function JobLog({ loaderData }: Route.ComponentProps) {
  const { repo, origin, runId, job, cursor, reading } = loaderData;
  const owner = repo.owner;
  const name = repo.name;
  const here = jobLogPath(owner, name, runId, job.id);
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="actions" />
      <p className="muted">
        <Link to={jobPath(owner, name, runId, job.id)}>{job.name}</Link>
      </p>
      <h2>Log as text</h2>
      <p className="muted">
        Shown as stored, masked where secrets were found; colours removed, other control sequences
        shown as marks. <a href={jobRawPath(owner, name, runId, job.id)}>Raw text</a>
      </p>
      {reading.kind === "refused" ? (
        <p role="alert" className="error">
          {reading.words} {cursor && <Link to={here}>Back to the start</Link>}
        </p>
      ) : reading.state === "none" ? (
        <p className="muted">
          {reading.next === null
            ? "This job has no log: it never got a runner."
            : "Waiting for a runner."}
        </p>
      ) : (
        <>
          {reading.rows.length === 0 ? (
            <p className="muted">No lines {cursor ? "after these" : "yet"}.</p>
          ) : (
            <section
              className="log-text"
              aria-label={`Log of ${job.name}`}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus, so the keyboard can scroll a wide log.
              tabIndex={0}
            >
              <pre>
                {reading.rows.map((row) => (
                  <Line key={`${row.i}:${"o" in row ? row.o : 0}`} row={row} />
                ))}
              </pre>
            </section>
          )}
          <nav className="pager" aria-label="Log pages">
            {cursor && <Link to={here}>Back to the start</Link>}
            {reading.next !== null && reading.rows.length > 0 && (
              <Link to={`${here}?cursor=${encodeURIComponent(reading.next)}`}>Next page</Link>
            )}
            {reading.next !== null && reading.rows.length === 0 && (
              <Link
                to={`${here}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`}
                reloadDocument
              >
                Look again
              </Link>
            )}
          </nav>
        </>
      )}
    </main>
  );
}
