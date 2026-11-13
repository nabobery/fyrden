// One job's runner payload: what the runner reads, as the spike's accepted
// fixtures have it; evaluated strings protected from a second evaluation;
// exact sizes before building; and the characters the runner's YAML reader
// would change escaped or refused.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { evaluateTemplate, parseTemplate } from "../../src/ci/expressions.js";
import type { MatrixValue } from "../../src/ci/matrix.js";
import { parseWorkflow } from "../../src/ci/parse.js";
import {
  instancePayloadBytes,
  invariantPayloadBytes,
  jobPayload,
  MAX_PAYLOAD_BYTES,
  type PayloadInstance,
} from "../../src/ci/payload.js";
import type { Workflow } from "../../src/ci/workflow-schema.js";
import basicSource from "./fixtures/runner/payload-basic.source.yml?raw";
import basicPayload from "./fixtures/runner/payload-basic.yml?raw";
import needsSource from "./fixtures/runner/payload-needs.source.yml?raw";
import needsPayload from "./fixtures/runner/payload-needs.yml?raw";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function workflowOf(text: string): Workflow {
  const parsed = parseWorkflow("w.yml", encoder.encode(text));
  if (!parsed.ok) throw new Error(`errors: ${JSON.stringify(parsed.errors, null, 2)}`);
  return parsed.workflow;
}

const plainInstance = (name: string): PayloadInstance => ({ name, runsOn: ["ubuntu-latest"] });

/** The payload as text and as data. */
function payload(workflow: Workflow, jobId: string, instance: PayloadInstance) {
  const bytes = jobPayload(workflow, jobId, instance);
  const text = decoder.decode(bytes);
  // biome-ignore lint/suspicious/noExplicitAny: the payload's shape is what the test inspects
  const data = JSON.parse(text) as any;
  return { bytes, text, data };
}

/** A workflow with one job `build`, whose job-level lines are `jobLines` (indented 4). */
const oneJob = (jobLines = "", top = "on: push\n") =>
  `${top}jobs:\n  build:\n    runs-on: ubuntu-latest\n${jobLines}    steps:\n      - run: echo hi\n`;

/** What the runner reads back from a protected string: the template evaluated with no contexts. */
function readBack(text: string): unknown {
  const template = parseTemplate(text);
  if (!template.ok) throw new Error(`not a template: ${text}`);
  const value = evaluateTemplate(template.template, {});
  if (!value.ok) throw new Error(`failed: ${text}`);
  return value.value;
}

describe("jobPayload: the runner's fixtures", () => {
  for (const [label, source, accepted, jobId] of [
    ["basic", basicSource, basicPayload, "probe"],
    ["needs", needsSource, needsPayload, "build"],
  ] as const) {
    it(`matches the ${label} payload the runner accepted, apart from the listed differences`, () => {
      const { data } = payload(workflowOf(source), jobId, plainInstance(jobId));
      const fixture = parseYaml(accepted);
      // Differences: `if` is always written; `on` is a mapping; labels are a list.
      expect(data.jobs[jobId].if).toBe(`\${{ always() }}`);
      delete data.jobs[jobId].if;
      expect(data.on).toEqual({ push: null });
      data.on = "push";
      expect(data.jobs[jobId]["runs-on"]).toEqual(["ubuntu-latest"]);
      data.jobs[jobId]["runs-on"] = "ubuntu-latest";
      expect(data).toEqual(fixture);
    });
  }

  it("writes exactly one job, the one asked for", () => {
    const workflow = workflowOf(
      "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo a\n  b:\n    runs-on: x\n    steps:\n      - run: echo b\n",
    );
    const { data } = payload(workflow, "b", plainInstance("b"));
    expect(Object.keys(data.jobs)).toEqual(["b"]);
    expect(data.jobs.b.steps).toEqual([{ run: "echo b" }]);
    expect(() => jobPayload(workflow, "c", plainInstance("c"))).toThrow(/no job `c`/);
  });
});

