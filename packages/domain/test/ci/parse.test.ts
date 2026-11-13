// Workflow files to the supported model: what a valid file becomes, and the
// named error for each way a file can be wrong.
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../../src/ci/parse.js";
import type { WorkflowError } from "../../src/ci/workflow-schema.js";

const encoder = new TextEncoder();
const parse = (text: string) => parseWorkflow(".github/workflows/ci.yml", encoder.encode(text));

function workflowOf(text: string) {
  const parsed = parse(text);
  if (!parsed.ok) throw new Error(`errors: ${JSON.stringify(parsed.errors, null, 2)}`);
  return parsed.workflow;
}

function errorsOf(
  text: string,
): Pick<WorkflowError, "code" | "feature" | "path" | "line" | "column">[] {
  const parsed = parse(text);
  if (parsed.ok) throw new Error("parsed without errors");
  return parsed.errors.map(({ code, feature, path, line, column }) => ({
    code,
    feature,
    path,
    line,
    column,
  }));
}

/** One job named build with `jobLines` (indented 4) and one step with `stepLines` (indented 8). */
const job = (jobLines = "", stepLines = "", on = "push") =>
  `on: ${on}\njobs:\n  build:\n    runs-on: ubuntu-latest\n${jobLines}    steps:\n      - run: echo hi\n${stepLines}`;

