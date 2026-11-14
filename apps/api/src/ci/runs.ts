import type { CreateAnswer } from "../do/RunDO.js";
import type { RunSpec } from "../do/run/spec.js";

export type { RunSpec } from "../do/run/spec.js";

export type StartRunAnswer =
  | CreateAnswer
  | {
      readonly ok: false;
      readonly code: "repo_not_found" | "repo_transferring" | "repo_not_ready";
    };

/**
 * Starts a CI run: the seam triggers call. The repository records the run
 * first, so erasing the repository always finds it; then the run object is
 * created. Both steps are idempotent per run id, so a trigger retries the
 * whole call with the same spec after any failure.
 */
export async function startRun(env: Env, spec: RunSpec): Promise<StartRunAnswer> {
  const registered = await env.REPO.getByName(spec.repoId).registerRun({
    runId: spec.runId,
    sha: spec.sha,
    path: spec.workflow.path,
  });
  if (!registered.ok) return registered;
  return env.RUN.getByName(spec.runId).create(spec);
}
