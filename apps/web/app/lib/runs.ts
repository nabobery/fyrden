import type {
  getWorkflowRun,
  getWorkflowRunGraph,
  listWorkflowRunJobs,
  listWorkflowRuns,
  listWorkflows,
  Output,
  readJobLog,
} from "@fyrden/api-contract";
import { HANDLE_SHAPE, MAX_HANDLE_LENGTH } from "@fyrden/domain";

export type RunSummary = Output<typeof listWorkflowRuns>["workflow_runs"][number];
export type RunsPage = Output<typeof listWorkflowRuns>;
export type WorkflowsPage = Output<typeof listWorkflows>;
export type Run = Output<typeof getWorkflowRun>;
export type RunGraph = Output<typeof getWorkflowRunGraph>;
export type GraphJob = RunGraph["jobs"][number];
export type Job = Output<typeof listWorkflowRunJobs>["jobs"][number];
export type Step = Job["steps"][number];
export type LogPage = Output<typeof readJobLog>;
export type LogRow = LogPage["rows"][number];

const seg = encodeURIComponent;

export const runsPath = (owner: string, repo: string): string => `/${owner}/${repo}/actions`;

export const workflowRunsPath = (owner: string, repo: string, file: string): string =>
  `${runsPath(owner, repo)}/workflows/${seg(file)}`;

export const runPath = (owner: string, repo: string, runId: string, attempt?: number): string =>
  `${runsPath(owner, repo)}/runs/${seg(runId)}${attempt === undefined ? "" : `?attempt=${attempt}`}`;

export const jobPath = (owner: string, repo: string, runId: string, jobId: number): string =>
  `${runsPath(owner, repo)}/runs/${seg(runId)}/job/${jobId}`;

export const jobLogPath = (owner: string, repo: string, runId: string, jobId: number): string =>
  `${jobPath(owner, repo, runId, jobId)}/log`;

export const jobRawPath = (owner: string, repo: string, runId: string, jobId: number): string =>
  `${jobPath(owner, repo, runId, jobId)}/raw`;

export const runsApi = (owner: string, repo: string): string =>
  `/repos/${seg(owner)}/${seg(repo)}/actions`;

export const STATUS_CHOICES = [
  { value: "queued", label: "Queued" },
  { value: "pending", label: "Waiting for its concurrency group" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "success", label: "Succeeded" },
  { value: "failure", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "action_required", label: "Waiting for approval" },
] as const;

export type StatusChoice = (typeof STATUS_CHOICES)[number]["value"];

export interface RunFilters {
  readonly status?: StatusChoice;
  readonly event?: string;
  readonly branch?: string;
  readonly actor?: string;
  readonly sha?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
}

