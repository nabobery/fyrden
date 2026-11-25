import type { RunnerProvider } from "./provider.js";

const OWN_MACHINES = "bring-your-own runners are registered by their owners";

/**
 * Runners people register on their own machines. They pull their jobs, so
 * nothing is bought, made or torn down here. What a machine has is not
 * known: a runner declares label names, not how it runs them.
 */
export const byoProvider: RunnerProvider = Object.freeze<RunnerProvider>({
  id: "byo",
  describe: () => ({
    provisions: false,
    os: [],
    arch: [],
    docker: "unknown",
    containerNetworking: "unknown",
    maxLifetimeMs: null,
  }),
  estimate: () => ({ microUsdPerMinute: 0, billingStepMs: 60_000, expectedBootMs: 0 }),
  provision: async () => ({ unsupported: OWN_MACHINES }),
  status: async () => ({ unsupported: OWN_MACHINES }),
  teardown: async () => undefined,
  listOrphans: async () => [],
});
