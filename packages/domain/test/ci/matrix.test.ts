// Matrix expansion: GitHub's documented order, include and exclude rules on
// a literal matrix, keys ignoring case, the caps, and the named error for
// each way a matrix cannot expand.
import { describe, expect, it } from "vitest";
import {
  expandMatrix,
  literalMatrixSpec,
  MAX_MATRIX_COMBINATIONS,
  MAX_MATRIX_ENTRIES,
  type MatrixCombination,
  type MatrixSpec,
  type MatrixValue,
} from "../../src/ci/matrix.js";
import { parseWorkflow } from "../../src/ci/parse.js";
import type { WorkflowError } from "../../src/ci/workflow-schema.js";

const encoder = new TextEncoder();

/** The literal matrix of job `build`, whose `matrix:` body is `lines` (indented 6). */
function literal(lines: string) {
  const text = `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n${lines}    steps:\n      - run: echo hi\n`;
  const parsed = parseWorkflow("w.yml", encoder.encode(text));
  if (!parsed.ok) throw new Error(`errors: ${JSON.stringify(parsed.errors, null, 2)}`);
  const matrix = parsed.workflow.jobs[0]?.strategy?.matrix;
  if (!matrix) throw new Error("no matrix");
  return literalMatrixSpec("build", matrix);
}

function specOf(lines: string): MatrixSpec {
  const result = literal(lines);
  if (result.kind !== "spec") throw new Error(`not a spec: ${JSON.stringify(result, null, 2)}`);
  return result.spec;
}

/** Indent YAML written at column 0 under `matrix:`. */
const m = (yaml: string) =>
  yaml
    .trim()
    .split("\n")
    .map((line) => `        ${line}\n`)
    .join("");

/** Plain data for comparison: objects as records in key order, arrays as arrays. */
function plain(value: MatrixValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value.kind === "array") return value.items.map(plain);
  return Object.fromEntries([...value.entries].map(([k, v]) => [k, plain(v)]));
}

const asRecords = (combinations: readonly MatrixCombination[]) =>
  combinations.map((c) => Object.fromEntries([...c.values].map(([k, v]) => [k, plain(v)])));
const keysOf = (combinations: readonly MatrixCombination[]) =>
  combinations.map((c) => [...c.values.keys()]);

function expand(lines: string) {
  const expanded = expandMatrix(specOf(lines));
  if (!expanded.ok) throw new Error(`errors: ${JSON.stringify(expanded.errors, null, 2)}`);
  return expanded;
}

function errorsOf(lines: string): WorkflowError[] {
  const result = literal(lines);
  if (result.kind === "invalid") return [...result.errors];
  if (result.kind !== "spec") throw new Error("dynamic");
  const expanded = expandMatrix(result.spec);
  if (expanded.ok) throw new Error("expanded without errors");
  return [...expanded.errors];
}

