/*
 * What a runner provider is: something that says what it can run, what that
 * costs, and (a hosted one) makes a machine that registers one ephemeral
 * runner for one job. Providers are plain objects: making one calls nothing.
 */
import type { Job } from "@fyrden/domain/ci";

export interface ProviderCapabilities {
  /** Whether it makes machines. False: its runners are somebody's own, and pull their jobs. */
  readonly provisions: boolean;
  readonly os: readonly string[];
  readonly arch: readonly string[];
  readonly docker: boolean | "unknown";
  /** Whether a job's containers get a network of their own, or only the host's. */
  readonly containerNetworking: "per_job" | "host" | "unknown";
  /** The longest a machine may live, its boot included; null when there is no limit. */
  readonly maxLifetimeMs: number | null;
}

/** What a job asks of a machine. The caller fills it in; nothing here is read from labels. */
export interface JobRequirements {
  /** The job's `runs-on`. */
  readonly labels: readonly string[];
  /** Null: any. */
  readonly os: string | null;
  readonly arch: string | null;
  readonly docker: boolean;
  /** Whether its containers need a network of the job's own (`requiresJobNetwork`). */
  readonly jobNetwork: boolean;
  readonly timeoutMs: number;
  /** How long it is expected to run, for its cost. */
  readonly expectedMs: number;
}

/** Whether a job has containers that reach each other: `services:`, or a `container:` of its own. */
export function requiresJobNetwork(job: Pick<Job, "services" | "container">): boolean {
  return job.services.length > 0 || job.container !== undefined;
}

/** Whole, non-negative numbers; the billing step is at least 1. */
export interface CostEstimate {
  readonly microUsdPerMinute: number;
  /** Time is billed in whole steps. */
  readonly billingStepMs: number;
  readonly expectedBootMs: number;
}

/** A provider's answer to what it does not do, or cannot run. */
export interface Unsupported {
  readonly unsupported: string;
}

export function isUnsupported(answer: unknown): answer is Unsupported {
  return typeof answer === "object" && answer !== null && "unsupported" in answer;
}

/** What a new machine registers its runner with. The token registers one runner, once. */
export interface EphemeralRegistration {
  readonly token: string;
}

/** An instance a provider made. It never carries the registration token. */
export interface InstanceHandle {
  readonly providerId: string;
  /** Never given to another instance, also once this one is gone. */
  readonly instanceId: string;
  /** What it was made for, as `provision` was given it: the instance's tag. */
  readonly intent: string;
}

export type InstanceStatus = "booting" | "ready" | "running" | "gone";

export interface RunnerProvider {
  readonly id: string;
  /** The same each time, and without calling anything, as `estimate`. */
  describe(): ProviderCapabilities;
  estimate(req: JobRequirements): CostEstimate | Unsupported;
  /**
   * Makes an instance tagged with `intent`. A call whose answer is lost may
   * have made it: list by the intent before asking again.
   */
  provision(
    req: JobRequirements,
    registration: EphemeralRegistration,
    intent: string,
  ): Promise<InstanceHandle | Unsupported>;
  /** `gone` only when it is: one it cannot ask about is a rejection. */
  status(handle: InstanceHandle): Promise<InstanceStatus | Unsupported>;
  /** Done when the instance is gone, also when it was gone already. */
  teardown(handle: InstanceHandle): Promise<void>;
  /**
   * Every instance there is whose intent begins with `tag`, one whose
   * answer was lost too. One it cannot be sure of is a rejection, never a
   * shorter list: an empty one allows another purchase. `tag` is a prefix:
   * the caller compares the whole intent before it takes one as its own.
   */
  listOrphans(tag: string): Promise<readonly InstanceHandle[]>;
}
