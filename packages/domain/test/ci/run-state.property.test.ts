// Properties of the run rules over random job graphs, matrices, limits and
// runner results, completed in random order: every node ends terminal; no
// instance is live before its node's needs are all terminal; a node never
// has more than max-parallel instances live; and a terminal node's outcome
// never changes.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  advanceInstance,
  attemptConclusion,
  failFastVictims,
  type InstanceEvent,
  type InstanceState,
  isLive,
  type NodeState,
  nodeOutcome,
  nodeResultOf,
  promotable,
  type RunnerResult,
  readyNodes,
  unreadyNodeStatus,
} from "../../src/ci/run-state.js";

interface Spec {
  n: number;
  needs: number[][];
  sizes: number[];
  maxParallel: (number | undefined)[];
  failFast: boolean[];
  continueOnError: boolean[];
  choices: number[];
}

const specs: fc.Arbitrary<Spec> = fc.integer({ min: 1, max: 7 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    // Each job needs only earlier jobs, so the graph has no cycle and index order is a valid order.
    needs: fc.tuple(
      ...Array.from({ length: n }, (_, i) =>
        i === 0
          ? fc.constant([] as number[])
          : fc.uniqueArray(fc.integer({ min: 0, max: i - 1 }), { maxLength: 3 }),
      ),
    ),
    sizes: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: n, maxLength: n }),
    maxParallel: fc.array(fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }), {
      minLength: n,
      maxLength: n,
    }),
    failFast: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    continueOnError: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    choices: fc.array(fc.nat(), { minLength: 200, maxLength: 200 }),
  }),
);

const RESULTS: RunnerResult[] = ["success", "failure", "cancelled", "skipped"];

describe("run rules properties", () => {
  it("drive every graph to a terminal state within its limits", () => {
    fc.assert(
      fc.property(specs, (spec) => {
        const ids = Array.from({ length: spec.n }, (_, i) => `j${i}`);
        const needsOf = (id: string) => (spec.needs[Number(id.slice(1))] ?? []).map((k) => `j${k}`);
        const nodes = new Map<string, NodeState>(
          ids.map((id) => [id, { status: "waiting", result: null }]),
        );
        const instances = new Map<string, InstanceState[]>();
        const ancestors = (id: string): string[] => {
          const out = new Set<string>();
          const walk = (x: string) => {
            for (const need of needsOf(x))
              if (!out.has(need)) {
                out.add(need);
                walk(need);
              }
          };
          walk(id);
          return [...out];
        };
        const settledOutcomes = new Map<string, string>();
        let pick = 0;
        const choose = (k: number) => (spec.choices[pick++ % spec.choices.length] ?? 0) % k;
        const apply = (id: string, index: number, event: InstanceEvent) => {
          const list = instances.get(id) as InstanceState[];
          const step = advanceInstance(list[index] as InstanceState, event);
          if (step.ok) list[index] = step.state;
          return step.ok;
        };

        for (let round = 0; round < 400; round++) {
          // Decide ready nodes: an absent `if:` is success() over the ancestors.
          for (const id of readyNodes(ids, needsOf, (x) => (nodes.get(x) as NodeState).status)) {
            const i = Number(id.slice(1));
            const ok = ancestors(id).every(
              (a) => nodeOutcome(nodes.get(a) as NodeState) === "success",
            );
            if (!ok) {
              nodes.set(id, { status: unreadyNodeStatus("none"), result: null });
              continue;
            }
            for (const need of needsOf(id))
              expect(nodeOutcome(nodes.get(need) as NodeState)).toBeDefined();
            instances.set(
              id,
              Array.from({ length: spec.sizes[i] ?? 1 }, () => ({
                status: "blocked" as const,
                conclusion: null,
                cancelReason: null,
                continueOnError: spec.continueOnError[i] ?? false,
              })),
            );
            nodes.set(id, { status: "running", result: null });
          }
          // Queue what max-parallel allows.
          for (const [id, list] of instances) {
            const i = Number(id.slice(1));
            for (const index of promotable(list, spec.maxParallel[i]))
              apply(id, index, { kind: "queue" });
            const limit = spec.maxParallel[i];
            if (limit !== undefined)
              expect(list.filter((s) => isLive(s.status)).length).toBeLessThanOrEqual(limit);
          }
          // One runner action on a random live instance.
          const live: [string, number][] = [];
          for (const [id, list] of instances)
            list.forEach((s, index) => {
              if (s.status === "queued" || s.status === "in_progress") live.push([id, index]);
            });
          if (live.length > 0) {
            const [id, index] = live[choose(live.length)] as [string, number];
            const list = instances.get(id) as InstanceState[];
            if ((list[index] as InstanceState).status === "queued")
              apply(id, index, { kind: "assign" });
            else {
              apply(id, index, { kind: "complete", result: RESULTS[choose(4)] as RunnerResult });
              const i = Number(id.slice(1));
              for (const victim of failFastVictims(list, index, spec.failFast[i] ?? true))
                apply(id, victim, { kind: "cancel", reason: "fail_fast" });
            }
          }
          // Cancelling instances answer.
          for (const [id, list] of instances)
            list.forEach((s, index) => {
              if (s.status === "cancelling")
                apply(id, index, { kind: "complete", result: "cancelled" });
            });
          // Nodes whose instances all completed are done.
          for (const [id, list] of instances)
            if (
              (nodes.get(id) as NodeState).status === "running" &&
              list.every((s) => s.status === "completed")
            )
              nodes.set(id, { status: "done", result: nodeResultOf(list) });
          // Terminal outcomes never change.
          for (const id of ids) {
            const outcome = nodeOutcome(nodes.get(id) as NodeState);
            const seen = settledOutcomes.get(id);
            if (seen !== undefined) expect(outcome).toBe(seen);
            else if (outcome !== undefined) settledOutcomes.set(id, outcome);
          }
          if (ids.every((id) => nodeOutcome(nodes.get(id) as NodeState) !== undefined)) break;
        }
        const outcomes = ids.map((id) => nodeOutcome(nodes.get(id) as NodeState));
        expect(outcomes.every((o) => o !== undefined)).toBe(true);
        const conclusion = attemptConclusion(
          "none",
          outcomes as NonNullable<(typeof outcomes)[number]>[],
        );
        expect(["success", "failure", "cancelled"]).toContain(conclusion);
      }),
      { numRuns: 300 },
    );
  });
});
