// A workflow's run-start check and each job's expansion into instances:
// the strategy evaluated once per job, then names, labels, timeout and
// continue-on-error per combination, under the run's job cap and the
// scheduling step's work budget.
import { describe, expect, it } from "vitest";
import {
  type ExpandOptions,
  expandJob,
  MAX_RUN_JOBS,
  planWorkflow,
  toPayloadInstance,
} from "../../src/ci/expand.js";
import { type ExprValue, exprArray, exprObject } from "../../src/ci/expression-values.js";
import { newWorkBudget } from "../../src/ci/expressions.js";
import { parseWorkflow } from "../../src/ci/parse.js";
import { invariantPayloadBytes, jobPayload } from "../../src/ci/payload.js";
import type { Workflow, WorkflowError } from "../../src/ci/workflow-schema.js";

const encoder = new TextEncoder();

function workflowOf(text: string): Workflow {
  const parsed = parseWorkflow("w.yml", encoder.encode(text));
  if (!parsed.ok) throw new Error(`errors: ${JSON.stringify(parsed.errors, null, 2)}`);
  return parsed.workflow;
}

/** One job `build` whose job-level lines are `lines` (indented 4). */
const job = (lines: string) =>
  `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n${lines}    steps:\n      - run: echo hi\n`;

const options = (workflow: Workflow, jobId = "build"): ExpandOptions => ({
  remainingRunJobs: MAX_RUN_JOBS,
  invariantPayloadBytes: invariantPayloadBytes(workflow, jobId),
  budget: newWorkBudget(),
});

function expanded(text: string, scope = {}, jobId = "build") {
  const workflow = workflowOf(text);
  const result = expandJob(workflow, jobId, scope, options(workflow, jobId));
  if (!result.ok) throw new Error(`errors: ${JSON.stringify(result.errors, null, 2)}`);
  return result.job;
}

function errorsOf(
  text: string,
  scope = {},
  override: Partial<ExpandOptions> = {},
): WorkflowError[] {
  const workflow = workflowOf(text);
  const result = expandJob(workflow, "build", scope, { ...options(workflow), ...override });
  if (result.ok) throw new Error("expanded without errors");
  return [...result.errors];
}

const obj = (entries: Record<string, ExprValue>) => exprObject(Object.entries(entries));
const plain = (m: ReadonlyMap<string, ExprValue> | null) =>
  m && Object.fromEntries([...m].map(([k, v]) => [k, typeof v === "object" && v ? "…" : v]));

