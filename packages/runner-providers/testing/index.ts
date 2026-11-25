// Test support for runner providers: the contract every one must pass, and
// a fake in memory.
export {
  describeProviderContract,
  PROVIDER_RULES,
  type ProviderRule,
  type ProviderUnderTest,
  ruleViolations,
} from "./contract.js";
export { createFakeProvider, type FakeProvider, type FakeProviderOptions } from "./fake.js";
