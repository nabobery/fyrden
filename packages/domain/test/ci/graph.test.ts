// The job graph a workflow's `needs` make: the order jobs become ready in,
// each job's direct needs, dependents and ancestors, and the named error for
// a `needs` that names no job, a cycle, or two job ids that differ only in case.
import { describe, expect, it } from "vitest";
import { buildJobGraph, type JobGraph } from "../../src/ci/graph.js";
import { parseWorkflow } from "../../src/ci/parse.js";
import {
  MAX_WORKFLOW_ERRORS,
  type Workflow,
  type WorkflowError,
} from "../../src/ci/workflow-schema.js";

const encoder = new TextEncoder();

/** A workflow whose jobs are `name: needs-list` lines, each with one step. */
function workflow(jobs: Record<string, string[]>): Workflow {
  const lines = ["on: push", "jobs:"];
  for (const [id, needs] of Object.entries(jobs)) {
    lines.push(`  ${id}:`, "    runs-on: ubuntu-latest");
    if (needs.length > 0) lines.push(`    needs: [${needs.join(", ")}]`);
    lines.push("    steps:", "      - run: echo hi");
  }
  const parsed = parseWorkflow("w.yml", encoder.encode(`${lines.join("\n")}\n`));
  if (!parsed.ok) throw new Error(`errors: ${JSON.stringify(parsed.errors, null, 2)}`);
  return parsed.workflow;
}

function graphOf(jobs: Record<string, string[]>): JobGraph {
  const built = buildJobGraph(workflow(jobs).jobs);
  if (!built.ok) throw new Error(`errors: ${JSON.stringify(built.errors, null, 2)}`);
  return built.graph;
}

function errorsOf(jobs: Record<string, string[]>): WorkflowError[] {
  const built = buildJobGraph(workflow(jobs).jobs);
  if (built.ok) throw new Error("built without errors");
  return [...built.errors];
}

const ids = (graph: JobGraph) => graph.order.map((job) => job.id);

describe("buildJobGraph: order", () => {
  it("keeps source order for jobs without needs", () => {
    expect(ids(graphOf({ lint: [], test: [], build: [] }))).toEqual(["lint", "test", "build"]);
  });

  it("puts every job after the jobs it needs, ties in source order", () => {
    const graph = graphOf({ deploy: ["build", "test"], test: [], build: ["lint"], lint: [] });
    expect(ids(graph)).toEqual(["test", "lint", "build", "deploy"]);
  });

  it("breaks ties by source order whenever several jobs become ready together", () => {
    const graph = graphOf({ c: ["a"], b: ["a"], a: [], d: [] });
    expect(ids(graph)).toEqual(["a", "c", "b", "d"]);
  });

  it("gives each job its index, direct needs as written and dependents in source order", () => {
    const graph = graphOf({ a: [], b: ["a"], c: ["b", "a"] });
    expect(graph.job("a")).toEqual({ id: "a", index: 0, needs: [], dependents: ["b", "c"] });
    expect(graph.job("c")).toEqual({ id: "c", index: 2, needs: ["b", "a"], dependents: [] });
    expect(graph.job("missing")).toBeUndefined();
  });
});

describe("buildJobGraph: ancestors", () => {
  it("lists every job a job transitively needs, in source order", () => {
    const graph = graphOf({ d: ["c"], a: [], c: ["b"], b: ["a"], e: [] });
    expect(graph.ancestors("d")).toEqual(["a", "c", "b"]);
    expect(graph.ancestors("b")).toEqual(["a"]);
    expect(graph.ancestors("e")).toEqual([]);
  });

  it("counts a job reached by two paths once", () => {
    const graph = graphOf({ a: [], b: ["a"], c: ["a"], d: ["b", "c"] });
    expect(graph.ancestors("d")).toEqual(["a", "b", "c"]);
  });

  it("refuses an id that is not a job", () => {
    const graph = graphOf({ a: [] });
    expect(() => graph.ancestors("A")).toThrow(/no job `A`/);
  });
});

describe("buildJobGraph: a need that names no job", () => {
  it("is unknown_job at the entry, naming the id", () => {
    const errors = errorsOf({ build: [], test: ["build", "lint"] });
    expect(errors).toEqual([
      {
        code: "unknown_job",
        feature: "jobs.<job_id>.needs",
        path: "jobs.test.needs[1]",
        line: 9,
        column: 20,
        message: "`jobs.test.needs` names `lint`, which is not a job in this workflow.",
      },
    ]);
  });

  it("names the job whose id differs only in case", () => {
    const [error] = errorsOf({ Build: [], test: ["build"] });
    expect(error?.message).toBe(
      "`jobs.test.needs` names `build`, which is not a job in this workflow; did you mean `Build`? Job ids match exactly.",
    );
  });

  it("reports every unknown need in one pass", () => {
    const errors = errorsOf({ a: ["x"], b: ["y", "z"] });
    expect(errors.map((e) => e.path)).toEqual([
      "jobs.a.needs[0]",
      "jobs.b.needs[0]",
      "jobs.b.needs[1]",
    ]);
  });

  it("stops at the error limit with a too_many_errors entry last", () => {
    const needs = Array.from({ length: MAX_WORKFLOW_ERRORS + 5 }, (_, i) => `missing${i}`);
    const errors = errorsOf({ a: needs });
    expect(errors).toHaveLength(MAX_WORKFLOW_ERRORS + 1);
    expect(errors.at(-1)?.code).toBe("too_many_errors");
    expect(errors.slice(0, -1).every((e) => e.code === "unknown_job")).toBe(true);
  });
});