describe("expandJob: instances", () => {
  it("expands a matrix in GitHub's order, naming each instance by its values", () => {
    const result = expanded(
      job("    strategy:\n      matrix:\n        node: [18, 20]\n        os: [linux, mac]\n"),
    );
    expect(result.instances.map((i) => i.name)).toEqual([
      "build (18, linux)",
      "build (18, mac)",
      "build (20, linux)",
      "build (20, mac)",
    ]);
    expect(result.instances.map((i) => [i.index, i.total])).toEqual([
      [0, 4],
      [1, 4],
      [2, 4],
      [3, 4],
    ]);
    expect(plain(result.instances[1]?.matrix ?? null)).toEqual({ node: 18, os: "mac" });
    expect(result.failFast).toBe(true);
    expect(result.maxParallel).toBeUndefined();
  });

  it("is one instance, 0 of 1, for a job without a matrix", () => {
    const result = expanded(job(""));
    expect(result.instances).toEqual([
      {
        jobId: "build",
        index: 0,
        total: 1,
        matrix: null,
        name: "build",
        runsOn: ["ubuntu-latest"],
        continueOnError: false,
      },
    ]);
  });

  it("uses the job's name before the values, and interpolates a name holding an expression without them", () => {
    const named = expanded(
      job("    name: Test\n    strategy:\n      matrix:\n        os: [linux]\n"),
    );
    expect(named.instances[0]?.name).toBe("Test (linux)");
    const templated = expanded(
      job(
        `    name: Node \${{ matrix.node }} on \${{ matrix.os }} (\${{ strategy.job-index }}/\${{ strategy.job-total }})\n    strategy:\n      matrix:\n        node: [18]\n        os: [linux, mac]\n`,
      ),
    );
    expect(templated.instances.map((i) => i.name)).toEqual([
      "Node 18 on linux (0/2)",
      "Node 18 on mac (1/2)",
    ]);
  });

  it("falls back to the default name when the name evaluates to empty, as the runner does", () => {
    const result = expanded(
      job(
        `    name: \${{ matrix.label }}\n    strategy:\n      matrix:\n        label: ['']\n        os: [linux]\n`,
      ),
    );
    expect(result.instances[0]?.name).toBe("build (, linux)");
  });

  it("falls back to the default name for an empty literal name too", () => {
    expect(expanded(job("    name: ''\n")).instances[0]?.name).toBe("build");
    expect(
      expanded(job("    name: ''\n    strategy:\n      matrix:\n        os: [linux]\n"))
        .instances[0]?.name,
    ).toBe("build (linux)");
  });

  it("reads the strategy context as the runner does: max-parallel is the total unless set", () => {
    const unset = expanded(
      job(
        `    name: \${{ strategy.max-parallel }} \${{ strategy.fail-fast }}\n    strategy:\n      matrix:\n        n: [1, 2, 3]\n`,
      ),
    );
    expect(unset.instances[0]?.name).toBe("3 true");
    const set = expanded(
      job(
        `    name: \${{ strategy.max-parallel }} \${{ strategy.fail-fast }}\n    strategy:\n      fail-fast: false\n      max-parallel: 2\n      matrix:\n        n: [1, 2, 3]\n`,
      ),
    );
    expect(set.instances[0]?.name).toBe("2 false");
    // Without a matrix the runner reads the total even when max-parallel is set.
    const noMatrix = expanded(
      job(`    name: \${{ strategy.max-parallel }}\n    strategy:\n      max-parallel: 2\n`),
    );
    expect(noMatrix.instances[0]?.name).toBe("1");
    expect([set.failFast, set.maxParallel]).toEqual([false, 2]);
  });

  it("evaluates labels per instance: one templated label, or an expression giving a string or a list", () => {
    const each = expanded(
      job("    strategy:\n      matrix:\n        os: [linux, mac]\n").replace(
        "runs-on: ubuntu-latest",
        `runs-on: [self-hosted, '\${{ matrix.os }}']`,
      ),
    );
    expect(each.instances.map((i) => i.runsOn)).toEqual([
      ["self-hosted", "linux"],
      ["self-hosted", "mac"],
    ]);
    const whole = expanded(
      job("").replace("runs-on: ubuntu-latest", `runs-on: \${{ fromJSON(inputs.labels) }}`),
      { inputs: obj({ labels: '["a", "b"]' }) },
    );
    expect(whole.instances[0]?.runsOn).toEqual(["a", "b"]);
    const one = expanded(job("").replace("runs-on: ubuntu-latest", `runs-on: \${{ inputs.os }}`), {
      inputs: obj({ os: "linux" }),
    });
    expect(one.instances[0]?.runsOn).toEqual(["linux"]);
  });

  it("refuses labels that are not non-empty strings, or repeat", () => {
    const at = (labels: string, inputs: Record<string, ExprValue>) =>
      errorsOf(job("").replace("runs-on: ubuntu-latest", `runs-on: ${labels}`), {
        inputs: obj(inputs),
      }).map((e) => [e.code, e.path]);
    expect(at(`\${{ fromJSON(inputs.l) }}`, { l: "[1]" })).toEqual([
      ["invalid_type", "jobs.build.runs-on"],
    ]);
    expect(at(`\${{ inputs.l }}`, { l: "" })).toEqual([["invalid_value", "jobs.build.runs-on"]]);
    expect(at(`[a, '\${{ inputs.l }}']`, { l: "a" })).toEqual([
      ["invalid_value", "jobs.build.runs-on[1]"],
    ]);
  });

  it("evaluates timeout-minutes and continue-on-error per instance, checked as literals are", () => {
    const result = expanded(
      job(
        `    timeout-minutes: \${{ matrix.t }}\n    continue-on-error: \${{ matrix.ok }}\n    strategy:\n      matrix:\n        include:\n          - {t: 5, ok: true}\n          - {t: 10, ok: false}\n`,
      ),
    );
    expect(result.instances.map((i) => [i.timeoutMinutes, i.continueOnError])).toEqual([
      [5, true],
      [10, false],
    ]);
    const codes = (lines: string) => errorsOf(job(lines)).map((e) => [e.code, e.path]);
    expect(codes(`    timeout-minutes: \${{ 0 }}\n`)).toEqual([
      ["invalid_value", "jobs.build.timeout-minutes"],
    ]);
    expect(codes(`    timeout-minutes: \${{ 'x' }}\n`)).toEqual([
      ["invalid_type", "jobs.build.timeout-minutes"],
    ]);
    expect(codes(`    continue-on-error: \${{ 'yes' }}\n`)).toEqual([
      ["invalid_type", "jobs.build.continue-on-error"],
    ]);
  });
});

