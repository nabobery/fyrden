import { isUlid, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { isFullSha } from "@fyrden/domain";
import {
  type AttemptConclusion,
  RUN_PHASES,
  type RunFacts,
  type RunPhase,
  runStateSeq,
} from "@fyrden/domain/ci";

/*
 * The repository's record of its CI runs' states (`ci_runs`). A run's
 * object owns the run and reports it here; the record only moves forward
 * (`runStateSeq`), so a report that comes late or twice changes nothing, and
 * a report alone never records a run the repository does not hold. `apply`
 * is where a run's recorded state changes, in the caller's transaction:
 * what else must follow a change belongs there.
 */

/** A run as its object reports it: what its trigger fixed, and where its current attempt stands. */
export interface RunReport extends RunFacts {
  readonly runId: string;
  readonly sha: string;
  /** The workflow file. */
  readonly path: string;
  readonly event: string;
  /** The original trigger. */
  readonly actor: string;
  readonly fork: boolean;
  readonly createdAt: number;
  readonly attempt: number;
  readonly phase: RunPhase;
  /** Set exactly when completed. */
  readonly conclusion: AttemptConclusion | null;
  /** Who started the current attempt. */
  readonly triggeringActor: string;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

type RunRow = {
  run_id: string;
  sha: string;
  workflow_path: string;
  created_at: number;
  state_seq: number;
  status: RunPhase | null;
  conclusion: AttemptConclusion | null;
  event: string | null;
  actor_id: string | null;
  head_branch: string | null;
  completed_at: number | null;
  summary: string | null;
};

/** What `ci_runs.summary` holds: shown, never read by a filter. */
type Summary = Pick<
  RunReport,
  | "attempt"
  | "triggeringActor"
  | "runNumber"
  | "name"
  | "title"
  | "pullNumber"
  | "fork"
  | "updatedAt"
  | "startedAt"
>;

const CONCLUSIONS: readonly AttemptConclusion[] = ["success", "failure", "cancelled"];

/** Longest text of a report's fields, in UTF-16 units: a branch is the longest. */
const MAX_TEXT = 2048;

export class RunHistory {
  constructor(private readonly git: RepoGitStorage) {}

  /**
   * In the caller's transaction: records what `report` says of a run the
   * repository holds, unless it holds that state or a later one already;
   * whether it did.
   */
  apply(report: RunReport): boolean {
    const summary: Summary = {
      attempt: report.attempt,
      triggeringActor: report.triggeringActor,
      runNumber: report.runNumber,
      name: report.name,
      title: report.title,
      pullNumber: report.pullNumber,
      fork: report.fork,
      updatedAt: report.updatedAt,
      startedAt: report.startedAt,
    };
    const seq = runStateSeq(report.attempt, report.phase);
    const cursor = this.git.context.storage.sql.exec(
      `UPDATE ci_runs SET state_seq = ?1, status = ?2, conclusion = ?3, event = ?4, actor_id = ?5,
         head_branch = ?6, completed_at = ?7, summary = ?8, created_at = ?9
       WHERE run_id = ?10 AND state_seq < ?1`,
      seq,
      report.phase,
      report.conclusion,
      report.event,
      report.actor,
      report.headBranch,
      report.completedAt,
      JSON.stringify(summary),
      report.createdAt,
      report.runId,
    );
    const written = cursor.rowsWritten;
    if (written > 0)
      this.git.context.metrics.count(
        "do.rows_written",
        { class: this.git.context.doClass, op: "ci_runs.state" },
        written,
      );
    return written > 0;
  }

  /** A run as last reported; undefined for one not recorded, or not reported yet. */
  get(runId: string): RunReport | undefined {
    const [row] = this.git.context.storage.sql
      .exec<RunRow>("SELECT * FROM ci_runs WHERE run_id = ? AND state_seq > 0", runId)
      .toArray();
    return row && reportOf(row);
  }
}

/** A report as a caller gives it, checked: one that is not one is a bug in its caller. */
export function validRunReport(report: RunReport): RunReport {
  const fail = (what: string): never => {
    throw new TypeError(`invalid run report: ${what}`);
  };
  const texts = [
    report.path,
    report.event,
    report.actor,
    report.triggeringActor,
    report.name,
    report.title,
    ...(report.headBranch === null ? [] : [report.headBranch]),
  ];
  if (typeof report.runId !== "string" || !isUlid(report.runId)) fail("runId");
  if (!isFullSha(report.sha)) fail("sha");
  if (texts.some((t) => typeof t !== "string" || t === "" || t.length > MAX_TEXT)) fail("text");
  if (!Number.isSafeInteger(report.attempt) || report.attempt < 1) fail("attempt");
  if (!RUN_PHASES.includes(report.phase)) fail("phase");
  if ((report.phase === "completed") !== (report.conclusion !== null)) fail("conclusion");
  if (report.conclusion !== null && !CONCLUSIONS.includes(report.conclusion)) fail("conclusion");
  if ((report.phase === "completed") !== (report.completedAt !== null)) fail("completedAt");
  return report;
}

function reportOf(row: RunRow): RunReport {
  const summary = JSON.parse(row.summary as string) as Summary;
  return {
    runId: row.run_id,
    sha: row.sha,
    path: row.workflow_path,
    event: row.event as string,
    actor: row.actor_id as string,
    headBranch: row.head_branch,
    createdAt: row.created_at,
    phase: row.status as RunPhase,
    conclusion: row.conclusion,
    completedAt: row.completed_at,
    ...summary,
  };
}
