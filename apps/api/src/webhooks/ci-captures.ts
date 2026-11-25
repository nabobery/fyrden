import type { CheckRunRecord, StatusRecord } from "../do/repo/checks.js";
import { checkRunOutput, statusOutput } from "../repos/ci-shapes.js";
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