describe("expandJob: matrices with expressions", () => {
  it("expands a matrix a need's output defines, once the job is ready", () => {
    const text = `on: push
jobs:
  define:
    runs-on: x
    outputs:
      colors: \${{ steps.c.outputs.colors }}
    steps:
      - id: c
        run: echo
  produce:
    runs-on: x
    needs: define
    strategy:
      matrix:
        color: \${{ fromJSON(needs.define.outputs.colors) }}
    steps:
      - run: echo
`;
    const needs = obj({
      define: obj({ result: "success", outputs: obj({ colors: '["red", "green"]' }) }),
    });
    const result = expanded(text, { needs }, "produce");
    expect(result.instances.map((i) => i.name)).toEqual(["produce (red)", "produce (green)"]);
  });

  it("evaluates a whole matrix, a value inside a literal one, and an include list", () => {
    const whole = expanded(job(`    strategy:\n      matrix: \${{ fromJSON(inputs.m) }}\n`), {
      inputs: obj({ m: '{"os": ["linux"], "include": [{"os": "linux", "x": 1}]}' }),
    });
    expect(plain(whole.instances[0]?.matrix ?? null)).toEqual({ os: "linux", x: 1 });
    const inside = expanded(
      job(`    strategy:\n      matrix:\n        os: [linux, '\${{ inputs.extra }}']\n`),
      {
        inputs: obj({ extra: "bsd" }),
      },
    );
    expect(inside.instances.map((i) => i.name)).toEqual(["build (linux)", "build (bsd)"]);
    const included = expanded(
      job(
        `    strategy:\n      matrix:\n        os: [linux]\n        include: \${{ fromJSON(inputs.more) }}\n`,
      ),
      { inputs: obj({ more: '[{"os": "mac"}]' }) },
    );
    expect(included.instances.map((i) => i.name)).toEqual(["build (linux)", "build (mac)"]);
  });

  it("tells apart expressions whose paths print the same, such as a dotted key and a nested one", () => {
    const result = expanded(
      job(
        `    strategy:\n      matrix:\n        obj:\n          - 'x.y': \${{ 'first' }}\n            x:\n              y: \${{ 'second' }}\n            'a[0]': \${{ 'third' }}\n            a: ["\${{ 'fourth' }}"]\n`,
      ),
    );
    expect(result.instances[0]?.name).toBe("build (first, second, third, fourth)");
  });

  it("charges checking evaluated matrix values, however many keys share one large array", () => {
    const big = exprArray(Array.from({ length: 10_000 }, (_, i) => i));
    const keys = Array.from({ length: 10 }, (_, i) => `        k${i}: \${{ inputs.big }}\n`).join(
      "",
    );
    const workflow = workflowOf(job(`    strategy:\n      matrix:\n${keys}`));
    const budget = newWorkBudget(50_000);
    const result = expandJob(
      workflow,
      "build",
      { inputs: obj({ big }) },
      { ...options(workflow), budget },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "limit_exceeded",
        path: expect.stringMatching(/^jobs\.build\.strategy\.matrix\.k\d$/),
        message: expect.stringMatching(/work/),
      }),
    ]);
  });

  it("charges every key of an evaluated object, refused duplicates too", () => {
    // 256 spellings of one key: each is a duplicate after the first, and each is charged.
    const spellings = Array.from({ length: 256 }, (_, i) =>
      [...i.toString(2).padStart(8, "0")]
        .map((bit, j) => (bit === "1" ? "ABCDEFGH"[j] : "abcdefgh"[j]))
        .join(""),
    );
    const object = exprObject(spellings.map((k) => [k, 1] as const));
    const workflow = workflowOf(
      job(`    strategy:\n      matrix:\n        os: ['\${{ inputs.o }}']\n`),
    );
    // Few enough units that the duplicate errors stay under the error limit.
    const budget = newWorkBudget(60);
    const result = expandJob(
      workflow,
      "build",
      { inputs: obj({ o: object }) },
      { ...options(workflow), budget },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeLessThan(100);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "limit_exceeded", message: expect.stringMatching(/work/) }),
      );
    }
  });

  it("names the feature of an evaluated value by where it is, not by how its key starts", () => {
    const errors = errorsOf(
      job(`    strategy:\n      matrix:\n        include-extra: ['\${{ Infinity }}']\n`),
    );
    expect(errors).toEqual([
      expect.objectContaining({
        code: "invalid_value",
        feature: "jobs.<job_id>.strategy.matrix",
        path: "jobs.build.strategy.matrix.include-extra[0]",
      }),
    ]);
  });

  it("refuses an evaluated matrix of the wrong shape, at the expression", () => {
    const codes = (lines: string, m: string) =>
      errorsOf(job(lines), { inputs: obj({ m }) }).map((e) => [e.code, e.path]);
    expect(codes(`    strategy:\n      matrix: \${{ fromJSON(inputs.m) }}\n`, "[1]")).toEqual([
      ["invalid_type", "jobs.build.strategy.matrix"],
    ]);
    expect(
      codes(`    strategy:\n      matrix:\n        os: \${{ fromJSON(inputs.m) }}\n`, '"linux"'),
    ).toEqual([["invalid_type", "jobs.build.strategy.matrix.os"]]);
    // fromJSON merges keys that differ only in case; a context object can still hold both.
    const both = obj({ os: exprArray([1]), OS: exprArray([2]) });
    expect(
      errorsOf(job(`    strategy:\n      matrix: \${{ inputs.m }}\n`), {
        inputs: obj({ m: both }),
      }).map((e) => [e.code, e.path]),
    ).toEqual([["duplicate_key", "jobs.build.strategy.matrix.os"]]);
  });

  it("evaluates fail-fast and max-parallel once per job, refusing values the runner cannot take", () => {
    const codes = (lines: string) => errorsOf(job(lines)).map((e) => [e.code, e.path]);
    expect(codes(`    strategy:\n      fail-fast: \${{ 'no' }}\n`)).toEqual([
      ["invalid_type", "jobs.build.strategy.fail-fast"],
    ]);
    expect(codes(`    strategy:\n      max-parallel: \${{ 2147483648 }}\n`)).toEqual([
      ["invalid_value", "jobs.build.strategy.max-parallel"],
    ]);
    expect(codes(`    strategy:\n      max-parallel: \${{ 0 }}\n`)).toEqual([
      ["invalid_value", "jobs.build.strategy.max-parallel"],
    ]);
    expect(
      expanded(job(`    strategy:\n      max-parallel: \${{ 2147483647 }}\n`)).maxParallel,
    ).toBe(2147483647);
  });
});

