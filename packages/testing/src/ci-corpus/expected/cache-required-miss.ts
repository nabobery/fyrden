import type { CorpusCase } from "../types.js";

export default {
  id: "cache-required-miss",
  proves: [],
  tiers: ["parse", "runner"],
  trigger: "push",
  runner: { cache: "on", tasks: 1 },
  expect: {
    parse: "ok",
    plan: { jobs: ["restore"] },
    run: {
      conclusion: "failure",
      jobs: {
        restore: {
          conclusion: "failure",
          failedSteps: ["required restore"],
          log: { never: ["never reached"] },
        },
      },
    },
  },
} as const satisfies CorpusCase;
