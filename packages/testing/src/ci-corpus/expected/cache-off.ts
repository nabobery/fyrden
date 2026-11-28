import type { CorpusCase } from "../types.js";

export default {
  id: "cache-off",
  proves: [],
  tiers: ["runner"],
  trigger: "push",
  runner: { cache: "off", tasks: 1 },
  expect: {
    parse: "ok",
    plan: { jobs: ["restore"] },
    run: {
      conclusion: "success",
      jobs: { restore: { conclusion: "success", log: { has: ["cache off [false] absent"] } } },
    },
  },
} as const satisfies CorpusCase;
