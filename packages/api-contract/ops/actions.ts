import { HANDLE_SHAPE, MAX_HANDLE_LENGTH } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const RepoInput = {
  owner: z
    .string()
    .min(1)
    .max(MAX_HANDLE_LENGTH)
    .regex(HANDLE_SHAPE)
    .describe("The owner's handle."),
  repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
};
const RunId = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "a run id")
  .describe("The run's id.");

const RunStatus = z
  .enum(["queued", "pending", "in_progress", "completed"])
  .describe("`pending`: waiting for its concurrency group.");
const RunConclusion = z
  .enum(["success", "failure", "cancelled", "action_required"])
  .nullable()
  .describe("`action_required`: the run waits for a maintainer's approval.");

const PerPage = z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100.");
const Cursor = z
  .string()
  .max(2_000)
  .optional()
  .describe("From a previous page's `next_cursor`, with the same filters.");
const NextCursor = z
  .string()
  .nullable()
  .describe("Pass as `cursor` for the next page; null on the last page.");

/** A run as a list shows it. */
export const WorkflowRunSummary = z.object({
  id: z.string(),
  run_number: z
    .number()
    .int()
    .nullable()
    .describe("The workflow's count of its runs, kept by re-runs; null for a run without one."),
  name: z.string().describe("The workflow's name, or its file's path."),
  display_title: z
    .string()
    .describe(
      "The workflow's `run-name`, else the pull request's title as the run was triggered, else the commit's first line, else the workflow's name; at most 256 characters.",
    ),
  run_attempt: z.number().int().describe("The current attempt: 1, then one more per re-run."),
  head_sha: z.string(),
  head_branch: z
    .string()
    .nullable()
    .describe(
      "The branch the run is for: a pull request's head branch (in `fork`'s case a branch of another repository), else its ref's; null for a tag.",
    ),
  event: z.string(),
  path: z.string().describe("The workflow file."),
  pull_request: z
    .object({ number: z.number().int() })
    .nullable()
    .describe("Fyrden: the pull request whose event triggered the run."),
  fork: z
    .boolean()
    .describe(
      "Fyrden: whether the run is a fork's: its pull request's head is in another repository.",
    ),
  status: RunStatus,
  conclusion: RunConclusion,
  actor: z
    .object({ id: z.string() })
    .describe("Who triggered the run: its jobs act with this principal's rights on every attempt."),
  triggering_actor: z.object({ id: z.string() }).describe("Who started the current attempt."),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  run_started_at: z.number().int().nullable(),
  completed_at: z.number().int().nullable(),
});

export const WorkflowRun = WorkflowRunSummary.extend({
  approval: z
    .object({
      state: z.enum(["waiting", "approved", "cancelled", "superseded", "expired"]),
      decided_by: z.object({ id: z.string() }).nullable(),
      decided_at: z.number().int().nullable(),
    })
    .nullable()
    .describe(
      "Fyrden: the maintainer's approval the run waits for, or got: a run from a fork's first-time contributor. Null when none is needed.",
    ),
  errors: z
    .array(
      z.object({
        code: z.string().describe("The error's code, such as `unsupported_key`."),
        feature: z.string().describe("The workflow feature it concerns; empty for none."),
        path: z.string().describe("Where in the file, such as `jobs.build.steps[0].uses`."),
        line: z.number().int().describe("From 1; 0 for the file as a whole."),
        column: z.number().int().describe("From 1; 0 for the file as a whole."),
        message: z.string(),
      }),
    )
    .describe("Why the workflow could not run, when it could not."),
  faults: z
    .array(
      z.object({
        kind: z.string(),
        error: z.string(),
        since: z.number().int(),
        count: z.number().int(),
      }),
    )
    .describe(
      "Fyrden: background work that exhausted its retries and is still being retried periodically.",
    ),
});

