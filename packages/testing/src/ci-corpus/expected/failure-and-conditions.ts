import type { CorpusCase } from "../types.js";

export default {
  id: "failure-and-conditions",
  proves: [
    { feature: "jobs.<job_id>.if" },
    { feature: "jobs.<job_id>.steps[*].if" },
    {
      feature: "jobs.<job_id>.continue-on-error",
      level: "parse",
      why: "Here another job already fails the run; that an allowed failure passes the run is the run engine's, tested by name.",
    },
    { feature: "jobs.<job_id>.steps[*].continue-on-error" },
    { feature: "expression.function", value: "success" },
    { feature: "expression.function", value: "failure" },
    { feature: "expression.function", value: "always" },
    { feature: "expression.function", value: "cancelled" },
  ],
  tiers: ["parse", "runner"],
  trigger: "push",
  runner: { cache: "on", tasks: 4 },
  expect: {
    parse: "ok",
    plan: { jobs: ["fails", "skipped-after-failure", "on-failure", "always", "tolerated"] },
    run: {
      conclusion: "failure",
      jobs: {
        fails: {
          conclusion: "failure",
          failedSteps: ["breaks"],
          log: { has: ["still 42", "step failure 4"], never: ["never 2"] },
        },
        "skipped-after-failure": { conclusion: "skipped" },
        "on-failure": { conclusion: "success", log: { has: ["job failure 6"] } },
        always: { conclusion: "success", log: { has: ["always 8"] } },
        tolerated: { conclusion: "failure", failedSteps: ["fails anyway"] },
      },
    },
  },
} as const satisfies CorpusCase;
