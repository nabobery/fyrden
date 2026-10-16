import type { JobKind, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import type { RepoDO } from "../../src/do/RepoDO.js";
import { maintenanceHandlers } from "../../src/git/maintenance/handlers.js";
import { MAINTENANCE_DEFAULTS, type MaintenancePolicy } from "../../src/git/maintenance/policy.js";
import { inRepo } from "./repo-git.js";

type Stub = DurableObjectStub<RepoDO>;

const FAR = 1e12;

/**
 * A maintenance policy for tests: nothing is scheduled by commits on its
 * own (tests run jobs explicitly), plus `overrides`.
 */
export function testPolicy(overrides: Partial<MaintenancePolicy> = {}): MaintenancePolicy {
  return {
    ...MAINTENANCE_DEFAULTS,
    reachabilityDelayMs: FAR,
    repackDelayMs: FAR,
    gcDelayMs: FAR,
    ...overrides,
  };
}

/**
 * How far ahead of real time a test object's clock starts: alarms the job
 * queue sets on that clock are then far in the real future and never fire
 * during a test, so only the test runs jobs.
 */
const CLOCK_AHEAD = 100 * 365 * 24 * 60 * 60 * 1000;

/**
 * Sets the test policy (`overrides` on `testPolicy`) and moves the object's
 * clock far ahead of real time (it keeps running with real time).
 */
export const setPolicy = (stub: Stub, overrides: Partial<MaintenancePolicy> = {}) =>
  inRepo(stub, (repo) => {
    repo.maintenance = testPolicy(overrides);
    if (!clocks.has(repo.git)) setOffset(repo.git, CLOCK_AHEAD);
  });

const clocks = new WeakMap<RepoGitStorage, number>();

/** Sets the object's clock to real time plus `offset` (every git storage component reads it). */
export function setOffset(git: RepoGitStorage, offset: number): void {
  clocks.set(git, offset);
  (git.context as { now: () => number }).now = () => Date.now() + offset;
}

export const now = (stub: Stub) => inRepo(stub, ({ git }) => git.context.now());

/** Moves the object's clock forward by `ms`. */
export const advance = (stub: Stub, ms: number) =>
  inRepo(stub, ({ git }) => {
    setOffset(git, (clocks.get(git) ?? 0) + ms);
  });

const JOB_KINDS: Record<string, JobKind> = {
  repack: "repack",
  gc: "gc",
  reachability: "reachability",
  "retire-packs": "retire_packs",
};

/**
 * Runs slices of a maintenance job (queued first if it is not) inside the
 * object, one slice per request, until it is done (or finished a run and
 * scheduled the next one for later: "scheduled") or `max` slices ran.
 * Returns the slices run and the final state.
 */
export async function runJob(
  stub: Stub,
  jobId: "repack" | "gc" | "reachability" | "retire-packs",
  { max = 200, between }: { max?: number; between?: (slice: number) => Promise<void> } = {},
): Promise<{ slices: number; state: string }> {
  const kind = JOB_KINDS[jobId] as JobKind;
  let slices = 0;
  let state = "queued";
  for (; slices < max; ) {
    state = await inRepo(stub, async (repo) => {
      const { git } = repo;
      const job = git.jobs.get(jobId);
      if (!job || job.state === "done" || job.state === "failed") git.jobs.ensure(kind, jobId);
      const handlers = maintenanceHandlers(git, {
        policy: () => repo.maintenance,
        log: createLogger({ test: "maintenance" }),
        retire: repo.retireOptions,
        gc: repo.gcHooks,
        roots: () => repo.gcRoots(),
      });
      const ran = await git.jobs.runJob(jobId, handlers[kind] as never, git.memory, 0);
      if (ran.state === "busy") return "busy";
      const after = git.jobs.get(jobId);
      // A run that finished and scheduled the next one for later: done for now.
      const due = git.context.storage.sql
        .exec<{ at: number }>("SELECT next_run_at AS at FROM jobs WHERE job_id = ?", jobId)
        .toArray()[0]?.at;
      if (after?.state === "queued" && after.cursor === null && (due ?? 0) > git.context.now())
        return "scheduled";
      return after?.state ?? "missing";
    });
    slices++;
    if (between) await between(slices);
    if (state !== "queued") break;
  }
  return { slices, state };
}

/** Pack rows by state, for assertions. */
export const packStates = (stub: Stub) =>
  inRepo(stub, ({ git }) =>
    git.context.storage.sql
      .exec<{ pack_id: string; kind: string; state: string; all_reachable: number }>(
        "SELECT pack_id, kind, state, all_reachable FROM packs ORDER BY created_at, pack_id",
      )
      .toArray(),
  );
