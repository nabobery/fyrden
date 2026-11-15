import { defineConfig } from "vitest/config";

// The pinned gitea/runner against fyrden-api under `wrangler dev`, in Docker
// (runner/; RUNNER_VERSION picks the release). One file, one runner at a time.
export default defineConfig({
  test: {
    include: ["runner/**/*.test.ts"],
    // A first run downloads the binary; a job runs in seconds once its container starts.
    testTimeout: 600_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
