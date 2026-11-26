import { isUlid, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { isFullSha, ulid } from "@fyrden/domain";
import {
  type AttemptConclusion,
  INSTANCE_CONCLUSIONS,
  type InstanceConclusion,
  JOB_ACTIONS,
  type JobAction,
  type JobsTold,
  jobMoves,
  RUN_PHASES,
  type RunFacts,
  type RunMove,
  type RunPhase,
  runMoves,
  runStateSeq,
  type TimeRange,
} from "@fyrden/domain/ci";
import { captureWorkflowJob, captureWorkflowRun } from "../../webhooks/ci-captures.js";
import type { RepoEvents } from "./events.js";

/*
 * The repository's record of its CI runs' states (`ci_runs`). A run's
 * object owns the run and reports it here; the record only moves forward
 * (`runStateSeq`), so a report that comes late or twice changes nothing, and
 * a report alone never records a run the repository does not hold. `apply`
 * is where a run's recorded state changes, in the caller's transaction, and
 * where webhooks are told of it: `told` remembers what they were told, apart
 * from the state, which the weekly check records too without telling.
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

export interface AttemptEnd {
  readonly attempt: number;
  readonly conclusion: AttemptConclusion;
  readonly triggeringActor: string;
  readonly startedAt: number | null;
  readonly completedAt: number;
}

/** A job instance that was queued at least once, or ended, as its run reports it. */
export interface JobReport {
  readonly jobId: number;
  readonly attempt: number;
  readonly triggeringActor: string;
  readonly key: string;
  readonly name: string;
  /** Null when they are not to be shown (`labelsFreeOfOutputs`), or it has none. */
  readonly labels: readonly string[] | null;
  readonly action: JobAction;
  /** Set exactly when completed. */
  readonly conclusion: InstanceConclusion | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

export interface RunNews {
  /** Attempts before the reported one that ended, which may not have been reported. */
  readonly earlier?: readonly AttemptEnd[];
  /** Jobs of any attempt that moved, by id, `MAX_JOB_REPORTS` at most. */
  readonly jobs?: readonly JobReport[];
}

export const MAX_JOB_REPORTS = 256;

/** Labels of a job a report carries at most. Proposed. */
export const MAX_JOB_LABELS = 100;

/** Events of a run's way to its end, which the Free plan sends a few of: `IN_BETWEEN_CAP`. */
export type InBetween = "created" | "queued" | "in_progress";

/** In-between events of each kind sent an attempt on Free. Proposed. */
export const IN_BETWEEN_CAP = 32;

interface Told extends JobsTold {
  readonly stateSeq: number;
  readonly sent: { readonly attempt: number } & Readonly<Record<InBetween, number>>;
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
  told: string | null;
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

/** Rows one page of runs reads at most. Proposed. */
export const RUN_PAGE_SCAN = 500;
/** A workflow's newest rows looked at for one that was reported. Proposed. */
const LATEST_SCAN = 50;

/** Which runs a page lists: all that match every field given. */
export interface RunFilter {
  readonly sha?: string;
  /** Workflow files: one, or the same name in each workflow directory. */
  readonly paths?: readonly [string] | readonly [string, string];
  readonly phases?: readonly RunPhase[];
  readonly conclusion?: AttemptConclusion;
  readonly branch?: string;
  readonly event?: string;
  readonly actor?: string;
  /** When they were triggered (their ids' time). */
  readonly triggered?: TimeRange;
}

/** Admits in-between events against their attempt's cap; `save` records those admitted. */
export interface InBetweenBudget {
  admit(run: { readonly runId: string; readonly attempt: number }): boolean;
  save(): void;
}

/** A page of runs, newest first; `next` the run id to continue before. */
export interface RunPage {
  readonly runs: RunReport[];
  readonly next: string | null;
}

/** A page of workflows with runs, by path; `next` the path to continue after. */
export interface WorkflowPage {
  readonly workflows: {
    readonly path: string;
    /** Its latest reported run's; null for none among its newest. */
    readonly name: string | null;
    /** Null for none, and for one expired and not forgotten yet. */
    readonly latest: RunReport | null;
  }[];
  readonly next: string | null;
}

export class RunHistory {
  constructor(
    private readonly git: RepoGitStorage,
    private readonly events: Pick<RepoEvents, "emitToHooks">,
    /** How long a run is kept after it completed: past it, it is answered as no run. */
    private readonly retentionMs: () => number,
    private readonly inBetweenCap: () => number | null,
  ) {}

  /**
   * In the caller's transaction: records what `report` says of a run the
   * repository holds, unless it holds that state or a later one already
   * (whether it did), and tells webhooks what they were not told of it yet.
   */
  apply(report: RunReport, news: RunNews = {}): boolean {
    const held = this.#held(report.runId);
    if (!held) return false;
    return this.#record(held, report, this.#tell(toldOf(held), report, news));
  }

  /** Every job id up to it was told complete; undefined for a run the repository does not hold. */
  jobsDone(runId: string): number | undefined {
    const held = this.#held(runId);
    return held && toldOf(held).done;
  }

  /** In the caller's transaction: the cap on checks' `created`, for checks of any runs. */
  createdBudget(): InBetweenBudget {
    const runs = new Map<string, { told: Told; admitted: boolean }>();
    const cap = this.inBetweenCap();
    return {
      admit: ({ runId, attempt }) => {
        if (cap === null) return true;
        let run = runs.get(runId);
        if (!run) {
          const held = this.#held(runId);
          if (!held) return true;
          run = { told: toldOf(held), admitted: false };
          runs.set(runId, run);
        }
        const sent = admitted(run.told.sent, attempt, "created", cap);
        if (!sent) return false;
        run.told = { ...run.told, sent };
        run.admitted = true;
        return true;
      },
      save: () => {
        for (const [runId, { told, admitted }] of runs) if (admitted) this.#writeTold(runId, told);
      },
    };
  }

  /**
   * In the caller's transaction: records the state of a run registering
   * itself, as `apply` does, telling no one. A run the repository held (not
   * `inserted` by this registration) still has told what it had.
   */
  register(report: RunReport, inserted: boolean): void {
    const held = this.#held(report.runId);
    if (!held) return;
    const told = toldOf(held);
    this.#record(
      held,
      report,
      inserted ? { ...told, stateSeq: runStateSeq(report.attempt, report.phase) } : told,
    );
  }

  #held(runId: string): Pick<RunRow, "state_seq" | "told"> | undefined {
    return this.git.context.storage.sql
      .exec<Pick<RunRow, "state_seq" | "told">>(
        "SELECT state_seq, told FROM ci_runs WHERE run_id = ?",
        runId,
      )
      .toArray()[0];
  }

  #tell(told: Told, report: RunReport, { earlier = [], jobs = [] }: RunNews): Told {
    const ends = new Map(earlier.map((end) => [end.attempt, end]));
    const run = runMoves(told.stateSeq, report, [...ends.keys()]);
    const ended = run.moves.filter((m) => m.attempt === report.attempt && m.action === "completed");
    for (const move of run.moves) if (!ended.includes(move)) this.#tellRun(move, report, ends);
    const job = jobMoves(told, jobs);
    let { sent } = told;
    for (const move of job.moves) sent = this.#tellJob(move, report, sent);
    for (const move of ended) this.#tellRun(move, report, ends);
    return { stateSeq: run.told, ...job.told, sent };
  }

  #tellRun(
    { attempt, action }: RunMove,
    report: RunReport,
    ends: ReadonlyMap<number, AttemptEnd>,
  ): void {
    const end = ends.get(attempt);
    const run: RunReport = end
      ? { ...report, ...end, phase: "completed", updatedAt: end.completedAt }
      : report;
    this.events.emitToHooks(
      `workflow_run.${action}`,
      { principal: run.triggeringActor, via: "api" },
      () => captureWorkflowRun(run),
    );
  }

  #tellJob(job: JobReport, report: RunReport, sent: Told["sent"]): Told["sent"] {
    const { action } = job;
    const cap = action === "completed" ? null : this.inBetweenCap();
    const after =
      action === "completed" || cap === null ? sent : admitted(sent, job.attempt, action, cap);
    const told =
      after !== undefined &&
      this.events.emitToHooks(
        `workflow_job.${action}`,
        { principal: job.triggeringActor, via: "api" },
        () => captureWorkflowJob(job, report),
      );
    return told ? after : sent;
  }

  #record(held: Pick<RunRow, "state_seq" | "told">, report: RunReport, told: Told): boolean {
    const seq = runStateSeq(report.attempt, report.phase);
    const toldText = JSON.stringify(told);
    if (seq <= held.state_seq) {
      if (toldText !== JSON.stringify(toldOf(held))) this.#writeTold(report.runId, told);
      return false;
    }
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
    this.#count(
      `UPDATE ci_runs SET state_seq = ?1, status = ?2, conclusion = ?3, event = ?4, actor_id = ?5,
         head_branch = ?6, completed_at = ?7, summary = ?8, created_at = ?9, told = ?11
       WHERE run_id = ?10`,
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
      toldText,
    );
    return true;
  }

  #writeTold(runId: string, told: Told): void {
    this.#count("UPDATE ci_runs SET told = ? WHERE run_id = ?", JSON.stringify(told), runId);
  }

  #count(query: string, ...bindings: (string | number | null)[]): void {
    const { rowsWritten } = this.git.context.storage.sql.exec(query, ...bindings);
    this.git.context.metrics.count(
      "do.rows_written",
      { class: this.git.context.doClass, op: "ci_runs.state" },
      rowsWritten,
    );
  }

  /** A run as last reported; undefined for one not recorded, or not reported yet. */
  get(runId: string): RunReport | undefined {
    const [row] = this.git.context.storage.sql
      .exec<RunRow>("SELECT * FROM ci_runs WHERE run_id = ? AND state_seq > 0", runId)
      .toArray();
    return row && reportOf(row);
  }

  /** Whether the repository holds the run and its retention has not ended: an operation answers it. */
  kept(runId: string): boolean {
    const [row] = this.git.context.storage.sql
      .exec<RunRow>("SELECT * FROM ci_runs WHERE run_id = ?", runId)
      .toArray();
    return row !== undefined && !this.#expiry()(row);
  }

  /**
   * Reported runs matching `filter`, before run id `before`, newest first.
   * Reads one range of one index, `RUN_PAGE_SCAN` rows of it at most: a
   * page that reads that many ends there, however few it holds.
   */
  list(filter: RunFilter, before: string | null, limit: number): RunPage {
    const { query, bindings } = rangeOf(filter, before);
    const cursor = this.git.context.storage.sql.exec<RunRow>(query, ...bindings);
    const expired = this.#expiry();
    const runs: RunReport[] = [];
    let scanned = 0;
    let last: string | null = null;
    for (const row of cursor) {
      // One row past what the page holds or reads only says there is more.
      if (runs.length === limit || scanned === RUN_PAGE_SCAN) return { runs, next: last };
      scanned++;
      last = row.run_id;
      if (row.state_seq > 0 && !expired(row) && matches(row, filter)) runs.push(reportOf(row));
    }
    return { runs, next: null };
  }

  /** Workflow files with runs, after path `after`, `limit` at most: each a few rows, however many runs it has. */
  workflows(after: string, limit: number): WorkflowPage {
    const { sql } = this.git.context.storage;
    const pathAfter = (path: string) =>
      sql
        .exec<{ workflow_path: string }>(
          "SELECT workflow_path FROM ci_runs WHERE workflow_path > ? ORDER BY workflow_path LIMIT 1",
          path,
        )
        .toArray()[0]?.workflow_path;
    const expired = this.#expiry();
    const workflows: WorkflowPage["workflows"] = [];
    let path = pathAfter(after);
    while (path !== undefined) {
      const last = workflows.at(-1);
      if (last && workflows.length === limit) return { workflows, next: last.path };
      const row = this.#latestOf(path);
      const run = row && reportOf(row);
      workflows.push({
        path,
        name: run?.name ?? null,
        latest: run && !expired(row) ? run : null,
      });
      path = pathAfter(path);
    }
    return { workflows, next: null };
  }

  #latestOf(path: string): RunRow | undefined {
    const cursor = this.git.context.storage.sql.exec<RunRow>(
      "SELECT * FROM ci_runs WHERE workflow_path = ? ORDER BY run_id DESC LIMIT ?",
      path,
      LATEST_SCAN,
    );
    for (const row of cursor) if (row.state_seq > 0) return row;
    return undefined;
  }

  /** Whether a run's retention has ended, so that it is answered as no run while it is retired. */
  #expiry(): (row: RunRow) => boolean {
    const since = this.git.context.now() - this.retentionMs();
    return (row) => row.completed_at !== null && row.completed_at <= since;
  }
}

