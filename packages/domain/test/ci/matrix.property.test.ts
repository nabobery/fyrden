// Matrix expansion over generated matrices, against a direct reading of
// GitHub's rules written as plainly as possible: the same combinations in
// the same order with the same keys, or the same error code.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  expandMatrix,
  type MatrixEntry,
  type MatrixScalar,
  type MatrixSpec,
} from "../../src/ci/matrix.js";
import { foldKey, looseEquals } from "../../src/ci/matrix-language.js";

const at = { line: 1, column: 1 };
const keys = fc.constantFrom("os", "OS", "node", "arch", "extra");
const scalars: fc.Arbitrary<MatrixScalar> = fc.oneof(
  fc.constantFrom("linux", "LINUX", "mac", "18", "x"),
  fc.constantFrom(18, 20, 0),
  fc.constantFrom(true, false, null),
);
/** Pairs with distinct folded keys, as the literal reader guarantees. */
const pairs = fc
  .uniqueArray(fc.tuple(keys, scalars), { maxLength: 3, selector: ([k]) => foldKey(k) })
  .map((list) => list as [string, MatrixScalar][]);

const specs = fc
  .record({
    dims: fc.uniqueArray(fc.tuple(keys, fc.array(scalars, { minLength: 0, maxLength: 3 })), {
      maxLength: 3,
      selector: ([k]) => foldKey(k),
    }),
    include: fc.array(pairs, { maxLength: 4 }),
    exclude: fc.array(pairs, { maxLength: 3 }),
  })
  .map(({ dims, include, exclude }): MatrixSpec => {
    const entries = (list: [string, MatrixScalar][][]): MatrixEntry[] =>
      list.map((keyed, i) => ({
        keys: keyed.map(([key, value]) => ({ key, value, at, path: `e${i}.${key}` })),
        at,
        path: `e${i}`,
      }));
    return {
      dimensions: dims.map(([name, values]) => ({ name, values, at, path: name })),
      include: entries(include),
      exclude: entries(exclude),
      at,
      path: "m",
    };
  });

type Combination = [string, MatrixScalar][];

/** GitHub's rules, read directly: scalar values only, no limits beyond the 256 cap. */
function reference(spec: MatrixSpec): Combination[] | string {
  const dims = spec.dimensions;
  if (dims.length === 0 && spec.include.length === 0) return "invalid_value";
  if (dims.some((d) => d.values.length === 0)) return "invalid_value";
  const dimOf = (key: string) => dims.findIndex((d) => foldKey(d.name) === foldKey(key));
  if (spec.exclude.some((e) => e.keys.some((k) => dimOf(k.key) === -1))) return "invalid_value";

  let originals: Combination[] = dims.length === 0 ? [] : [[]];
  for (const dim of dims) {
    originals = originals.flatMap((c) =>
      dim.values.map((v): Combination => [...c, [dim.name, v as MatrixScalar]]),
    );
  }
  const valueIn = (c: Combination, key: string) =>
    c.find(([k]) => foldKey(k) === foldKey(key))?.[1] ?? null;
  originals = originals.filter(
    (c) =>
      !spec.exclude.some((e) =>
        e.keys.every((k) => looseEquals(valueIn(c, k.key), k.value as MatrixScalar)),
      ),
  );
  const extras: Combination[] = [];
  for (const entry of spec.include) {
    const declared = entry.keys.filter((k) => dimOf(k.key) !== -1);
    const others = entry.keys.filter((k) => dimOf(k.key) === -1);
    let matched = false;
    for (const c of originals) {
      if (!declared.every((k) => looseEquals(valueIn(c, k.key), k.value as MatrixScalar))) continue;
      matched = true;
      for (const k of others) {
        const i = c.findIndex(([name]) => foldKey(name) === foldKey(k.key));
        if (i >= 0) c[i] = [c[i]?.[0] as string, k.value as MatrixScalar];
        else c.push([k.key, k.value as MatrixScalar]);
      }
    }
    if (matched) continue;
    if (entry.keys.length === 0) return "invalid_value";
    extras.push([
      ...declared.map((k): [string, MatrixScalar] => [
        dims[dimOf(k.key)]?.name as string,
        k.value as MatrixScalar,
      ]),
      ...others.map((k): [string, MatrixScalar] => [k.key, k.value as MatrixScalar]),
    ]);
  }
  const all = [...originals, ...extras];
  if (all.length > 256) return "limit_exceeded";
  if (all.length === 0) return "invalid_value";
  return all;
}

describe("expandMatrix: properties", () => {
  it("agrees with a direct reading of GitHub's rules", () => {
    fc.assert(
      fc.property(specs, (spec) => {
        const expected = reference(spec);
        const result = expandMatrix(spec);
        if (typeof expected === "string") {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.errors[0]?.code).toBe(expected);
          return;
        }
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.combinations.map((c) => [...c.values])).toEqual(expected);
      }),
      { numRuns: 1000 },
    );
  });
});
