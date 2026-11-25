import type { CheckRunRecord, StatusRecord } from "../do/repo/checks.js";
import type { RunReport } from "../do/repo/run-history.js";
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
