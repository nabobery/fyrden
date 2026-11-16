import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**"],
      reporter: ["text-summary", "json", "lcov"],
    },
  },
});