/** The one index range that holds every run of `filter`, before `before`, newest first. */
function rangeOf(
  filter: RunFilter,
  before: string | null,
): { readonly query: string; readonly bindings: (string | number)[] } {
  const bindings: (string | number)[] = [];
  const bind = (value: string | number) => {
    bindings.push(value);
    return `?${bindings.length}`;
  };
  const bounds: string[] = [];
  const { from = null, until = null } = filter.triggered ?? {};
  // A run id's first characters are its time, so the least id of a time bounds the ids from it on.
  const upper = [before, until === null ? null : leastIdAt(until)].filter((id) => id !== null);
  for (const id of upper) bounds.push(`run_id < ${bind(id)}`);
  if (from !== null) bounds.push(`run_id >= ${bind(leastIdAt(from))}`);
  const select = (...where: string[]) => {
    const all = [...where, ...bounds];
    return `SELECT * FROM ci_runs${all.length > 0 ? ` WHERE ${all.join(" AND ")}` : ""}`;
  };
  const order = ` ORDER BY run_id DESC LIMIT ${bind(RUN_PAGE_SCAN + 1)}`;
  if (filter.sha !== undefined)
    return { query: select(`sha = ${bind(filter.sha)}`) + order, bindings };
  if (filter.paths) {
    const parts = filter.paths.map((path) => select(`workflow_path = ${bind(path)}`));
    return { query: parts.join(" UNION ALL ") + order, bindings };
  }
  if (filter.phases?.every((phase) => phase !== "completed"))
    return {
      query: select("status IN ('waiting', 'queued', 'pending', 'in_progress')") + order,
      bindings,
    };
  return { query: select() + order, bindings };
}

