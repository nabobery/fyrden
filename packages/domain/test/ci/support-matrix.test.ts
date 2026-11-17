// The support matrix as the parser and the compatibility page use it: every
// entry once, every unsupported feature failing with exactly its own named
// error, and every supported key accepted.
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../../src/ci/parse.js";
import { featureOf, WORKFLOW_FEATURES, type WorkflowFeature } from "../../src/ci/support-matrix.js";

const encoder = new TextEncoder();
const parse = (text: string) => parseWorkflow(".github/workflows/x.yml", encoder.encode(text));
const features = WORKFLOW_FEATURES as readonly WorkflowFeature[];
const label = (f: WorkflowFeature) =>
  f.value === undefined ? f.feature : `${f.feature} = ${f.value}`;

describe("the support matrix", () => {
  it("lists each feature, and each value of a feature, once", () => {
    const labels = features.map(label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("finds every entry by its feature and value", () => {
    for (const f of features) expect(featureOf(f.feature, f.value)).toBe(f);
    expect(featureOf("jobs.<job_id>.no-such-key")).toBeUndefined();
  });

  it("names a reason and an example for every unsupported entry", () => {
    for (const f of features) {
      if (f.status === "unsupported") {
        expect(f.reason, label(f)).toMatch(/\.$/);
        expect(f.example.length, label(f)).toBeGreaterThan(0);
      }
    }
  });

  it("covers GitHub's 33 events, five of them supported", () => {
    const events = features.filter((f) => /^on\.[a-z_]+$/.test(f.feature) && f.value === undefined);
    expect(events).toHaveLength(33);
    expect(events.filter((f) => f.status === "supported").map((f) => f.feature)).toEqual([
      "on.push",
      "on.pull_request",
      "on.pull_request_target",
      "on.schedule",
      "on.workflow_dispatch",
    ]);
  });

  describe.each(
    features.flatMap((f) => (f.status === "unsupported" ? [[label(f), f] as const] : [])),
  )("unsupported: %s", (_, f) => {
    it("fails with exactly one error naming it", () => {
      if (f.status !== "unsupported") throw new Error("not unsupported");
      const parsed = parse(f.example);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors).toHaveLength(1);
      const [error] = parsed.errors;
      expect(error?.code).toMatch(/^unsupported_(key|value)$/);
      expect(error?.feature).toBe(f.feature);
      expect(error?.message).toContain(f.reason);
      expect(error?.line).toBeGreaterThan(0);
    });
  });
});
