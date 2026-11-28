import type { CorpusCase } from "../types.js";

export default {
  id: "run-steps",
  proves: [
    { feature: "on" },
    { feature: "on.push" },
    { feature: "jobs" },
    { feature: "env" },
    { feature: "defaults" },
    { feature: "defaults.run" },
    { feature: "defaults.run.shell" },
    { feature: "defaults.run.working-directory" },
    { feature: "jobs.<job_id>.runs-on" },
    { feature: "jobs.<job_id>.env" },
    { feature: "jobs.<job_id>.defaults" },
    { feature: "jobs.<job_id>.defaults.run" },
    { feature: "jobs.<job_id>.defaults.run.shell" },
    { feature: "jobs.<job_id>.defaults.run.working-directory" },
    { feature: "jobs.<job_id>.steps" },
    { feature: "jobs.<job_id>.steps[*].run" },
    { feature: "jobs.<job_id>.steps[*].name" },
    { feature: "jobs.<job_id>.steps[*].id" },
    { feature: "jobs.<job_id>.steps[*].env" },
    { feature: "jobs.<job_id>.steps[*].shell" },
    { feature: "jobs.<job_id>.steps[*].working-directory" },
    {
      feature: "permissions",
      level: "parse",
      why: "What a widened job token may do is not built yet; the parser models the scopes.",
    },
    {
      feature: "jobs.<job_id>.timeout-minutes",
      level: "parse",
      why: "Enforced by the runner; showing it would wait on the runner's clock.",
    },
    {
      feature: "jobs.<job_id>.steps[*].timeout-minutes",
      level: "parse",
      why: "Enforced by the runner; showing it would wait on the runner's clock.",
    },
  ],
  tiers: ["parse", "runner"],
  trigger: "push",
  runner: { cache: "on", tasks: 2 },
  expect: {
    parse: "ok",
    plan: { jobs: ["inherits", "steps"] },
    run: {
      conclusion: "success",
      jobs: {
        inherits: { conclusion: "success", log: { has: ["inherited sh in /"] } },
        steps: {
          conclusion: "success",
          log: {
            has: [
              "levels workflow-env/job-env/step-env",
              "defaults bash in /tmp",
              "overrides sh in /usr",
            ],
          },
        },
      },
    },
  },
} as const satisfies CorpusCase;
