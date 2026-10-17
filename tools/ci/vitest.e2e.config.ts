import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 60_000,
    // A teardown closes the browser, gives wrangler dev its 10 s grace before
    // SIGKILL, waits for its processes to be gone and removes the state:
    // well past Vitest's 10 s default, so a stalled shutdown still cleans up.
    hookTimeout: 60_000,
  },
});
