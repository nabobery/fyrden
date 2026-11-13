// Inputs that broke earlier versions of the parser: keys that look like
// deeper features, long text read many times through aliases, errors that
// quote huge keys, null written through an alias or a tag, and timeouts
// that are not whole minutes.
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../../src/ci/parse.js";

const encoder = new TextEncoder();
const parse = (text: string) => parseWorkflow("w.yml", encoder.encode(text));
const JOB = "jobs:\n  b:\n    runs-on: x\n    steps: [{run: a}]\n";
const job = (jobLines = "", stepLines = "") =>
  `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n${jobLines}    steps:\n      - run: echo hi\n${stepLines}`;
const summary = (text: string) => {
  const parsed = parse(text);
  return parsed.ok ? "ok" : parsed.errors.map((e) => `${e.code} ${e.path}`);
};

describe("keys that name deeper features or values", () => {
  it.each([
    [
      "a dotted top-level key",
      `on: push\n"defaults.run": {}\n${JOB}`,
      ["unknown_key defaults.run"],
    ],
    ["a dotted job key", job('    "services.db": {}\n'), ["unknown_key jobs.build.services.db"]],
    ["a dotted event", `on: push.branches\n${JOB}`, ["unknown_key on"]],
    ["an event naming a value entry", `on: pull_request.types=opened\n${JOB}`, ["unknown_key on"]],
    [
      "a mapped dotted event",
      `on:\n  "push.branches": ~\n${JOB}`,
      ["unknown_key on.push.branches"],
    ],
  ])("%s is unknown, never a throw", (_, text, expected) => {
    expect(() => parse(text)).not.toThrow();
    expect(summary(text)).toEqual(expected);
  });
});

describe("long text read many times", () => {
  it("charges a scalar's length at each use through an alias", () => {
    const long = `a/b@${"v".repeat(64_000)}`;
    const uses = Array.from({ length: 100 }, () => "      - *step").join("\n");
    const text = `on: push\njobs:\n  build:\n    runs-on: x\n    steps:\n      - &step {uses: "${long}"}\n${uses}\n`;
    expect(summary(text)).toEqual(["yaml_too_complex jobs.build.steps[49].uses"]);
  });

  it("charges a key's length too", () => {
    const key = "K".repeat(64_000);
    const jobs = Array.from(
      { length: 100 },
      (_, i) => `  j${i}:\n    runs-on: x\n    env: *env\n    steps: [{run: a}]\n`,
    ).join("");
    const parsed = parse(`on: push\nenv: &env {${key}: v}\njobs:\n${jobs}`);
    expect(parsed.ok || parsed.errors.map((e) => e.code)).toEqual(["yaml_too_complex"]);
  });
});

describe("errors quoting huge keys", () => {
  it("keeps every error's path, feature and message short", () => {
    const env = Array.from({ length: 100 }, (_, i) => `  ${"k".repeat(2_000)}${i}: {}`).join("\n");
    const parsed = parse(`on: push\nenv:\n${env}\n${JOB}`);
    if (parsed.ok) throw new Error("parsed");
    expect(parsed.errors).toHaveLength(100);
    let size = 0;
    for (const e of parsed.errors) {
      expect([...e.path].length).toBeLessThanOrEqual(201);
      expect([...e.feature].length).toBeLessThanOrEqual(201);
      expect([...e.message].length).toBeLessThanOrEqual(401);
      size += e.path.length + e.feature.length + e.message.length;
    }
    expect(size).toBeLessThan(100 * 1_000);
  });

  it("cuts keys of astral characters too", () => {
    const key = "\u{1F600}".repeat(120_000);
    const parsed = parse(`on: push\n? "${key}"\n: {}\n${JOB}`);
    if (parsed.ok) throw new Error("parsed");
    const [error] = parsed.errors;
    expect(error?.code).toBe("unknown_key");
    expect([...(error?.path ?? "")].length).toBeLessThanOrEqual(201);
    expect([...(error?.feature ?? "")].length).toBeLessThanOrEqual(201);
    expect([...(error?.message ?? "")].length).toBeLessThanOrEqual(401);
  });
});

describe("null through an alias or a tag", () => {
  const contexts: [string, (value: string, anchor: string) => string][] = [
    ["push", (v, a) => `on:\n  pull_request: &e ${a}\n  push: ${v}\n`],
    ["pull_request", (v, a) => `on:\n  push: &e ${a}\n  pull_request: ${v}\n`],
    ["workflow_dispatch", (v, a) => `on:\n  push: &e ${a}\n  workflow_dispatch: ${v}\n`],
    ["inputs", (v, a) => `on:\n  push: &e ${a}\n  workflow_dispatch:\n    inputs: ${v}\n`],
    [
      "an input",
      (v, a) => `on:\n  push: &e ${a}\n  workflow_dispatch:\n    inputs:\n      level: ${v}\n`,
    ],
  ];

  it.each(contexts)("%s: literal, aliased and tagged null", (_, on) => {
    expect(summary(`${on("~", "null")}${JOB}`)).toBe("ok");
    expect(summary(`${on("*e", "null")}${JOB}`)).toBe("ok");
    const tagged = parse(`${on("!!null null", "null")}${JOB}`);
    expect(tagged.ok || tagged.errors.map((e) => [e.code, e.feature])).toEqual([
      ["unsupported_value", "yaml.tags"],
    ]);
  });
});

describe("timeouts are whole minutes", () => {
  it.each(["0.5", "0", "-1", ".inf", "9007199254740993"])(
    "%s is refused at job and step",
    (value) => {
      expect(summary(job(`    timeout-minutes: ${value}\n`))).toEqual([
        "invalid_value jobs.build.timeout-minutes",
      ]);
      expect(summary(job("", `        timeout-minutes: ${value}\n`))).toEqual([
        "invalid_value jobs.build.steps[0].timeout-minutes",
      ]);
    },
  );

  it("accepts a whole number or an expression", () => {
    expect(
      summary(job("    timeout-minutes: 30\n", "        timeout-minutes: ${{ inputs.t }}\n")),
    ).toBe("ok");
  });
});
