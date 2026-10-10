import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The e2e suite needs a web build and runs separately (vitest.e2e.config.ts).
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**"],
      reporter: ["text-summary", "json", "lcov"],
    },
  },
});
