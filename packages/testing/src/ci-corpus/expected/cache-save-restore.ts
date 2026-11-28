import type { CorpusCase } from "../types.js";

export default {
  id: "cache-save-restore",
  proves: [],
  tiers: ["parse", "runner"],
  trigger: "push",
  runner: { cache: "on", tasks: 2 },
  expect: {
    parse: "ok",
    plan: { jobs: ["save", "restore"] },
    run: {
      conclusion: "success",
      jobs: {
        save: { conclusion: "success" },
        restore: {
          conclusion: "success",
          log: { has: ["exact [true] cached ", "prefix [false] cached ", "miss [] absent"] },
        },
      },
    },
  },
} as const satisfies CorpusCase;
