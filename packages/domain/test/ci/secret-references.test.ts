// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests write workflow expressions, `${{ }}` included, as plain strings
// Which secrets a job's expressions reference: names from `secrets.NAME` and
// `secrets['NAME']`, every secret for any other use of the context, read from
// the workflow `env` and that job's runner-evaluated fields only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EXPRESSION_SITES, type SiteFeature } from "../../src/ci/expression-sites.js";
import { foldCase } from "../../src/ci/expression-values.js";
import { parseWorkflow } from "../../src/ci/parse.js";
import { secretReferences } from "../../src/ci/secret-references.js";
import type { Workflow } from "../../src/ci/workflow-schema.js";

const encoder = new TextEncoder();

function workflowOf(text: string): Workflow {
  const parsed = parseWorkflow(".github/workflows/ci.yml", encoder.encode(text));
  if (!parsed.ok) throw new Error(`errors: ${JSON.stringify(parsed.errors, null, 2)}\n${text}`);
  return parsed.workflow;
}

/** Jobs `a` and `b`, each with one step; `a` gets `aLines` (indented 4) and `aStep` (indented 8). */
const two = (aLines = "", aStep = "", top = "", bStep = "") =>
  [
    `${top}on: push`,
    "jobs:",
    "  a:",
    "    runs-on: ubuntu-latest",
    `${aLines}    steps:`,
    "      - run: echo a",
    `${aStep}  b:`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo b",
    bStep,
  ].join("\n");

