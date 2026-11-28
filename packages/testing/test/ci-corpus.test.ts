import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  expandJob,
  invariantPayloadBytes,
  MAX_RUN_JOBS,
  newWorkBudget,
  parseWorkflow,
  planWorkflow,
  WORKFLOW_FEATURES,
  type WorkflowFeature,
} from "@fyrden/domain/ci";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  CAPACITY_WORKLOADS,
  CASES,
  type CorpusCase,
  capacitySource,
  ELSEWHERE,
  MAX_RUNNER_TASKS,
  type Proof,
  rowKey,
  workflowSource,
} from "../src/ci-corpus/index.js";

const root = resolve(import.meta.dirname, "../../..");
const corpus = resolve(import.meta.dirname, "../src/ci-corpus");
const encoder = new TextEncoder();
const features = WORKFLOW_FEATURES as readonly WorkflowFeature[];
const supported = features.filter((f) => f.status === "supported");
const rows = new Map(features.map((f) => [rowKey(f), f]));

const parse = (c: CorpusCase) =>
  parseWorkflow(`.github/workflows/${c.id}.yml`, encoder.encode(workflowSource(c.id)));

function workflowOf(c: CorpusCase) {
  const parsed = parse(c);
  if (!parsed.ok) throw new Error(`${c.id}: ${JSON.stringify(parsed.errors, null, 2)}`);
  return parsed.workflow;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Node = unknown;

const asMap = (node: Node, key: string): Record<string, Node> | undefined => {
  if (key === "on" && typeof node === "string") return { [node]: null };
  if (key === "on" && Array.isArray(node)) return Object.fromEntries(node.map((e) => [e, null]));
  return node !== null && typeof node === "object" && !Array.isArray(node)
    ? (node as Record<string, Node>)
    : undefined;
};

function nodesAt(root: Node, feature: string): Node[] {
  let nodes: { node: Node; key: string }[] = [{ node: root, key: "" }];
  for (const segment of feature.split(".")) {
    const name = segment.replace("[*]", "");
    const next: { node: Node; key: string }[] = [];
    for (const { node, key } of nodes) {
      const map = asMap(node, key);
      if (!map) continue;
      const children = name.startsWith("<")
        ? Object.entries(map)
        : Object.hasOwn(map, name)
          ? [[name, map[name]] as const]
          : [];
      for (const [k, child] of children) {
        if (segment.endsWith("[*]")) {
          if (Array.isArray(child)) for (const item of child) next.push({ node: item, key: k });
        } else next.push({ node: child, key: k });
      }
    }
    nodes = next;
  }
  return nodes.map((n) => n.node);
}

function holds(node: Node, value: string): boolean {
  if (Array.isArray(node)) return node.some((e) => String(e) === value);
  if (node !== null && typeof node === "object") return Object.hasOwn(node, value);
  return String(node) === value;
}

function mentions(c: CorpusCase, proof: Proof): boolean {
  const text = workflowSource(c.id);
  const value = "value" in proof ? proof.value : undefined;
  if (proof.feature === "expression.function") return text.includes(`${value}(`);
  if (proof.feature === "expression.context")
    return new RegExp(`(^|[^\\w.-])${escapeRegExp(value ?? "")}[.)]`, "m").test(text);
  if (proof.feature === "yaml.anchors") return /&\w+/.test(text) && /\*\w+/.test(text);
  const nodes = nodesAt(parseYaml(text), proof.feature);
  return value === undefined ? nodes.length > 0 : nodes.some((n) => holds(n, value));
}

const runnerCases = CASES.filter((c) => c.tiers.includes("runner"));
const parseCases = CASES.filter((c) => c.tiers.includes("parse"));

describe("the corpus's shape", () => {
  it("names each case after its workflow and expected files, with nothing left over", () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const files = (dir: string, ext: string) =>
      readdirSync(resolve(corpus, dir))
        .filter((f) => f.endsWith(ext))
        .map((f) => f.slice(0, -ext.length))
        .sort();
    expect(files("workflows", ".yml")).toEqual([...ids].sort());
    expect(files("expected", ".ts")).toEqual([...ids].sort());
    for (const c of CASES)
      expect(workflowSource(c.id), c.id).toMatch(new RegExp(`^name: ${c.id}\\n`));
  });

  it("gives every runner case its tasks, and no other case any", () => {
    for (const c of CASES) expect(c.runner !== undefined, c.id).toBe(c.tiers.includes("runner"));
    for (const c of runnerCases) expect(c.expect.run, c.id).toBeDefined();
  });

  it(`keeps the runner tier within ${MAX_RUNNER_TASKS} tasks a runner version`, () => {
    const tasks = runnerCases.reduce((sum, c) => sum + (c.runner?.tasks ?? 0), 0);
    process.stdout.write(`corpus: ${CASES.length} cases, ${tasks} runner tasks\n`);
    expect(tasks).toBeLessThanOrEqual(MAX_RUNNER_TASKS);
  });

  it("uses plain names: no internal ids in case ids, files or workflow text", () => {
    const internal =
      /\b(M[0-9]+(\.[0-9]+)?|ADR(-[0-9]+)?|SP[0-9]+|U[0-9]{2,}|D-[0-9]+|[Mm]ilestones?|[Ss]pikes?)\b/;
    for (const c of CASES) {
      expect(c.id, c.id).not.toMatch(internal);
      expect(workflowSource(c.id), c.id).not.toMatch(internal);
      for (const [path, content] of Object.entries(c.setup?.files ?? {}))
        expect(`${path}\n${content}`, `${c.id}: ${path}`).not.toMatch(internal);
    }
    for (const id of CAPACITY_WORKLOADS) expect(capacitySource(id), id).not.toMatch(internal);
  });
});

