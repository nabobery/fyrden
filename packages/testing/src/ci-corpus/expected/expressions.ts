import type { CorpusCase } from "../types.js";

export default {
  id: "expressions",
  proves: [
    { feature: "yaml.anchors" },
    { feature: "name" },
    { feature: "run-name" },
    { feature: "expression.function", value: "contains" },
    { feature: "expression.function", value: "startsWith" },
    { feature: "expression.function", value: "endsWith" },
    { feature: "expression.function", value: "format" },
    { feature: "expression.function", value: "join" },
    { feature: "expression.function", value: "toJSON" },
    { feature: "expression.function", value: "fromJSON" },
    { feature: "expression.function", value: "case" },
    { feature: "expression.function", value: "hashFiles" },
    { feature: "expression.context", value: "github" },
    { feature: "expression.context", value: "env" },
    { feature: "expression.context", value: "job" },
    { feature: "expression.context", value: "runner" },
    { feature: "expression.context", value: "vars" },
  ],
  tiers: ["parse", "runner"],
  trigger: "push",
  setup: { vars: { CORPUS_VAR: "corpus-variable" } },
  runner: { cache: "on", tasks: 1 },
  expect: {
    parse: "ok",
    plan: { jobs: ["evaluate"] },
    run: {
      conclusion: "success",
      displayTitle: "expressions on main",
      jobs: {
        evaluate: {
          conclusion: "success",
          log: {
            has: [
              'functions true true true a-b x+y "quoted" pushed',
              "status functions 2",
              "contexts push hello success Linux corpus-variable anchored",
              "hash a16d0b0520fcad3c3541e90556805b629b7bee70ddcbd8e0be5bad95ff35e9e4",
            ],
          },
        },
      },
    },
  },
} as const satisfies CorpusCase;