const refs = (text: string, job = "a") => secretReferences(workflowOf(text), job);
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe("secretReferences", () => {
  it("takes names from secrets.NAME and secrets['NAME'], uppercased and once each", () => {
    expect(
      refs(
        two(
          "",
          "        env:\n          A: ${{ secrets.A }}\n          B: \"${{ secrets['b'] }} ${{ secrets.Ab }} ${{ secrets['AB'] }}\"\n",
        ),
      ),
    ).toEqual({ kind: "names", names: ["A", "AB", "B"] });
  });

  it("folds a non-ASCII index as the runner's ordinal ignore-case lookup does", () => {
    // `ß` has no single-letter uppercase (not `SS`), `ı` never maps into ASCII, `é` is `É`.
    expect(
      refs(
        two(
          "",
          "        env:\n          A: \"${{ secrets['ß'] }} ${{ secrets['ı'] }} ${{ secrets['é'] }} ${{ secrets['ﬀ'] }}\"\n",
        ),
      ),
    ).toEqual({ kind: "names", names: ["ß", "ı", "É", "ﬀ"].map(foldCase).sort(byCodeUnit) });
    expect(refs(two("", "        env:\n          A: \"${{ secrets['ß'] }}\"\n"))).toEqual({
      kind: "names",
      names: ["ß"],
    });
  });

  it("is no names for a job that reads no secret", () => {
    expect(refs(two())).toEqual({ kind: "names", names: [] });
  });

  it("takes a property's name once, past further properties", () => {
    expect(refs(two("", "        env:\n          A: ${{ secrets.A.length }}\n"))).toEqual({
      kind: "names",
      names: ["A"],
    });
  });

  it.each([
    ["an index read from another context", "${{ secrets[github.ref] }}"],
    ["an index built by a function", "${{ secrets[format('{0}', 'A')] }}"],
    ["toJSON of the whole context", "${{ toJSON(secrets) }}"],
    ["the context passed to format", "${{ format('{0}', secrets) }}"],
    ["the context alone", "${{ secrets }}"],
    ["a star over it", "${{ secrets.* }}"],
    ["a number as the index", "${{ secrets[1] }}"],
  ])("is every secret for %s", (_, expression) => {
    expect(refs(two("", `        env:\n          A: "${expression}"\n`))).toEqual({ kind: "all" });
  });

  it("counts the workflow env, for every job", () => {
    const text = two("", "", "env:\n  W: ${{ secrets.WIDE }}\n");
    expect(refs(text, "a")).toEqual({ kind: "names", names: ["WIDE"] });
    expect(refs(text, "b")).toEqual({ kind: "names", names: ["WIDE"] });
  });

  it("does not count another job's references", () => {
    const text = two(
      "",
      "        env:\n          A: ${{ secrets.MINE }}\n",
      "",
      "        env:\n          B: ${{ toJSON(secrets) }}${{ secrets.THEIRS }}\n",
    );
    expect(refs(text, "a")).toEqual({ kind: "names", names: ["MINE"] });
    expect(refs(text, "b")).toEqual({ kind: "all" });
  });

  it("does not count job ids that only start with the job's", () => {
    const text = [
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: x",
      "    steps:",
      "      - run: echo",
      "  a-b:",
      "    runs-on: x",
      "    env:",
      "      T: ${{ secrets.OTHER }}",
      "    steps:",
      "      - run: echo",
      "",
    ].join("\n");
    expect(refs(text, "a")).toEqual({ kind: "names", names: [] });
    expect(refs(text, "a-b")).toEqual({ kind: "names", names: ["OTHER"] });
  });

  it("never reads steps.if, where secrets are not available", () => {
    // The parser refuses `secrets` in a step's `if`, so the condition is put there by hand.
    const parsed = workflowOf(two("", "        if: env.A == 'x'\n"));
    const [job] = parsed.jobs;
    const [step] = job?.steps ?? [];
    if (!job || !step?.if) throw new Error("no step condition");
    const workflow: Workflow = {
      ...parsed,
      jobs: [
        { ...job, steps: [{ ...step, if: { ...step.if, source: "secrets.X == 'x'" } }] },
        ...parsed.jobs.slice(1),
      ],
    };
    expect(secretReferences(workflow, "a")).toEqual({ kind: "names", names: [] });
  });

  it("ignores text outside expressions and string literals", () => {
    expect(
      refs(two("", "        env:\n          A: \"secrets.A ${{ 'secrets.B' }} ${{ vars.C }}\"\n")),
    ).toEqual({ kind: "names", names: [] });
  });

  it("reads container and service credentials, their env, and the job's outputs", () => {
    expect(
      refs(
        two(
          [
            "    container:",
            "      image: node:20",
            "      credentials:",
            "        username: ${{ secrets.CU }}",
            "        password: ${{ secrets.CP }}",
            "      env:",
            "        E: ${{ secrets.CE }}",
            "    services:",
            "      db:",
            "        image: postgres",
            "        credentials:",
            "          username: u",
            "          password: ${{ secrets.SP }}",
            "        env:",
            "          E: ${{ secrets.SE }}",
            "    outputs:",
            "      o: ${{ secrets.OUT }}",
            "",
          ].join("\n"),
        ),
      ),
    ).toEqual({ kind: "names", names: ["CE", "CP", "CU", "OUT", "SE", "SP"] });
  });
});

// --- Properties ----------------------------------------------------------------------------

/** How a generated expression reads a name: a reference, a dynamic read, or a decoy. */
type Form = "dot" | "index" | "dynamic" | "vars" | "literal";
interface Ref {
  readonly form: Form;
  readonly name: string;
}

const KEYWORDS = new Set(["true", "false", "null", "nan", "infinity"]);
const nameArb = fc
  .stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,5}$/)
  .filter((n) => !KEYWORDS.has(n.toLowerCase()));
/** An index's name may be any text: these fold differently from `toUpperCase` (or not at all). */
const indexNameArb = fc.oneof(
  nameArb,
  fc
    .array(fc.constantFrom("a", "Z", "_", "ß", "ı", "ſ", "é", "ﬀ", "ς", "İ", "ǅ", "😀", " "), {
      minLength: 1,
      maxLength: 4,
    })
    .map((chars) => chars.join("")),
);
const refArb: fc.Arbitrary<Ref> = fc.oneof(
  fc.record({
    form: fc.constantFrom<Form>("dot", "dot", "vars", "literal", "dynamic"),
    name: nameArb,
  }),
  fc.record({ form: fc.constant<Form>("index"), name: indexNameArb }),
);

