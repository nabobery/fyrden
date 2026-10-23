// One slice of working out who owns what a pull request changes: the tree
// diff resumed from a checkpoint, each changed path matched against the
// CODEOWNERS rules (by its raw bytes: one not UTF-8 is never matched), the
// counts per deciding rule kept, and every budget a stop or a terminal
// outcome. Cut into slices any way, the result is the one-shot result.
import { type CodeOwnersFile, parseCodeOwners } from "@fyrden/domain";
import { compareTreeEntries, type Oid, ReadDeferred, type TreeEntry } from "@fyrden/git-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CODE_OWNER_LIMITS,
  type CodeOwnerLimits,
  deserializeEvaluation,
  type Evaluation,
  evaluateSlice,
  freshEvaluation,
  serializeEvaluation,
} from "../src/do/repo/code-owner-slice.js";
import { ReadsTooLargeError } from "../src/do/repo/held-reads.js";

const enc = new TextEncoder();
const FILE = 0o100644;
const TREE = 0o40000;

type Spec = { [name: string]: Spec | number };

/** Trees by id from nested descriptions (a number is a file's content id); names may be raw bytes. */
class Store {
  readonly trees = new Map<string, TreeEntry[]>();
  #next = 1;
  reads = 0;

  tree(spec: Spec, raw: Record<string, Uint8Array> = {}): Oid {
    const entries = Object.entries(spec)
      .map(([name, value]): TreeEntry => {
        const bytes = raw[name] ?? enc.encode(name);
        return typeof value === "number"
          ? { name: bytes, mode: FILE, oid: blob(value) }
          : { name: bytes, mode: TREE, oid: this.tree(value, raw) };
      })
      .sort(compareTreeEntries);
    const id = `t${this.#next++}`;
    this.trees.set(id, entries);
    const oid = new Uint8Array(20);
    oid.set(enc.encode(id));
    return oid as Oid;
  }

  read = async (oid: Oid): Promise<readonly TreeEntry[]> => {
    this.reads++;
    const tree = this.trees.get(new TextDecoder().decode(oid).replace(/\0+$/, ""));
    if (!tree) throw new Error("no such tree");
    return tree;
  };
}

const blob = (n: number): Oid => {
  const bytes = new Uint8Array(20).fill(0xee);
  bytes[0] = n % 256;
  bytes[1] = Math.floor(n / 256);
  return bytes as Oid;
};

const file = (text: string): CodeOwnersFile => parseCodeOwners(enc.encode(text));

/** Runs slices to the end, as the job would; the final evaluation and how many slices it took. */
async function run(
  read: (oid: Oid) => Promise<readonly TreeEntry[]>,
  base: Oid | null,
  head: Oid,
  rules: CodeOwnersFile,
  limits: CodeOwnerLimits = CODE_OWNER_LIMITS,
) {
  let evaluation: Evaluation = freshEvaluation();
  for (let slices = 0; slices < 10_000; slices++) {
    const next = await evaluateSlice(read, base, head, rules, evaluation, limits);
    evaluation = next;
    if (next.state !== "pending") return { evaluation, slices: slices + 1 };
  }
  throw new Error("no end");
}

/** The rule counts as `line:paths:example`. */
const counted = (evaluation: Evaluation) =>
  [...evaluation.rules].map(([line, r]) => `${line}:${r.paths}:${r.example}`).sort();

