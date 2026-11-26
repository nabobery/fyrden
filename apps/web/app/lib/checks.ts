import type { getCombinedStatus, listCheckRuns, Output } from "@fyrden/api-contract";
import { checkNameKey } from "@fyrden/domain";
import { jobPath, runPath } from "./runs.js";

export type CheckRunsPage = Output<typeof listCheckRuns>;
export type CheckRunItem = CheckRunsPage["check_runs"][number];
export type CombinedStatus = Output<typeof getCombinedStatus>;
export type StatusItem = CombinedStatus["statuses"][number];

/** Fyrden's own CI checks' source, as a required check names it. */
export const CI_SOURCE = "ci";

export function isRequired(
  name: string,
  source: string,
  required: readonly { readonly context: string; readonly integration_id: string | null }[],
): boolean {
  const key = checkNameKey(name);
  return required.some(
    (r) =>
      checkNameKey(r.context) === key && (r.integration_id === null || r.integration_id === source),
  );
}

export function checkTarget(owner: string, repo: string, check: CheckRunItem): string | null {
  if (check.run === null) return null;
  return check.run.job_id !== null
    ? jobPath(owner, repo, check.run.id, check.run.job_id)
    : runPath(owner, repo, check.run.id, check.run.run_attempt);
}

export function statusTarget(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const FAILING_CHECKS = new Set(["failure", "timed_out", "cancelled", "action_required"]);
const PASSING_CHECKS = new Set(["success", "skipped", "neutral"]);

export function checkCounts(
  checks: readonly Pick<CheckRunItem, "status" | "conclusion">[],
  statuses: readonly Pick<StatusItem, "state">[],
): { failing: number; running: number; passed: number; total: number } {
  const counts = { failing: 0, running: 0, passed: 0, total: checks.length + statuses.length };
  for (const c of checks)
    if (c.status !== "completed") counts.running += 1;
    else if (c.conclusion !== null && FAILING_CHECKS.has(c.conclusion)) counts.failing += 1;
    else if (c.conclusion !== null && PASSING_CHECKS.has(c.conclusion)) counts.passed += 1;
  for (const s of statuses)
    if (s.state === "pending") counts.running += 1;
    else if (s.state === "success") counts.passed += 1;
    else counts.failing += 1;
  return counts;
}
