// The adversarial payload corpus for the pinned runner's own reader. Each case is checked
// here on the TypeScript side (the bytes are exactly the counted size, and every protected
// string reads back through Fyrden's evaluator). With FYRDEN_RUNNER_HARNESS set to a
// directory, each payload and what the runner should read from it are also written there for
// the Go harness in fixtures/runner/harness, which reads them with gitea/runner v6.0.0's
// parser and evaluator (see its README).
import { describe, expect, it } from "vitest";
import { evaluateTemplate, parseTemplate } from "../../src/ci/expressions.js";
import type { MatrixValue } from "../../src/ci/matrix.js";
import { parseWorkflow } from "../../src/ci/parse.js";
import {
  instancePayloadBytes,
  invariantPayloadBytes,
  jobPayload,
  type PayloadInstance,
} from "../../src/ci/payload.js";
import basicSource from "./fixtures/runner/payload-basic.source.yml?raw";
import needsSource from "./fixtures/runner/payload-needs.source.yml?raw";

const encoder = new TextEncoder();
// The domain package has no Node types: read the variable and load `node:fs` only when asked.
const out = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
  .FYRDEN_RUNNER_HARNESS;

interface Files {
  mkdirSync(path: string, options: { recursive: true }): void;
  writeFileSync(path: string, data: Uint8Array | string): void;
}
const files = async (): Promise<Files> => import(/* @vite-ignore */ `node:${"fs"}`);

function workflowOf(text: string) {
  const parsed = parseWorkflow("w.yml", encoder.encode(text));
  if (!parsed.ok) throw new Error(`errors: ${JSON.stringify(parsed.errors, null, 2)}`);
  return parsed.workflow;
}

const object = (entries: [string, MatrixValue][]): MatrixValue => ({
  kind: "object",
  entries: new Map(entries),
});
const array = (items: MatrixValue[]): MatrixValue => ({ kind: "array", items });

/** Plain JSON data, as the runner's matrix reads it. */
function plain(value: MatrixValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value.kind === "array") return value.items.map(plain);
  return Object.fromEntries([...value.entries].map(([k, v]) => [k, plain(v)]));
}

/** Strings a value Fyrden evaluated might hold, for every protected field. */
const DANGEROUS = [
  `\${{ secrets.DEMO }}`,
  `x-\${{ secrets.DEMO }}-y`,
  `\${{ insert }}`,
  `a \${{insert}} b`,
  `it's \${{ 'quoted' }} ''`,
  `}} \${{ \${{ $$ {{ $`,
  `line1\nline2 \${{ github.sha }}\r\n`,
  `\${{ x }}`.repeat(4000),
  `${"q'".repeat(15_000)}\${{ secrets.DEMO }}${"$".repeat(30_000)}{{`,
  'LS\u2028 PS\u2029  both\u2028\u2029 x \u2028\u0001 😀 \\ "\u2029',
  "\u2028 \t\u2029\t \u2028",
];

const matrixSource = `on: push
jobs:
  build:
    runs-on: x
    strategy:
      matrix:
        v: [1]
    steps:
      - run: echo hi
`;

