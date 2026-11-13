// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests write workflow expressions, `${{ }}` included, as plain strings
// Expressions where a workflow uses them: each field's row of GitHub's context availability
// table decides which contexts and special functions it may use, fields with no row take no
// expressions, and the errors join the parser's, at the field's path and position.
import { describe, expect, it } from "vitest";
import {
  EXPRESSION_SITES,
  evaluateField,
  evaluateJobCondition,
  expressionFields,
} from "../../src/ci/expression-sites.js";
import { exprArray } from "../../src/ci/expression-values.js";
import { parseWorkflow } from "../../src/ci/parse.js";
import type { Workflow, WorkflowError } from "../../src/ci/workflow-schema.js";
import { scopeOf } from "./expression-helpers.js";

const encoder = new TextEncoder();
const parse = (text: string) => parseWorkflow(".github/workflows/ci.yml", encoder.encode(text));

function workflowOf(text: string): Workflow {
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

function messageOf(text: string): string {
  const parsed = parse(text);
  if (parsed.ok) throw new Error("parsed without errors");
  return parsed.errors.map((e) => e.message).join("\n");
}

/** One job named build with `jobLines` (indented 4) and one step with `stepLines` (indented 8). */
const job = (jobLines = "", stepLines = "", top = "") =>
  `${top}on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n${jobLines}    steps:\n      - run: echo hi\n${stepLines}`;

describe("contexts each field may use", () => {
  it.each([
    [
      "job if: github, needs, vars, inputs",
      job("    if: github.ref == 'x' && needs.a.result && vars.v && inputs.i\n"),
    ],
    [
      "job if: status functions",
      job("    if: always() && !cancelled() || failure() || success()\n"),
    ],
    [
      "runs-on: matrix and strategy",
      job("    strategy:\n      matrix:\n        os: [a]\n", "", "").replace(
        "runs-on: ubuntu-latest",
        "runs-on: ${{ matrix.os }}-${{ strategy.job-index }}",
      ),
    ],
    [
      "strategy: needs and inputs",
      job("    strategy:\n      matrix: ${{ fromJSON(needs.detect.outputs.m) }}\n"),
    ],
    ["job env: secrets", job("    env:\n      T: ${{ secrets.TOKEN }}\n")],
    [
      "step run: every runner context and hashFiles",
      job(
        "",
        "        env:\n          A: ${{ steps.x.outputs.y }}${{ job.status }}${{ runner.os }}${{ env.B }}${{ secrets.S }}${{ hashFiles('**') }}\n",
      ),
    ],
    [
      "step if: status functions and steps",
      job("", "        if: failure() && steps.x.conclusion == 'failure'\n"),
    ],
    [
      "run-name: github, inputs, vars",
      job("", "", "run-name: ${{ github.actor }} ${{ inputs.x }} ${{ vars.y }}\n"),
    ],
    ["outputs: steps", job("    outputs:\n      v: ${{ steps.s.outputs.v }}\n")],
    [
      "container env: runner",
      job("    container:\n      image: node\n      env:\n        A: ${{ runner.temp }}\n"),
    ],
    [
      "literal fromJSON, strict",
      job("", "        env:\n          A: ${{ fromJSON('{\"a\":[1]}').a[0] }}\n"),
    ],
  ])("%s", (_, text) => {
    expect(parse(text).ok).toBe(true);
  });

  it.each([
    [
      "secrets in a job if",
      job("    if: secrets.TOKEN != ''\n"),
      "jobs.<job_id>.if",
      "jobs.build.if",
    ],
    ["matrix in a job if", job("    if: matrix.os == 'a'\n"), "jobs.<job_id>.if", "jobs.build.if"],
    [
      "matrix in strategy",
      job(
        "    strategy:\n      matrix:\n        os: [a]\n        include:\n          - os: ${{ matrix.os }}\n",
      ),
      "jobs.<job_id>.strategy.matrix.include",
      "jobs.build.strategy.matrix.include[0].os",
    ],
    [
      "env in runs-on",
      job().replace("runs-on: ubuntu-latest", "runs-on: ${{ env.RUNNER }}"),
      "jobs.<job_id>.runs-on",
      "jobs.build.runs-on",
    ],
    [
      "secrets in a step if",
      job("", "        if: secrets.X\n"),
      "jobs.<job_id>.steps[*].if",
      "jobs.build.steps[0].if",
    ],
    [
      "steps in run-name",
      job("", "", "run-name: ${{ steps.a.outputs.b }}\n"),
      "run-name",
      "run-name",
    ],
    [
      "needs in the workflow's concurrency",
      job("", "", "concurrency: ${{ needs.a.result }}\n"),
      "concurrency.group",
      "concurrency.group",
    ],
    [
      "secrets in a service image",
      job("    services:\n      db:\n        image: ${{ secrets.IMAGE }}\n"),
      "jobs.<job_id>.services.<service_id>.image",
      "jobs.build.services.db.image",
    ],
  ])("%s is refused", (_, text, feature, path) => {
    expect(errorsOf(text)).toEqual([
      expect.objectContaining({ code: "context_not_available", feature, path }),
    ]);
  });

  it("names the contexts allowed, and suggests vars or matrix for env in a job field", () => {
    const message = messageOf(
      job().replace("runs-on: ubuntu-latest", "runs-on: ${{ env.RUNNER }}"),
    );
    expect(message).toContain("`env`");
    expect(message).toContain("`vars`");
    expect(message).toContain("`github`, `needs`, `strategy`, `matrix`, `vars`, `inputs`");
  });

  it("points at the field", () => {
    expect(errorsOf(job("    if: secrets.TOKEN != ''\n"))).toEqual([
      {
        code: "context_not_available",
        feature: "jobs.<job_id>.if",
        path: "jobs.build.if",
        line: 5,
        column: 9,
      },
    ]);
  });
});

describe("special functions", () => {
  it.each([
    [
      "success() in run-name",
      job("", "", "run-name: ${{ success() }}\n"),
      "function_not_available",
    ],
    [
      "always() in a step's env",
      job("", "        env:\n          A: ${{ always() }}\n"),
      "function_not_available",
    ],
    ["hashFiles in a job name", job("    name: ${{ hashFiles('x') }}\n"), "function_not_available"],
    ["hashFiles in a job if", job("    if: hashFiles('x') != ''\n"), "function_not_available"],
  ])("%s", (_, text, code) => {
    expect(errorsOf(text).map((e) => e.code)).toEqual([code]);
  });
});

describe("fields that take no expressions", () => {
  it.each([
    [
      "uses",
      job("", "      - uses: ./${{ inputs.path }}\n"),
      "jobs.<job_id>.steps[*].uses",
      "jobs.build.steps[1].uses",
    ],
    [
      "shell",
      job("", "        shell: ${{ matrix.shell }}\n"),
      "jobs.<job_id>.steps[*].shell",
      "jobs.build.steps[0].shell",
    ],
    [
      "needs",
      job('    needs: ["${{ inputs.a }}"]\n'),
      "jobs.<job_id>.needs",
      "jobs.build.needs[0]",
    ],
    [
      "a step id",
      job("", "        id: ${{ inputs.a }}\n"),
      "jobs.<job_id>.steps[*].id",
      "jobs.build.steps[0].id",
    ],
    [
      "a branch filter",
      "on:\n  push:\n    branches: ['${{ inputs.b }}']\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: a\n",
      "on.push.branches",
      "on.push.branches[0]",
    ],
    [
      "a dispatch input's description",
      "on:\n  workflow_dispatch:\n    inputs:\n      a:\n        description: ${{ github.ref }}\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: a\n",
      "on.workflow_dispatch.inputs.<input_id>.description",
      "on.workflow_dispatch.inputs.a.description",
    ],
    ["the workflow name", job("", "", "name: ${{ github.ref }}\n"), "name", "name"],
  ])("%s", (_, text, feature, path) => {
    expect(errorsOf(text)).toEqual([
      expect.objectContaining({ code: "expression_not_allowed", feature, path }),
    ]);
  });

  it("a dispatch input's default", () => {
    const text =
      "on:\n  workflow_dispatch:\n    inputs:\n      a:\n        default: ${{ github.ref }}\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: a\n";
    expect(errorsOf(text)).toEqual([
      expect.objectContaining({
        code: "expression_not_allowed",
        path: "on.workflow_dispatch.inputs.a.default",
      }),
    ]);
  });

  it("names a forbidden context once however often it appears", () => {
    expect(errorsOf(job("    if: secrets.A == secrets.B\n"))).toHaveLength(1);
  });

  it("points the workflow name at run-name", () => {
    expect(messageOf(job("", "", "name: ${{ github.ref }}\n"))).toContain("run-name");
  });
});

describe("language errors at the field", () => {
  it.each([
    ["an unknown context", job("    if: gitea.ref == 'x'\n"), "unknown_context"],
    [
      "an unknown function",
      job("", "        env:\n          A: ${{ length('x') }}\n"),
      "unknown_function",
    ],
    ["a syntax error", job("", "        env:\n          A: ${{ 1 = 1 }}\n"), "expression_syntax"],
    ["an unclosed expression", job("", "        env:\n          A: ${{ 1\n"), "expression_syntax"],
    [
      "text beside a job condition",
      job("    if: ${{ github.ref }} == 'x'\n"),
      "condition_not_single_expression",
    ],
    [
      "text beside a step condition",
      job("", '        if: " ${{ false }}"\n'),
      "condition_not_single_expression",
    ],
    [
      "a block scalar condition ending in a newline",
      job("", "        if: |\n          ${{ false }}\n"),
      "condition_not_single_expression",
    ],
    [
      "literal fromJSON that is not strict JSON",
      job("", "        env:\n          A: ${{ fromJSON('{a:1}') }}\n"),
      "expression_failed",
    ],
    [
      "an expression past GitHub's length",
      job("", `        env:\n          A: \${{ '${"a".repeat(21_000)}' }}\n`),
      "limit_exceeded",
    ],
  ])("%s", (_, text, code) => {
    expect(errorsOf(text).map((e) => e.code)).toEqual([code]);
  });

  it("accepts a condition in a |- block, and a bare expression in a | block", () => {
    expect(parse(job("", "        if: |-\n          ${{ false }}\n")).ok).toBe(true);
    expect(parse(job("", "        if: |\n          github.ref == 'x'\n")).ok).toBe(true);
  });

  it("reports structural errors first; expressions are checked once the structure is valid", () => {
    const text = job("    environment: prod\n    if: nope.x\n");
    expect(errorsOf(text).map((e) => e.code)).toEqual(["unsupported_key"]);
  });

  it("reports each occurrence of an aliased expression at its own path", () => {
    const steps = Array.from({ length: 5 }, () => `      - run: *bad\n`).join("");
    const text = `on: push\njobs:\n  build:\n    runs-on: x\n    env:\n      A: &bad \${{ nope.x }}\n    steps:\n${steps}`;
    expect(errorsOf(text).map((e) => e.path)).toEqual([
      "jobs.build.env.A",
      "jobs.build.steps[0].run",
      "jobs.build.steps[1].run",
      "jobs.build.steps[2].run",
      "jobs.build.steps[3].run",
      "jobs.build.steps[4].run",
    ]);
  });

  it("caps a file's expression errors like any others", () => {
    const steps = Array.from({ length: 150 }, (_, i) => `      - run: \${{ nope${i} }}\n`).join("");
    const parsed = parse(`on: push\njobs:\n  build:\n    runs-on: x\n    steps:\n${steps}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toHaveLength(101);
      expect(parsed.errors.at(-1)?.code).toBe("too_many_errors");
    }
  });
});

describe("review regressions", () => {
  it.each([
    ["an env name", job("    env:\n      ${{ nope.x }}: v\n"), "jobs.build.env.${{ nope.x }}"],
    [
      "a with name",
      job("", "      - uses: a/b@v1\n        with:\n          ${{ nope.x }}: v\n"),
      "jobs.build.steps[1].with.${{ nope.x }}",
    ],
    [
      "a matrix key",
      job("    strategy:\n      matrix:\n        ${{ secrets.K }}: [a]\n"),
      "jobs.build.strategy.matrix.${{ secrets.K }}",
    ],
    [
      "a key inside a matrix value",
      job("    strategy:\n      matrix:\n        include:\n          - ${{ secrets.K }}: a\n"),
      "jobs.build.strategy.matrix.include[0].${{ secrets.K }}",
    ],
    [
      "a service id",
      job("    services:\n      ${{ nope.x }}:\n        image: x\n"),
      "jobs.build.services.${{ nope.x }}",
    ],
  ])("refuses an expression in %s", (_, text, path) => {
    expect(errorsOf(text)).toEqual([
      expect.objectContaining({ code: "expression_not_allowed", path }),
    ]);
  });

  it("names a refused context once per field, across its expressions", () => {
    expect(errorsOf(job("    name: ${{ env.A }}-${{ env.B }}\n"))).toHaveLength(1);
    expect(errorsOf(job("    name: ${{ always() }}${{ always() }}\n"))).toHaveLength(1);
  });

  it("keeps the earliest errors when the cap is reached, whatever the key order", () => {
    const env = Array.from({ length: 120 }, (_, i) => `  E${i}: \${{ nope${i} }}\n`).join("");
    const text = `on: push\njobs:\n  build:\n    if: nope.x\n    runs-on: x\n    steps:\n      - run: a\nenv:\n${env}`;
    const parsed = parse(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors[0]).toMatchObject({ code: "unknown_context", path: "jobs.build.if" });
      expect(parsed.errors.at(-1)?.code).toBe("too_many_errors");
    }
  });

  it("evaluateJobCondition decides only a job's if", () => {
    const workflow = workflowOf(
      job("    name: ${{ matrix.os }}\n", "", "run-name: ${{ 'matrix.os' }}\n"),
    );
    const fields = expressionFields(workflow);
    const status = { cancelled: false, ancestors: [] } as const;
    const scope = scopeOf({ matrix: { os: "linux" } });
    for (const path of ["run-name", "jobs.build.name"]) {
      const field = fields.find((f) => f.path === path);
      const result = evaluateJobCondition(field, scope, status);
      expect(result.ok ? "ok" : result.error.code, path).toBe("expression_failed");
    }
  });
});

describe("expressionFields", () => {
  const kitchen = `name: x
run-name: \${{ github.ref }}
on: push
env:
  A: \${{ vars.a }}
concurrency:
  group: \${{ github.ref }}
  cancel-in-progress: \${{ github.ref == 'x' }}
jobs:
  a:
    runs-on: x
    steps:
      - run: x
  b:
    name: \${{ matrix.os }}
    needs: a
    if: needs.a.result == 'success'
    runs-on: [x, '\${{ matrix.os }}']
    strategy:
      matrix:
        os: ['\${{ inputs.os }}']
        include:
          - node: \${{ inputs.node }}
      fail-fast: \${{ inputs.ff }}
      max-parallel: \${{ inputs.mp }}
    env:
      B: \${{ secrets.b }}
    defaults:
      run:
        shell: \${{ env.SHELL }}
    timeout-minutes: \${{ inputs.t }}
    continue-on-error: \${{ inputs.c }}
    concurrency:
      group: \${{ matrix.os }}
    outputs:
      o: \${{ steps.s.outputs.o }}
    services:
      db:
        image: \${{ matrix.db }}
        credentials:
          username: \${{ secrets.u }}
          password: \${{ secrets.p }}
        env:
          E: \${{ runner.os }}
    container:
      image: \${{ matrix.image }}
      options: \${{ matrix.options }}
      credentials:
        username: \${{ secrets.u }}
        password: \${{ secrets.p }}
      env:
        E: \${{ job.status }}
    steps:
      - name: \${{ matrix.os }}
        id: s
        if: success()
        env:
          S: \${{ steps.s.outputs.x }}
        continue-on-error: \${{ inputs.c }}
        timeout-minutes: \${{ inputs.t }}
        working-directory: \${{ env.D }}
        run: echo \${{ hashFiles('x') }}
      - uses: a/b@v1
        with:
          w: \${{ github.sha }}
`;

  it("finds a field for every row of the table, and the kitchen sink parses", () => {
    const workflow = workflowOf(kitchen);
    const sites = new Set(expressionFields(workflow).map((f) => f.site));
    expect([...Object.keys(EXPRESSION_SITES)].filter((site) => !sites.has(site as never))).toEqual(
      [],
    );
  });

  it("gives each occurrence, with its path and position", () => {
    const workflow = workflowOf(kitchen);
    const fields = expressionFields(workflow);
    expect(fields.find((f) => f.path === "jobs.b.strategy.matrix.include[0].node")).toMatchObject({
      source: "${{ inputs.node }}",
      feature: "jobs.<job_id>.strategy.matrix.include",
      site: "jobs.<job_id>.strategy",
      at: { line: 23, column: 19 },
    });
    expect(fields.find((f) => f.path === "jobs.b.runs-on[1]")).toMatchObject({
      site: "jobs.<job_id>.runs-on",
    });
    expect(fields.filter((f) => f.source === "${{ matrix.os }}").map((f) => f.path)).toEqual([
      "jobs.b.name",
      "jobs.b.runs-on[1]",
      "jobs.b.concurrency.group",
      "jobs.b.steps[0].name",
    ]);
    expect(fields.find((f) => f.path === "jobs.b.if")).toMatchObject({ kind: "condition" });
  });
});

describe("evaluating a field", () => {
  const workflow = workflowOf(
    job(
      "    name: Build ${{ matrix.os }}\n    strategy:\n      matrix: ${{ fromJSON(needs.a.outputs.m) }}\n    if: needs.a.result == 'success' && inputs.go\n    env:\n      T: ${{ secrets.T }}\n",
      "",
      "run-name: ${{ github.actor }} built ${{ github.ref }}\n",
    ),
  );
  const fields = expressionFields(workflow);
  const field = (path: string) => {
    const found = fields.find((f) => f.path === path);
    if (!found) throw new Error(`no field ${path}`);
    return found;
  };
  const scope = scopeOf({
    github: { actor: "mona", ref: "refs/heads/main" },
    needs: { a: { result: "success", outputs: { m: '{"os":["linux"]}' } } },
    inputs: { go: true },
    matrix: { os: "linux" },
  });

  it("evaluates Fyrden-side fields", () => {
    expect(evaluateField(field("run-name"), scope)).toEqual({
      ok: true,
      value: "mona built refs/heads/main",
    });
    expect(evaluateField(field("jobs.build.name"), scope)).toEqual({
      ok: true,
      value: "Build linux",
    });
    const matrix = evaluateField(field("jobs.build.strategy.matrix"), scope);
    expect(matrix.ok && matrix.value).toMatchObject({ kind: "object" });
  });

  it("refuses a field the runner evaluates, so secrets never pass through here", () => {
    const result = evaluateField(field("jobs.build.env.T"), scope);
    expect(result.ok ? "ok" : result.error).toMatchObject({
      code: "expression_failed",
      path: "jobs.build.env.T",
    });
  });

  it("refuses a condition, which evaluateJobCondition decides", () => {
    expect(evaluateField(field("jobs.build.if"), scope).ok).toBe(false);
  });

  it("refuses a context the field may not use, whatever the caller passes", () => {
    const sneaky = { ...field("jobs.build.name"), source: "${{ secrets.T }}" };
    const result = evaluateField(sneaky, scope);
    expect(result.ok ? "ok" : result.error.code).toBe("context_not_available");
  });

  it("decides a job's if with its status", () => {
    const ok = { cancelled: false, ancestors: ["success"] } as const;
    const failed = { cancelled: false, ancestors: ["failure"] } as const;
    expect(evaluateJobCondition(field("jobs.build.if"), scope, ok)).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateJobCondition(field("jobs.build.if"), scope, failed)).toEqual({
      ok: true,
      value: false,
    });
    expect(evaluateJobCondition(undefined, scope, ok)).toEqual({ ok: true, value: true });
    expect(evaluateJobCondition(undefined, scope, failed)).toEqual({ ok: true, value: false });
  });

  it("refuses a step condition, which the runner decides", () => {
    const steps = workflowOf(job("", "        if: success()\n"));
    const stepIf = expressionFields(steps).find((f) => f.path === "jobs.build.steps[0].if");
    const result = evaluateJobCondition(stepIf, scope, { cancelled: false, ancestors: [] });
    expect(result.ok ? "ok" : result.error.code).toBe("expression_failed");
  });

  it("places an error in a job condition's evaluation at the condition", () => {
    const failing = workflowOf(job("    if: fromJSON(inputs.j)\n"));
    const jobIf = expressionFields(failing).find((f) => f.path === "jobs.build.if");
    const result = evaluateJobCondition(jobIf, scopeOf({ inputs: { j: "{" } }), {
      cancelled: false,
      ancestors: [],
    });
    expect(result.ok ? "ok" : result.error).toMatchObject({
      code: "expression_failed",
      path: "jobs.build.if",
    });
  });

  it("checks a field's syntax again before evaluating it", () => {
    const broken = { ...field("jobs.build.name"), source: "${{ 1 = 1 }}" };
    const result = evaluateField(broken, scope);
    expect(result.ok ? "ok" : result.error.code).toBe("expression_syntax");
  });

  it("places evaluation errors at the field", () => {
    const bad = scopeOf({ ...{ needs: { a: { outputs: { m: "{" } } } } });
    const result = evaluateField(field("jobs.build.strategy.matrix"), bad);
    expect(result.ok ? "ok" : result.error).toMatchObject({
      code: "expression_failed",
      path: "jobs.build.strategy.matrix",
      line: 8,
    });
    expect(exprArray([]).kind).toBe("array");
  });
});
