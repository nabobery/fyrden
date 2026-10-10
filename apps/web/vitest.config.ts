import { defineConfig } from "vitest/config";

// Unit tests for server-side helpers under plain Node. The Worker as a whole
// is exercised by the e2e suite (tools/ci/e2e) under wrangler dev.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["app/lib/**"],
      reporter: ["text-summary", "json", "lcov"],
    },
  },
});
