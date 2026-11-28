import type { CorpusCase } from "../types.js";

export default {
  id: "checkout",
  proves: [{ feature: "jobs.<job_id>.steps[*].uses" }, { feature: "jobs.<job_id>.steps[*].with" }],
  tiers: ["parse", "runner"],
  trigger: "push",
  setup: { files: { "corpus/checkout.txt": "checked out from the forge\n" } },
  runner: { cache: "on", tasks: 1 },
  expect: {
    parse: "ok",
    plan: { jobs: ["checkout"] },
    run: {
      conclusion: "success",
      jobs: { checkout: { conclusion: "success", log: { has: ["checked out from the forge"] } } },
    },
  },
} as const satisfies CorpusCase;
