import type { CorpusCase } from "../types.js";

export default {
  id: "needs-and-outputs",
  proves: [
    { feature: "jobs.<job_id>.needs" },
    { feature: "jobs.<job_id>.outputs" },
    { feature: "expression.context", value: "needs" },
    { feature: "expression.context", value: "steps" },
  ],
  tiers: ["parse", "runner"],
  trigger: "push",
  runner: { cache: "on", tasks: 3 },
  expect: {
    parse: "ok",
    plan: { jobs: ["build", "lint", "report"] },
    run: {
      conclusion: "success",
      jobs: {
        build: { conclusion: "success" },
        lint: { conclusion: "success" },
        report: { conclusion: "success", log: { has: ["report answer=42 verdict=clean-42"] } },
      },
    },
  },
} as const satisfies CorpusCase;
