import type { CorpusCase } from "../types.js";

export default {
  id: "secrets-and-vars",
  proves: [{ feature: "expression.context", value: "secrets" }],
  tiers: ["parse", "runner"],
  trigger: "push",
  setup: { secrets: ["CORPUS_SECRET"], vars: { CORPUS_VAR: "corpus-variable" } },
  runner: { cache: "on", tasks: 1 },
  expect: {
    parse: "ok",
    plan: { jobs: ["secrets"] },
    run: {
      conclusion: "success",
      jobs: {
        secrets: {
          conclusion: "success",
          log: { has: ["secret [***]", "variable corpus-variable"] },
        },
      },
    },
  },
} as const satisfies CorpusCase;
