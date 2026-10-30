// The read model is written only through its executor: no source reaches its
// binding (`env.ORG_READ`) or the raw database (`rawReadModel`) but the
// executor's own modules and the exceptions named here, so a write cannot go
// around admission by holding the database.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Where the binding or the raw database may be named, and why. */
const ALLOWED: Record<string, string> = {
  "../src/events/read-model.ts": "where the raw database comes from",
  "../src/read-model/executor.ts": "the executor",
  "../src/read-model/maintenance.ts": "the barrier's steps (its tables are not guarded)",
  "../src/do/RepoDO.ts":
    "counting an invocation's calls (countedD1), its writes still through the executor",
};

/**
 * Code with its comments taken out, in one pass with its string literals
 * (so a comment's delimiter inside a string, or a quote inside a comment,
 * is neither).
 */
const code = (source: string) =>
  source.replace(
    /'(?:\\.|[^\\'\n])*'|"(?:\\.|[^\\"\n])*"|`(?:\\.|[^\\`])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => (match.startsWith("/") ? " " : match),
  );

/**
 * Whether code names the binding or the raw database anywhere (a property,
 * an index, a destructuring, an import) but in a type picking it from `Env` or omitting it.
 */
const reaches = (source: string) =>
  /\bORG_READ\b|\brawReadModel\b/.test(
    code(source).replace(/\b(?:Pick|Omit)<\s*Env\s*,[^>]*>/g, ""),
  );

describe("the read model's binding", () => {
  it("is reached only by the executor and the named exceptions", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    const reaching = Object.entries(SOURCES)
      .filter(([, source]) => reaches(source))
      .map(([path]) => path)
      .filter((path) => !(path in ALLOWED));
    expect(reaching).toEqual([]);
  });

  it("is found however code names it, and not in a type that picks it", () => {
    for (const source of [
      'const marker = "/*";\nconst db = env.ORG_READ;\nconst end = "*/";',
      'const url = "https://fyrden.test"; const db = env.ORG_READ;',
      "const db = env.ORG_READ;",
      'const db = env["ORG_READ"];',
      "const { ORG_READ: db } = env;",
      'import { rawReadModel } from "../events/read-model.js";',
    ])
      expect(reaches(source), source).toBe(true);
    for (const source of [
      'function f(env: Pick<Env, "DIRECTORY" | "ORG_READ">) {}',
      'type Rest = Omit<Env, "ORG_READ">;',
      'function f(env: Pick<\n  Env,\n  "ORG_READ"\n>) {}',
      "// env.ORG_READ, in a comment",
      "/* rawReadModel */ const x = 1;",
    ])
      expect(reaches(source), source).toBe(false);
  });

  it("is used by RepoDO only to count its calls", () => {
    const repo = code(SOURCES["../src/do/RepoDO.ts"] ?? "");
    const uses = repo.match(/[^\n]*\bORG_READ\b[^\n]*/g) ?? [];
    expect(uses.map((line) => line.trim())).toEqual(["ORG_READ: countedD1(env.ORG_READ),"]);
  });
});