describe("jobPayload: contents", () => {
  const source = `name: CI
run-name: Build \${{ github.ref }}
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      level:
        description: How loud
        type: choice
        options: [low, high]
        default: low
      dry:
        type: boolean
        required: true
        default: false
permissions: read-all
concurrency: ci
env:
  GLOBAL: g
  __proto__: data
defaults:
  run:
    shell: bash
jobs:
  build:
    name: Build \${{ matrix.os }}
    runs-on: [self-hosted, '\${{ matrix.os }}']
    needs: [lint]
    if: github.event_name == 'push'
    permissions: write-all
    concurrency: one
    timeout-minutes: \${{ inputs.minutes }}
    continue-on-error: true
    env:
      JOB: j
    defaults:
      run:
        working-directory: src
    outputs:
      out: \${{ steps.a.outputs.x }}
    services:
      db:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: \${{ secrets.DB }}
        ports: ['5432:5432']
    container:
      image: node:22
      credentials:
        username: u
        password: \${{ secrets.P }}
      volumes: [/cache]
      options: --cpus 1
    steps:
      - id: a
        name: Step A
        if: \${{ success() }}
        run: echo "\${{ matrix.os }}"
        shell: bash
        working-directory: sub
        env:
          STEP: s
        continue-on-error: \${{ inputs.lenient }}
        timeout-minutes: 5
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`;
  const instance: PayloadInstance = {
    name: "Build linux",
    runsOn: ["self-hosted", "linux"],
    timeoutMinutes: 30,
    continueOnError: true,
  };

  it("writes what the runner reads, Fyrden's evaluated values for the fields it evaluates", () => {
    const { data } = payload(workflowOf(source), "build", instance);
    expect(Object.keys(data)).toEqual(["name", "on", "env", "defaults", "jobs"]);
    expect(data.name).toBe("CI");
    expect(data.on).toEqual({
      push: null,
      workflow_dispatch: {
        inputs: {
          level: {
            description: "How loud",
            required: false,
            default: "low",
            type: "choice",
            options: ["low", "high"],
          },
          dry: { required: true, default: false, type: "boolean" },
        },
      },
    });
    expect(data.env).toEqual({ GLOBAL: "g", ["__proto__"]: "data" });
    expect(Object.keys(data.env)).toEqual(["GLOBAL", "__proto__"]);
    expect(data.defaults).toEqual({ run: { shell: "bash" } });
    expect(data.jobs.build).toEqual({
      name: "Build linux",
      "runs-on": ["self-hosted", "linux"],
      "timeout-minutes": 30,
      "continue-on-error": true,
      needs: ["lint"],
      if: `\${{ always() }}`,
      env: { JOB: "j" },
      defaults: { run: { "working-directory": "src" } },
      outputs: { out: `\${{ steps.a.outputs.x }}` },
      services: {
        db: {
          image: "postgres:16",
          env: { POSTGRES_PASSWORD: `\${{ secrets.DB }}` },
          ports: ["5432:5432"],
        },
      },
      container: {
        image: "node:22",
        credentials: { username: "u", password: `\${{ secrets.P }}` },
        volumes: ["/cache"],
        options: "--cpus 1",
      },
      steps: [
        {
          id: "a",
          name: "Step A",
          if: `\${{ success() }}`,
          run: `echo "\${{ matrix.os }}"`,
          shell: "bash",
          "working-directory": "sub",
          env: { STEP: "s" },
          "continue-on-error": `\${{ inputs.lenient }}`,
          "timeout-minutes": 5,
        },
        { uses: "actions/checkout@v4", with: { "fetch-depth": "0" } },
      ],
    });
  });

  it("writes the per-instance fields first, as one group", () => {
    const { text } = payload(workflowOf(source), "build", instance);
    const job = text.slice(text.indexOf('"build":{') + '"build":{'.length);
    expect(
      job.startsWith(
        '"name":"Build linux","runs-on":["self-hosted","linux"],"timeout-minutes":30,"continue-on-error":true,"needs"',
      ),
    ).toBe(true);
  });

  it("is deterministic, byte for byte", () => {
    const workflow = workflowOf(source);
    expect(jobPayload(workflow, "build", instance)).toEqual(
      jobPayload(workflow, "build", instance),
    );
  });
});