describe("the capacity workloads", () => {
  it("are every file in capacity/, each parsing to one job named by its file", () => {
    const files = readdirSync(resolve(corpus, "capacity"))
      .filter((f) => f.endsWith(".yml"))
      .map((f) => f.slice(0, -".yml".length))
      .sort();
    expect(files).toEqual([...CAPACITY_WORKLOADS].sort());
    for (const id of CAPACITY_WORKLOADS) {
      const source = capacitySource(id);
      expect(source, id).toMatch(new RegExp(`^name: ${id}\\n`));
      const parsed = parseWorkflow(`.github/workflows/${id}.yml`, encoder.encode(source));
      expect(parsed.ok ? parsed.workflow.jobs.length : parsed.errors, id).toBe(1);
    }
  });
});

describe.each(parseCases.map((c) => [c.id, c] as const))("case %s", (_, c) => {
  it("parses to its expected outcome", () => {
    const parsed = parse(c);
    if (c.expect.parse === "ok") {
      expect(parsed.ok ? [] : parsed.errors).toEqual([]);
      return;
    }
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((e) => ({ code: e.code, feature: e.feature }))).toEqual(
      c.expect.parse.errors,
    );
  });

  it.runIf(c.expect.plan !== undefined)("plans its jobs and matrix instances", () => {
    const workflow = workflowOf(c);
    const planned = planWorkflow(workflow);
    if (!planned.ok) throw new Error(JSON.stringify(planned.errors, null, 2));
    expect([...planned.plan.jobs.keys()]).toEqual(c.expect.plan?.jobs);
    for (const [jobId, expected] of Object.entries(c.expect.plan?.instances ?? {})) {
      const result = expandJob(
        workflow,
        jobId,
        {},
        {
          remainingRunJobs: MAX_RUN_JOBS,
          invariantPayloadBytes: invariantPayloadBytes(workflow, jobId),
          budget: newWorkBudget(),
        },
      );
      if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
      expect(
        result.job.instances.map((i) => ({
          index: i.index,
          name: i.name,
          matrix: Object.fromEntries(i.matrix ?? []),
        })),
      ).toEqual(expected.map((e, index) => ({ index, ...e })));
    }
  });
});

describe("coverage of the support matrix", () => {
  it("names only supported rows, each visibly used by its case's workflow", () => {
    for (const c of CASES) {
      for (const proof of c.proves) {
        expect(rows.get(rowKey(proof))?.status, `${c.id}: ${rowKey(proof)}`).toBe("supported");
        expect(mentions(c, proof), `${c.id} does not use ${rowKey(proof)}`).toBe(true);
      }
    }
    for (const e of ELSEWHERE)
      expect(rows.get(rowKey(e.ref))?.status, rowKey(e.ref)).toBe("supported");
  });

  it("lists every test it names among its Turbo inputs, so a deleted one cannot replay a cached pass", () => {
    const turbo = readFileSync(resolve(import.meta.dirname, "../turbo.json"), "utf8");
    for (const e of ELSEWHERE)
      for (const test of e.tests) expect(turbo, test).toContain(`"$TURBO_ROOT$/${test}"`);
  });

  it("names only test files that exist", () => {
    for (const e of ELSEWHERE)
      for (const test of e.tests) expect(existsSync(resolve(root, test)), test).toBe(true);
  });

  it("proves every supported row, by exact feature and value", () => {
    const proven = new Set([
      ...CASES.flatMap((c) => c.proves.map(rowKey)),
      ...ELSEWHERE.map((e) => rowKey(e.ref)),
    ]);
    process.stdout.write(`corpus: ${supported.length} supported rows\n`);
    expect(supported.map(rowKey).filter((key) => !proven.has(key))).toEqual([]);
  });
});
