import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { type GraphJob, jobPath, layers, type RunGraph } from "../lib/runs.js";
import { duration, RunState } from "./run-ui.js";

type Edge = { readonly from: string; readonly to: string; readonly d: string };

const cardId = (key: string) => `job-card-${key}`;
const groupId = (key: string) => `job-${key}`;

function useEdges(box: React.RefObject<HTMLElement | null>, jobs: readonly GraphJob[]) {
  const [edges, setEdges] = useState<Edge[]>([]);
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    const measure = () => {
      const origin = root.getBoundingClientRect();
      const at = (key: string) =>
        root
          .querySelector<HTMLElement>(`[data-card="${CSS.escape(key)}"]`)
          ?.getBoundingClientRect();
      const next: Edge[] = [];
      for (const job of jobs)
        for (const need of job.needs) {
          const a = at(need);
          const b = at(job.key);
          if (!a || !b) continue;
          const x1 = a.right - origin.left + root.scrollLeft;
          const y1 = a.top + a.height / 2 - origin.top + root.scrollTop;
          const x2 = b.left - origin.left + root.scrollLeft;
          const y2 = b.top + b.height / 2 - origin.top + root.scrollTop;
          const mid = (x1 + x2) / 2;
          next.push({
            from: need,
            to: job.key,
            d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
          });
        }
      setEdges(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [box, jobs]);
  return edges;
}

function Card({
  job,
  owner,
  repo,
  runId,
}: {
  job: GraphJob;
  owner: string;
  repo: string;
  runId: string;
}) {
  const only = job.jobs.length === 1 ? job.jobs[0] : undefined;
  const title = only ? (
    <Link to={jobPath(owner, repo, runId, only.id)}>{job.name}</Link>
  ) : job.jobs.length > 1 ? (
    <a href={`#${groupId(job.key)}`}>{job.name}</a>
  ) : (
    <span>{job.name}</span>
  );
  return (
    <li className="graph-card" data-card={job.key} id={cardId(job.key)}>
      <span className="graph-name">{title}</span>
      <RunState status={job.status} conclusion={job.conclusion} />
      {job.jobs.length > 1 && <span className="muted"> {job.jobs.length} jobs</span>}
      {job.jobs.length === 0 && job.needs.length > 0 && (
        <span className="muted graph-waits">Waiting for {job.needs.join(", ")}</span>
      )}
      {job.needs.length > 0 && (
        <span className="visually-hidden">. Needs {job.needs.join(", ")}.</span>
      )}
    </li>
  );
}

export function JobGraph({
  graph,
  owner,
  repo,
  runId,
  waitingWords,
}: {
  graph: RunGraph;
  owner: string;
  repo: string;
  runId: string;
  waitingWords: (waiting: string | null | undefined) => string | null;
}) {
  const box = useRef<HTMLElement>(null);
  const columns = layers(graph.jobs);
  const edges = useEdges(box, graph.jobs);
  if (graph.jobs.length === 0) return null;
  return (
    <>
      <section>
        <h3>Job graph</h3>
        <section
          className="graph"
          ref={box}
          aria-label="Job graph, scrolls sideways"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus, so the keyboard can scroll a wide graph.
          tabIndex={0}
        >
          <svg className="graph-edges" aria-hidden="true" focusable="false">
            {edges.map((e) => (
              <path key={`${e.from}\u0000${e.to}`} d={e.d} />
            ))}
          </svg>
          {columns.map((column, i) => (
            <ol key={column[0]?.key ?? i} className="graph-column" aria-label={`Stage ${i + 1}`}>
              {column.map((job) => (
                <Card key={job.key} job={job} owner={owner} repo={repo} runId={runId} />
              ))}
            </ol>
          ))}
        </section>
      </section>
      <section aria-labelledby="jobs-title">
        <h3 id="jobs-title">Jobs</h3>
        {/* biome-ignore lint/a11y/noRedundantRoles: without markers, WebKit reads a list as a group unless told. */}
        <ul role="list" className="run-jobs">
          {graph.jobs.map((node) => (
            <li key={node.key} id={groupId(node.key)}>
              {node.jobs.length === 0 ? (
                <p className="row">
                  <RunState status={node.status} conclusion={node.conclusion} /> {node.name}
                  {node.needs.length > 0 && (
                    <span className="muted">, after {node.needs.join(", ")}</span>
                  )}
                </p>
              ) : (
                // biome-ignore lint/a11y/noRedundantRoles: without markers, WebKit reads a list as a group unless told.
                <ul role="list">
                  {node.jobs.map((job) => {
                    const took = duration(job.started_at, job.completed_at);
                    const waits = waitingWords(job.waiting_for);
                    return (
                      <li key={job.id} className="row">
                        <RunState status={job.status} conclusion={job.conclusion} />
                        <Link to={jobPath(owner, repo, runId, job.id)}>{job.name}</Link>
                        {took !== null && <span className="muted">{took}</span>}
                        {waits !== null && <span className="muted">{waits}</span>}
                        {job.error !== null && <span className="error">{job.error}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
