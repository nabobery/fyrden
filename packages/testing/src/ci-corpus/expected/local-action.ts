import type { CorpusCase } from "../types.js";

export default {
  id: "local-action",
  proves: [{ feature: "jobs.<job_id>.steps[*].uses" }],
  tiers: ["parse", "runner"],
  trigger: "push",
  setup: {
    files: {
      ".github/actions/greet/action.yml": [
        "name: greet",
        "inputs:",
        "  who:",
        "    required: true",
        "runs:",
        "  using: composite",
        "  steps:",
        '    - run: echo "greet $WHO"',
        "      shell: bash",
        "      env:",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: an action expression, as plain text
        "        WHO: ${{ inputs.who }}",
        "",
      ].join("\n"),
    },
  },
  runner: { cache: "on", tasks: 1 },
  expect: {
    parse: "ok",
    plan: { jobs: ["local"] },
    run: {
      conclusion: "success",
      jobs: { local: { conclusion: "success", log: { has: ["greet corpus"] } } },
    },
  },
} as const satisfies CorpusCase;