interface Case {
  readonly name: string;
  readonly source: string;
  readonly jobId: string;
  readonly instance: PayloadInstance;
  readonly steps: number;
  readonly on: readonly string[];
  /** The runner's reading of the `workflow_dispatch` inputs, when the workflow has the event. */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

const cases: Case[] = [
  {
    name: "fixture-basic",
    source: basicSource,
    jobId: "probe",
    instance: { name: "probe", runsOn: ["ubuntu-latest"] },
    steps: 2,
    on: ["push"],
  },
  {
    name: "fixture-needs",
    source: needsSource,
    jobId: "build",
    instance: { name: "build", runsOn: ["ubuntu-latest"] },
    steps: 2,
    on: ["push"],
  },
  ...DANGEROUS.map(
    (s, i): Case => ({
      name: `protected-${i}`,
      source: matrixSource,
      jobId: "build",
      instance: {
        name: s,
        runsOn: [s, "plain"],
        strategy: {
          failFast: true,
          matrix: {
            combination: new Map<string, MatrixValue>([
              [s, s],
              ["nested", object([[s, array([s, 1, null, object([[s, s]])])]])],
            ]),
            index: 0,
            total: 1,
          },
        },
      },
      steps: 1,
      on: ["push"],
    }),
  ),
  {
    name: "values",
    source: matrixSource,
    jobId: "build",
    instance: {
      name: "values (1)",
      runsOn: ["x"],
      strategy: {
        failFast: false,
        maxParallel: 3,
        matrix: {
          combination: new Map<string, MatrixValue>([
            ["big", 9007199254740991],
            ["fine", 1.2345678901234567],
            ["huge", 1e21],
            ["negative", -0.5],
            ["strings", array(["true", "18", "0x10", "yes", "on", "null", "1e3", ""])],
            ["flags", array([true, false, null])],
            ["include", "just a key"],
            ["exclude", object([["os", "linux"]])],
            ["__proto__", object([["constructor", "data"]])],
            ["deep", array([array([array([object([["k", array([1])]])])])])],
          ]),
          index: 4,
          total: 6,
        },
      },
      timeoutMinutes: 45,
      continueOnError: true,
    },
    steps: 1,
    on: ["push"],
  },
  {
    name: "strategy-without-matrix",
    source: `on: push\njobs:\n  build:\n    runs-on: x\n    strategy:\n      fail-fast: false\n      max-parallel: 2\n    steps:\n      - run: echo hi\n`,
    jobId: "build",
    instance: { name: "build", runsOn: ["x"], strategy: { failFast: false, maxParallel: 2 } },
    steps: 1,
    on: ["push"],
  },
  {
    name: "events-and-inputs",
    source: `on:
  push:
    branches: [main]
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:
    inputs:
      level:
        type: choice
        options: [low, high]
        default: low
      dry:
        type: boolean
        default: false
      count:
        type: number
        default: 3
jobs:
  build:
    runs-on: x
    continue-on-error: false
    steps:
      - run: echo \${{ inputs.level }}
`,
    jobId: "build",
    instance: { name: "build", runsOn: ["x"], continueOnError: false },
    steps: 1,
    on: ["push", "schedule", "workflow_dispatch"],
    inputs: {
      level: {
        description: "",
        required: false,
        default: "low",
        type: "choice",
        options: ["low", "high"],
      },
      dry: { description: "", required: false, default: "false", type: "boolean", options: null },
      count: { description: "", required: false, default: "3", type: "number", options: null },
    },
  },
  {
    name: "empty-name",
    source: matrixSource,
    jobId: "build",
    instance: {
      name: "",
      runsOn: ["x"],
      strategy: {
        failFast: true,
        matrix: { combination: new Map<string, MatrixValue>([["", ""]]), index: 0, total: 1 },
      },
    },
    steps: 1,
    on: ["push"],
  },
  {
    name: "noncharacters",
    source: matrixSource,
    jobId: "build",
    instance: {
      name: "a\ufffeb\uffff",
      runsOn: ["\uffff", "x\ufffe"],
      strategy: {
        failFast: true,
        matrix: {
          combination: new Map<string, MatrixValue>([["k\ufffe", array([`\uffff \${{ x }}`])]]),
          index: 0,
          total: 1,
        },
      },
    },
    steps: 1,
    on: ["push"],
  },
];

function expectation(c: Case) {
  const { instance } = c;
  const matrix = instance.strategy?.matrix;
  return {
    name: instance.name,
    labels: instance.runsOn,
    matrix: matrix
      ? Object.fromEntries([...matrix.combination].map(([k, v]) => [k, plain(v)]))
      : null,
    index: matrix?.index ?? 0,
    total: matrix?.total ?? 0,
    failFast: instance.strategy ? String(instance.strategy.failFast) : "",
    maxParallel:
      instance.strategy?.maxParallel === undefined ? "" : String(instance.strategy.maxParallel),
    timeout: instance.timeoutMinutes === undefined ? "" : String(instance.timeoutMinutes),
    continueOnError: instance.continueOnError === undefined ? "" : String(instance.continueOnError),
    steps: c.steps,
    on: c.on,
    inputs: c.inputs ?? null,
  };
}

function readBack(text: string): unknown {
  const template = parseTemplate(text);
  if (!template.ok) throw new Error(`not a template: ${text.slice(0, 80)}`);
  const value = evaluateTemplate(template.template, {});
  if (!value.ok) throw new Error(`failed: ${text.slice(0, 80)}`);
  return value.value;
}

describe("runner payload corpus", () => {
  for (const c of cases) {
    it(`${c.name}: counted exactly, protected strings read back`, async () => {
      const workflow = workflowOf(c.source);
      const bytes = jobPayload(workflow, c.jobId, c.instance);
      expect(bytes.length).toBe(
        invariantPayloadBytes(workflow, c.jobId) + instancePayloadBytes(c.instance),
      );
      // biome-ignore lint/suspicious/noExplicitAny: the payload's shape is what the test inspects
      const job = (JSON.parse(new TextDecoder().decode(bytes)) as any).jobs[c.jobId];
      expect(readBack(job.name)).toBe(c.instance.name);
      expect(job["runs-on"].map(readBack)).toEqual(c.instance.runsOn);
      if (out) {
        const fs = await files();
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(`${out}/${c.name}.payload.json`, bytes);
        fs.writeFileSync(`${out}/${c.name}.expect.json`, JSON.stringify(expectation(c)));
      }
    }, 60_000);
  }
});
