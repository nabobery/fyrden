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

export const WorkflowRun = z.object({
  id: z.string(),
  run_attempt: z.number().int().describe("The current attempt: 1, then one more per re-run."),
  head_sha: z.string(),
  head_branch: z.string().nullable().describe("The branch the run is for, if its ref is one."),
  event: z.string(),
  path: z.string().describe("The workflow file."),
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
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(2_000).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    jobs: z.array(WorkflowJob),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
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
  description: `Runs a workflow that has a \`workflow_dispatch\` trigger, at \`ref\` (a branch or tag name, or a full ref), with \`inputs\` checked against the ones it declares (typed in the run's \`inputs\` context, strings in \`github.event.inputs\`). \`workflow_id\` is the workflow's file name, such as \`ci.yml\`; Fyrden has no numeric workflow ids. The file must also be on the default branch (GitHub's rule); the version at \`ref\` runs. One run per request, and per \`Idempotency-Key\` within its window: the answer names the run even when its start is still being retried. 404 \`workflow_not_found\`; 422 \`ref_not_found\`, \`workflow_not_dispatchable\` (no \`workflow_dispatch\` trigger), \`invalid_inputs\` and \`invalid_workflow\` (each with \`errors\`); 409 \`repo_not_ready\`; 409 \`repo_transferring\` while a transfer moves the repository, or once it was transferred or renamed after the request was authorized (once any active transfer ends, look the repository up again and dispatch with a new \`Idempotency-Key\`: the same key answers the refusal again); 409 \`owner_changed\` when it changed owner before the run started, so the run was dropped (a run answered before that and dropped later is never created: looking it up answers 404 \`run_not_found\`); and 409 \`ci_off\` while this deployment runs no CI. ${COMPATIBILITY} Takes the \`actions:write\` permission.`,
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
