import type { CorpusCase } from "../types.js";

const TOKEN_SCOPES =
  "What a widened job token may do is not built yet; the parser models the scopes.";
const LABELS =
  "Label matching is the scheduler's, before any runner; the parser models the list form.";
const REGISTRY =
  "Passed to the runner as written; showing it needs a private registry, published ports or host mounts on the test machine.";

export default {
  id: "job-fields",
  proves: [
    { feature: "permissions", value: "actions", level: "parse", why: TOKEN_SCOPES },
    { feature: "permissions", value: "checks", level: "parse", why: TOKEN_SCOPES },
    { feature: "permissions", value: "contents", level: "parse", why: TOKEN_SCOPES },
    { feature: "permissions", value: "issues", level: "parse", why: TOKEN_SCOPES },
    { feature: "permissions", value: "pull-requests", level: "parse", why: TOKEN_SCOPES },
    { feature: "permissions", value: "statuses", level: "parse", why: TOKEN_SCOPES },
    { feature: "jobs.<job_id>.permissions", level: "parse", why: TOKEN_SCOPES },
    { feature: "jobs.<job_id>.runs-on.labels", level: "parse", why: LABELS },
    { feature: "jobs.<job_id>.container.credentials", level: "parse", why: REGISTRY },
    { feature: "jobs.<job_id>.container.credentials.username", level: "parse", why: REGISTRY },
    { feature: "jobs.<job_id>.container.credentials.password", level: "parse", why: REGISTRY },
    { feature: "jobs.<job_id>.container.ports", level: "parse", why: REGISTRY },
    { feature: "jobs.<job_id>.container.volumes", level: "parse", why: REGISTRY },
    { feature: "jobs.<job_id>.services.<service_id>.credentials", level: "parse", why: REGISTRY },
    {
      feature: "jobs.<job_id>.services.<service_id>.credentials.username",
      level: "parse",
      why: REGISTRY,
    },
    {
      feature: "jobs.<job_id>.services.<service_id>.credentials.password",
      level: "parse",
      why: REGISTRY,
    },
    { feature: "jobs.<job_id>.services.<service_id>.ports", level: "parse", why: REGISTRY },
    { feature: "jobs.<job_id>.services.<service_id>.volumes", level: "parse", why: REGISTRY },
    { feature: "jobs.<job_id>.services.<service_id>.options", level: "parse", why: REGISTRY },
  ],
  tiers: ["parse"],
  trigger: "push",
  expect: { parse: "ok", plan: { jobs: ["fields"] } },
} as const satisfies CorpusCase;
