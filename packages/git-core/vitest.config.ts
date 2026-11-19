import { configDefaults, defineConfig } from "vitest/config";

function localWorkers(): { maxWorkers?: number } {
  const workers = Number(process.env.FYRDEN_TEST_WORKERS) || (process.env.CI ? 0 : 2);
  return workers > 0 ? { maxWorkers: workers } : {};
}

export default defineConfig({
  test: {
    ...localWorkers(),
    // Stryker's sandboxes are copies of this package; never collect them as tests.
    exclude: [...configDefaults.exclude, "**/.stryker-tmp/**"],
    // Many tests run git itself; under coverage and a full parallel run a
    // single git round trip can take seconds.
    testTimeout: 30_000,
    coverage: {
      provider: "istanbul",
      include: ["src/**"],
      reporter: ["text-summary", "json", "lcov"],
      thresholds: { lines: 80 },
    },
  },
});
