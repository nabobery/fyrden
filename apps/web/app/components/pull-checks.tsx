import { Link } from "react-router";
import {
  type CheckRunItem,
  CI_SOURCE,
  checkCounts,
  checkTarget,
  isRequired,
  type StatusItem,
  statusTarget,
} from "../lib/checks.js";
import type { RequiredChecks } from "../lib/merge.js";
import { RunState } from "./run-ui.js";

export type Read<T> =
  | { readonly state: "read"; readonly body: T }
  | { readonly state: "unavailable" };

type Required = RequiredChecks["checks"] | null;

const STATUS_WORDS: Record<string, { status: string; conclusion: string | null }> = {
  success: { status: "completed", conclusion: "success" },
  failure: { status: "completed", conclusion: "failure" },
  error: { status: "completed", conclusion: "failure" },
  pending: { status: "in_progress", conclusion: null },
};

function RequiredBadge() {
  return <span className="badge">Required</span>;
}

export function CheckRow({
  check,
  owner,
  repo,
  required,
}: {
  check: CheckRunItem;
  owner: string;
  repo: string;
  required: Required;
}) {
  const target = checkTarget(owner, repo, check);
  return (
    <li className="row">
      <RunState status={check.status} conclusion={check.conclusion} />
      {target ? <Link to={target}>{check.name}</Link> : <span>{check.name}</span>}
      {required && isRequired(check.name, CI_SOURCE, required) && <RequiredBadge />}
      {check.attempt > 1 && <span className="muted">attempt {check.attempt}</span>}
    </li>
  );
}

export function StatusRow({ status, required }: { status: StatusItem; required: Required }) {
  const words = STATUS_WORDS[status.state] ?? { status: "completed", conclusion: null };
  const target = statusTarget(status.target_url);
  return (
    <li className="row">
      <RunState status={words.status} conclusion={words.conclusion} />
      {target ? (
        <a href={target} rel="noreferrer nofollow">
          {status.context}
        </a>
      ) : (
        <span>{status.context}</span>
      )}
      {required && isRequired(status.context, status.creator.id, required) && <RequiredBadge />}
      {status.description && <span className="muted">{status.description}</span>}
    </li>
  );
}

const SUMMARY_LISTED = 10;

export function ChecksSummary({
  checks,
  statuses,
  required,
  owner,
  repo,
  tab,
}: {
  checks: Read<{ check_runs: CheckRunItem[]; next_cursor: string | null; total_count: number }>;
  statuses: Read<{ statuses: StatusItem[]; next_cursor: string | null; total_count: number }>;
  required: Required;
  owner: string;
  repo: string;
  tab: string;
}) {
  const runs = checks.state === "read" ? checks.body.check_runs : [];
  const posted = statuses.state === "read" ? statuses.body.statuses : [];
  if (checks.state === "read" && statuses.state === "read" && runs.length + posted.length === 0)
    return null;
  const counts = checkCounts(runs, posted);
  const partial =
    (checks.state === "read" && checks.body.next_cursor !== null) ||
    (statuses.state === "read" && statuses.body.next_cursor !== null);
  const notPassed = runs.filter(
    (c) =>
      c.status !== "completed" || !["success", "skipped", "neutral"].includes(c.conclusion ?? ""),
  );
  const statusesNotPassed = posted.filter((s) => s.state !== "success");
  const listedStatuses = statusesNotPassed.slice(0, Math.max(0, SUMMARY_LISTED - notPassed.length));
  return (
    <section className="panel" aria-labelledby="checks-title">
      <h3 id="checks-title">Checks</h3>
      <p>
        {counts.failing} failing, {counts.running} running, {counts.passed} passed
        {partial && " (of the first 100 of each)"}. <Link to={tab}>View all checks</Link>
      </p>
      {(checks.state === "unavailable" || statuses.state === "unavailable") && (
        <p className="muted">Some checks could not be read; reload to try again.</p>
      )}
      {notPassed.length + statusesNotPassed.length > 0 && (
        // biome-ignore lint/a11y/noRedundantRoles: without markers, WebKit reads a list as a group unless told.
        <ul role="list" className="run-jobs">
          {notPassed.slice(0, SUMMARY_LISTED).map((c) => (
            <CheckRow key={c.name} check={c} owner={owner} repo={repo} required={required} />
          ))}
          {listedStatuses.map((s) => (
            <StatusRow key={s.id} status={s} required={required} />
          ))}
        </ul>
      )}
    </section>
  );
}