describe("expandMatrix: GitHub's documented examples", () => {
  it("varies the first key slowest", () => {
    const { combinations } = expand(
      m("version: [10, 12, 14]\nos: [ubuntu-latest, windows-latest]"),
    );
    expect(asRecords(combinations)).toEqual([
      { version: 10, os: "ubuntu-latest" },
      { version: 10, os: "windows-latest" },
      { version: 12, os: "ubuntu-latest" },
      { version: 12, os: "windows-latest" },
      { version: 14, os: "ubuntu-latest" },
      { version: 14, os: "windows-latest" },
    ]);
  });

  it("adds include entries to original combinations, and the rest as new ones", () => {
    const { combinations } = expand(
      m(`
fruit: [apple, pear]
animal: [cat, dog]
include:
  - color: green
  - color: pink
    animal: cat
  - fruit: apple
    shape: circle
  - fruit: banana
  - fruit: banana
    animal: cat
`),
    );
    expect(asRecords(combinations)).toEqual([
      { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
      { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
      { fruit: "pear", animal: "cat", color: "pink" },
      { fruit: "pear", animal: "dog", color: "green" },
      { fruit: "banana" },
      { fruit: "banana", animal: "cat" },
    ]);
    expect(keysOf(combinations)[0]).toEqual(["fruit", "animal", "color", "shape"]);
  });

  it("removes every combination an exclude entry matches partially", () => {
    const { combinations } = expand(
      m(`
os: [macos-latest, windows-latest]
version: [12, 14, 16]
environment: [staging, production]
exclude:
  - os: macos-latest
    version: 12
    environment: production
  - os: windows-latest
    version: 16
`),
    );
    expect(combinations).toHaveLength(9);
    expect(asRecords(combinations)).not.toContainEqual({
      os: "macos-latest",
      version: 12,
      environment: "production",
    });
    expect(
      asRecords(combinations).filter((c) => c.os === "windows-latest" && c.version === 16),
    ).toEqual([]);
  });

  it("runs every include entry of a matrix with no other keys", () => {
    const { combinations } = expand(
      m("include:\n  - site: production\n  - site: staging\n    region: eu"),
    );
    expect(asRecords(combinations)).toEqual([
      { site: "production" },
      { site: "staging", region: "eu" },
    ]);
  });

  it("lets include add back a combination exclude removed", () => {
    const { combinations } = expand(
      m("os: [linux, mac]\nexclude:\n  - os: mac\ninclude:\n  - os: mac\n    extra: yes-please"),
    );
    expect(asRecords(combinations)).toEqual([{ os: "linux" }, { os: "mac", extra: "yes-please" }]);
  });
});

describe("expandMatrix: keys ignore case", () => {
  it("matches include and exclude keys to dimensions ignoring case, keeping the dimension's spelling", () => {
    const { combinations } = expand(
      m(
        "os: [linux, mac]\nexclude:\n  - OS: MAC\ninclude:\n  - Os: linux\n    arch: x64\n  - OS: bsd",
      ),
    );
    expect(asRecords(combinations)).toEqual([{ os: "linux", arch: "x64" }, { os: "bsd" }]);
  });

  it("keeps the first spelling of a key include added, with the latest value", () => {
    const { combinations } = expand(m("os: [linux]\ninclude:\n  - tag: green\n  - TAG: pink"));
    expect(asRecords(combinations)).toEqual([{ os: "linux", tag: "pink" }]);
  });

  it("refuses two keys of one object that differ only in case, at the second", () => {
    expect(errorsOf(m("os: [a]\nOS: [b]"))).toEqual([
      expect.objectContaining({
        code: "duplicate_key",
        path: "jobs.build.strategy.matrix.OS",
        line: 8,
        column: 9,
      }),
    ]);
    expect(errorsOf(m("os: [a]\ninclude:\n  - x: 1\n    X: 2"))).toEqual([
      expect.objectContaining({
        code: "duplicate_key",
        feature: "jobs.<job_id>.strategy.matrix.include",
        path: "jobs.build.strategy.matrix.include[0].X",
      }),
    ]);
    expect(errorsOf(m("cfg:\n  - {name: a, Name: b}"))).toEqual([
      expect.objectContaining({
        code: "duplicate_key",
        path: "jobs.build.strategy.matrix.cfg[0].Name",
      }),
    ]);
  });
});

describe("expandMatrix: matching", () => {
  it("matches strings ignoring case and numbers across types, as the expression language's ==", () => {
    const { combinations } = expand(
      m(
        "os: [Ubuntu-Latest, mac]\nnode: [18, 20]\nexclude:\n  - os: ubuntu-latest\n    node: '18'",
      ),
    );
    expect(asRecords(combinations)).toEqual([
      { os: "Ubuntu-Latest", node: 20 },
      { os: "mac", node: 18 },
      { os: "mac", node: 20 },
    ]);
  });

  it("matches nested objects key by key and arrays index by index", () => {
    const lines = (filter: string) =>
      m(
        `cfg:\n  - {os: linux, arch: x64, flags: [a, b]}\n  - {os: mac, arch: arm64, flags: [a]}\nexclude:\n  - cfg: ${filter}`,
      );
    expect(expand(lines("{os: LINUX}")).combinations).toHaveLength(1);
    // Nested keys match ignoring case too.
    expect(expand(lines("{OS: linux, Arch: X64}")).combinations).toHaveLength(1);
    expect(expand(lines("{flags: [a, b]}")).combinations).toHaveLength(1);
    // `[a]` matches both values index by index, so nothing is left.
    expect(errorsOf(lines("{flags: [a]}")).map((e) => e.code)).toEqual(["invalid_value"]);
    // A longer filter than the value: the missing key is null, which does not equal 'x'.
    expect(expand(lines("{os: linux, extra: x}")).combinations).toHaveLength(2);
    // A filter key missing from the value matches only a filter value equal to null.
    expect(expand(lines("{os: linux, extra: null}")).combinations).toHaveLength(1);
  });

  it("converts number text as the expression language does: 0x, 0o and spaces", () => {
    const { combinations } = expand(m(`n: [16, 8, 17]\nexclude:\n  - n: '0x10'\n  - n: ' 0o10 '`));
    expect(asRecords(combinations)).toEqual([{ n: 17 }]);
    const added = expand(m(`n: [16]\ninclude:\n  - n: '0x10'\n    extra: yes-please`));
    expect(asRecords(added.combinations)).toEqual([{ n: 16, extra: "yes-please" }]);
  });

  it("reads long text that is almost a number in one pass", () => {
    const almost = `${"1".repeat(200_000)}x`;
    const { combinations } = expand(m(`n: [1, 2]\nexclude:\n  - n: '${almost}'\n  - n: 2`));
    expect(asRecords(combinations)).toEqual([{ n: 1 }]);
  });

  it("never compares two containers with ==: a scalar filter against an object does not match", () => {
    const { combinations } = expand(m("cfg:\n  - {os: linux}\nexclude:\n  - cfg: linux"));
    expect(combinations).toHaveLength(1);
  });
});

describe("expandMatrix: limits", () => {
  it("refuses a product over the cap before building any combination", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => i).join(", ");
    const result = expandMatrix(specOf(m(`a: [${list(16)}]\nb: [${list(1000)}]`)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "limit_exceeded",
        path: "jobs.build.strategy.matrix.b",
        message: `A matrix may have at most ${MAX_MATRIX_COMBINATIONS} combinations; \`a\` and \`b\` make at least 16000.`,
      }),
    ]);
    expect(result.units).toBeLessThan(10);
  });

  it("accepts exactly the cap and refuses one more after include", () => {
    const values = Array.from({ length: 256 }, (_, i) => i).join(", ");
    expect(expand(m(`n: [${values}]`)).combinations).toHaveLength(MAX_MATRIX_COMBINATIONS);
    expect(errorsOf(m(`n: [${values}]\ninclude:\n  - n: extra`))).toEqual([
      expect.objectContaining({
        code: "limit_exceeded",
        path: "jobs.build.strategy.matrix",
        message: `A matrix may have at most ${MAX_MATRIX_COMBINATIONS} combinations; this one has 257 after \`include\`.`,
      }),
    ]);
  });

  it("refuses too many entries before building, whatever the combination count", () => {
    const values = Array.from({ length: 256 }, (_, i) => i).join(", ");
    const singles = (count: number) =>
      Array.from({ length: count }, (_, i) => `k${i}: [x]`).join("\n");
    // 256 combinations of 64 keys is exactly the cap.
    expect(expand(m(`n: [${values}]\n${singles(63)}`)).combinations).toHaveLength(256);
    const errors = errorsOf(m(`n: [${values}]\n${singles(64)}`));
    expect(errors).toEqual([
      expect.objectContaining({
        code: "limit_exceeded",
        path: "jobs.build.strategy.matrix",
        message: `A matrix may hold at most ${MAX_MATRIX_ENTRIES} keys across its combinations; this one would hold at least 16640.`,
      }),
    ]);
  });

  it("counts keys include adds toward the entry cap", () => {
    const values = Array.from({ length: 256 }, (_, i) => i).join(", ");
    const singles = Array.from({ length: 62 }, (_, i) => `k${i}: [x]`).join("\n");
    // 256 × 63 keys, then two keys added to every combination.
    const errors = errorsOf(m(`n: [${values}]\n${singles}\ninclude:\n  - a: 1\n  - b: 2`));
    expect(errors.map((e) => e.code)).toEqual(["limit_exceeded"]);
  });

  it("charges matching work linearly in the size of the objects compared", () => {
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}: v${i}`).join(", ");
    const run = (n: number) =>
      expandMatrix(
        specOf(m(`cfg:\n  - {${keys(n)}}\nexclude:\n  - cfg: {${keys(n)}, missing: 1}`)),
      );
    const small = run(1000);
    const large = run(4000);
    expect(small.ok && large.ok).toBe(true);
    if (!small.ok || !large.ok) return;
    expect(small.combinations).toHaveLength(1);
    expect(large.units).toBeLessThan(5 * small.units);
    expect(large.units).toBeGreaterThan(3 * small.units);
  });

  it("charges each include entry against each original combination, even an empty entry", () => {
    const at = { line: 1, column: 1 };
    const spec = (includes: number): MatrixSpec => ({
      dimensions: [
        { name: "n", values: Array.from({ length: 256 }, (_, i) => i), at, path: "m.n" },
      ],
      include: Array.from({ length: includes }, (_, i) => ({
        keys: [],
        at,
        path: `m.include[${i}]`,
      })),
      exclude: [],
      at,
      path: "m",
    });
    const none = expandMatrix(spec(0));
    const many = expandMatrix(spec(1000));
    expect(none.ok && many.ok).toBe(true);
    expect(many.units - none.units).toBeGreaterThanOrEqual(256 * 1000);
    expect(expandMatrix(spec(1000), 100_000).ok).toBe(false);
  });

  it("folds each key name once, however many combinations reuse it", () => {
    const at = { line: 1, column: 1 };
    const name = "k".repeat(64_000);
    const result = expandMatrix({
      dimensions: [
        { name, values: ["x"], at, path: "m.k" },
        { name: "n", values: Array.from({ length: 256 }, (_, i) => i), at, path: "m.n" },
      ],
      include: [],
      exclude: [],
      at,
      path: "m",
    });
    expect(result.ok).toBe(true);
    // One fold of the long name is about 1,000 units; folding it per combination would be 256 times that.
    expect(result.units).toBeGreaterThanOrEqual(1000);
    expect(result.units).toBeLessThan(10_000);
  });

  it("refuses with limit_exceeded when the work budget runs out", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `k${i}: v${i}`).join(", ");
    const spec = specOf(m(`cfg:\n  - {${keys}}\nexclude:\n  - cfg: {${keys}}`));
    const result = expandMatrix(spec, 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "limit_exceeded", path: "jobs.build.strategy.matrix" }),
    ]);
  });
});

describe("expandMatrix: refusals", () => {
  it("refuses a matrix with no keys and no include entries", () => {
    expect(errorsOf(m("include: []"))).toEqual([
      expect.objectContaining({ code: "invalid_value", path: "jobs.build.strategy.matrix" }),
    ]);
  });

  it("refuses a key with no values, at the key", () => {
    expect(errorsOf(m("os: [linux]\narch: []"))).toEqual([
      expect.objectContaining({ code: "invalid_value", path: "jobs.build.strategy.matrix.arch" }),
    ]);
  });

  it("refuses an exclude key that names no matrix key, at that key", () => {
    expect(errorsOf(m("os: [linux]\nexclude:\n  - os: linux\n    arch: x64"))).toEqual([
      expect.objectContaining({
        code: "invalid_value",
        feature: "jobs.<job_id>.strategy.matrix.exclude",
        path: "jobs.build.strategy.matrix.exclude[0].arch",
        line: 10,
        column: 13,
      }),
    ]);
  });

  it("refuses a matrix whose every combination is excluded, naming the job's if: as the way to skip it", () => {
    const [error] = errorsOf(m("os: [linux, mac]\nexclude:\n  - os: linux\n  - os: mac"));
    expect(error).toMatchObject({ code: "invalid_value", path: "jobs.build.strategy.matrix" });
    expect(error?.message).toBe(
      "Every combination of this matrix is excluded, so the job would have nothing to run. To skip the job on purpose, use the job's `if:`.",
    );
  });

  it("refuses an include entry with no keys when it would create a combination", () => {
    expect(errorsOf(m("include:\n  - {}\n  - x: a"))).toEqual([
      expect.objectContaining({
        code: "invalid_value",
        path: "jobs.build.strategy.matrix.include[0]",
      }),
    ]);
    // With matrix keys it matches every combination and adds nothing.
    expect(asRecords(expand(m("os: [linux]\ninclude:\n  - {}")).combinations)).toEqual([
      { os: "linux" },
    ]);
  });

  it("names the one key that is over the cap by itself", () => {
    const values = Array.from({ length: 300 }, (_, i) => i).join(", ");
    expect(errorsOf(m(`n: [${values}]`))[0]?.message).toBe(
      `A matrix may have at most ${MAX_MATRIX_COMBINATIONS} combinations; \`n\` makes at least 300.`,
    );
  });
});

