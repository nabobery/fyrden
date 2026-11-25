import type { createStatus, listCheckRuns, listWorkflowRuns, Output } from "@fyrden/api-contract";
import type { CheckRunRecord, StatusRecord } from "../do/repo/checks.js";
import type { RunReport } from "../do/repo/run-history.js";

export function statusOutput(status: StatusRecord): Output<typeof createStatus> {
  return {
    id: status.id,
    state: status.state,
    context: status.context,
    description: status.description,
    target_url: status.targetUrl,
    created_at: status.createdAt,
    updated_at: status.createdAt,
    creator: { id: status.creator },
  };
}

export function checkRunOutput(
  check: CheckRunRecord,
): Output<typeof listCheckRuns>["check_runs"][number] {
  return {
    name: check.name,
    head_sha: check.sha,
    status: check.status,
    conclusion: check.conclusion,
    attempt: check.attempt,
    run: check.origin && {
      id: check.origin.runId,
      run_attempt: check.origin.attempt,
      job_id: check.origin.jobId,
    },
    details_url: check.detailsUrl,
    updated_at: check.updatedAt,
  };
}

/** A run as its repository last heard of it. A held one shows as GitHub shows it: completed, its action required. */
export function runSummary(
  run: RunReport,
): Output<typeof listWorkflowRuns>["workflow_runs"][number] {
  return {
    id: run.runId,
    run_number: run.runNumber,
    name: run.name,
    display_title: run.title,
    run_attempt: run.attempt,
    head_sha: run.sha,
    head_branch: run.headBranch,
    event: run.event,
    path: run.path,
    pull_request: run.pullNumber === null ? null : { number: run.pullNumber },
    fork: run.fork,
    ...(run.phase === "waiting"
      ? { status: "completed" as const, conclusion: "action_required" as const }
      : { status: run.phase, conclusion: run.conclusion }),
    actor: { id: run.actor },
    triggering_actor: { id: run.triggeringActor },
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    run_started_at: run.startedAt,
    completed_at: run.completedAt,
  };
}
