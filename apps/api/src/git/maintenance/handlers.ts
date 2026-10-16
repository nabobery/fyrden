import {
  type JobHandler,
  type JobKind,
  type PackRetireOptions,
  packRetireHandler,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import type { BlockCache, Oid } from "@fyrden/git-core";
import { type GcHooks, gcHandler } from "./gc-job.js";
import type { MaintenancePolicy } from "./policy.js";
import { reachabilityHandler } from "./reachability-job.js";
import { repackHandler } from "./repack-job.js";

export interface MaintenanceWiring {
  readonly policy: () => MaintenancePolicy;
  readonly log: Logger;
  /** The object's in-memory pack block tier. */
  readonly blocks?: () => BlockCache;
  readonly retire?: PackRetireOptions;
  readonly gc?: GcHooks;
  /** What garbage collection keeps besides what the refs and the reflog reach. */
  readonly roots: () => readonly Oid[];
}

/** The job handlers of repack and garbage collection, for the object's alarm. */
export function maintenanceHandlers(
  git: RepoGitStorage,
  wiring: MaintenanceWiring,
): Partial<Record<JobKind, JobHandler>> {
  return {
    repack: repackHandler(git, wiring.policy, wiring.log, wiring.blocks),
    gc: gcHandler(git, wiring.policy, wiring.log, wiring.blocks, wiring.gc, wiring.roots),
    reachability: reachabilityHandler(git, wiring.policy, wiring.blocks),
    retire_packs: packRetireHandler(git, wiring.retire),
  };
}