describe("expandJob: limits", () => {
  it("refuses more instances than the run has room for, naming the cap and the counts", () => {
    const [error] = errorsOf(
      job("    strategy:\n      matrix:\n        n: [1, 2, 3]\n"),
      {},
      { remainingRunJobs: 2 },
    );
    expect(error).toMatchObject({ code: "limit_exceeded", path: "jobs.build.strategy.matrix" });
    expect(error?.message).toBe(
      `A run may have at most ${MAX_RUN_JOBS} job instances; this job has 3 and the run has room for 2 more.`,
    );
  });

  it("charges its work to the scheduling step's budget, and stops when it runs out", () => {
    const workflow = workflowOf(
      job(`    name: \${{ matrix.n }}\n    strategy:\n      matrix:\n        n: [1, 2, 3]\n`),
    );
    const budget = newWorkBudget();
    expect(expandJob(workflow, "build", {}, { ...options(workflow), budget }).ok).toBe(true);
    expect(budget.spent).toBeGreaterThan(0);
    const spent = newWorkBudget(budget.spent - 1);
    const result = expandJob(workflow, "build", {}, { ...options(workflow), budget: spent });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("limit_exceeded");
  });

  it("charges naming and payload counting, so a long literal name cannot run free", () => {
    const workflow = workflowOf(job(`    name: ${"n".repeat(100_000)}\n`));
    const budget = newWorkBudget(1000);
    const result = expandJob(workflow, "build", {}, { ...options(workflow), budget });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]).toMatchObject({ code: "limit_exceeded", path: "jobs.build" });
    expect(budget.spent).toBeGreaterThan(1000);
    // The run's start checks every string: a long job name, which is not in the invariant part.
    const named = planWorkflow(workflow, newWorkBudget(100));
    expect(named.ok).toBe(false);
    if (!named.ok) expect(named.errors[0]?.code).toBe("limit_exceeded");
    // It then counts each job's invariant part: a long env value, about 1,600 units to check
    // and as many again to count, so 2,500 units pass the check and stop at the count.
    const env = workflowOf(job(`    env:\n      E: ${"e".repeat(100_000)}\n`));
    const plan = planWorkflow(env, newWorkBudget(2500));
    expect(plan.ok).toBe(false);
    if (!plan.ok)
      expect(plan.errors[0]).toMatchObject({ code: "limit_exceeded", path: "jobs.build" });
  });

  it("charges the matrix's own work to the same budget", () => {
    // No expressions: anything spent is the matrix's expansion.
    const workflow = workflowOf(job("    strategy:\n      matrix:\n        n: [1, 2, 3]\n"));
    const budget = newWorkBudget();
    expect(expandJob(workflow, "build", {}, { ...options(workflow), budget }).ok).toBe(true);
    expect(budget.spent).toBeGreaterThan(0);
  });

  it("refuses an instance whose payload would be over the cap", () => {
    // Each label is under the evaluator's own memory limit; together they are over the cap.
    const ids = ["a", "b", "c", "d", "e", "f"];
    const runsOn = `[${ids.map((id) => `'\${{ inputs.${id} }}'`).join(", ")}]`;
    const workflow = workflowOf(job("").replace("runs-on: ubuntu-latest", `runs-on: ${runsOn}`));
    const inputs = obj(Object.fromEntries(ids.map((id) => [id, id.repeat(400_000)])));
    const result = expandJob(workflow, "build", { inputs }, options(workflow));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]).toMatchObject({ code: "limit_exceeded", path: "jobs.build" });
  }, 60_000);

  it("refuses an evaluated string the runner cannot read, at its field", () => {
    expect(
      errorsOf(job(`    name: \${{ inputs.n }}\n`), { inputs: obj({ n: "a\u0085b" }) }).map((e) => [
        e.code,
        e.path,
      ]),
    ).toEqual([["invalid_value", "jobs.build.name"]]);
    expect(
      errorsOf(job(`    strategy:\n      matrix:\n        os: ['\${{ inputs.n }}']\n`), {
        inputs: obj({ n: "\ud800" }),
      }).map((e) => [e.code, e.path]),
    ).toEqual([["invalid_value", "jobs.build.strategy.matrix.os[0]"]]);
  });
});

