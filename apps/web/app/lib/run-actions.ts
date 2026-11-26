import type { Run } from "./runs.js";

export type RunIntent = "rerun" | "cancel" | "approve";

/** What a writer may ask of a run as it is shown: approval first, since a waiting run reads as completed. */
export function runActions(run: Run): Record<RunIntent, boolean> {
  const approval = run.approval?.state ?? null;
  if (approval === "waiting") return { rerun: false, cancel: true, approve: true };
  if (approval !== null && approval !== "approved")
    return { rerun: false, cancel: false, approve: false };
  if (run.status !== "completed") return { rerun: false, cancel: true, approve: false };
  return { rerun: run.errors.length === 0, cancel: false, approve: false };
}

export function runActionError(status: number, code: string | undefined, detail?: string): string {
  switch (code) {
    case "run_not_cancellable":
      return "This run has already finished.";
    case "run_not_completed":
      return "This run is still running, or its workflow could not run, so it cannot be re-run.";
    case "rerun_limit":
      return "This run has been re-run 50 times, the most it can be.";
    case "approval_not_pending":
      return "This run no longer waits for approval.";
    case "approval_required":
      return "This run was never approved, so it cannot be re-run; push again or ask a maintainer.";
    case "attempt_changed":
      return "The run has a newer attempt; review it before acting.";
    case "ci_off":
      return "CI is off on this deployment.";
    case "rate_limited":
      return "Too many requests; try again shortly.";
  }
  if (status === 403 || status === 404)
    return "You do not have permission to do this, or the run no longer exists.";
  return detail ?? "The run could not be changed; try again.";
}
