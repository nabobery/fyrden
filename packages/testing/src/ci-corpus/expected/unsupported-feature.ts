import type { CorpusCase } from "../types.js";

export default {
  id: "unsupported-feature",
  proves: [],
  tiers: ["parse", "runner"],
  trigger: "push",
  runner: { cache: "on", tasks: 0 },
  expect: {
    parse: { errors: [{ code: "unsupported_key", feature: "jobs.<job_id>.uses" }] },
    run: {
      conclusion: "failure",
      jobs: {},
      errors: [{ code: "unsupported_key", feature: "jobs.<job_id>.uses" }],
    },
  },
} as const satisfies CorpusCase;
