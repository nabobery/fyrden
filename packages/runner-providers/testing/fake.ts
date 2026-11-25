import { labelsMatch } from "@fyrden/domain/ci";
import type {
  CostEstimate,
  InstanceHandle,
  InstanceStatus,
  JobRequirements,
  ProviderCapabilities,
  RunnerProvider,
  Unsupported,
} from "../src/provider.js";

export interface FakeProviderOptions {
  readonly id?: string;
  readonly capabilities?: Partial<ProviderCapabilities>;
  /** The labels its runners have. */
  readonly labels?: readonly string[];
  readonly estimate?: CostEstimate;
}

export interface FakeProvider {
  readonly provider: RunnerProvider;
  /** Calls that would reach the provider's service, by name. No argument is kept: one is a token. */
  readonly calls: Readonly<Record<"provision" | "status" | "teardown" | "listOrphans", number>>;
  /** Instances made so far, those gone again too. */
  made(): number;
  /** Instances there are now. */
  live(): number;
  /** While on, every call to its service fails, after the first few if told so. */
  outage(on: boolean, after?: number): void;
  /** The next `provision` makes its instance, and its answer is lost. */
  loseNextResponse(): void;
  /** The instance's next state: booting, ready, running. */
  advance(handle: InstanceHandle): void;
  /** The machine goes away by itself. */
  vanish(handle: InstanceHandle): void;
}

const LIVE = ["booting", "ready", "running"] as const satisfies readonly InstanceStatus[];

/** A hosted provider in memory. Nothing changes by itself: a test advances it. */
export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const id = options.id ?? "fake";
  const capabilities: ProviderCapabilities = {
    provisions: true,
    os: ["linux"],
    arch: ["amd64"],
    docker: true,
    containerNetworking: "per_job",
    maxLifetimeMs: 6 * 60 * 60_000,
    ...options.capabilities,
  };
  const labels = options.labels ?? ["ubuntu-latest"];
  const cost = options.estimate ?? {
    microUsdPerMinute: 100,
    billingStepMs: 60_000,
    expectedBootMs: 30_000,
  };
  const calls = { provision: 0, status: 0, teardown: 0, listOrphans: 0 };
  const instances = new Map<string, { intent: string; at: number }>();
  let made = 0;
  let lose = false;
  let callsLeft: number | null = null;
  const call = (name: keyof typeof calls) => {
    calls[name]++;
    if (callsLeft === null) return;
    if (callsLeft === 0) throw new Error("the service is down");
    callsLeft--;
  };

  const handleOf = (instanceId: string, intent: string): InstanceHandle => ({
    providerId: id,
    instanceId,
    intent,
  });
  const refusal = (req: JobRequirements): Unsupported | null => {
    const { os, arch, docker, containerNetworking, maxLifetimeMs } = capabilities;
    if (!labelsMatch(req.labels, labels)) return { unsupported: "labels" };
    if (req.os !== null && !os.includes(req.os)) return { unsupported: "os" };
    if (req.arch !== null && !arch.includes(req.arch)) return { unsupported: "arch" };
    if ((req.docker || req.jobNetwork) && docker !== true) return { unsupported: "docker" };
    if (req.jobNetwork && containerNetworking !== "per_job") return { unsupported: "networking" };
    if (maxLifetimeMs !== null && cost.expectedBootMs + req.timeoutMs > maxLifetimeMs)
      return { unsupported: "lifetime" };
    return null;
  };
  const ownLive = (handle: InstanceHandle) =>
    handle.providerId === id ? instances.get(handle.instanceId) : undefined;

  return {
    calls,
    made: () => made,
    live: () => instances.size,
    outage: (on, after = 0) => {
      callsLeft = on ? after : null;
    },
    loseNextResponse: () => {
      lose = true;
    },
    advance: (handle) => {
      const instance = ownLive(handle);
      if (!instance) throw new Error(`no instance ${handle.instanceId}`);
      instance.at = Math.min(instance.at + 1, LIVE.length - 1);
    },
    vanish: (handle) => {
      instances.delete(handle.instanceId);
    },
    provider: {
      id,
      describe: () => capabilities,
      estimate: (req) => refusal(req) ?? cost,
      provision: async (req, _registration, intent) => {
        const refused = refusal(req);
        if (refused) return refused;
        call("provision");
        const instanceId = `${id}-${++made}`;
        instances.set(instanceId, { intent, at: 0 });
        if (lose) {
          lose = false;
          throw new Error("the response was lost");
        }
        return handleOf(instanceId, intent);
      },
      status: async (handle) => {
        call("status");
        const instance = ownLive(handle);
        return instance ? (LIVE[instance.at] as InstanceStatus) : "gone";
      },
      teardown: async (handle) => {
        call("teardown");
        if (handle.providerId === id) instances.delete(handle.instanceId);
      },
      listOrphans: async (tag) => {
        call("listOrphans");
        return [...instances]
          .filter(([, instance]) => instance.intent.startsWith(tag))
          .map(([instanceId, instance]) => handleOf(instanceId, instance.intent));
      },
    },
  };
}
