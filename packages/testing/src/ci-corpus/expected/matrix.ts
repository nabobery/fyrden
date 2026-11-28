import type { CorpusCase } from "../types.js";

export default {
  id: "matrix",
  proves: [
    { feature: "jobs.<job_id>.name" },
    { feature: "jobs.<job_id>.strategy" },
    { feature: "jobs.<job_id>.strategy.matrix" },
    { feature: "jobs.<job_id>.strategy.matrix.include" },
    { feature: "jobs.<job_id>.strategy.matrix.exclude" },
    { feature: "expression.context", value: "matrix" },
    { feature: "expression.context", value: "strategy" },
  ],
  tiers: ["parse", "runner"],
  trigger: "push",
  runner: { cache: "on", tasks: 3 },
  expect: {
    parse: "ok",
    plan: {
      jobs: ["combine"],
      instances: {
        combine: [
          { name: "combine linux small", matrix: { os: "linux", size: "small", extra: "bonus" } },
          { name: "combine linux large", matrix: { os: "linux", size: "large" } },
          { name: "combine mac small", matrix: { os: "mac", size: "small" } },
        ],
      },
    },
    run: {
      conclusion: "success",
      jobs: {
        "combine linux small": {
          conclusion: "success",
          log: { has: ["cell linux-small-bonus at 0/3"] },
        },
        "combine linux large": {
          conclusion: "success",
          log: { has: ["cell linux-large- at 1/3"] },
        },
        "combine mac small": { conclusion: "success", log: { has: ["cell mac-small- at 2/3"] } },
      },
    },
  },
} as const satisfies CorpusCase;