describe("jobPayload: strategy", () => {
  const matrix = (entries: [string, MatrixValue][]) => new Map(entries);

  it("writes a matrix job's one combination as a literal include-only matrix, with its index and total", () => {
    const workflow = workflowOf(oneJob("    strategy:\n      matrix:\n        os: [linux, mac]\n"));
    const { data, text } = payload(workflow, "build", {
      ...plainInstance("build (mac)"),
      strategy: {
        failFast: true,
        maxParallel: 2,
        matrix: {
          combination: matrix([
            ["os", "mac"],
            ["big", 9007199254740991],
            ["fine", 1.2345678901234567],
            ["include", "just a key"],
            [
              "cfg",
              {
                kind: "object",
                entries: new Map([["exclude", { kind: "array", items: [1, null, true] }]]),
              },
            ],
          ]),
          index: 1,
          total: 2,
        },
      },
    });
    expect(data.jobs.build.strategy).toEqual({
      "fail-fast": true,
      "max-parallel": 2,
      matrix: {
        include: [
          {
            os: "mac",
            big: 9007199254740991,
            fine: 1.2345678901234567,
            include: "just a key",
            cfg: { exclude: [1, null, true] },
          },
        ],
      },
      "job-index": 1,
      "job-total": 2,
    });
    expect(text).toContain('"big":9007199254740991,"fine":1.2345678901234567');
  });

  it("writes fail-fast alone for a job that declares a strategy without a matrix, and nothing without one", () => {
    const withStrategy = workflowOf(oneJob("    strategy:\n      fail-fast: false\n"));
    expect(
      payload(withStrategy, "build", { ...plainInstance("build"), strategy: { failFast: false } })
        .data.jobs.build.strategy,
    ).toEqual({
      "fail-fast": false,
    });
    expect(
      payload(workflowOf(oneJob()), "build", plainInstance("build")).data.jobs.build.strategy,
    ).toBeUndefined();
  });
});

describe("jobPayload: protection of evaluated strings", () => {
  const dangerous = [
    `\${{ secrets.DEMO }}`,
    `x-\${{ secrets.DEMO }}`,
    `\${{ insert }}`,
    `a \${{insert}} b`,
    `it's \${{ 'quoted' }}`,
    `}} \${{ \${{ $$ {{`,
    `line1\nline2 \${{ github.sha }}`,
    `${`\${{ x }}`.repeat(5000)}`,
    `${"q'".repeat(30_000)}\${{`,
  ];

  it("writes names, labels, matrix keys and values so the runner reads back exactly what Fyrden evaluated", () => {
    const workflow = workflowOf(oneJob("    strategy:\n      matrix:\n        v: [1]\n"));
    for (const s of dangerous) {
      const nested: MatrixValue = {
        kind: "object",
        entries: new Map([[s, { kind: "array", items: [s, 1] }]]),
      };
      const { data, text } = payload(workflow, "build", {
        name: s,
        runsOn: [s, "plain"],
        strategy: {
          failFast: true,
          matrix: {
            combination: new Map<string, MatrixValue>([
              [s, s],
              ["n", nested],
            ]),
            index: 0,
            total: 1,
          },
        },
      });
      const job = data.jobs.build;
      expect(readBack(job.name)).toBe(s);
      expect(job["runs-on"].map(readBack)).toEqual([s, "plain"]);
      const [entry] = job.strategy.matrix.include;
      const keys = Object.keys(entry);
      expect(keys.map(readBack)).toEqual([s, "n"]);
      expect(readBack(entry[keys[0] as string])).toBe(s);
      const [innerKey] = Object.keys(entry.n);
      expect(readBack(innerKey as string)).toBe(s);
      expect(
        entry.n[innerKey as string].map((v: unknown) => (typeof v === "string" ? readBack(v) : v)),
      ).toEqual([s, 1]);
      // The runner's insert directive can never match anywhere in the payload.
      expect(text).not.toMatch(/\$\{\{\s*insert\s*\}\}/);
    }
  });

  it(`leaves strings without \${{ as they are`, () => {
    const { data } = payload(workflowOf(oneJob()), "build", {
      name: "build {{ x }} $",
      runsOn: ["a b"],
    });
    expect(data.jobs.build.name).toBe("build {{ x }} $");
  });

  it("writes fields Fyrden does not evaluate as written, for the runner to evaluate once", () => {
    const { data } = payload(
      workflowOf(oneJob(`    env:\n      T: \${{ secrets.T }}\n`)),
      "build",
      plainInstance("b"),
    );
    expect(data.jobs.build.env).toEqual({ T: `\${{ secrets.T }}` });
  });
});

