// The interoperability catalogue's bookkeeping. With FYRDEN_GIT_SOURCE set
// to a git source tree (v2.53.0), also checks every cited title exists in
// its script and every test of each script is either ported or listed as
// not ported, with a reason.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOGUE } from "../interop/cases/index.ts";

const gitSource = process.env.FYRDEN_GIT_SOURCE;

/** The `test_expect_success` / `test_expect_failure` titles of a git test script. */
function titles(script: string): string[] {
  const out: string[] = [];
  // Optional prerequisites (possibly followed by a line continuation), then a
  // quoted title or a bare word such as `setup`.
  const pattern =
    /^\s*test_expect_(?:success|failure)\s+(?:[A-Z0-9_,!]+\s+(?:\\\n\s*)?)?(?:(['"])(.*?)\1|(\w+)\s)/gm;
  for (const match of script.matchAll(pattern)) out.push((match[2] ?? match[3]) as string);
  return out;
}

describe("interop case catalogue", () => {
  it.each(CATALOGUE.map((file) => [file.cases[0]?.from, file] as const))(
    "%s: each title appears once, every case and omission cites the script",
    (from, file) => {
      const all = [...file.cases.map((c) => c.test), ...file.notPorted.flatMap((n) => n.tests)];
      expect(new Set(all).size).toBe(all.length);
      for (const c of file.cases) expect(c.from).toBe(from);
      for (const n of file.notPorted) {
        expect(n.from).toBe(from);
        expect(n.reason.length).toBeGreaterThan(10);
      }
    },
  );

  it.skipIf(!gitSource).each(CATALOGUE.map((file) => [file.cases[0]?.from, file] as const))(
    "%s: matches the git test script",
    async (from, file) => {
      const script = await readFile(join(gitSource as string, "t", from as string), "utf8");
      const upstream = new Set(titles(script));
      const ours = [...file.cases.map((c) => c.test), ...file.notPorted.flatMap((n) => n.tests)];
      expect(ours.filter((title) => !upstream.has(title))).toEqual([]);
      expect([...upstream].filter((title) => !ours.includes(title))).toEqual([]);
    },
  );
});
