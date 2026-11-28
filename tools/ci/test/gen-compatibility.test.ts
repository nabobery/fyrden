import type { WorkflowFeature } from "@fyrden/domain/ci";
import type { CorpusCase } from "@fyrden/testing/ci-corpus";
import { describe, expect, it } from "vitest";
import { type CompatibilityInput, DEFAULT_INPUT, generate } from "../src/gen-compatibility.ts";

const features: readonly WorkflowFeature[] = [
  { feature: "name", area: "workflow", status: "supported", owner: "run pages" },
  { feature: "run-name", area: "workflow", status: "supported", owner: "run pages" },
  { feature: "on.push", area: "trigger", status: "supported", owner: "triggers" },
  {
    feature: "cache-mode",
    area: "workflow",
    status: "unsupported",
    reason: "No shared cache | yet.",
    example: "cache-mode: read\n",
  },
];

const runner: CorpusCase = {
  id: "names",
  proves: [{ feature: "name" }],
  tiers: ["parse", "runner"],
  trigger: "push",
  runner: { cache: "on", tasks: 1 },
  expect: { parse: "ok" },
};
const parseOnly: CorpusCase = {
  id: "titles",
  proves: [{ feature: "run-name", level: "parse", why: "Only parsed here." }],
  tiers: ["parse"],
  trigger: "push",
  expect: { parse: "ok" },
};

const input: CompatibilityInput = {
  ...DEFAULT_INPUT,
  features,
  cases: [runner, parseOnly],
  elsewhere: [],
  runnerVersions: ["9.9.9"],
  actionPins: [{ action: "actions/checkout", tag: "v1", commit: "a".repeat(40) }],
  images: { job: "node@sha256:abc" },
};
const rowOf = (page: string, feature: string) =>
  page.split("\n").find((line) => line.startsWith(`| \`${feature}\` |`));

describe("the compatibility page", () => {
  const page = generate(input);

  it("shows a feature a runner case proves as running, with its case", () => {
    expect(rowOf(page, "name")).toBe("| `name` | supported | runs | `names` |");
  });

  it("shows a parse-level proof as parsed, with its reason", () => {
    expect(rowOf(page, "run-name")).toBe(
      "| `run-name` | supported | parsed | `titles`. Only parsed here. |",
    );
  });

  it("shows only the strongest proofs of a row, with their reasons alone", () => {
    const both = generate({
      ...input,
      cases: [
        runner,
        { ...parseOnly, proves: [{ feature: "name", level: "parse", why: "Weaker." }] },
      ],
    });
    expect(rowOf(both, "name")).toBe("| `name` | supported | runs | `names` |");
  });

  it("shows a row an existing test proves as tested, above a parse-level case", () => {
    const tested = generate({
      ...input,
      elsewhere: [
        { ref: { feature: "run-name" }, tests: ["a/b.test.ts"], why: "Before any runner." },
      ],
    });
    expect(rowOf(tested, "run-name")).toBe(
      "| `run-name` | supported | tested | `a/b.test.ts`. Before any runner. |",
    );
  });

  it("keeps a feature name with a pipe, a newline or a backtick inside its cell", () => {
    const odd = generate({
      ...input,
      features: [
        {
          feature: "a|b\nc`d",
          area: "workflow",
          status: "unsupported",
          reason: "No.",
          example: "",
        },
      ],
    });
    expect(odd).toContain("| `` a\\|b c`d `` | unsupported | — | No. |");
  });

  it("marks a supported feature nothing proves", () => {
    expect(rowOf(page, "on.push")).toBe("| `on.push` | supported | **not proven** | — |");
  });

  it("gives an unsupported feature its reason, a pipe kept inside its cell", () => {
    expect(rowOf(page, "cache-mode")).toBe(
      "| `cache-mode` | unsupported | — | No shared cache \\| yet. |",
    );
  });

  it("names the runner versions and pins in its header", () => {
    expect(page).toContain("- gitea/runner: `9.9.9`");
    expect(page).toContain(`- \`actions/checkout@${"a".repeat(40)}\` (v1)`);
    expect(page).toContain("- job image: `node@sha256:abc`");
  });

  it("proves every supported row of the real matrix", () => {
    expect(generate()).not.toContain("**not proven**");
  });
});