export const WorkflowJob = z.object({
  id: z.number().int().describe("The job's id within its run."),
  run_id: z.string(),
  run_attempt: z.number().int(),
  name: z.string(),
  job_key: z
    .string()
    .describe("Fyrden: the job's id in the workflow file; a matrix's combinations share one."),
  status: z.enum(["pending", "queued", "in_progress", "completed"]),
  conclusion: z.enum(["success", "failure", "cancelled", "skipped", "timed_out"]).nullable(),
  started_at: z.number().int().nullable(),
  completed_at: z.number().int().nullable(),
  check: z
    .object({
      state: z.string().nullable().describe("The state its check was last given."),
      code: z
        .string()
        .nullable()
        .describe("Why its check is not published, when it is not (`duplicate_check`, …)."),
    })
    .describe("Fyrden: the job's check on the commit."),
  log_complete: z
    .boolean()
    .nullable()
    .describe("Fyrden: whether every log row reached durable storage; null while it runs."),
  error: z.string().nullable(),
  steps: z
    .array(
      z.object({
        number: z.number().int().describe("Its place among the job's steps, from 1."),
        name: z
          .string()
          .describe(
            "As the workflow writes it, expressions in it not evaluated: its `name`, else `Run` and the first line of what it runs.",
          ),
        stage: z
          .enum(["setup", "containers", "pre", "main", "post", "cleanup"])
          .describe("Fyrden: `main` for the workflow's own steps."),
        status: z.enum(["queued", "in_progress", "completed"]),
        conclusion: z.enum(["success", "failure", "cancelled", "skipped"]).nullable(),
        started_at: z.number().int().nullable(),
        completed_at: z.number().int().nullable(),
        log: z
          .object({ from: z.number().int(), rows: z.number().int() })
          .nullable()
          .describe("Fyrden: its rows of the job's log (the first, and how many)."),
      }),
    )
    .describe(
      "As the runner last reported them, up to 30 seconds old while the job runs; at most 256, each name cut to 200 characters, and none before its first report or for jobs from before this deployment kept them.",
    ),
  waiting_for: z
    .enum(["ci_minutes", "daily_capacity"])
    .nullable()
    .optional()
    .describe(
      "Fyrden: why a queued job is not offered to runners yet: its account's CI minutes for the month, or the deployment's daily CI capacity; it asks again when they may allow it. Null otherwise.",
    ),
});

const COMPATIBILITY =
  "GitHub's paths and status codes; Fyrden's ids (a run id string, job ids per run), times in milliseconds and cursor paging.";

export const getWorkflowRun = defineOperation({
  id: "actions.runs.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/runs/{run_id}",
  summary: "Get a workflow run",
  description: `A CI run of the repository as its current attempt stands. ${COMPATIBILITY} Takes the \`actions:read\` permission.`,
  input: z.object({ ...RepoInput, run_id: RunId }),
  output: WorkflowRun,
  permission: "actions:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_workflow_run",
    title: "Get a workflow run",
    description: "Get a CI run: its status, conclusion, attempt and who triggered it.",
    readOnly: true,
  },
});

export const listWorkflowRunJobs = defineOperation({
  id: "actions.runs.jobs.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
  summary: "List jobs for a workflow run",
  description: `The jobs of a run's attempt (the current one by default), by id: one per matrix combination, and one for a job that never ran (skipped or failed before it started). ${COMPATIBILITY} Takes the \`actions:read\` permission.`,
  input: z.object({
    ...RepoInput,
    run_id: RunId,
    attempt: z.coerce
      .number()
      .int()
      .min(1)
      .max(51)
      .optional()
      .describe("An attempt; the current by default."),
    per_page: PerPage,
    cursor: z.string().max(2_000).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({ jobs: z.array(WorkflowJob), next_cursor: NextCursor }),
  permission: "actions:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_workflow_run_jobs",
    title: "List a workflow run's jobs",
    description: "List the jobs of a CI run's attempt with their status, conclusion and check.",
    readOnly: true,
  },
});

/** GitHub's `status` filter: a status, or a conclusion. */
export const RUN_STATUS_FILTERS = [
  "completed",
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "success",
  "timed_out",
  "in_progress",
  "queued",
  "requested",
  "waiting",
  "pending",
] as const;

const RunFilters = {
  branch: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe("Only runs of this branch (`head_branch`), forks' included."),
  event: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Only runs this event triggered, such as `push` or `pull_request`."),
  status: z
    .enum(RUN_STATUS_FILTERS)
    .optional()
    .describe(
      "Only runs of this status or conclusion. `completed` includes a run waiting for approval; `action_required`: only those. GitHub's other values are taken and match nothing: no run here has them.",
    ),
  actor: z
    .string()
    .min(1)
    .max(MAX_HANDLE_LENGTH)
    .regex(HANDLE_SHAPE)
    .optional()
    .describe("A handle: only runs this user or agent triggered (`actor`, kept by re-runs)."),
  head_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, "a full commit SHA, lowercase")
    .optional()
    .describe("Only runs of this commit."),
  created: z
    .string()
    .max(64)
    .optional()
    .describe(
      "Only runs triggered at these times, in GitHub's syntax: `2026-11-20` (that UTC day), `>=2026-11-20`, `<2026-11-20T10:00:00Z`, `2026-11-18..2026-11-20`, `2026-11-18..*`.",
    ),
  check_suite_id: z
    .unknown()
    .optional()
    .describe("Not supported (422 `unsupported_parameter`): Fyrden has no check suites."),
  exclude_pull_requests: z
    .unknown()
    .optional()
    .describe(
      "Not supported (422 `unsupported_parameter`): a run carries no pull requests but the one that triggered it.",
    ),
  per_page: PerPage,
  cursor: Cursor,
};