describe("toPayloadInstance", () => {
  it("gives jobPayload what the instance evaluated, with the strategy only when the job declares one", () => {
    const text = job(
      "    continue-on-error: true\n    strategy:\n      matrix:\n        os: [linux]\n",
    );
    const workflow = workflowOf(text);
    const result = expandJob(workflow, "build", {}, options(workflow));
    if (!result.ok) throw new Error("errors");
    const instance = result.job.instances[0];
    if (!instance) throw new Error("no instance");
    const bytes = jobPayload(workflow, "build", toPayloadInstance(result.job, instance));
    // biome-ignore lint/suspicious/noExplicitAny: the payload's shape is what the test inspects
    const data = JSON.parse(new TextDecoder().decode(bytes)) as any;
    expect(data.jobs.build.name).toBe("build (linux)");
    expect(data.jobs.build.strategy).toEqual({
      "fail-fast": true,
      matrix: { include: [{ os: "linux" }] },
      "job-index": 0,
      "job-total": 1,
    });
    expect(data.jobs.build["continue-on-error"]).toBe(true);
    const plainJob = expanded(job(""));
    expect(toPayloadInstance(plainJob, plainJob.instances[0] as never)).toEqual({
      name: "build",
      runsOn: ["ubuntu-latest"],
    });
  });
});