function expression(r: Ref): string {
  switch (r.form) {
    case "dot":
      return `secrets.${r.name}`;
    case "index":
      return `secrets['${r.name}']`;
    case "dynamic":
      return "toJSON(secrets)";
    case "vars":
      return `vars.${r.name}`;
    case "literal":
      return `'secrets.${r.name}'`;
  }
}

/** A text field: each reference in its own `${{ }}`, with plain text between. */
const text = (list: readonly Ref[]) =>
  JSON.stringify(
    list.length === 0
      ? "plain"
      : list.map((r) => `secrets.${r.name} \${{ ${expression(r)} }}`).join(" "),
  );
/** A field whose value is one expression. */
const single = (list: readonly Ref[]) =>
  JSON.stringify(list.length === 0 ? "${{ 1 }}" : `\${{ ${list.map(expression).join(" || ")} }}`);

/** Every site where `secrets` may be read, and the lines (job-relative) that put refs there. */
const SLOTS: Record<string, (list: readonly Ref[]) => { job?: string[]; step?: string[] }> = {
  env: () => ({}),
  "jobs.<job_id>.env": (l) => ({ job: ["    env:", `      J: ${text(l)}`] }),
  "jobs.<job_id>.outputs.<output_id>": (l) => ({ job: ["    outputs:", `      o: ${text(l)}`] }),
  "jobs.<job_id>.container.credentials": (l) => ({
    job: [
      "    container:",
      "      image: node:20",
      "      credentials:",
      "        username: u",
    ].concat([`        password: ${text(l)}`]),
  }),
  "jobs.<job_id>.container.env.<env_id>": (l) => ({
    job: ["    container:", "      image: node:20", "      env:", `        C: ${text(l)}`],
  }),
  "jobs.<job_id>.services.<service_id>.credentials": (l) => ({
    job: [
      "    services:",
      "      db:",
      "        image: postgres",
      "        credentials:",
      "          username: u",
      `          password: ${text(l)}`,
    ],
  }),
  "jobs.<job_id>.services.<service_id>.env.<env_id>": (l) => ({
    job: [
      "    services:",
      "      db:",
      "        image: postgres",
      "        env:",
      `          S: ${text(l)}`,
    ],
  }),
  "jobs.<job_id>.steps.name": (l) => ({ step: ["        run: echo", `        name: ${text(l)}`] }),
  "jobs.<job_id>.steps.env": (l) => ({
    step: ["        run: echo", "        env:", `          E: ${text(l)}`],
  }),
  "jobs.<job_id>.steps.run": (l) => ({ step: [`        run: ${text(l)}`] }),
  "jobs.<job_id>.steps.working-directory": (l) => ({
    step: ["        run: echo", `        working-directory: ${text(l)}`],
  }),
  "jobs.<job_id>.steps.continue-on-error": (l) => ({
    step: ["        run: echo", `        continue-on-error: ${single(l)}`],
  }),
  "jobs.<job_id>.steps.timeout-minutes": (l) => ({
    step: ["        run: echo", `        timeout-minutes: ${single(l)}`],
  }),
  "jobs.<job_id>.steps.with": (l) => ({
    step: ["        uses: actions/checkout@v4", "        with:", `          w: ${text(l)}`],
  }),
};

/** Sites where `secrets` may not be read; decoys only go there. */
const DECOY_JOB = (l: readonly Ref[]) => {
  const decoys = l.filter((r) => r.form === "vars" || r.form === "literal");
  return decoys.length === 0
    ? []
    : [
        `    if: ${JSON.stringify(decoys.map(expression).join(" || "))}`,
        `    timeout-minutes: ${single(decoys)}`,
      ];
};

interface Placed {
  readonly site: string;
  readonly job: "a" | "b";
  readonly refs: readonly Ref[];
}

