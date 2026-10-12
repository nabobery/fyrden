import { defineConfig } from "vitest/config";

// The long-running fuzzer (fuzz/run.fuzz.ts), outside the regular test run.
// Its own time budget is FYRDEN_FUZZ_SECONDS per target; the timeout leaves
// room for the seed pass and the last batch.
const seconds = Number(process.env.FYRDEN_FUZZ_SECONDS ?? 10);

export default defineConfig({
  test: {
    include: ["fuzz/**/*.fuzz.ts"],
    testTimeout: (seconds + 120) * 1000,
    // The runner's memory bounds collect garbage before they judge; the heap
    // has a hard cap too.
    execArgv: ["--expose-gc", "--max-old-space-size=1536"],
  },
});
