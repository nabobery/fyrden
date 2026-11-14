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
const RunConclusion = z.enum(["success", "failure", "cancelled"]).nullable();

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
  errors: z.array(z.string()).describe("Why the workflow could not run, when it could not."),
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
