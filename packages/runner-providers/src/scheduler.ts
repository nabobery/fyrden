import {
  type CostEstimate,
  isUnsupported,
  type JobRequirements,
  type ProviderCapabilities,
  type RunnerProvider,
} from "./provider.js";

/** Why a candidate was dropped: the first that holds, in this order. */
export type DropReason =
  | "does_not_provision"
  | "os"
  | "arch"
  | "docker"
  | "networking"
  /** The provider's own answer (the job's labels, say). */
  | "unsupported"
  | "invalid_estimate"
  /** It would boot and run the job for longer than the machine may live. */
  | "lifetime";

export interface Dropped {
  readonly providerId: string;
  readonly reason: DropReason;
  /** The provider's words, for `unsupported`. */
  readonly detail?: string;
}

export interface Choice {
  readonly provider: RunnerProvider;
  readonly estimate: CostEstimate;
  /** The expected cost, in whole micro-USD, rounded up. */
  readonly costMicroUsd: number;
}

export interface Schedule {
  /** Null when every candidate was dropped. */
  readonly choice: Choice | null;
  /** In the candidates' order. */
  readonly dropped: readonly Dropped[];
}

const MINUTE_MS = 60_000;

/**
 * Where to buy a machine for a job: the cheapest candidate that can run it,
 * the soonest to boot among equals, then the first id. Nothing is assumed:
 * what a candidate does not know of itself counts as not having it. It does
 * not decide which registered runner takes a job: those pull, and the caller
 * asks whether one may before it buys. A candidate that throws, two with
 * one id, or times that are not whole and positive, are mistakes: thrown.
 */
export function schedule(req: JobRequirements, candidates: readonly RunnerProvider[]): Schedule {
  for (const name of ["timeoutMs", "expectedMs"] as const)
    if (!Number.isSafeInteger(req[name]) || req[name] <= 0)
      throw new RangeError(`${name} ${req[name]}`);

  const ids = new Set<string>();
  for (const { id } of candidates) {
    if (ids.has(id)) throw new RangeError(`two candidates are ${id}`);
    ids.add(id);
  }

  const dropped: Dropped[] = [];
  let best: Priced | null = null;
  for (const provider of candidates) {
    const providerId = provider.id;
    const has = provider.describe();
    const lacks = missing(req, has);
    if (lacks) {
      dropped.push({ providerId, reason: lacks });
      continue;
    }
    const estimate = provider.estimate(req);
    if (isUnsupported(estimate)) {
      dropped.push({ providerId, reason: "unsupported", detail: estimate.unsupported });
      continue;
    }
    const cost = expectedCost(estimate, req.expectedMs);
    if (cost === null) {
      dropped.push({ providerId, reason: "invalid_estimate" });
      continue;
    }
    const needsMs = estimate.expectedBootMs + req.timeoutMs;
    if (has.maxLifetimeMs !== null && !(needsMs <= has.maxLifetimeMs)) {
      dropped.push({ providerId, reason: "lifetime" });
      continue;
    }
    const priced = { provider, estimate, cost };
    if (best === null || before(priced, best)) best = priced;
  }
  return {
    choice: best && {
      provider: best.provider,
      estimate: best.estimate,
      costMicroUsd: Math.ceil(best.cost / MINUTE_MS),
    },
    dropped,
  };
}

function missing(req: JobRequirements, has: ProviderCapabilities): DropReason | null {
  if (!has.provisions) return "does_not_provision";
  if (req.os !== null && !has.os.includes(req.os)) return "os";
  if (req.arch !== null && !has.arch.includes(req.arch)) return "arch";
  if ((req.docker || req.jobNetwork) && has.docker !== true) return "docker";
  if (req.jobNetwork && has.containerNetworking !== "per_job") return "networking";
  return null;
}

interface Priced {
  readonly provider: RunnerProvider;
  readonly estimate: CostEstimate;
  /** Micro-USD times milliseconds a minute: whole, so compared exactly. */
  readonly cost: number;
}

const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** The price of `expectedMs` in whole billing steps; null for an estimate that is no price. */
function expectedCost(estimate: CostEstimate, expectedMs: number): number | null {
  const { microUsdPerMinute, billingStepMs, expectedBootMs } = estimate;
  if (!whole(microUsdPerMinute) || !whole(billingStepMs) || !whole(expectedBootMs)) return null;
  if (billingStepMs === 0) return null;
  const cost = Math.ceil(expectedMs / billingStepMs) * billingStepMs * microUsdPerMinute;
  return whole(cost) ? cost : null;
}

function before(a: Priced, b: Priced): boolean {
  if (a.cost !== b.cost) return a.cost < b.cost;
  if (a.estimate.expectedBootMs !== b.estimate.expectedBootMs)
    return a.estimate.expectedBootMs < b.estimate.expectedBootMs;
  return a.provider.id < b.provider.id;
}