export interface FilterError {
  readonly field: "actor" | "sha" | "created" | "branch" | "event";
  readonly message: string;
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const SHA = /^[0-9a-f]{40}$/;

function isDay(text: string): boolean {
  if (!DAY.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

export function runFilters(url: URL): { filters: RunFilters; errors: FilterError[] } {
  const get = (name: string) => url.searchParams.get(name)?.trim() || undefined;
  const filters: { -readonly [K in keyof RunFilters]: RunFilters[K] } = {};
  const errors: FilterError[] = [];
  const status = get("status");
  if (status && STATUS_CHOICES.some((c) => c.value === status))
    filters.status = status as StatusChoice;
  const event = get("event");
  if (event)
    if (event.length <= 64) filters.event = event;
    else errors.push({ field: "event", message: "An event name is at most 64 characters." });
  const branch = get("branch");
  if (branch)
    if (branch.length <= 1024) filters.branch = branch;
    else errors.push({ field: "branch", message: "A branch name is at most 1,024 characters." });
  const actor = get("actor");
  if (actor)
    if (actor.length <= MAX_HANDLE_LENGTH && HANDLE_SHAPE.test(actor)) filters.actor = actor;
    else errors.push({ field: "actor", message: "Not a user or agent handle." });
  const sha = get("sha")?.toLowerCase();
  if (sha)
    if (SHA.test(sha)) filters.sha = sha;
    else errors.push({ field: "sha", message: "A full commit SHA: 40 hexadecimal characters." });
  const from = get("created_from");
  const to = get("created_to");
  if (from !== undefined || to !== undefined) {
    if ((from !== undefined && !isDay(from)) || (to !== undefined && !isDay(to)))
      errors.push({ field: "created", message: "Dates are days: YYYY-MM-DD." });
    else if (from !== undefined && to !== undefined && from > to)
      errors.push({ field: "created", message: "The range ends before it starts." });
    else {
      if (from !== undefined) filters.createdFrom = from;
      if (to !== undefined) filters.createdTo = to;
    }
  }
  return { filters, errors };
}

function filterPairs(filters: RunFilters): [string, string][] {
  const pairs: [string, string][] = [];
  if (filters.status) pairs.push(["status", filters.status]);
  if (filters.event) pairs.push(["event", filters.event]);
  if (filters.branch) pairs.push(["branch", filters.branch]);
  if (filters.actor) pairs.push(["actor", filters.actor]);
  if (filters.sha) pairs.push(["sha", filters.sha]);
  if (filters.createdFrom) pairs.push(["created_from", filters.createdFrom]);
  if (filters.createdTo) pairs.push(["created_to", filters.createdTo]);
  return pairs;
}

/** The page's own query for `filters` (and a cursor read with them): `""` or `?…`. */
export function runFiltersQuery(filters: RunFilters, cursor?: string | null): string {
  const query = new URLSearchParams(filterPairs(filters));
  if (cursor) query.set("cursor", cursor);
  const text = query.toString();
  return text ? `?${text}` : "";
}

function createdOf(filters: RunFilters): string | undefined {
  const { createdFrom: from, createdTo: to } = filters;
  if (from && to) return `${from}..${to}`;
  if (from) return `>=${from}`;
  if (to) return `<=${to}`;
  return undefined;
}

export const RUNS_PER_PAGE = 30;

/** The API's query for a page of runs with `filters`, after `cursor` (bound to those filters). */
export function runsApiQuery(filters: RunFilters, cursor: string | null): string {
  const query = new URLSearchParams({ per_page: String(RUNS_PER_PAGE) });
  if (filters.status) query.set("status", filters.status);
  if (filters.event) query.set("event", filters.event);
  if (filters.branch) query.set("branch", filters.branch);
  if (filters.actor) query.set("actor", filters.actor);
  if (filters.sha) query.set("head_sha", filters.sha);
  const created = createdOf(filters);
  if (created) query.set("created", created);
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export type Tone = "ok" | "bad" | "busy" | "idle";

export interface StateWords {
  readonly words: string;
  readonly mark: string;
  readonly tone: Tone;
}

const CONCLUDED: Record<string, StateWords> = {
  success: { words: "Succeeded", mark: "✓", tone: "ok" },
  failure: { words: "Failed", mark: "✗", tone: "bad" },
  timed_out: { words: "Timed out", mark: "✗", tone: "bad" },
  cancelled: { words: "Cancelled", mark: "⊘", tone: "idle" },
  skipped: { words: "Skipped", mark: "–", tone: "idle" },
  action_required: { words: "Waiting for approval", mark: "!", tone: "busy" },
};

const UNDERWAY: Record<string, StateWords> = {
  queued: { words: "Queued", mark: "○", tone: "idle" },
  pending: { words: "Waiting", mark: "○", tone: "idle" },
  in_progress: { words: "In progress", mark: "●", tone: "busy" },
};

export function runWords(status: string, conclusion: string | null): StateWords {
  if (status !== "completed") return UNDERWAY[status] ?? { words: status, mark: "○", tone: "idle" };
  return (
    (conclusion !== null ? CONCLUDED[conclusion] : undefined) ?? {
      words: "Completed",
      mark: "✓",
      tone: "idle",
    }
  );
}

/**
 * The graph's jobs in columns: each one column after the longest chain of
 * jobs it needs, in the workflow's order within a column. A need that names
 * no job of the graph, or a cycle, puts every job in one column.
 */
export function layers<T extends Pick<GraphJob, "key" | "needs">>(jobs: readonly T[]): T[][] {
  const byKey = new Map(jobs.map((j) => [j.key, j]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (job: T): number | undefined => {
    const known = depth.get(job.key);
    if (known !== undefined) return known;
    if (visiting.has(job.key)) return undefined;
    visiting.add(job.key);
    let d = 0;
    for (const key of job.needs) {
      const need = byKey.get(key);
      const nd = need ? depthOf(need) : undefined;
      if (nd === undefined) return undefined;
      d = Math.max(d, nd + 1);
    }
    visiting.delete(job.key);
    depth.set(job.key, d);
    return d;
  };
  const columns: T[][] = [];
  for (const job of jobs) {
    const d = depthOf(job);
    if (d === undefined) return jobs.length === 0 ? [] : [[...jobs]];
    const column = columns[d] ?? [];
    column.push(job);
    columns[d] = column;
  }
  return columns;
}

/** The attempt `text` names (the current one when absent), or null for none of the run's. */
export function attemptOf(text: string | null, current: number): number | null {
  if (text === null || text === "") return current;
  if (!/^[1-9][0-9]?$/.test(text)) return null;
  const n = Number(text);
  return n <= current ? n : null;
}

export function waitingWords(waiting: string | null | undefined): string | null {
  if (waiting === "ci_minutes") return "Waiting for the account's CI minutes";
  if (waiting === "daily_capacity") return "Waiting for today's CI capacity";
  return null;
}

/** What a page says when a log page is refused: by the API's code, never its detail alone. */
export function logRefusalWords(
  status: number,
  code: string | undefined,
  retryAt?: number,
): string {
  const at =
    retryAt !== undefined
      ? ` at ${new Date(retryAt).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "";
  switch (code) {
    case "log_unavailable":
      return "This log was stored before logs were masked, so it cannot be shown.";
    case "log_not_found":
      return "This job has no log: it never got a runner.";
    case "invalid_cursor":
      return "This page of the log is no longer valid.";
    case "log_reads_spent":
      return `Log reading is used up for today on this deployment; it starts again${at}.`;
    case "log_reads_unavailable":
      return "Log reading cannot be accounted for right now; try again shortly.";
    case "log_busy":
      return "The run is busy storing logs; try again in a moment.";
    case "log_unreadable":
      return "A stored part of this log cannot be read.";
    case "rate_limited":
      return "Too many requests from your account this minute; try again in a minute.";
  }
  if (status === 403 || status === 404)
    return "This job or its log no longer exists, or you cannot read it.";
  return "The log could not be read; try again shortly.";
}
