// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests write workflow expressions, `${{ }}` included, as plain strings
// `on:` read alone, so a file whose jobs cannot run still has its triggers,
// and the cron check `parseWorkflow` shares with it.
import { describe, expect, it } from "vitest";
import { parseTriggers, parseWorkflow } from "../../src/ci/parse.js";

const encoder = new TextEncoder();
const PATH = ".github/workflows/ci.yml";
const triggersOf = (text: string) => parseTriggers(PATH, encoder.encode(text));

const brokenJobs = `on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    runs-on: x
    steps:
      - uses: https://github.com/actions/checkout@v4
`;

describe("parseTriggers: expressions in on:", () => {
  it.each([
    [
      "push branches",
      'on:\n  push:\n    branches: ["${{ github.ref }}"]\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n',
    ],
    [
      "pull_request paths",
      'on:\n  pull_request:\n    paths: ["${{ x }}"]\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n',
    ],
    [
      "dispatch input default",
      "on:\n  workflow_dispatch:\n    inputs:\n      a:\n        default: ${{ github.ref }}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n",
    ],
  ])("refuses an expression in %s, as parseWorkflow does", (_name, text) => {
    const full = parseWorkflow(PATH, encoder.encode(text));
    const triggers = triggersOf(text);
    expect(full.ok).toBe(false);
    expect(triggers.ok).toBe(false);
    if (!full.ok && !triggers.ok) {
      const codes = (errors: readonly { code: string }[]) => errors.map((e) => e.code);
      expect(codes(triggers.errors)).toEqual(
        codes(full.errors).filter((c) => c === "expression_not_allowed"),
      );
    }
  });
});

describe("parseTriggers", () => {
  it("reads on: from a file whose jobs are refused", () => {
    const full = parseWorkflow(PATH, encoder.encode(brokenJobs));
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.errors.map((e) => e.message).join("\n")).toMatch(/action reference/);
    const parsed = triggersOf(brokenJobs);
    expect(parsed).toEqual({
      ok: true,
      triggers: [
        {
          event: "push",
          at: { line: 2, column: 3 },
          branches: {
            mode: "include",
            patterns: [{ value: "main", at: { line: 3, column: 16 } }],
            at: { line: 3, column: 5 },
          },
        },
        { event: "pull_request", at: { line: 4, column: 3 } },
      ],
    });
  });

  it("reads on: without any jobs and ignores unknown top-level keys", () => {
    expect(triggersOf("on: [push, workflow_dispatch]\nwhatever: 1\n")).toMatchObject({
      ok: true,
      triggers: [{ event: "push" }, { event: "workflow_dispatch", inputs: [] }],
    });
  });

  it.each([
    ["on: missing", "jobs:\n  a:\n    runs-on: x\n", "missing_key", "on"],
    ["an unknown event", "on:\n  pushh:\n", "unknown_key", "on.pushh"],
    ["an unknown event by name", "on: 3\n", "unknown_key", "on"],
    ["an unsupported event", "on: issues\n", "unsupported_key", "on"],
    ["an event of the wrong type", "on:\n  push: [main]\n", "invalid_type", "on.push"],
    ["an empty event list", "on: []\n", "invalid_value", "on"],
    ["broken YAML", "on: [push\n", "yaml_syntax", ""],
    ["a non-mapping file", "- push\n", "invalid_type", ""],
    [
      "an invalid cron",
      "on:\n  schedule:\n    - cron: '61 * * * *'\n",
      "invalid_value",
      "on.schedule[0].cron",
    ],
  ])("refuses %s with a named error", (_name, text, code, path) => {
    const parsed = triggersOf(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors[0]).toMatchObject({ code, path });
  });

  it("refuses a file that is not UTF-8", () => {
    const parsed = parseTriggers(PATH, new Uint8Array([0x6f, 0x6e, 0x3a, 0xff]));
    expect(parsed).toMatchObject({ ok: false, errors: [{ code: "invalid_encoding" }] });
  });
});

describe("cron check in on.schedule", () => {
  const withCron = (cron: string) =>
    `on:\n  schedule:\n    - cron: '${cron}'\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: a\n`;

  it.each([
    ["61 * * * *", /minute/],
    ["0 0 * * 8", /day of week/],
    ["0 0 30 2 *", /never/],
    ["*/0 * * * *", /step/],
  ])("refuses %j with invalid_value", (cron, message) => {
    const parsed = parseWorkflow(PATH, encoder.encode(withCron(cron)));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatchObject({
      code: "invalid_value",
      feature: "on.schedule[*].cron",
      path: "on.schedule[0].cron",
      line: 3,
      column: 13,
    });
    expect(parsed.errors[0]?.message).toMatch(message);
  });

  it("accepts names, steps and day of week 7", () => {
    expect(parseWorkflow(PATH, encoder.encode(withCron("*/15 9-17 * JAN-jun MON-FRI,7"))).ok).toBe(
      true,
    );
  });
});
