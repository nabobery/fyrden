import type { CorpusCase } from "../types.js";

export default {
  id: "docker-step",
  proves: [{ feature: "jobs.<job_id>.steps[*].uses" }],
  tiers: ["parse", "runner"],
  trigger: "push",
  runner: { cache: "on", tasks: 1 },
  expect: {
    parse: "ok",
    plan: { jobs: ["docker"] },
    run: {
      conclusion: "success",
      jobs: { docker: { conclusion: "success", log: { has: ["docker step 42"] } } },
    },
  },
} as const satisfies CorpusCase;
