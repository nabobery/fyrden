import { defineConfig } from "vitest/config";

// Unit tests for server-side helpers under plain Node. The Worker as a whole
// is exercised by the e2e suite (tools/ci/e2e) under wrangler dev.
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
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    coverage: {
      provider: "istanbul",
      include: ["app/lib/**"],
      reporter: ["text-summary", "json", "lcov"],
    },
  },
});
