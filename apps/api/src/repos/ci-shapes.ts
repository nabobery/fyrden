import type { createStatus, listCheckRuns, Output } from "@fyrden/api-contract";
import type { CheckRunRecord, StatusRecord } from "../do/repo/checks.js";

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