const MAX_ULID_TIME = 2 ** 48 - 1;
const leastIdAt = (ms: number) =>
  ulid(Math.min(Math.max(ms, 0), MAX_ULID_TIME), (n) => new Uint8Array(n));

function matches(row: RunRow, filter: RunFilter): boolean {
  return (
    (filter.sha === undefined || row.sha === filter.sha) &&
    (filter.paths === undefined || filter.paths.some((path) => path === row.workflow_path)) &&
    (filter.phases === undefined || filter.phases.some((phase) => phase === row.status)) &&
    (filter.conclusion === undefined || row.conclusion === filter.conclusion) &&
    (filter.branch === undefined || row.head_branch === filter.branch) &&
    (filter.event === undefined || row.event === filter.event) &&
    (filter.actor === undefined || row.actor_id === filter.actor)
  );
}

function toldOf(row: Pick<RunRow, "state_seq" | "told">): Told {
  return {
    stateSeq: row.state_seq,
    done: 0,
    live: {},
    sent: { attempt: 0, created: 0, queued: 0, in_progress: 0 },
    ...(row.told === null ? {} : (JSON.parse(row.told) as Partial<Told>)),
  };
}

function admitted(
  sent: Told["sent"],
  attempt: number,
  kind: InBetween,
  cap: number,
): Told["sent"] | undefined {
  if (attempt < sent.attempt) return undefined;
  const now = attempt > sent.attempt ? { attempt, created: 0, queued: 0, in_progress: 0 } : sent;
  return now[kind] < cap ? { ...now, [kind]: now[kind] + 1 } : undefined;
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

export function validRunNews(news: RunNews, report: RunReport): RunNews {
  const fail = (what: string): never => {
    throw new TypeError(`invalid run report: ${what}`);
  };
  const { earlier = [], jobs = [] } = news;
  let last = 0;
  for (const end of earlier) {
    if (!Number.isSafeInteger(end.attempt) || end.attempt <= last || end.attempt >= report.attempt)
      fail("earlier attempt");
    last = end.attempt;
    if (!CONCLUSIONS.includes(end.conclusion)) fail("earlier conclusion");
    const actor = end.triggeringActor;
    if (typeof actor !== "string" || actor === "" || actor.length > MAX_TEXT) fail("earlier actor");
    if (!Number.isFinite(end.completedAt)) fail("earlier completedAt");
  }
  if (jobs.length > MAX_JOB_REPORTS) fail("jobs");
  for (const job of jobs) {
    if (!Number.isSafeInteger(job.jobId) || job.jobId < 1) fail("job");
    if (!Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > report.attempt)
      fail("job attempt");
    const labels = job.labels ?? [];
    if (labels.length > MAX_JOB_LABELS) fail("job labels");
    for (const text of [job.key, job.name, job.triggeringActor, ...labels])
      if (typeof text !== "string" || text === "" || text.length > MAX_TEXT) fail("job text");
    if (!JOB_ACTIONS.includes(job.action)) fail("job action");
    if ((job.action === "completed") !== (job.conclusion !== null)) fail("job conclusion");
    if (job.conclusion !== null && !INSTANCE_CONCLUSIONS.includes(job.conclusion))
      fail("job conclusion");
  }
  return news;
}
