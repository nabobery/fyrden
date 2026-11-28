import type { CorpusCase } from "../types.js";

export default {
  id: "nested-reference",
  proves: [],
  tiers: ["runner"],
  trigger: "push",
  setup: {
    files: {
      "corpus/nested.txt": "nested from the forge\n",
      ".github/actions/nested/action.yml": [
        "name: nested",
        "runs:",
        "  using: composite",
        "  steps:",
        "    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "      with:",
        "        path: nested",
        "",
      ].join("\n"),
    },
  },
  runner: { cache: "on", tasks: 1 },
  expect: {
    parse: "ok",
    plan: { jobs: ["nested"] },
    run: {
      conclusion: "success",
      jobs: { nested: { conclusion: "success", log: { has: ["nested from the forge"] } } },
    },
  },
} as const satisfies CorpusCase;