describe("buildJobGraph: error limits", () => {
  it("keeps the first errors in file order, whatever kind is found first", () => {
    const late = Array.from({ length: MAX_WORKFLOW_ERRORS + 5 }, (_, i) => `missing${i}`);
    const errors = errorsOf({ early: ["early"], late });
    expect(errors).toHaveLength(MAX_WORKFLOW_ERRORS + 1);
    expect(errors[0]).toMatchObject({ code: "dependency_cycle", path: "jobs.early.needs[0]" });
    expect(errors.at(-2)?.path).toBe(`jobs.late.needs[${MAX_WORKFLOW_ERRORS - 2}]`);
    expect(errors.at(-1)?.code).toBe("too_many_errors");
  });

  it("cuts paths and messages that quote a long job id", () => {
    const long = `j${"x".repeat(1_000)}`;
    const Long = `J${"x".repeat(1_000)}`;
    const errors = errorsOf({ [long]: [long, "nope", Long], [Long]: [] });
    expect(errors.map((e) => e.code).sort()).toEqual([
      "dependency_cycle",
      "duplicate_key",
      "unknown_job",
    ]);
    for (const error of errors) {
      expect(Array.from(error.path).length).toBeLessThanOrEqual(201);
      expect(Array.from(error.feature).length).toBeLessThanOrEqual(201);
      expect(Array.from(error.message).length).toBeLessThanOrEqual(401);
    }
  });
});

describe("buildJobGraph: cycles", () => {
  it("reports a job that needs itself", () => {
    const errors = errorsOf({ a: ["a"] });
    expect(errors).toEqual([
      {
        code: "dependency_cycle",
        feature: "jobs.<job_id>.needs",
        path: "jobs.a.needs[0]",
        line: 5,
        column: 13,
        message: "Jobs need each other in a cycle: `a` -> `a`.",
      },
    ]);
  });

  it("reports a cycle at its first job in source order, with a real chain of needs", () => {
    const errors = errorsOf({ setup: [], b: ["c"], a: ["setup", "b"], c: ["a"] });
    expect(errors).toEqual([
      expect.objectContaining({
        code: "dependency_cycle",
        path: "jobs.b.needs[0]",
        message: "Jobs need each other in a cycle: `b` -> `c` -> `a` -> `b`.",
      }),
    ]);
  });

  it("gives one error per cyclic component, naming the component's other jobs", () => {
    // a -> b -> a and b -> c -> d -> b: one component of four jobs.
    // e -> f -> e: another.
    const errors = errorsOf({ a: ["b"], b: ["a", "c"], c: ["d"], d: ["b"], e: ["f"], f: ["e"] });
    expect(errors.map(({ code, path, message }) => ({ code, path, message }))).toEqual([
      {
        code: "dependency_cycle",
        path: "jobs.a.needs[0]",
        message:
          "Jobs need each other in a cycle: `a` -> `b` -> `a`. `c` and `d` are in cycles with them too.",
      },
      {
        code: "dependency_cycle",
        path: "jobs.e.needs[0]",
        message: "Jobs need each other in a cycle: `e` -> `f` -> `e`.",
      },
    ]);
  });

  it("does not count a job that only needs a cycle as part of it", () => {
    const errors = errorsOf({ a: ["b"], b: ["a"], c: ["a"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("Jobs need each other in a cycle: `a` -> `b` -> `a`.");
  });

  it("reports cycles and unknown needs together, in file order", () => {
    const errors = errorsOf({ a: ["b"], b: ["a", "nope"] });
    expect(errors.map((e) => e.code)).toEqual(["dependency_cycle", "unknown_job"]);
  });

  it("handles a chain far longer than any recursion limit", () => {
    // Built directly: 20,000 jobs is beyond MAX_JOBS, but the graph code must not recurse.
    const n = 20_000;
    const at = { line: 1, column: 1 };
    const jobs = Array.from({ length: n }, (_, i) => ({
      id: { value: `j${i}`, at },
      needs: [{ value: `j${(i + 1) % n}`, at }],
    }));
    const built = buildJobGraph(jobs);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors).toHaveLength(1);
    expect(built.errors[0]?.code).toBe("dependency_cycle");
  });
});

describe("buildJobGraph: job ids that differ only in case", () => {
  it("are duplicate_key at the second", () => {
    const errors = errorsOf({ build: [], Build: [] });
    expect(errors).toEqual([
      {
        code: "duplicate_key",
        feature: "jobs.<job_id>",
        path: "jobs.Build",
        line: 7,
        column: 3,
        message:
          "Job ids `build` and `Build` differ only in case; expressions read `needs.<job_id>` ignoring case, so they would be ambiguous.",
      },
    ]);
  });
});
