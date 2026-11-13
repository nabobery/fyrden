// Real workflows: Fyrden's own CI and nightly workflows, copied unchanged
// from the repository at d51c1b7 (fixtures/fyrden-*.yml). The CI workflow
// uses one key Fyrden does not support (a deployment environment) and must
// be refused for exactly that; without it, both parse.
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../../src/ci/parse.js";
import ci from "./fixtures/fyrden-ci.yml?raw";
import nightly from "./fixtures/fyrden-nightly.yml?raw";

const encoder = new TextEncoder();
const parse = (path: string, text: string) => parseWorkflow(path, encoder.encode(text));

describe("Fyrden's own workflows", () => {
  it("refuses the CI workflow for its deployment environment alone", () => {
    const parsed = parse(".github/workflows/ci.yml", ci);
    expect(
      parsed.ok ||
        parsed.errors.map(({ code, path, line, column }) => ({ code, path, line, column })),
    ).toEqual([{ code: "unsupported_key", path: "jobs.deploy.environment", line: 518, column: 5 }]);
  });

  it("parses the CI workflow once that key is removed", () => {
    const lines = ci.split("\n");
    expect(lines[517]).toBe(`    environment: \${{ matrix.target }}`);
    const parsed = parse(
      ".github/workflows/ci.yml",
      [...lines.slice(0, 517), ...lines.slice(518)].join("\n"),
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors, null, 2));
    const { workflow } = parsed;
    expect(workflow.on.map((t) => t.event)).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(workflow.permissions).toMatchObject({
      kind: "scopes",
      scopes: [{ scope: "contents", access: "read" }],
    });
    expect(workflow.concurrency?.cancelInProgress).toMatchObject({ kind: "expression" });
    expect(workflow.jobs.length).toBeGreaterThan(10);
    const deploy = workflow.jobs.find((j) => j.id.value === "deploy");
    expect(deploy?.strategy?.matrix).toMatchObject({ kind: "literal", value: { dimensions: [] } });
    expect(deploy?.concurrency?.group.value).toBe(`deploy-\${{ matrix.target }}`);
  });

  it("parses the nightly workflow", () => {
    const parsed = parse(".github/workflows/nightly.yml", nightly);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors, null, 2));
    expect(parsed.workflow.on.map((t) => t.event)).toContain("schedule");
  });
});
