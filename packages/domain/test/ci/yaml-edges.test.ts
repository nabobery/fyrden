// YAML at its edges, as the workflow parser takes it: anchors and the
// bounds on what they expand to, merge keys, tags, directives, duplicate
// keys, encodings, positions in code points, and keys that are prototype
// names. Bounds are asserted as outcomes and work, never as time.
import { describe, expect, it } from "vitest";
import { parseWorkflow, YAML_OPTIONS } from "../../src/ci/parse.js";
import {
  MAX_WORKFLOW_ERRORS,
  MAX_WORKFLOW_NODES,
  MAX_YAML_DEPTH,
} from "../../src/ci/workflow-schema.js";

const encoder = new TextEncoder();

/**
 * A limit for tests whose input is deliberately at a bound (the node budget,
 * the stack): generous because CI runs every package's suite at once on one
 * runner. What they assert is the outcome and the work, never the time.
 */
const LARGE_INPUT = 60_000;
const parse = (text: string) => parseWorkflow("w.yml", encoder.encode(text));
const job = (jobLines = "", stepLines = "") =>
  `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n${jobLines}    steps:\n      - run: echo hi\n${stepLines}`;
const codes = (text: string) => {
  const parsed = parse(text);
  return parsed.ok ? [] : parsed.errors.map((e) => e.code);
};

describe("anchors and aliases", () => {
  it("resolves an alias to its anchor's value", () => {
    const parsed = parse(`env: &e\n  A: b\n${job("    env: *e\n")}`);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(parsed.workflow.jobs[0]?.env.map(([k, v]) => [k.value, v.value])).toEqual([["A", "b"]]);
  });

  it("uses the most recent anchor of a name, as YAML does", () => {
    const parsed = parse(`env:\n  A: &x one\n  B: &x two\n  C: *x\n${job()}`);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(parsed.workflow.env.map(([, v]) => v.value)).toEqual(["one", "two", "two"]);
  });

  it("refuses an alias with no anchor before it, missing or later", () => {
    expect(codes(`env:\n  A: *missing\n${job()}`)).toEqual(["yaml_syntax"]);
    expect(codes(`env:\n  A: *later\n  B: &later x\n${job()}`)).toEqual(["yaml_syntax"]);
  });

  it("refuses an alias inside the value it names", () => {
    const parsed = parse(job("    strategy:\n      matrix:\n        a: &a [x, *a]\n"));
    expect(parsed.ok || parsed.errors.map((e) => [e.code, e.path])).toEqual([
      ["yaml_too_complex", "jobs.build.strategy.matrix.a[1]"],
    ]);
  });

  it(
    "stops an alias bomb within the node budget",
    () => {
      // Each dimension doubles the one before: 2^21 values if expanded.
      let dimensions = "        x0: &a0 [v, v]\n";
      for (let i = 1; i <= 20; i++)
        dimensions += `        x${i}: &a${i} [*a${i - 1}, *a${i - 1}]\n`;
      const parsed = parse(job(`    strategy:\n      matrix:\n${dimensions}`));
      expect(parsed.ok || parsed.errors.map((e) => e.code)).toEqual(["yaml_too_complex"]);
    },
    LARGE_INPUT,
  );

  it("refuses nesting deeper than the bound before walking it", () => {
    const deep = `${"[".repeat(MAX_YAML_DEPTH + 1)}${"]".repeat(MAX_YAML_DEPTH + 1)}`;
    expect(codes(job(`    strategy:\n      matrix:\n        n: ${deep}\n`))).toEqual([
      "yaml_too_complex",
    ]);
    const fits = `${"[".repeat(MAX_YAML_DEPTH - 8)}1${"]".repeat(MAX_YAML_DEPTH - 8)}`;
    expect(codes(job(`    strategy:\n      matrix:\n        n: ${fits}\n`))).toEqual([]);
  });

  it("refuses nesting that aliases build deeper than the bound, though the text is shallow", () => {
    const open = "[".repeat(30);
    const close = "]".repeat(30);
    const text = job(
      `    strategy:\n      matrix:\n        a: &a ${open}x${close}\n        b: ${open}*a${close}\n`,
    );
    expect(codes(text)).toEqual(["yaml_too_complex"]);
  });

  it(
    "stops a tree too large or deep in the anchor pass, before the walk",
    () => {
      const wide = Array.from({ length: MAX_WORKFLOW_NODES / 2 + 1 }, (_, i) => `k${i}: 1`).join(
        ", ",
      );
      expect(codes(`env: {${wide}}\n${job()}`)).toEqual(["yaml_too_complex"]);
      const nested = `${"[".repeat(400)}{${Array.from({ length: 2_000 }, (_, i) => `k${i}: v`).join(", ")}}${"]".repeat(400)}`;
      expect(codes(`env: ${nested}\n${job()}`)).toEqual(["yaml_too_complex"]);
    },
    LARGE_INPUT,
  );

  it(
    "turns nesting too deep for the stack into an error, never a throw",
    () => {
      const depth = 100_000;
      // parseWorkflow never throws (codes() would fail the test if it did).
      // The library reports the overflow (yaml_syntax); a runtime with a deeper stack would reach
      // the parser's own depth bound instead (yaml_too_complex). Either way, one error.
      const found = codes(`${"[".repeat(depth)}${"]".repeat(depth)}`);
      expect(found).toHaveLength(1);
      expect(["yaml_syntax", "yaml_too_complex"]).toContain(found[0]);
    },
    LARGE_INPUT,
  );
});

