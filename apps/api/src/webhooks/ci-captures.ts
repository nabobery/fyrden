import type { CheckRunRecord, StatusRecord } from "../do/repo/checks.js";
import type { JobReport, RunReport } from "../do/repo/run-history.js";
import { checkRunOutput, runSummary, statusOutput } from "../repos/ci-shapes.js";
import type { CaptureValue } from "./capture.js";
import { capturable } from "./captures.js";

type Captured = Record<string, CaptureValue>;

export const captureStatus = (status: StatusRecord): Captured => ({
  sha: status.sha,
  ...(capturable(statusOutput(status)) as Captured),
});

export const captureCheckRun = (check: CheckRunRecord): Captured => ({
  check_run: capturable(checkRunOutput(check)),
});

export const captureWorkflowRun = (run: RunReport): Captured => ({
  workflow_run: capturable(runSummary(run)),
});

export const captureWorkflowJob = (job: JobReport, run: RunReport): Captured => ({
  workflow_job: capturable({
    id: job.jobId,
    run_id: run.runId,
    run_attempt: job.attempt,
    workflow_name: run.name,
    head_branch: run.headBranch,
    head_sha: run.sha,
    name: job.name,
    job_key: job.key,
    status: job.action,
    conclusion: job.conclusion,
    labels: job.labels,
    started_at: job.startedAt,
    completed_at: job.completedAt,
  }),
});