describe("parseWorkflow: a valid workflow", () => {
  const text = `name: CI
run-name: Build \${{ github.ref }}
on:
  push:
    branches: [main, 'release/**']
    paths-ignore: [docs/**]
  pull_request:
    types: [opened, synchronize]
  schedule:
    - cron: '0 5 * * 1-5'
  workflow_dispatch:
    inputs:
      level:
        description: Log level
        type: choice
        options: [info, debug]
        default: info
permissions:
  contents: read
  id-token: none
env:
  A: 1.0
  B: 0x10
  C:
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
defaults:
  run:
    shell: bash
jobs:
  test:
    name: Test \${{ matrix.node }}
    runs-on: [self-hosted, linux]
    timeout-minutes: 30
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        node: [20, 22]
        include:
          - node: 24
            experimental: true
    services:
      db:
        image: postgres:17
        ports: ['5432:5432', 80]
    container: node:24
    outputs:
      result: \${{ steps.t.outputs.result }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: t
        if: \${{ success() }}
        run: |
          npm test
        working-directory: app
        continue-on-error: \${{ matrix.experimental == true }}
  deploy:
    needs: test
    if: false
    runs-on: \${{ inputs.runner }}
    steps:
      - uses: ./.github/actions/deploy
`;

  it("keeps every supported key, in source order, with positions", () => {
    const w = workflowOf(text);
    expect(w.path).toBe(".github/workflows/ci.yml");
    expect(w.name).toEqual({ value: "CI", at: { line: 1, column: 7 } });
    expect(w.runName?.value).toBe(`Build \${{ github.ref }}`);
    expect(w.on.map((t) => t.event)).toEqual([
      "push",
      "pull_request",
      "schedule",
      "workflow_dispatch",
    ]);
    const [push, pr, schedule, dispatch] = w.on;
    expect(push).toMatchObject({
      event: "push",
      branches: { mode: "include", patterns: [{ value: "main" }, { value: "release/**" }] },
      paths: { mode: "ignore", patterns: [{ value: "docs/**" }] },
    });
    expect(pr).toMatchObject({ types: [{ value: "opened" }, { value: "synchronize" }] });
    expect(schedule).toMatchObject({
      crons: [{ value: "0 5 * * 1-5", at: { line: 10, column: 13 } }],
    });
    expect(dispatch).toMatchObject({
      inputs: [
        {
          id: { value: "level" },
          description: { value: "Log level" },
          type: "choice",
          required: false,
          options: [{ value: "info" }, { value: "debug" }],
          default: { kind: "scalar", value: "info" },
        },
      ],
    });
    expect(w.permissions).toMatchObject({
      kind: "scopes",
      scopes: [{ scope: "contents", access: "read" }],
    });
    expect(w.env.map(([k, v]) => [k.value, v.value])).toEqual([
      ["A", "1.0"],
      ["B", "0x10"],
      ["C", ""],
    ]);
    expect(w.concurrency).toMatchObject({
      group: { value: `ci-\${{ github.ref }}` },
      cancelInProgress: { kind: "literal", value: true },
    });
    expect(w.defaults).toMatchObject({ shell: { value: "bash" } });
    expect(w.jobs.map((j) => j.id.value)).toEqual(["test", "deploy"]);
  });

  it("reads a job's fields, its matrix with positions all the way down, and its steps", () => {
    const [test, deploy] = workflowOf(text).jobs;
    expect(test?.runsOn).toMatchObject({
      kind: "literal",
      value: [{ value: "self-hosted" }, { value: "linux" }],
    });
    expect(test?.timeoutMinutes).toMatchObject({ kind: "literal", value: 30 });
    expect(test?.strategy?.failFast).toMatchObject({ kind: "literal", value: false });
    expect(test?.strategy?.maxParallel).toMatchObject({ kind: "literal", value: 2 });
    const matrix = test?.strategy?.matrix;
    if (matrix?.kind !== "literal") throw new Error("no matrix");
    expect(matrix.value.dimensions[0]?.name.value).toBe("node");
    expect(matrix.value.dimensions[0]?.values).toMatchObject({
      kind: "literal",
      value: [
        { kind: "scalar", value: 20, source: "20" },
        { kind: "scalar", value: 22, source: "22" },
      ],
    });
    const include = matrix.value.include;
    if (include?.kind !== "literal") throw new Error("no include");
    expect(include.value[0]).toMatchObject({
      kind: "mapping",
      entries: [
        [{ value: "node" }, { kind: "scalar", value: 24, at: { line: 42, column: 19 } }],
        [{ value: "experimental" }, { kind: "scalar", value: true }],
      ],
    });
    expect(test?.services[0]).toMatchObject({
      id: { value: "db" },
      image: { value: "postgres:17" },
      ports: [{ value: "5432:5432" }, { value: "80" }],
    });
    expect(test?.container).toMatchObject({ image: { value: "node:24" }, env: [], ports: [] });
    expect(test?.outputs[0]?.[1].value).toBe(`\${{ steps.t.outputs.result }}`);
    expect(test?.steps).toMatchObject([
      {
        kind: "uses",
        uses: { value: "actions/checkout@v4" },
        with: [[{ value: "fetch-depth" }, { value: "0" }]],
      },
      {
        kind: "run",
        id: { value: "t" },
        if: { source: `\${{ success() }}` },
        run: { value: "npm test\n" },
        workingDirectory: { value: "app" },
        continueOnError: { kind: "expression", source: `\${{ matrix.experimental == true }}` },
      },
    ]);
    expect(deploy?.needs.map((n) => n.value)).toEqual(["test"]);
    expect(deploy?.if).toEqual({ source: "false", at: { line: 63, column: 9 } });
    expect(deploy?.runsOn).toMatchObject({ kind: "expression", source: `\${{ inputs.runner }}` });
    expect(deploy?.steps[0]).toMatchObject({
      kind: "uses",
      uses: { value: "./.github/actions/deploy" },
    });
  });

  it("accepts the short forms of on, permissions, concurrency and needs", () => {
    expect(workflowOf(job("", "", "[push, pull_request]")).on.map((t) => t.event)).toEqual([
      "push",
      "pull_request",
    ]);
    const w = workflowOf(
      `permissions: read-all\nconcurrency: one\n${job("    needs: [a]\n")}`.replace(
        "on: push",
        "on: workflow_dispatch",
      ),
    );
    expect(w.permissions).toMatchObject({ kind: "all", access: "read" });
    expect(w.concurrency?.group.value).toBe("one");
    expect(w.on).toMatchObject([{ event: "workflow_dispatch", inputs: [] }]);
    expect(workflowOf(`permissions: {}\n${job()}`).permissions).toMatchObject({
      kind: "scopes",
      scopes: [],
    });
    expect(
      workflowOf(job("    runs-on:\n      labels: x\n").replace("    runs-on: ubuntu-latest\n", ""))
        .jobs[0]?.runsOn,
    ).toMatchObject({
      kind: "literal",
      value: [{ value: "x" }],
    });
  });

  it("takes `on` as the key it is, never the YAML 1.1 boolean", () => {
    expect(workflowOf(job()).on).toMatchObject([{ event: "push" }]);
    expect(workflowOf(job().replace("on: push", '"on": push')).on).toMatchObject([
      { event: "push" },
    ]);
  });
});