describe("literalMatrixSpec: dynamic matrices", () => {
  it("leaves a matrix with an expression in any value for when the job is ready", () => {
    expect(literal(`        \${{ fromJSON(needs.a.outputs.m) }}\n`).kind).toBe("dynamic");
    expect(literal(m(`os: \${{ fromJSON(inputs.os) }}`)).kind).toBe("dynamic");
    expect(literal(m(`os: [linux, '\${{ inputs.extra }}']`)).kind).toBe("dynamic");
    expect(
      literal(m(`os: [linux]\ninclude:\n  - os: linux\n    cfg: {flags: ['\${{ inputs.flag }}']}`))
        .kind,
    ).toBe("dynamic");
    expect(literal(m("os: [linux]")).kind).toBe("spec");
  });

  it("never sees an expression in a key: the parser refuses one", () => {
    const text = `on: push\njobs:\n  build:\n    runs-on: x\n    strategy:\n      matrix:\n        '\${{ inputs.axis }}': [linux]\n        os: [{'\${{ y }}': 1}]\n    steps:\n      - run: hi\n`;
    const parsed = parseWorkflow("w.yml", encoder.encode(text));
    expect(parsed.ok ? [] : parsed.errors.map((e) => e.code)).toEqual([
      "expression_not_allowed",
      "expression_not_allowed",
    ]);
  });
});

describe("expandMatrix: name values", () => {
  it("lists each dimension's scalars, objects in key order, not keys include added", () => {
    const { combinations } = expand(
      m("os: [linux]\ncfg:\n  - {z: 1, a: [x, y]}\ninclude:\n  - os: linux\n    extra: e"),
    );
    expect(combinations[0]?.nameValues).toEqual(["linux", 1, "x", "y"]);
  });

  it("lists a new combination's dimension keys first, then its other keys, in the entry's order", () => {
    const { combinations } = expand(m("os: [linux]\ninclude:\n  - extra: e\n    OS: bsd"));
    expect(combinations[1]?.nameValues).toEqual(["bsd", "e"]);
    expect([...(combinations[1]?.values.keys() ?? [])]).toEqual(["os", "extra"]);
  });
});
