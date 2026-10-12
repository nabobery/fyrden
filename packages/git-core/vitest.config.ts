import { configDefaults, defineConfig } from "vitest/config";

/** Vitest's default on CI; 2 locally; FYRDEN_TEST_WORKERS overrides both. */
function localWorkers(): { maxWorkers?: number } {
  const workers = Number(process.env.FYRDEN_TEST_WORKERS) || (process.env.CI ? 0 : 2);
  return workers > 0 ? { maxWorkers: workers } : {};
}

export default defineConfig({
  test: {
    // Each test file starts its own runtime (and git processes), so local runs
    // are capped (CI keeps the default; FYRDEN_TEST_WORKERS overrides both).
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
      // Floor, not target.
      thresholds: { lines: 80 },
    },
  },
});
