import type { CorpusCase } from "../types.js";

export default {
  id: "uses-absolute-github",
  proves: [],
  tiers: ["parse"],
  trigger: "push",
  expect: {
    parse: { errors: [{ code: "invalid_value", feature: "jobs.<job_id>.steps[*].uses" }] },
  },
} as const satisfies CorpusCase;
