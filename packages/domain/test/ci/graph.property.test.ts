// Properties of the job graph over generated `needs`, checked against a
// brute-force reachability matrix: it builds exactly when there is no cycle;
// its order respects every need and breaks ties by source order; ancestors
// are exactly the jobs reachable through needs; and each cyclic component
// gets one error whose chain is made of real needs.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildJobGraph } from "../../src/ci/graph.js";

const at = { line: 1, column: 1 };

/** Jobs j0..j(n-1); `edges[i]` lists the indices job i needs, in order, no repeats. */
const graphs = fc.integer({ min: 1, max: 12 }).chain((n) =>
  fc
    .array(fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), { maxLength: 4 }), {
      minLength: n,
      maxLength: n,
    })
    .map((edges) => ({ n, edges })),
);

const jobsOf = ({ n, edges }: { n: number; edges: number[][] }) =>
  Array.from({ length: n }, (_, i) => ({
    id: { value: `j${i}`, at },
    needs: (edges[i] ?? []).map((target) => ({ value: `j${target}`, at })),
  }));

/** reach[i][k]: job i needs job k, directly or through others. */
function reachability(n: number, edges: number[][]): boolean[][] {
  const reach = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, k) => (edges[i] ?? []).includes(k)),
  );
  for (let m = 0; m < n; m++)
    for (let i = 0; i < n; i++)
      for (let k = 0; k < n; k++)
        if (reach[i]?.[m] && reach[m]?.[k]) (reach[i] as boolean[])[k] = true;
  return reach;
}

/** Kahn's algorithm, choosing the lowest ready index each time, by brute force. */
function referenceOrder(n: number, edges: number[][]): number[] {
  const done = new Set<number>();
  const order: number[] = [];
  while (order.length < n) {
    const next = Array.from({ length: n }, (_, i) => i).find(
      (i) => !done.has(i) && (edges[i] ?? []).every((k) => done.has(k)),
    );
    if (next === undefined) throw new Error("cyclic");
    done.add(next);
    order.push(next);
  }
  return order;
}

describe("buildJobGraph: properties", () => {
  it("matches brute-force reachability", () => {
    fc.assert(
      fc.property(graphs, ({ n, edges }) => {
        const reach = reachability(n, edges);
        const cyclic = Array.from({ length: n }, (_, i) => reach[i]?.[i] === true);
        const built = buildJobGraph(jobsOf({ n, edges }));

        if (!cyclic.some(Boolean)) {
          expect(built.ok).toBe(true);
          if (!built.ok) return;
          expect(built.graph.order.map((job) => job.index)).toEqual(referenceOrder(n, edges));
          for (let i = 0; i < n; i++) {
            const expected = Array.from({ length: n }, (_, k) => k)
              .filter((k) => reach[i]?.[k])
              .map((k) => `j${k}`);
            expect(built.graph.ancestors(`j${i}`)).toEqual(expected);
          }
          return;
        }

        expect(built.ok).toBe(false);
        if (built.ok) return;
        // One error per cyclic component: components are the classes of mutual reachability.
        const components = new Set(
          Array.from({ length: n }, (_, i) => i)
            .filter((i) => cyclic[i])
            .map((i) =>
              Array.from({ length: n }, (_, k) => k)
                .filter((k) => k === i || (reach[i]?.[k] && reach[k]?.[i]))
                .join(","),
            ),
        );
        expect(built.errors).toHaveLength(components.size);
        for (const error of built.errors) {
          expect(error.code).toBe("dependency_cycle");
          const chain = [...(error.message.split(".")[0] ?? "").matchAll(/`j(\d+)`/g)].map((m) =>
            Number(m[1]),
          );
          expect(chain.length).toBeGreaterThanOrEqual(2);
          expect(chain[0]).toBe(chain.at(-1));
          for (let s = 0; s + 1 < chain.length; s++) {
            expect(edges[chain[s] as number]).toContain(chain[s + 1]);
          }
          // Positioned at the component's first job, at the entry that starts the chain.
          const first = chain[0] as number;
          const component = new Set(
            [...components]
              .find((c) => c.split(",").map(Number).includes(first))
              ?.split(",")
              .map(Number),
          );
          expect(Math.min(...component)).toBe(first);
          const entry = (edges[first] ?? []).findIndex((target) => component.has(target));
          expect(chain[1]).toBe(edges[first]?.[entry]);
          expect(error.path).toBe(`jobs.j${first}.needs[${entry}]`);
        }
      }),
      { numRuns: 500 },
    );
  });
});