const RUN_LIST =
  "Newest first by run id (when each was triggered). A page reads at most 500 runs, so with filters it can hold fewer than `per_page`, even none, with a `next_cursor`: follow it until it is null. A run is listed within seconds of starting and for as long as it is kept; its state is the one it last reported, seconds old at most in normal running (`actions.runs.get` is current), and `updated_at` is when that state was reached. Runs from before this deployment recorded runs' states appear within a week of its upgrade. No `total_count`.";

const WorkflowId = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/]+$/, "a file name")
  .describe("The workflow's file name, such as `ci.yml`; Fyrden has no numeric workflow ids.");

const RunPage = z.object({
  workflow_runs: z.array(WorkflowRunSummary),
  next_cursor: NextCursor,
});

export const listWorkflowRuns = defineOperation({
  id: "actions.runs.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/runs",
  summary: "List workflow runs for a repository",
  description: `The repository's CI runs, each as its current attempt stands. ${RUN_LIST} ${COMPATIBILITY} Takes the \`actions:read\` permission.`,
  input: z.object({ ...RepoInput, ...RunFilters }),
  output: RunPage,
  permission: "actions:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_workflow_runs",
    title: "List workflow runs",
    description:
      "List a repository's CI runs, newest first, by branch, event, status, actor, commit or time. A page can hold fewer runs than asked, even none: follow next_cursor until it is null.",
    readOnly: true,
  },
});

export const listRunsOfWorkflow = defineOperation({
  id: "actions.workflows.runs.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
  summary: "List workflow runs for a workflow",
  description: `The runs of one workflow file, as \`actions.runs.list\` lists them: those of \`.github/workflows\` and of \`.fyrden/workflows\` under that name. A file with no runs kept answers none. ${RUN_LIST} ${COMPATIBILITY} Takes the \`actions:read\` permission.`,
  input: z.object({ ...RepoInput, workflow_id: WorkflowId, ...RunFilters }),
  output: RunPage,
  permission: "actions:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_runs_of_workflow",
    title: "List a workflow's runs",
    description:
      "List the CI runs of one workflow file, newest first, with the filters of list_workflow_runs. Follow next_cursor until it is null.",
    readOnly: true,
  },
});

export const listWorkflows = defineOperation({
  id: "actions.workflows.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/workflows",
  summary: "List repository workflows with runs",
  description: `The workflow files with runs kept, in path order, each with its latest run. A file that never ran, or whose runs all expired, is not listed (GitHub lists the default branch's files): read \`.github/workflows\` for those. No \`total_count\`. ${COMPATIBILITY} Takes the \`actions:read\` permission.`,
  input: z.object({ ...RepoInput, per_page: PerPage, cursor: Cursor }),
  output: z.object({
    workflows: z.array(
      z.object({
        id: z.string().describe("The workflow's file name, as the other operations take it."),
        path: z.string().describe("The workflow file."),
        name: z
          .string()
          .nullable()
          .describe("The workflow's name as its latest run had it; null until one is reported."),
        latest_run: WorkflowRunSummary.nullable().describe(
          "Fyrden: its latest run; null while that one has not been reported, or is about to expire.",
        ),
      }),
    ),
    next_cursor: NextCursor,
  }),
  permission: "actions:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_workflows",
    title: "List workflows with runs",
    description:
      "List the workflow files that have CI runs, each with its latest run; follow next_cursor until it is null. Not the files that never ran: read .github/workflows for those.",
    readOnly: true,
  },
});

