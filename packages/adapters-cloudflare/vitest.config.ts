import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** Vitest's default on CI; 2 locally; FYRDEN_TEST_WORKERS overrides both. */
function localWorkers(): { maxWorkers?: number } {
  const workers = Number(process.env.FYRDEN_TEST_WORKERS) || (process.env.CI ? 0 : 2);
  return workers > 0 ? { maxWorkers: workers } : {};
}

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    // Each test file starts its own runtime (and git processes), so local runs
    // are capped (CI keeps the default; FYRDEN_TEST_WORKERS overrides both).
    ...localWorkers(),
    setupFiles: ["./test/setup/log-capture.ts"],
    // Istanbul only: V8 coverage is not supported inside workerd.
    coverage: {
      provider: "istanbul",
      include: ["src/**"],
      reporter: ["text-summary", "json", "lcov"],
    },
  },
});
