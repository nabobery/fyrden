import type { JobRequirements } from "../../src/index.js";
import {
  createFakeProvider,
  type FakeProviderOptions,
  type ProviderUnderTest,
} from "../../testing/index.js";

const MINUTE = 60_000;

export const job = (more: Partial<JobRequirements> = {}): JobRequirements => ({
  labels: ["ubuntu-latest"],
  os: "linux",
  arch: "amd64",
  docker: false,
  jobNetwork: false,
  timeoutMs: 60 * MINUTE,
  expectedMs: 10 * MINUTE,
  ...more,
});

/** A fake and jobs it can and cannot run, as the contract takes them. */
export function fakeUnderTest(options: FakeProviderOptions = {}): ProviderUnderTest {
  const fake = createFakeProvider(options);
  return {
    provider: fake.provider,
    supported: job({ docker: true, jobNetwork: true }),
    unsupported: [
      job({ labels: ["windows-latest"] }),
      job({ labels: [] }),
      job({ os: "windows" }),
      job({ arch: "arm64" }),
      job({ timeoutMs: 7 * 60 * MINUTE }),
    ],
    calls: () => Object.values(fake.calls).reduce((a, b) => a + b, 0),
    made: fake.made,
    loseNextResponse: fake.loseNextResponse,
  };
}
