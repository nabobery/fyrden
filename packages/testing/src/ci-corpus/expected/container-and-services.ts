import type { CorpusCase } from "../types.js";

export default {
  id: "container-and-services",
  proves: [
    { feature: "jobs.<job_id>.container" },
    { feature: "jobs.<job_id>.container.image" },
    { feature: "jobs.<job_id>.container.env" },
    { feature: "jobs.<job_id>.container.options" },
    { feature: "jobs.<job_id>.services" },
    { feature: "jobs.<job_id>.services.<service_id>.image" },
    {
      feature: "jobs.<job_id>.services.<service_id>.env",
      level: "parse",
      why: "Passed to the service as written; the service image here does not report its environment.",
    },
  ],
  tiers: ["parse", "runner"],
  trigger: "push",
  runner: { cache: "on", tasks: 1 },
  expect: {
    parse: "ok",
    plan: { jobs: ["services"] },
    run: {
      conclusion: "success",
      jobs: {
        services: {
          conclusion: "success",
          log: { has: ["container container-env on corpus-container", "service +PONG"] },
        },
      },
    },
  },
} as const satisfies CorpusCase;
