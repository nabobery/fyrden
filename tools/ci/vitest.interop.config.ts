import { defineConfig } from "vitest/config";

// The git interoperability suites under interop/ (see docs/testing.md). Each
// file starts its own `wrangler dev`; cases inside a file run a few at a time.
export default defineConfig({
  test: {
    include: ["interop/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    maxConcurrency: 4,
  },
});
