import { PULL_REQUEST_HEAD } from "../shared.js";
import type { CorpusCase } from "../types.js";

export default {
  id: "pull-request",
  proves: [
    { feature: "on.pull_request" },
    { feature: "on.pull_request.types" },
    { feature: "on.pull_request.types", value: "opened" },
  ],
  tiers: ["parse", "runner"],
  trigger: "pull_request",
  runner: { cache: "on", tasks: 1 },
  expect: {
    parse: "ok",
    plan: { jobs: ["pr"] },
    run: {
      conclusion: "success",
      jobs: {
        pr: { conclusion: "success", log: { has: [`refs ${PULL_REQUEST_HEAD} into main`] } },
      },
    },
  },
} as const satisfies CorpusCase;
