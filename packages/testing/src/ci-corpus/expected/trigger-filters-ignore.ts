import { TRIGGER_RUNTIME } from "../shared.js";
import type { CorpusCase } from "../types.js";

export default {
  id: "trigger-filters-ignore",
  proves: [
    { feature: "on.push.branches-ignore", level: "parse", why: TRIGGER_RUNTIME },
    { feature: "on.push.tags-ignore", level: "parse", why: TRIGGER_RUNTIME },
    { feature: "on.push.paths-ignore", level: "parse", why: TRIGGER_RUNTIME },
    { feature: "on.pull_request.branches", level: "parse", why: TRIGGER_RUNTIME },
    { feature: "on.pull_request.paths", level: "parse", why: TRIGGER_RUNTIME },
    { feature: "on.pull_request_target.branches-ignore", level: "parse", why: TRIGGER_RUNTIME },
    { feature: "on.pull_request_target.paths-ignore", level: "parse", why: TRIGGER_RUNTIME },
  ],
  tiers: ["parse"],
  trigger: "push",
  expect: { parse: "ok", plan: { jobs: ["noop"] } },
} as const satisfies CorpusCase;