describe("planWorkflow", () => {
  const plan = (text: string) => planWorkflow(workflowOf(text));

  it("orders the jobs and counts instances: static matrices expanded, dynamic ones one each", () => {
    const result = plan(`on: push
jobs:
  a:
    runs-on: x
    strategy:
      fail-fast: \${{ inputs.ff == 'yes' }}
      matrix:
        n: [1, 2, 3]
    steps:
      - run: echo
  b:
    runs-on: x
    needs: a
    strategy:
      matrix:
        n: \${{ fromJSON(needs.a.outputs.n) }}
    steps:
      - run: echo
  c:
    runs-on: x
    steps:
      - run: echo
`);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.plan.graph.order.map((j) => j.id)).toEqual(["a", "b", "c"]);
    expect(result.plan.staticInstances).toBe(5);
    expect(result.plan.jobs.get("a")?.instances).toBe(3);
    expect(result.plan.jobs.get("b")?.instances).toBeUndefined();
  });

  it("fails a run whose static matrix cannot expand, whatever the job's if:", () => {
    const result = plan(
      job(
        "    if: false\n    strategy:\n      matrix:\n        os: [a]\n        exclude:\n          - os: a\n",
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toEqual(["invalid_value"]);
  });

  it("refuses a run past the job cap at the matrix that passes it, without expanding the rest", () => {
    const values = Array.from({ length: 200 }, (_, i) => i).join(", ");
    const matrixJob = (id: string) =>
      `  ${id}:\n    runs-on: x\n    strategy:\n      matrix:\n        n: [${values}]\n    steps:\n      - run: echo\n`;
    const result = plan(`on: push\njobs:\n${matrixJob("a")}${matrixJob("b")}${matrixJob("c")}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "limit_exceeded",
        path: "jobs.b.strategy.matrix",
        message: `A run may have at most ${MAX_RUN_JOBS} job instances; the jobs up to \`b\` already make 400.`,
      }),
    ]);
  });

  it("refuses text the runner cannot read, positioned", () => {
    const result = plan(job('    env:\n      A: "x\\u0085y"\n      B: "\\ud800"\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => [e.code, e.line, e.column])).toEqual([
      ["invalid_value", 6, 10],
      ["invalid_value", 7, 10],
    ]);
  });

  it("refuses a job whose payload is over the cap before any instance", () => {
    const value = "v".repeat(10_000);
    const env = Array.from({ length: 210 }, (_, i) => `      E${i}: *big\n`).join("");
    const result = plan(`name: &big "${value}"\n${job(`    env:\n${env}`)}`);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]).toMatchObject({ code: "limit_exceeded", path: "jobs.build" });
  }, 60_000);

  it("reports graph errors", () => {
    const result = plan(
      "on: push\njobs:\n  a:\n    runs-on: x\n    needs: a\n    steps:\n      - run: echo\n",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toEqual(["dependency_cycle"]);
  });
});
