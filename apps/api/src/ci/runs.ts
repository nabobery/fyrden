import type { CreateAnswer, RunDO } from "../do/RunDO.js";
import type { RunSpec } from "../do/run/spec.js";

export type { RunSpec } from "../do/run/spec.js";

type RegisterRefusal =
  | "repo_not_found"
  | "repo_transferring"
  | "repo_not_ready"
  | "owner_changed"
  | "commit_unreachable";

export type StartRunAnswer = CreateAnswer | { readonly ok: false; readonly code: RegisterRefusal };

type RegisterAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RegisterRefusal };

/**
 * The owner (and owner generation) a spec was built under: its first
 * registration needs it, and the run is bound to that owner, whose secrets
 * alone its jobs are given.
 */
export interface BuiltUnder {
  readonly owner: string;
  readonly ownerGen?: number;
}

/** What records a run in its repository (the repository object's `registerRun`). */
export interface RunRegistrar {
  registerRun(input: {
    readonly runId: string;
    readonly sha: string;
    readonly path: string;
    readonly builtUnder?: BuiltUnder;
    readonly reachableVia?: string;
  }): Promise<RegisterAnswer>;
}

/**
 * Starts a CI run: the seam triggers call. The repository records the run
 * after its id is reserved, so erasing the repository always finds its own
 * run; then the run object is created. All steps are idempotent per run id, so a trigger retries the
 * whole call with the same spec after any failure.
 */
export async function startRun(
  env: Env,
  spec: RunSpec,
  builtUnder?: BuiltUnder,
): Promise<StartRunAnswer> {
  return startRunFrom(env.REPO.getByName(spec.repoId), env, spec, builtUnder);
}

/**
 * `startRun` with the repository given: the repository object starting its
 * own runs passes itself, so recording the run is no call to itself.
 * `reachableVia` is the object a ref named when the trigger read the
 * commit (the commit, or an annotated tag's object): a first registration
 * refuses it as `commit_unreachable` once no ref and no reflog entry within
 * the retention names it, as garbage collection may no longer keep the commit.
 */
export async function startRunFrom(
  repo: RunRegistrar,
  env: { readonly RUN: DurableObjectNamespace<RunDO> },
  spec: RunSpec,
  builtUnder?: BuiltUnder,
  reachableVia?: string,
): Promise<StartRunAnswer> {
  const reserved = await env.RUN.getByName(spec.runId).reserve(spec);
  if (!reserved.ok) return reserved;
  const registered = await repo.registerRun({
    runId: spec.runId,
    sha: spec.sha,
    path: spec.workflow.path,
    ...(builtUnder && { builtUnder }),
    ...(reachableVia !== undefined && { reachableVia }),
  });
  if (!registered.ok) return registered;
  // The RPC stub's type of a union answer is not assignable to the union; it is the union.
  return (await env.RUN.getByName(spec.runId).create(
    spec,
    builtUnder?.owner,
  )) as unknown as CreateAnswer;
}
