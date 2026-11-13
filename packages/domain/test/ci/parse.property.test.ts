// Properties of the workflow parser over generated input: it never throws
// and its errors are ordered and inside the file; a generated valid workflow
// parses to the model it was generated from; and one unknown key placed
// anywhere is reported, alone, at its path.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../../src/ci/parse.js";
import type { ParsedWorkflow } from "../../src/ci/workflow-schema.js";

const encoder = new TextEncoder();
const parse = (text: string) => parseWorkflow("w.yml", encoder.encode(text));

function checkErrors(parsed: ParsedWorkflow, lineCount: number) {
  if (parsed.ok) return;
  expect(parsed.errors.length).toBeGreaterThan(0);
  let previous = { line: 0, column: 0 };
  for (const error of parsed.errors) {
    if (error.code === "too_many_errors") continue;
    expect(error.line).toBeGreaterThanOrEqual(0);
    expect(error.line).toBeLessThanOrEqual(lineCount + 1);
    if (error.line > 0) expect(error.column).toBeGreaterThanOrEqual(1);
    const ordered =
      error.line > previous.line ||
      (error.line === previous.line && error.column >= previous.column);
    expect(ordered).toBe(true);
    previous = error;
  }
}

/** YAML-shaped text: keys, indentation, flow collections, anchors, tags, directives. */
const yamlish = fc
  .array(
    fc.constantFrom(
      "on",
      "jobs",
      "push",
      "build",
      "runs-on",
      "steps",
      "run",
      "uses",
      "env",
      "matrix",
      "<<",
      "&a",
      "*a",
      "!!str",
      "!t",
      "%YAML 1.1",
      "---",
      ":",
      ": ",
      "- ",
      "[",
      "]",
      "{",
      "}",
      ",",
      "\n",
      "  ",
      "\t",
      "#",
      "'",
      '"',
      "|",
      ">-",
      `\${{ x }}`,
      "\u{1F600}",
      "﻿",
      "\r\n",
      "?",
      "~",
      "0x10",
      "1.0",
      "yes",
    ),
    { maxLength: 80 },
  )
  .map((parts) => parts.join(""));

describe("parseWorkflow properties", () => {
  it("never throws on arbitrary bytes, and orders its errors", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const parsed = parseWorkflow("w.yml", bytes);
        const lines = new TextDecoder().decode(bytes).split("\n").length;
        checkErrors(parsed, lines);
      }),
    );
  });

  it("never throws on YAML-shaped text, and orders its errors", () => {
    fc.assert(
      fc.property(yamlish, (text) => {
        checkErrors(parse(text), text.split(/\r\n|\n|\r/).length);
      }),
    );
  });

  const id = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_-]{0,8}$/);
  const text = fc.string({ maxLength: 12 });
  const generated = fc.record({
    jobs: fc.uniqueArray(
      fc.record({
        id,
        labels: fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/), {
          minLength: 1,
          maxLength: 3,
        }),
        env: fc.uniqueArray(fc.tuple(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,6}$/), text), {
          maxLength: 3,
          selector: ([k]) => k,
        }),
        steps: fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant("run" as const), value: text }),
            fc.record({
              kind: fc.constant("uses" as const),
              value: fc.stringMatching(/^[a-z]{1,5}\/[a-z]{1,5}@v[0-9]$/),
            }),
          ),
          { minLength: 1, maxLength: 3 },
        ),
      }),
      { minLength: 1, maxLength: 4, selector: (j) => j.id },
    ),
  });

  type Generated = typeof generated extends fc.Arbitrary<infer T> ? T : never;

  /** As YAML: every string double-quoted as JSON, which YAML reads the same way. */
  function render(w: Generated): string {
    const q = (s: string) => JSON.stringify(s);
    let out = "on: push\njobs:\n";
    for (const job of w.jobs) {
      out += `  ${q(job.id)}:\n    runs-on: [${job.labels.map(q).join(", ")}]\n`;
      if (job.env.length > 0)
        out += `    env:\n${job.env.map(([k, v]) => `      ${q(k)}: ${q(v)}\n`).join("")}`;
      out += "    steps:\n";
      for (const step of job.steps) out += `      - ${step.kind}: ${q(step.value)}\n`;
    }
    return out;
  }

  it("parses a generated workflow to the model it came from", () => {
    fc.assert(
      fc.property(generated, (w) => {
        const parsed = parse(render(w));
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
        const jobs = parsed.workflow.jobs;
        expect(jobs.map((j) => j.id.value)).toEqual(w.jobs.map((j) => j.id));
        jobs.forEach((job, i) => {
          const source = w.jobs[i];
          expect(job.runsOn).toMatchObject({ kind: "literal" });
          if (job.runsOn.kind === "literal")
            expect(job.runsOn.value.map((l) => l.value)).toEqual(source?.labels);
          expect(job.env.map(([k, v]) => [k.value, v.value])).toEqual(source?.env);
          expect(
            job.steps.map((s) => [s.kind, s.kind === "run" ? s.run.value : s.uses.value]),
          ).toEqual(source?.steps.map((s) => [s.kind, s.value]));
        });
      }),
    );
  });

  it("reports one unknown key, wherever it is put, at its path", () => {
    const placements = ["top", "job", "step"] as const;
    fc.assert(
      fc.property(
        generated,
        fc.constantFrom(...placements),
        fc.stringMatching(/^zz[a-z]{1,6}$/),
        (w, where, key) => {
          const lines = render(w).split("\n");
          const job = w.jobs[0]?.id ?? "";
          let path: string;
          if (where === "top") {
            lines.unshift(`${key}: 1`);
            path = key;
          } else if (where === "job") {
            lines.splice(3, 0, `    ${key}: 1`);
            path = `jobs.${job}.${key}`;
          } else {
            const at = lines.findIndex((l) => l.startsWith("      - "));
            lines.splice(at + 1, 0, `        ${key}: 1`);
            path = `jobs.${job}.steps[0].${key}`;
          }
          const parsed = parse(lines.join("\n"));
          expect(parsed.ok || parsed.errors.map((e) => [e.code, e.path])).toEqual([
            ["unknown_key", path],
          ]);
        },
      ),
    );
  });
});