export const getWorkflowRunGraph = defineOperation({
  id: "actions.runs.graph.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/runs/{run_id}/graph",
  summary: "Get a workflow run's job graph",
  description:
    "Fyrden: the jobs of a run's attempt (the current one by default) as the workflow file writes them, with what each needs and where it stands, those not started included. `actions.runs.jobs.list` lists what runs: a job here has one there per matrix combination, by `job_key`, once its needs ended. Empty for a run whose workflow could not run (its `errors` say why). Takes the `actions:read` permission.",
  input: z.object({
    ...RepoInput,
    run_id: RunId,
    attempt: z.coerce
      .number()
      .int()
      .min(1)
      .max(51)
      .optional()
      .describe("An attempt; the current by default."),
  }),
  output: z.object({
    run_id: z.string(),
    run_attempt: z.number().int(),
    jobs: z
      .array(
        z.object({
          key: z.string().describe("The job's id in the workflow file."),
          name: z.string().describe("Its name, without what an expression in it would add."),
          needs: z.array(z.string()).describe("The keys of the jobs it waits for."),
          status: z
            .enum(["pending", "in_progress", "completed"])
            .describe(
              "`pending`: the jobs it needs have not ended. `in_progress`: it has jobs, queued or running.",
            ),
          conclusion: z
            .enum(["success", "failure", "cancelled", "skipped"])
            .nullable()
            .describe(
              "As its dependents see it: a failure `continue-on-error` allows is a success.",
            ),
        }),
      )
      .describe("Each after the jobs it needs."),
  }),
  permission: "actions:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_workflow_run_graph",
    title: "Get a workflow run's job graph",
    description:
      "Get a CI run's jobs as its workflow writes them: what each needs, and whether it waits, runs or ended.",
    readOnly: true,
  },
});

const Accepted = z.object({}).describe("Accepted: the run is being cancelled.");

export const cancelWorkflowRun = defineOperation({
  id: "actions.runs.cancel",
  method: "POST",
  path: "/repos/{owner}/{repo}/actions/runs/{run_id}/cancel",
  summary: "Cancel a workflow run",
  description: `Cancels a run: queued jobs end, running jobs whose \`if:\` no longer holds once the run is cancelled are told to stop (as GitHub re-evaluates running jobs), and jobs whose \`if:\` still holds (such as \`if: always()\`) run; Fyrden also runs such jobs that have not started yet, which GitHub does not document. 409 \`run_not_cancellable\` once the run completed. ${COMPATIBILITY} Takes the \`actions:write\` permission.`,
  input: z.object({ ...RepoInput, run_id: RunId }),
  output: Accepted,
  permission: "actions:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 202,
  mcp: {
    tool: "cancel_workflow_run",
    title: "Cancel a workflow run",
    description: "Cancel a CI run; jobs with if: always() still run.",
    readOnly: false,
  },
});

export const forceCancelWorkflowRun = defineOperation({
  id: "actions.runs.force_cancel",
  method: "POST",
  path: "/repos/{owner}/{repo}/actions/runs/{run_id}/force-cancel",
  summary: "Force cancel a workflow run",
  description: `Cancels every unfinished job of a run at once, whatever its \`if:\` (for a run that does not respond to a cancel); running jobs' runners are told to stop and their logs may be incomplete. 409 \`run_not_cancellable\` once the run completed. ${COMPATIBILITY} Takes the \`actions:write\` permission.`,
  input: z.object({ ...RepoInput, run_id: RunId }),
  output: Accepted,
  permission: "actions:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 202,
  mcp: {
    tool: "force_cancel_workflow_run",
    title: "Force cancel a workflow run",
    description: "Cancel every unfinished job of a CI run at once, ignoring if: always().",
    readOnly: false,
  },
});