describe("jobPayload: characters", () => {
  it("escapes the line separators, and a space right after one, which the runner's reader would drop", () => {
    const s = 'a\u2028 b\u2029  c \u2028\u2029 d\u0001e"f\\g\th😀\u2028';
    const { text, data } = payload(workflowOf(oneJob()), "build", { name: s, runsOn: ["x"] });
    expect(text).toContain("a\\u2028\\u0020b\\u2029\\u0020 c \\u2028\\u2029\\u0020d");
    expect(text).not.toMatch(/[\u2028\u2029]/);
    expect(data.jobs.build.name).toBe(s);
  });

  it("escapes U+FFFE and U+FFFF, which the runner's reader refuses raw", () => {
    const s = "a\ufffeb\uffff";
    const { text, data } = payload(workflowOf(oneJob()), "build", { name: s, runsOn: ["x"] });
    expect(text).toContain("a\\ufffeb\\uffff");
    expect(data.jobs.build.name).toBe(s);
  });

  it("writes an empty name as an expression giving '', which the reader would replace with the job id", () => {
    const { data } = payload(workflowOf(oneJob()), "build", { name: "", runsOn: ["x"] });
    expect(data.jobs.build.name).toBe(`\${{ '' }}`);
    expect(readBack(data.jobs.build.name)).toBe("");
  });

  it("refuses NEL, which the runner's reader drops in every form, as a bug", () => {
    expect(() =>
      jobPayload(workflowOf(oneJob()), "build", { name: "a\u0085b", runsOn: ["x"] }),
    ).toThrow(/NEL/);
  });

  it("refuses a string that is not well-formed UTF-16 as a bug", () => {
    expect(() =>
      jobPayload(workflowOf(oneJob()), "build", { name: "a\ud800b", runsOn: ["x"] }),
    ).toThrow(/not well-formed/);
  });
});

describe("jobPayload: size", () => {
  it("is exactly the invariant part plus the instance's group", () => {
    const cases: [Workflow, string, PayloadInstance][] = [
      [workflowOf(basicSource), "probe", plainInstance("probe")],
      [workflowOf(needsSource), "build", plainInstance("build")],
      [
        workflowOf(oneJob(`    env:\n      E: "\\u2028 \\u0001 😀 \\" \${{ github.sha }}"\n`)),
        "build",
        {
          name: `n \${{ y }} 😀 \u2028 x`,
          runsOn: [`l'\${{`],
          timeoutMinutes: 7,
          continueOnError: false,
          strategy: {
            failFast: false,
            maxParallel: 3,
            matrix: {
              combination: new Map<string, MatrixValue>([["k", "v\u0001"]]),
              index: 0,
              total: 1,
            },
          },
        },
      ],
    ];
    for (const [workflow, jobId, instance] of cases) {
      const bytes = jobPayload(workflow, jobId, instance);
      expect(bytes.length).toBe(
        invariantPayloadBytes(workflow, jobId) + instancePayloadBytes(instance),
      );
    }
  });

  it("holds for any name and labels", () => {
    const workflow = workflowOf(oneJob());
    const invariant = invariantPayloadBytes(workflow, "build");
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme" }),
        fc.array(fc.string({ unit: "binary" }), { minLength: 1, maxLength: 3 }),
        (name, labels) => {
          const safe = labels.map((l) => l.replace(/[\ud800-\udfff\u0085]/g, "x"));
          const instance = { name: name.replace(/[\ud800-\udfff\u0085]/g, "x"), runsOn: safe };
          expect(jobPayload(workflow, "build", instance).length).toBe(
            invariant + instancePayloadBytes(instance),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it("builds a payload of exactly the cap and refuses one byte more", () => {
    const workflow = workflowOf(oneJob());
    const base =
      invariantPayloadBytes(workflow, "build") + instancePayloadBytes({ name: "n", runsOn: ["x"] });
    // Each further "n" adds one byte.
    const fill = "n".repeat(MAX_PAYLOAD_BYTES - base + 1);
    expect(jobPayload(workflow, "build", { name: fill, runsOn: ["x"] }).length).toBe(
      MAX_PAYLOAD_BYTES,
    );
    expect(() => jobPayload(workflow, "build", { name: `${fill}n`, runsOn: ["x"] })).toThrow(
      /over/,
    );
  }, 60_000);

  it("counts a job whose aliases repeat text past the cap without building it", () => {
    const value = "v".repeat(10_000);
    const env = Array.from({ length: 210 }, (_, i) => `      E${i}: *big\n`).join("");
    const workflow = workflowOf(
      `x-anchor: &big "${value}"\n`.replace("x-anchor", "name") + oneJob(`    env:\n${env}`),
    );
    expect(invariantPayloadBytes(workflow, "build")).toBeGreaterThan(MAX_PAYLOAD_BYTES);
  }, 60_000);
});