describe("keys", () => {
  it("refuses a duplicate key, at the second occurrence", () => {
    for (const text of [
      `name: a\nname: b\n${job()}`,
      job("    name: a\n    name: b\n"),
      job().replace("on: push", "on:\n  push:\n  push:"),
    ]) {
      const parsed = parse(text);
      expect(parsed.ok || parsed.errors.map((e) => e.code)).toEqual(["duplicate_key"]);
    }
    const parsed = parse(`name: a\nname: b\n${job()}`);
    expect(parsed.ok || parsed.errors[0]).toMatchObject({ path: "name", line: 2, column: 1 });
  });

  it(
    "checks a wide mapping's keys in linear work: no library check, one lookup per key",
    () => {
      expect(YAML_OPTIONS.uniqueKeys).toBe(false);
      const wide = Array.from({ length: 20_000 }, (_, i) => `K${i}: v`).join("\n  ");
      const parsed = parse(`env:\n  ${wide}\n${job()}`);
      expect(parsed.ok || parsed.errors).toBe(true);
    },
    LARGE_INPUT,
  );

  it("refuses a merge key by name", () => {
    const parsed = parse(`env: &e {A: b}\n${job("    env:\n      <<: *e\n")}`);
    expect(parsed.ok || parsed.errors.map((e) => [e.code, e.feature, e.path])).toEqual([
      ["unsupported_key", "yaml.merge-keys", "jobs.build.env.<<"],
    ]);
  });

  it("refuses keys that are not plain strings", () => {
    expect(codes(job("    env:\n      1: a\n"))).toEqual(["invalid_type"]);
    expect(codes(job("    env:\n      ? [a]\n      : b\n"))).toEqual(["invalid_type"]);
  });

  it("keeps __proto__, constructor and prototype as data", () => {
    const parsed = parse(
      job(
        "    env:\n      __proto__: a\n      constructor: b\n    strategy:\n      matrix:\n        __proto__: [x]\n        include:\n          - prototype: y\n",
        "",
      ).replace(
        "      - run: echo hi\n",
        "      - uses: a/b@v1\n        with:\n          __proto__: c\n",
      ),
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const build = parsed.workflow.jobs[0];
    expect(build?.env.map(([k]) => k.value)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(build?.env)).toBe(Array.prototype);
    expect(build?.strategy?.matrix).toMatchObject({
      value: { dimensions: [{ name: { value: "__proto__" } }] },
    });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("YAML version, directives and tags", () => {
  it("reads yes, off and on as strings", () => {
    const parsed = parse(`env:\n  A: yes\n  B: off\n${job()}`);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(parsed.workflow.env.map(([, v]) => v.value)).toEqual(["yes", "off"]);
  });

  it("accepts %YAML 1.2 and refuses every other directive, each by name", () => {
    expect(codes(`%YAML 1.2\n---\n${job()}`)).toEqual([]);
    for (const directives of ["%YAML 1.1", "%YAML 1.3", "%TAG !! tag:yaml.org,2002:", "%FOO bar"]) {
      const parsed = parse(`${directives}\n---\n${job()}`);
      expect(parsed.ok || parsed.errors.map((e) => [e.code, e.feature, e.line])).toEqual([
        ["unsupported_value", "yaml.directives", 1],
      ]);
    }
    const both = parse(`%YAML 1.1\n%YAML 1.2\n---\n${job()}`);
    expect(both.ok || both.errors.map((e) => [e.code, e.line])).toEqual([["unsupported_value", 1]]);
  });

  it("refuses each tag once, by name, whether the library resolves it or not", () => {
    for (const tag of [
      "!!omap [{k: x}]",
      "!!set {A: null}",
      "!!pairs [{k: x}]",
      "!!str x",
      "!custom x",
    ]) {
      const parsed = parse(
        job("    strategy:\n      matrix:\n", "").replace(
          "      matrix:\n",
          `      matrix:\n        n: [${tag}]\n`,
        ),
      );
      expect(parsed.ok || parsed.errors.map((e) => [e.code, e.feature])).toEqual([
        ["unsupported_value", "yaml.tags"],
      ]);
    }
    expect(YAML_OPTIONS.resolveKnownTags).toBe(false);
  });

  it("refuses a second document", () => {
    const parsed = parse(`${job()}---\nname: x\n`);
    expect(parsed.ok || parsed.errors.map((e) => [e.code, e.line])).toEqual([
      ["multiple_documents", 7],
    ]);
  });

  it("refuses YAML syntax errors with their position, and does not walk the tree", () => {
    const parsed = parse("on: push\njobs:\n\tbuild: {}\n");
    expect(parsed.ok || parsed.errors.every((e) => e.code === "yaml_syntax")).toBe(true);
    expect(parsed.ok || parsed.errors[0]?.line).toBe(3);
  });

  it("does not format diagnostics, and reports a line of many tagged items in bounded errors", () => {
    expect(YAML_OPTIONS.prettyErrors).toBe(false);
    const tagged = `[${Array(10_000).fill("!x a").join(",")}]`;
    const parsed = parse(job().replace("runs-on: ubuntu-latest", `runs-on: ${tagged}`));
    if (parsed.ok) throw new Error("parsed");
    // Each item is refused in turn until the cap, then one entry says there were more.
    expect(parsed.errors).toHaveLength(MAX_WORKFLOW_ERRORS + 1);
    expect(parsed.errors.slice(0, -1).every((e) => e.feature === "yaml.tags")).toBe(true);
    expect(parsed.errors.at(-1)?.code).toBe("too_many_errors");
  });
});

describe("encodings and positions", () => {
  it("accepts a byte order mark and CRLF, positions unchanged", () => {
    const parsed = parse(`﻿${job("    environment: x\n")}`.replaceAll("\n", "\r\n"));
    expect(parsed.ok || parsed.errors.map((e) => [e.code, e.line, e.column])).toEqual([
      ["unsupported_key", 5, 5],
    ]);
    const first = parse(`﻿foo: 1\n${job()}`);
    expect(first.ok || first.errors.map((e) => [e.line, e.column])).toEqual([[1, 1]]);
  });

  it("counts columns in code points after an astral character", () => {
    const parsed = parse(`name: "\u{1F600}" \nenv: {A: b, \u{1F600}: c, x: {}}\n${job()}`);
    expect(parsed.ok || parsed.errors.map((e) => [e.code, e.line, e.column])).toEqual([
      ["invalid_type", 2, 22],
    ]);
  });
});