describe("parseWorkflow: named errors", () => {
  it.each([
    [
      "an unknown top-level key",
      `jobz: {}\n${job()}`,
      { code: "unknown_key", feature: "jobz", path: "jobz", line: 1, column: 1 },
    ],
    [
      "an unknown job key",
      job("    enviroment: x\n"),
      {
        code: "unknown_key",
        feature: "jobs.<job_id>.enviroment",
        path: "jobs.build.enviroment",
        line: 5,
        column: 5,
      },
    ],
    [
      "a key in the wrong case",
      `Name: CI
${job()}`,
      { code: "unknown_key", feature: "Name", path: "Name", line: 1, column: 1 },
    ],
    [
      "an unknown event",
      job("", "", "pushh"),
      { code: "unknown_key", feature: "on.pushh", path: "on", line: 1, column: 5 },
    ],
    [
      "a job id that is not one",
      job().replace("  build:", "  1build:"),
      { code: "invalid_value", feature: "jobs.<job_id>", path: "jobs.1build", line: 3, column: 3 },
    ],
    [
      "a missing runs-on",
      job().replace("    runs-on: ubuntu-latest\n", ""),
      {
        code: "missing_key",
        feature: "jobs.<job_id>.runs-on",
        path: "jobs.build.runs-on",
        line: 3,
        column: 3,
      },
    ],
    [
      "no jobs",
      "on: push\njobs: {}\n",
      { code: "invalid_value", feature: "jobs", path: "jobs", line: 2, column: 7 },
    ],
    [
      "no on",
      "jobs:\n  b:\n    runs-on: x\n    steps: [{run: a}]\n",
      { code: "missing_key", feature: "on", path: "on", line: 1, column: 1 },
    ],
    [
      "a step with neither run nor uses",
      job("", "      - name: x\n"),
      {
        code: "missing_key",
        feature: "jobs.<job_id>.steps[*].run",
        path: "jobs.build.steps[1]",
        line: 7,
        column: 9,
      },
    ],
    [
      "a step with both run and uses",
      job("", "        uses: a/b@v1\n"),
      {
        code: "invalid_value",
        feature: "jobs.<job_id>.steps[*]",
        path: "jobs.build.steps[0].uses",
        line: 7,
        column: 9,
      },
    ],
    [
      "with on a run step",
      job("", "        with: {a: b}\n"),
      {
        code: "invalid_value",
        feature: "jobs.<job_id>.steps[*].with",
        path: "jobs.build.steps[0].with",
        line: 7,
        column: 9,
      },
    ],
    [
      "an action without a ref",
      job("", "      - uses: actions/checkout\n"),
      {
        code: "invalid_value",
        feature: "jobs.<job_id>.steps[*].uses",
        path: "jobs.build.steps[1].uses",
        line: 7,
        column: 15,
      },
    ],
    [
      "fail-fast: yes (a string in YAML 1.2)",
      job("    strategy:\n      fail-fast: yes\n"),
      {
        code: "invalid_type",
        feature: "jobs.<job_id>.strategy.fail-fast",
        path: "jobs.build.strategy.fail-fast",
        line: 6,
        column: 18,
      },
    ],
    [
      "timeout-minutes as a quoted number",
      job('    timeout-minutes: "5"\n'),
      {
        code: "invalid_type",
        feature: "jobs.<job_id>.timeout-minutes",
        path: "jobs.build.timeout-minutes",
        line: 5,
        column: 22,
      },
    ],
    [
      "max-parallel of zero",
      job("    strategy:\n      max-parallel: 0\n"),
      {
        code: "invalid_value",
        feature: "jobs.<job_id>.strategy.max-parallel",
        path: "jobs.build.strategy.max-parallel",
        line: 6,
        column: 21,
      },
    ],
    [
      "an unsafe integer in the matrix",
      job("    strategy:\n      matrix:\n        n: [9007199254740993]\n"),
      {
        code: "invalid_value",
        feature: "jobs.<job_id>.strategy.matrix",
        path: "jobs.build.strategy.matrix.n[0]",
        line: 7,
        column: 13,
      },
    ],
    [
      "an event listed twice",
      job("", "", "[push, push]"),
      { code: "invalid_value", feature: "on", path: "on[1]", line: 1, column: 12 },
    ],
    [
      "branches with branches-ignore",
      job().replace("on: push", "on:\n  push:\n    branches: [a]\n    branches-ignore: [b]"),
      {
        code: "invalid_value",
        feature: "on.push.branches-ignore",
        path: "on.push.branches-ignore",
        line: 4,
        column: 5,
      },
    ],
    [
      "an invalid cron",
      job().replace("on: push", "on:\n  schedule:\n    - cron: every day"),
      {
        code: "invalid_value",
        feature: "on.schedule[*].cron",
        path: "on.schedule[0].cron",
        line: 3,
        column: 13,
      },
    ],
    [
      "an unknown activity type",
      job().replace("on: push", "on:\n  pull_request:\n    types: [openned]"),
      {
        code: "invalid_value",
        feature: "on.pull_request.types",
        path: "on.pull_request.types",
        line: 3,
        column: 13,
      },
    ],
    [
      "an unknown permission scope",
      `permissions:\n  content: read\n${job()}`,
      {
        code: "unknown_key",
        feature: "permissions.content",
        path: "permissions.content",
        line: 2,
        column: 3,
      },
    ],
    [
      "read on a write-or-none scope",
      `permissions:\n  id-token: read\n${job()}`,
      {
        code: "invalid_value",
        feature: "permissions",
        path: "permissions.id-token",
        line: 2,
        column: 13,
      },
    ],
    [
      "a choice input without options",
      job().replace(
        "on: push",
        "on:\n  workflow_dispatch:\n    inputs:\n      a:\n        type: choice",
      ),
      {
        code: "missing_key",
        feature: "on.workflow_dispatch.inputs.<input_id>.options",
        path: "on.workflow_dispatch.inputs.a.options",
        line: 4,
        column: 7,
      },
    ],
    [
      "a container without an image",
      job("    container:\n      env: {A: b}\n"),
      {
        code: "missing_key",
        feature: "jobs.<job_id>.container.image",
        path: "jobs.build.container.image",
        line: 6,
        column: 7,
      },
    ],
    [
      "a step id used twice",
      job("", "        id: a\n      - id: a\n        run: b\n"),
      {
        code: "invalid_value",
        feature: "jobs.<job_id>.steps[*].id",
        path: "jobs.build.steps[1].id",
        line: 8,
        column: 13,
      },
    ],
    [
      "an env value that is a mapping",
      job("    env:\n      A: {b: c}\n"),
      {
        code: "invalid_type",
        feature: "jobs.<job_id>.env",
        path: "jobs.build.env.A",
        line: 6,
        column: 10,
      },
    ],
    [
      "a root that is not a mapping",
      "- a\n- b\n",
      { code: "invalid_type", feature: "", path: "", line: 1, column: 1 },
    ],
    ["an empty file", "", { code: "invalid_type", feature: "", path: "", line: 1, column: 1 }],
  ])("%s", (_, text, expected) => {
    expect(errorsOf(text)).toEqual([expected]);
  });

  it("reports every error in a file, sorted by position", () => {
    const errors = errorsOf(`foo: 1\n${job("    environment: x\n    bar: 2\n")}`);
    expect(errors.map((e) => [e.code, e.path, e.line])).toEqual([
      ["unknown_key", "foo", 1],
      ["unsupported_key", "jobs.build.environment", 6],
      ["unknown_key", "jobs.build.bar", 7],
    ]);
  });

  it("names the feature in a message a person can act on", () => {
    const parsed = parse(job("    environment: production\n"));
    expect(parsed.ok || parsed.errors[0]?.message).toBe(
      "`jobs.build.environment` is not supported: Fyrden has no deployment environments yet.",
    );
  });

  it("refuses a file over the size limit and one that is not UTF-8, as a whole", () => {
    const big = parseWorkflow("x.yml", new Uint8Array(500_001).fill(0x20));
    expect(big.ok || big.errors.map((e) => [e.code, e.line, e.column])).toEqual([
      ["file_too_large", 0, 0],
    ]);
    const latin1 = parseWorkflow("x.yml", new Uint8Array([0x6f, 0x6e, 0x3a, 0x20, 0xe9]));
    expect(latin1.ok || latin1.errors.map((e) => e.code)).toEqual(["invalid_encoding"]);
  });

  it("refuses more jobs than the bound", () => {
    const jobs = Array.from(
      { length: 257 },
      (_, i) => `  j${i}:\n    runs-on: x\n    steps: [{run: a}]\n`,
    ).join("");
    const errors = errorsOf(`on: push\njobs:\n${jobs}`);
    expect(errors.map((e) => [e.code, e.path])).toEqual([["limit_exceeded", "jobs.j256"]]);
  });
});