export const rerunWorkflowRun = defineOperation({
  id: "actions.runs.rerun",
  method: "POST",
  path: "/repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
  summary: "Re-run a workflow",
  description: `Runs every job of a completed run again as a new attempt, from the same commit and workflow; its jobs keep the rights of the run's original actor, and the caller is the attempt's triggering actor. A run takes 50 re-runs (409 \`rerun_limit\`); one still running, or whose workflow could not run (\`errors\`), is 409 \`run_not_completed\`. ${COMPATIBILITY} Takes the \`actions:write\` permission.`,
  input: z.object({ ...RepoInput, run_id: RunId }),
  output: z.object({ run_attempt: z.number().int() }),
  permission: "actions:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "rerun_workflow_run",
    title: "Re-run a workflow run",
    description: "Run every job of a completed CI run again as a new attempt.",
    readOnly: false,
  },
});

export const issueJobLogTicket = defineOperation({
  id: "actions.runs.jobs.live_ticket",
  method: "POST",
  path: "/repos/{owner}/{repo}/actions/runs/{run_id}/jobs/{job_id}/logs/live",
  summary: "Get a ticket to watch a job's log live",
  description:
    'A single-use ticket (30 seconds) to open a WebSocket at `url` (`GET` with `Upgrade: websocket`; add `&from=<index>` to start at a row, 0 by default) that streams the job\'s log rows, masked as they are stored: `{"t":"rows","rows":[{"i":<index>,"t":<Unix ms or null>,"c":"<text>"}]}` in order, each position once. An oversized omitted row is a whole record in the same `rows` array: `{"i":<index>,"omitted":"row_too_large","bytes":<declared size>}`. It has no content or timestamp, is never split into parts, and keeps the log incomplete. The stream immediately after a gap is conservatively masked and can hide non-secret text. Logs created before server masking was introduced are unavailable: the socket sends no history and ends with `log: "incomplete"` and `durable: 0`. A row too long for one frame comes as `{"t":"part","i","o","c","end"}` pieces (the first with `"ts"`, the row\'s time) to join in order. Once a whole final upload seals the log, or ten minutes have passed since its task ended, and every stored row was sent: `{"t":"end","log":"complete"|"incomplete","durable":<n>}` (rows at or past `durable` were not stored and cannot be added after `end`; late uploads are accepted only after task completion and before final sealing or the ten-minute deadline; `"unfinished":<index>` names a row whose parts cannot be finished, to discard), then close 1000. Where the deployment meters log viewers (Workers Free), a socket reads from storage at most what reading back the log stored when its ticket was issued takes (each chunk once for every 504 KiB it holds) plus 4 MiB, in a bounded number of reads and of checks of its credential: one whose next read or check would pass that is closed 4429, after `{"t":"end","reason":"budget"}` when the window has room for it (with `"unfinished":<index>` for a row cut mid-part); ask for a new ticket and reconnect with `from` at `unfinished` when given, else at the row after the last whole row received (a row received only in part starts again). Rows sent live as they arrive are not counted. Acknowledge with `{"t":"ack","i":<next index>,"o":<UTF-16 offset in it>}` only at the position immediately after a received frame: the next row index and offset 0 after a `rows` frame, or the end position of a `part` frame (the next row and offset 0 when `end` is true). Send an acknowledgement after each 256 KiB of frames (their UTF-8) or 16 complete frames handled. Only an acknowledgement at a sent frame boundary that releases outstanding frames advances the window; other acknowledgements count against the control-message limit. At most 64 frames or 1 MiB go unacknowledged; once that is full, nothing more is sent until acknowledgements leave at most 256 KiB and 16 frames out, and a socket that takes 2 minutes to get there closes 4408. `ping` is answered `pong`. Closes: 4401 the credential no longer holds, 4429 the socket\'s budget is spent, 4403 access to the repository was lost (checked at least every 60 seconds while rows flow), 4404 the run was erased, 1001 after 24 hours, 1011 a stored chunk or outgoing frame could not be read or sent, 1008 any other message, or more than 20 a minute that do not acknowledge a sent frame boundary and release outstanding frames. The upgrade needs the same credential: the session\'s cookie from this origin, or the token in `Authorization`. The caller\'s own credentials only (a delegated or DPoP-bound token: 403 `delegated_listing`). At most 20 tickets a run unredeemed (429 `too_many_tickets`). Where log viewers are metered, each ticket is paid from the deployment\'s daily CI capacity: once viewers\' share of the day is spent, 429 `log_viewers_spent` with `retry_after` and `retry_at` naming the next 00:00 UTC (finished logs included); 503 `log_viewers_unavailable` when it cannot be accounted for, while more runners serve than the deployment\'s fleet cap, or when watching the log costs more than viewers\' daily share. A run takes 20 sockets, 5 a credential and 10 a principal. If the response is lost, retrying its `Idempotency-Key` returns `409 secret_already_disclosed`; use a new key to request another ticket. The lost ticket expires automatically. Takes the `actions:read` permission. A Fyrden extension.',
  input: z.object({
    ...RepoInput,
    run_id: RunId,
    job_id: z.coerce
      .number()
      .int()
      .min(1)
      .max(2 ** 31 - 1)
      .describe("The job's id within its run."),
  }),
  output: z.object({
    ticket: z.string(),
    expires_in: z.number().int().describe("Seconds the ticket can be redeemed."),
    url: z.string().describe("Where to open the WebSocket (the ticket in its query)."),
  }),
  permission: "actions:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  secretResponse: true,
  mcp: false,
});