function build(placed: readonly Placed[], wide: readonly Ref[]): string {
  const jobLines = (id: "a" | "b") => {
    const mine = placed.filter((p) => p.job === id);
    const job: string[] = [];
    const steps: string[][] = [];
    for (const p of mine) {
      const made = (SLOTS[p.site] as (typeof SLOTS)[string])(p.refs);
      if (made.job) job.push(...made.job);
      if (made.step) steps.push(made.step);
    }
    const decoys = mine.flatMap((p) => p.refs);
    return [
      `  ${id}:`,
      "    runs-on: ubuntu-latest",
      ...DECOY_JOB(decoys),
      ...job,
      "    steps:",
      "      - run: echo first",
      ...steps.map(
        (lines) => `      - ${lines.map((l, i) => (i === 0 ? l.trimStart() : l)).join("\n")}`,
      ),
    ].join("\n");
  };
  return [
    ...(wide.length > 0 ? ["env:", `  W: ${text(wide)}`] : []),
    "on: push",
    "jobs:",
    jobLines("a"),
    jobLines("b"),
    "",
  ].join("\n");
}

const secretSites = (Object.keys(EXPRESSION_SITES) as SiteFeature[]).filter((s) =>
  (EXPRESSION_SITES[s].contexts as readonly string[]).includes("secrets"),
);

const placedArb: fc.Arbitrary<Placed[]> = fc
  .uniqueArray(
    fc.record({
      site: fc.constantFrom(...Object.keys(SLOTS).filter((s) => s !== "env")),
      job: fc.constantFrom<"a" | "b">("a", "b"),
      refs: fc.array(refArb, { maxLength: 3 }),
    }),
    // A job has each of its keys once: one slot per site and job.
    { selector: (p) => `${p.job}:${p.site}`, maxLength: 10 },
  )
  // Container and its env share a key, as do a service and its env: one of each pair a job.
  .map((list) => {
    const seen = new Set<string>();
    return list.filter((p) => {
      const key = `${p.job}:${p.site.includes("container") ? "c" : p.site.includes("services") ? "s" : p.site}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

const named = (r: Ref) => r.form === "dot" || r.form === "index";

describe("secretReferences properties", () => {
  it("has a slot for every site where secrets may be read", () => {
    expect(Object.keys(SLOTS).sort()).toEqual([...secretSites].sort());
  });

  it("is sound: every name it gives is referenced in the job or the workflow env", () => {
    fc.assert(
      fc.property(placedArb, fc.array(refArb, { maxLength: 3 }), (placed, wide) => {
        const got = secretReferences(workflowOf(build(placed, wide)), "a");
        if (got.kind === "all") {
          const dynamic = [...placed.filter((p) => p.job === "a").flatMap((p) => p.refs), ...wide];
          expect(dynamic.some((r) => r.form === "dynamic")).toBe(true);
          return;
        }
        const referenced = new Set(
          [...placed.filter((p) => p.job === "a").flatMap((p) => p.refs), ...wide]
            .filter(named)
            .map((r) => foldCase(r.name)),
        );
        expect(new Set(got.names).size).toBe(got.names.length);
        for (const name of got.names) expect(referenced).toContain(name);
      }),
    );
  });

  it("is complete: a reference at any site of the job or the workflow env is given, or all are", () => {
    fc.assert(
      fc.property(placedArb, fc.array(refArb, { maxLength: 3 }), (placed, wide) => {
        const got = secretReferences(workflowOf(build(placed, wide)), "a");
        if (got.kind === "all") return;
        for (const r of [...placed.filter((p) => p.job === "a").flatMap((p) => p.refs), ...wide])
          if (named(r)) expect(got.names).toContain(foldCase(r.name));
      }),
    );
  });

  it("is complete at each site on its own", () => {
    for (const site of secretSites) {
      fc.assert(
        fc.property(indexNameArb, nameArb, fc.boolean(), (unicode, ascii, dot) => {
          // A property name is an identifier; an index may be any text.
          const ref: Ref = dot ? { form: "dot", name: ascii } : { form: "index", name: unicode };
          const text =
            site === "env" ? build([], [ref]) : build([{ site, job: "a", refs: [ref] }], []);
          expect(secretReferences(workflowOf(text), "a")).toEqual({
            kind: "names",
            names: [foldCase(ref.name)],
          });
        }),
        { numRuns: 20 },
      );
    }
  });
});
