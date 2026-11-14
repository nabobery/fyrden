// Properties of the concurrency registry under random interleavings of
// requests, repeats, releases (stale ones included), lease renewals and
// clock steps: one owner at a time; every change of owner takes a larger
// generation; no owner is evicted before its release deadline or a lease it
// was granted; a release by anyone but the owner or the pending requester
// changes nothing; and receipts agree with the group.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  acquire,
  type ConcurrencyContext,
  type GroupState,
  type OwnerRef,
  type Receipt,
  release,
  renewScope,
  sameRef,
  settle,
} from "../../src/ci/concurrency.js";

const MIN = 60_000;
const LEASE = 10 * MIN;

type Op =
  | { kind: "acquire"; who: number; cancelInProgress: boolean; holdMin: number }
  | { kind: "repeat"; who: number }
  | { kind: "release"; who: number; withGeneration: boolean; wrongGeneration: boolean }
  | { kind: "renew"; who: number }
  | { kind: "tick"; minutes: number };

const ops = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant("acquire" as const),
      who: fc.integer({ min: 0, max: 5 }),
      cancelInProgress: fc.boolean(),
      holdMin: fc.integer({ min: 0, max: 20 }),
    }),
    fc.record({ kind: fc.constant("repeat" as const), who: fc.integer({ min: 0, max: 5 }) }),
    fc.record({
      kind: fc.constant("release" as const),
      who: fc.integer({ min: 0, max: 5 }),
      withGeneration: fc.boolean(),
      wrongGeneration: fc.boolean(),
    }),
    fc.record({ kind: fc.constant("renew" as const), who: fc.integer({ min: 0, max: 5 }) }),
    fc.record({ kind: fc.constant("tick" as const), minutes: fc.integer({ min: 1, max: 15 }) }),
  ) as fc.Arbitrary<Op>,
  { maxLength: 60 },
);

/** Requester i is run r<i>'s attempt 1: each identity asks at most once (receipts answer the rest). */
const refOf = (who: number): OwnerRef => ({ runId: `r${who}`, ownerKey: "a1" });

describe("concurrency registry properties", () => {
  it("holds its invariants under random interleavings", () => {
    fc.assert(
      fc.property(ops, (sequence) => {
        let now = 0;
        let generation = 0;
        const leases = new Map<string, number>();
        const receipts = new Map<number, Receipt>();
        /** What each owner was told it holds: renew's answer, or a fresh lease on becoming owner. */
        const granted = new Map<string, number>();
        let group: GroupState | null = null;
        let lastGeneration = 0;
        const ctx = (): ConcurrencyContext => ({
          now,
          leaseMs: LEASE,
          nextGeneration: () => ++generation,
          leaseExpiry: (runId) => leases.get(runId),
        });
        const apply = (out: {
          group: GroupState | null;
          receipts: readonly { ref: OwnerRef; receipt: Receipt }[];
          leaseGrants: readonly string[];
        }) => {
          const before = group?.owner;
          const after = out.group?.owner;
          if (after && (!before || !sameRef(before.ref, after.ref))) {
            // Every new owner takes a larger generation.
            expect(after.generation).toBeGreaterThan(lastGeneration);
            lastGeneration = after.generation;
          }
          if (before && (!after || !sameRef(before.ref, after.ref))) {
            const evicted = out.receipts.find(
              (r) => sameRef(r.ref, before.ref) && r.receipt.outcome === "evicted",
            );
            if (evicted) {
              // Never evicted before its deadline, nor before a lease it was granted.
              expect(before.releaseDeadline).not.toBeNull();
              expect(now).toBeGreaterThanOrEqual(before.releaseDeadline as number);
              expect(now).toBeGreaterThanOrEqual(granted.get(before.ref.runId) ?? 0);
            }
          }
          for (const r of out.receipts) receipts.set(Number(r.ref.runId.slice(1)), r.receipt);
          for (const runId of out.leaseGrants) {
            leases.set(runId, Math.max(leases.get(runId) ?? 0, now + LEASE));
            granted.set(runId, leases.get(runId) as number);
          }
          group = out.group;
        };

        for (const op of sequence) {
          switch (op.kind) {
            case "acquire": {
              if (receipts.has(op.who)) break; // an identity asks once; "repeat" covers retries
              apply(
                acquire(
                  group,
                  "g",
                  refOf(op.who),
                  {
                    name: "G",
                    cancelInProgress: op.cancelInProgress,
                    holdMs: op.holdMin * MIN,
                  },
                  undefined,
                  ctx(),
                ),
              );
              break;
            }
            case "repeat": {
              const known = receipts.get(op.who);
              if (!known) break;
              const before = group;
              const out = acquire(
                group,
                "g",
                refOf(op.who),
                { name: "G", cancelInProgress: true, holdMs: 0 },
                known,
                ctx(),
              );
              expect(out.group).toBe(before);
              expect(out.receipt).toEqual(known);
              break;
            }
            case "release": {
              const current = group as GroupState | null;
              const isParty =
                (current?.owner && sameRef(current.owner.ref, refOf(op.who))) ||
                (current?.pending && sameRef(current.pending.ref, refOf(op.who)));
              const gen = op.withGeneration
                ? (current?.owner?.generation ?? 0) + (op.wrongGeneration ? 1 : 0)
                : undefined;
              const out = release(current, refOf(op.who), gen, ctx());
              // Strangers, and an owner naming another generation, change nothing.
              const wrongGen =
                current?.owner &&
                sameRef(current.owner.ref, refOf(op.who)) &&
                gen !== undefined &&
                gen !== current.owner.generation;
              if (!isParty || wrongGen) expect(out.group).toBe(current);
              apply(out);
              break;
            }
            case "renew": {
              const current = group as GroupState | null;
              const owner = current?.owner;
              if (owner && sameRef(owner.ref, refOf(op.who))) {
                const lease = Math.max(leases.get(owner.ref.runId) ?? 0, now + LEASE);
                leases.set(owner.ref.runId, lease);
                const answer = renewScope(current, owner.ref, owner.generation, lease);
                if (answer.ok) granted.set(owner.ref.runId, answer.grantedUntil);
              }
              break;
            }
            case "tick":
              now += op.minutes * MIN;
              apply(settle(group, ctx()));
              break;
          }
          const current = group as GroupState | null;
          // One owner, distinct from the pending requester; no pending requester without an owner.
          if (current?.pending) {
            expect(current.owner).not.toBeNull();
            expect(sameRef(current.pending.ref, current.owner?.ref as OwnerRef)).toBe(false);
          }
          // Receipts agree with the group: only the owner holds an "owner" receipt, with its generation.
          for (const [who, receipt] of receipts) {
            const isOwner = current?.owner && sameRef(current.owner.ref, refOf(who));
            if (receipt.outcome === "owner") {
              expect(isOwner).toBe(true);
              expect(receipt.generation).toBe(current?.owner?.generation);
            }
            if (receipt.outcome === "pending")
              expect(current?.pending && sameRef(current.pending.ref, refOf(who))).toBe(true);
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});