const LogRowIndex = z.number().int().describe("The row's index in the log.");
const LogRowTime = z.number().nullable().describe("When it was printed, Unix ms; null for none.");

const LogRow = z.union([
  z
    .object({
      i: LogRowIndex,
      t: LogRowTime,
      c: z.string(),
      o: z.number().int().describe("Where this piece starts in the row, in UTF-16 units."),
      end: z.boolean().describe("Whether it reaches the row's end."),
    })
    .describe("A piece of a row too long for one page."),
  z.object({ i: LogRowIndex, t: LogRowTime, c: z.string() }).describe("A whole row."),
  z
    .object({
      i: LogRowIndex,
      omitted: z.literal("row_too_large"),
      bytes: z.number().int().describe("The row's declared size."),
    })
    .describe("A row too large to be stored."),
]);

export const readJobLog = defineOperation({
  id: "actions.runs.jobs.logs.read",
  method: "GET",
  path: "/repos/{owner}/{repo}/actions/runs/{run_id}/jobs/{job_id}/logs/rows",
  summary: "Read a job's log",
  description:
    "A page of a job's log rows as stored, finished or so far: masked when they were stored, oldest first. Start at a row (`from`), at the last rows (`tail`) or where a page ended (`cursor`), one of them at most; without one, at the first row. A page holds at most `max_bytes` of encoded rows and reads a bounded part of storage, so it can hold fewer. `next_cursor` is null only once the log is closed and was read to its end: while rows may still come it is always given, and reading from it again follows the log (no rows when there are none yet). A row too long for a page comes in pieces, to join by `o`; with `tail`, a last row too long comes as its end. Only stored rows are answered: the last ones a running job printed may be held back for masking. `state`: `none` before the job got a task, or when it never did; `streaming`; `complete`; `incomplete` (rows were lost or are still late). A cursor of another log, or past its end, is 422 `invalid_cursor`. A log from before server masking is 410 `log_unavailable`. 503 `log_busy` while the run stores uploads that need the room, 503 `log_unreadable` when a stored part cannot be read. Where the deployment meters CI (Workers Free), pages that read storage share a daily allowance: 429 `log_reads_spent` with `retry_after` and `retry_at` naming the next 00:00 UTC, 503 `log_reads_unavailable` when it cannot be accounted for. `GET …/jobs/{job_id}/logs` answers the same as plain text, from `from`, `tail` or `cursor`, at most 512 KiB a page, with a `Link` to the next page while more is stored. Takes the `actions:read` permission. A Fyrden extension.",
  input: z.object({
    ...RepoInput,
    run_id: RunId,
    job_id: z.coerce
      .number()
      .int()
      .min(1)
      .max(2 ** 31 - 1)
      .describe("The job's id within its run."),
    from: z.coerce
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1)
      .optional()
      .describe("The row to start at; past the end, the end."),
    tail: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe("The last rows to read: fewer when they do not fit."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
    max_bytes: z.coerce
      .number()
      .int()
      .min(1024)
      .max(512 * 1024)
      .default(64 * 1024)
      .describe("The encoded rows a page holds at most, in bytes."),
  }),
  output: z.object({
    rows: z.array(LogRow),
    state: z.enum(["none", "streaming", "complete", "incomplete"]),
    end: z.number().int().describe("Rows stored when the page was read."),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` to read on; null once a closed log was read to its end."),
  }),
  permission: "actions:read",
  principals: ["user", "agent"],
  rateLimit: "expensive",
  idempotency: "none",
  noStore: true,
  mcp: {
    tool: "get_job_log",
    title: "Read a CI job's log",
    description:
      "Read a page of a CI job's log, finished or still running. Use tail (such as 200) for why a job failed, from or cursor to read on; next_cursor is null once everything was read.",
    readOnly: true,
  },
});

export const approveWorkflowRun = defineOperation({
  id: "actions.runs.approve",
  method: "POST",
  path: "/repos/{owner}/{repo}/actions/runs/{run_id}/approve",
  summary: "Approve a workflow run from a fork",
  description: `Lets a run from a fork's first-time contributor start: it waits (\`status: completed\`, \`conclusion: action_required\`, \`approval.state: waiting\`) until a user with write access approves it. Approving again answers the same; a run that is not waiting (it needed no approval, or was superseded by a newer push, cancelled or expired) is 409 \`approval_not_pending\`. Only users may approve. ${COMPATIBILITY} Takes the \`actions:write\` permission.`,
  input: z.object({ ...RepoInput, run_id: RunId }),
  output: z.object({}),
  permission: "actions:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "approve_workflow_run",
    title: "Approve a workflow run",
    description: "Let a CI run from a fork's first-time contributor start.",
    readOnly: false,
  },
});

export const dispatchWorkflow = defineOperation({
  id: "actions.workflows.dispatch",
  method: "POST",
  path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
  summary: "Create a workflow dispatch event",
  description: `Runs a workflow that has a \`workflow_dispatch\` trigger, at \`ref\` (a branch or tag name, or a full ref), with \`inputs\` checked against the ones it declares (typed in the run's \`inputs\` context, strings in \`github.event.inputs\`). \`workflow_id\` is the workflow's file name, such as \`ci.yml\`; Fyrden has no numeric workflow ids. The file must also be on the default branch (GitHub's rule); the version at \`ref\` runs. One run per request, and per \`Idempotency-Key\` (MCP: \`idempotency_key\`) within its window: the answer names the run even when its start is still being retried. 404 \`workflow_not_found\`; 422 \`ref_not_found\`, \`workflow_not_dispatchable\` (no \`workflow_dispatch\` trigger), \`invalid_inputs\` and \`invalid_workflow\` (each with \`errors\`); 409 \`repo_not_ready\`; 409 \`repo_transferring\` while a transfer moves the repository, or once it was transferred or renamed after the request was authorized (once any active transfer ends, look the repository up again and dispatch with a new \`Idempotency-Key\`: the same key answers the refusal again); 409 \`owner_changed\` when it changed owner before the run started, so the run was dropped (a run answered before that and dropped later is never created: looking it up answers 404 \`run_not_found\`); 409 \`commit_unreachable\` when no branch, tag or recent ref history named its commit any more when the run started, so the run was dropped (the same lookup answers 404); and 409 \`ci_off\` while this deployment runs no CI. ${COMPATIBILITY} Takes the \`actions:write\` permission.`,
  input: z.object({
    ...RepoInput,
    workflow_id: z.string().min(1).max(255).describe("The workflow's file name, such as `ci.yml`."),
    ref: z.string().min(1).max(1024).describe("A branch or tag name, or a full ref."),
    inputs: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("The workflow's inputs by name (at most 25)."),
  }),
  output: z.object({
    workflow_run_id: z.string().describe("The run's id."),
    run_url: z.string().describe("The run in the REST API."),
    html_url: z.string(),
  }),
  permission: "actions:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "dispatch_workflow",
    title: "Run a workflow",
    description: "Run a workflow that has a workflow_dispatch trigger, with inputs.",
    readOnly: false,
  },
});
