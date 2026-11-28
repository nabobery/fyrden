import type { CorpusCase } from "../types.js";

const INPUT_CHECKS =
  "Checked when the dispatch request arrives, before any runner; the run pages show descriptions.";

export default {
  id: "dispatch-inputs",
  proves: [
    { feature: "on.workflow_dispatch" },
    { feature: "on.workflow_dispatch.inputs" },
    {
      feature: "on.workflow_dispatch.inputs.<input_id>.description",
      level: "parse",
      why: INPUT_CHECKS,
    },
    {
      feature: "on.workflow_dispatch.inputs.<input_id>.required",
      level: "parse",
      why: INPUT_CHECKS,
    },
    { feature: "on.workflow_dispatch.inputs.<input_id>.default" },
    { feature: "on.workflow_dispatch.inputs.<input_id>.type" },
    {
      feature: "on.workflow_dispatch.inputs.<input_id>.options",
      level: "parse",
      why: INPUT_CHECKS,
    },
    { feature: "on.workflow_dispatch.inputs.<input_id>.type", value: "string" },
    { feature: "on.workflow_dispatch.inputs.<input_id>.type", value: "boolean" },
    { feature: "on.workflow_dispatch.inputs.<input_id>.type", value: "choice" },
    { feature: "on.workflow_dispatch.inputs.<input_id>.type", value: "number" },
    { feature: "expression.context", value: "inputs" },
  ],
  tiers: ["parse", "runner"],
  trigger: "workflow_dispatch",
  setup: { inputs: { word: "corpus", flag: "true", pick: "blue" } },
  runner: { cache: "on", tasks: 1 },
  expect: {
    parse: "ok",
    plan: { jobs: ["inputs"] },
    run: {
      conclusion: "success",
      jobs: { inputs: { conclusion: "success", log: { has: ["inputs corpus true blue 1"] } } },
    },
  },
} as const satisfies CorpusCase;