describe("a code owners slice", () => {
  it("counts each changed path under the rule that decides it, last match winning", async () => {
    const s = new Store();
    const base = s.tree({ docs: { "a.md": 1 }, src: { "x.ts": 2, "y.js": 3 } });
    const head = s.tree({
      docs: { "a.md": 4 },
      src: { "x.ts": 5, "y.js": 3, "z.ts": 6 },
      "README.md": 7,
    });
    const rules = file(`* @everyone
*.ts @ts-team
/docs/ @docs
/src/z.ts
`);
    const { evaluation } = await run(s.read, base, head, rules);
    expect(evaluation.state).toBe("complete");
    // docs/a.md (line 3), src/x.ts (line 2), src/z.ts (ownerless, line 4), README.md (line 1).
    expect(counted(evaluation)).toEqual(
      ["1:1:README.md", "2:1:src/x.ts", "3:1:docs/a.md", "4:1:src/z.ts"].sort(),
    );
    expect(evaluation.unmatched).toBe(0);
    expect(evaluation.errors).toBe(0);
  });

  it("counts a rename as its removal and its addition, and a path no rule matches as unmatched", async () => {
    const s = new Store();
    const base = s.tree({ a: { "f.txt": 1 } });
    const head = s.tree({ b: { "f.txt": 1 } });
    const { evaluation } = await run(s.read, base, head, file("/a/ @alpha\n"));
    expect(counted(evaluation)).toEqual(["1:1:a/f.txt"]);
    expect(evaluation.unmatched).toBe(1);
  });

  it("never matches a path that is not UTF-8, counting it with its bytes as an example", async () => {
    const s = new Store();
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in Latin-1
    const head = s.tree({ odd: 1, "ok.txt": 2 }, { odd: latin1 });
    const { evaluation } = await run(s.read, null, head, file("* @everyone\n"));
    expect(evaluation.unmatchable).toBe(1);
    expect(evaluation.unmatchableExample).toBe(btoa(String.fromCharCode(...latin1)));
    expect(counted(evaluation)).toEqual(["1:1:ok.txt"]);
  });

  it("keeps the file's error count, and a whole tree against nothing when there is no merge base", async () => {
    const s = new Store();
    const head = s.tree({ a: 1, b: { c: 2 } });
    const { evaluation } = await run(s.read, null, head, file("[ab] @x\n!nope @y\n* @z\n"));
    expect(evaluation.errors).toBe(1);
    expect(counted(evaluation)).toEqual(["3:2:a"]);
  });

  it("stops at its budgets and resumes to the same result, however small they are", async () => {
    const s = new Store();
    const spec: Spec = {};
    for (let d = 0; d < 6; d++) {
      const dir: Spec = {};
      for (let f = 0; f < 7; f++) dir[`f${f}.${f % 2 ? "ts" : "md"}`] = d * 10 + f;
      spec[`d${d}`] = dir;
    }
    const head = s.tree(spec);
    const rules = file("* @all\n*.ts @ts\n/d3/ @three\n");
    const whole = await run(s.read, null, head, rules);
    expect(whole.slices).toBe(1);
    const cut = await run(s.read, null, head, rules, {
      ...CODE_OWNER_LIMITS,
      sliceChanges: 3,
      sliceSteps: 200,
    });
    expect(cut.slices).toBeGreaterThan(5);
    expect(counted(cut.evaluation)).toEqual(counted(whole.evaluation));
    expect(cut.evaluation.totals.slices).toBe(cut.slices);
  });

  it("resumes after a deferred read, and ends stuck after three slices without progress", async () => {
    const s = new Store();
    const head = s.tree({ a: { b: { c: 1 } } });
    let reads = 0;
    const deferThird = async (oid: Oid) => {
      if (++reads === 3) throw new ReadDeferred();
      return s.read(oid);
    };
    const resumed = await run(deferThird, null, head, file("* @all\n"));
    expect(resumed.evaluation.state).toBe("complete");
    expect(counted(resumed.evaluation)).toEqual(["1:1:a/b/c"]);

    const never = async () => {
      throw new ReadDeferred();
    };
    const stuck = await run(never, null, head, file("* @all\n"));
    expect(stuck.evaluation).toMatchObject({ state: "too_large", reason: "stuck" });
    expect(stuck.slices).toBe(3);
  });

  it("ends too large past its totals, its depth, a tree too large to read, or a path too costly to match", async () => {
    const s = new Store();
    const many: Spec = {};
    for (let f = 0; f < 30; f++) many[`f${f}`] = f;
    const wide = s.tree(many);
    expect(
      (await run(s.read, null, wide, file("* @a\n"), { ...CODE_OWNER_LIMITS, totalChanges: 10 }))
        .evaluation,
    ).toMatchObject({ state: "too_large", reason: "work" });
    expect(
      (
        await run(s.read, null, wide, file("* @a\n"), {
          ...CODE_OWNER_LIMITS,
          sliceChanges: 1,
          maxSlices: 5,
        })
      ).evaluation,
    ).toMatchObject({ state: "too_large", reason: "work" });

    let spec: Spec = { f: 1 };
    for (let d = 0; d < 5; d++) spec = { d: spec };
    const deep = s.tree(spec);
    expect(
      (await run(s.read, null, deep, file("* @a\n"), { ...CODE_OWNER_LIMITS, maxDepth: 3 }))
        .evaluation,
    ).toMatchObject({ state: "too_large", reason: "depth" });

    const huge = async () => {
      throw new ReadsTooLargeError();
    };
    expect((await run(huge, null, wide, file("* @a\n"))).evaluation).toMatchObject({
      state: "too_large",
      reason: "tree",
    });

    expect(
      (await run(s.read, null, wide, file("* @a\n"), { ...CODE_OWNER_LIMITS, sliceSteps: 1 }))
        .evaluation,
    ).toMatchObject({ state: "too_large", reason: "path" });
  });

  it("reads no tree past the last change a slice's matcher can afford (the largest file's shape, measured)", async () => {
    const s = new Store();
    const spec: Spec = {};
    for (let d = 0; d < 200; d++) {
      const dir: Spec = {};
      for (let f = 0; f < 10; f++) dir[`f${f}.txt`] = d * 10 + f;
      spec[`d${String(d).padStart(3, "0")}`] = dir;
    }
    const head = s.tree(spec);
    // Rules that cost every path a few steps each, as the largest accepted file's do.
    const costly = file(
      Array.from({ length: 200 }, (_, r) => `/r${r}${"x".repeat(300)}?/y* @o`).join("\n"),
    );
    const one = await evaluateSlice(s.read, null, head, costly, freshEvaluation(), {
      ...CODE_OWNER_LIMITS,
      sliceSteps: 20_000,
    });
    expect(one.state).toBe("pending");
    // A tree read for every ten changes matched, not for the 2,000 a slice may list.
    expect(one.totals.changes).toBeGreaterThan(0);
    expect(one.totals.trees).toBeLessThanOrEqual(Math.ceil(one.totals.changes / 10) + 2);
  });

  it("keeps every byte of a checkpoint's paths and cursor across storing it", () => {
    const evaluation = freshEvaluation();
    evaluation.rules.set(3, { paths: 2, example: "\ufeffa.txt" });
    const stored = {
      ...evaluation,
      cursor: {
        path: [
          { name: new Uint8Array([0xef, 0xbb, 0xbf, 0x64]), tree: true },
          { name: new Uint8Array([0xff, 0x00, 0x2f]), tree: false },
        ],
        enter: false,
      },
    };
    const back = deserializeEvaluation({ ...serializeEvaluation(stored), errors: 0 });
    expect(back.rules.get(3)?.example).toBe("\ufeffa.txt");
    expect(back.cursor).toEqual(stored.cursor);
  });

  it("keeps a checkpoint well under a row's size at its maxima", async () => {
    const evaluation = freshEvaluation();
    const control = String.fromCharCode(...Array.from({ length: 512 }, (_, i) => 1 + (i % 30)));
    for (let line = 1; line <= 1_000; line++)
      evaluation.rules.set(line, { paths: 200_000, example: control });
    const stored = JSON.stringify(serializedRules(evaluation));
    expect(new TextEncoder().encode(stored).length).toBeLessThan(1_000_000);
  });

  it("lists, cut into slices any way, what one slice lists (property)", async () => {
    const names = fc.constantFrom("a", "a-", "a.ts", "a0", "b", "z.md", "!x", "0");
    const spec: fc.Arbitrary<Spec> = fc.letrec<{ tree: Spec }>((tie) => ({
      tree: fc.dictionary(
        names,
        fc.oneof({ depthSize: "small" }, fc.integer({ min: 0, max: 4 }), tie("tree")),
        { maxKeys: 5 },
      ),
    })).tree as fc.Arbitrary<Spec>;
    const rules = file("* @all\n*.ts @ts\n/a/ @a\na0 @zero\n/z.md\n");
    await fc.assert(
      fc.asyncProperty(
        spec,
        spec,
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 20, max: 400 }),
        async (oldSpec, newSpec, sliceChanges, sliceSteps) => {
          const s = new Store();
          const base = s.tree(oldSpec);
          const head = s.tree(newSpec);
          const whole = await run(s.read, base, head, rules);
          const cut = await run(s.read, base, head, rules, {
            ...CODE_OWNER_LIMITS,
            sliceChanges,
            sliceSteps,
          });
          if (cut.evaluation.state === "too_large") {
            // A path costing more than a slice's steps ends it, as it must.
            expect(cut.evaluation.reason).toBe("path");
            return;
          }
          expect(counted(cut.evaluation)).toEqual(counted(whole.evaluation));
          expect(cut.evaluation.unmatched).toBe(whole.evaluation.unmatched);
        },
      ),
      { numRuns: 200 },
    );
  });
});

/** The rules as a checkpoint stores them (see `serializeEvaluation`). */
function serializedRules(evaluation: Evaluation) {
  return serializeEvaluation(evaluation).partial;
}
