// A concurrency group's rules: one owner, at most one pending owner that a
// newcomer displaces, cancel-in-progress, one answer per request, release
// by identity, and an owner that never answers evicted only after its
// granted lease and its hold.
import { describe, expect, it } from "vitest";
import {
  acquire,
  type ConcurrencyContext,
  type GroupState,
  type OwnerRef,
  release,
  renewScope,
  settle,
} from "../../src/ci/concurrency.js";

const MIN = 60_000;
const ref = (runId: string, ownerKey = "a1"): OwnerRef => ({ runId, ownerKey });

/** A context with a clock, a generation counter and per-run leases the test sets. */
function context(now = 0) {
  let generation = 0;
  const leases = new Map<string, number>();
  let clock = now;
  const ctx: ConcurrencyContext & { leases: Map<string, number>; at(t: number): void } = {
    get now() {
      return clock;
    },
    leaseMs: 10 * MIN,
    nextGeneration: () => ++generation,
    leaseExpiry: (runId) => leases.get(runId),
    leases,
    at(t) {
      clock = t;
    },
  };
  return ctx;
}

const opts = (cancelInProgress = false, holdMs = 6 * MIN) => ({
  name: "Deploy",
  cancelInProgress,
  holdMs,
});

describe("acquire", () => {
  it("makes the first requester the owner, with a new generation and a lease grant", () => {
    const ctx = context();
    const out = acquire(null, "deploy", ref("A"), opts(), undefined, ctx);
    expect(out.receipt).toEqual({ outcome: "owner", generation: 1 });
    expect(out.group?.owner).toMatchObject({ ref: ref("A"), generation: 1 });
    expect(out.leaseGrants).toEqual(["A"]);
    expect(out.signals).toEqual([]);
  });

  it("answers a repeated request with its receipt and changes nothing", () => {
    const ctx = context();
    const first = acquire(null, "deploy", ref("A"), opts(), undefined, ctx);
    const second = acquire(first.group, "deploy", ref("B"), opts(), undefined, ctx);
    const again = acquire(second.group, "deploy", ref("B"), opts(), second.receipt, ctx);
    expect(again.receipt).toEqual({ outcome: "pending", generation: null });
    expect(again.group).toEqual(second.group);
    expect(again.receipts).toEqual([]);
    expect(again.signals).toEqual([]);
  });

  it("queues a newcomer as the single pending owner and displaces the older one", () => {
    const ctx = context();
    let g = acquire(null, "deploy", ref("A"), opts(), undefined, ctx).group;
    const b = acquire(g, "deploy", ref("B"), opts(), undefined, ctx);
    expect(b.receipt.outcome).toBe("pending");
    g = b.group;
    const c = acquire(g, "deploy", ref("C"), opts(), undefined, ctx);
    expect(c.receipt.outcome).toBe("pending");
    expect(c.group?.pending?.ref).toEqual(ref("C"));
    expect(c.receipts).toContainEqual({
      ref: ref("B"),
      receipt: { outcome: "displaced", generation: null },
    });
    expect(c.signals).toContainEqual({ ref: ref("B"), kind: "displaced", generation: 0 });
  });

  it("does not let a displaced requester displace its displacer: its receipt answers", () => {
    const ctx = context();
    let g = acquire(null, "deploy", ref("A"), opts(), undefined, ctx).group;
    g = acquire(g, "deploy", ref("B"), opts(), undefined, ctx).group;
    const c = acquire(g, "deploy", ref("C"), opts(), undefined, ctx);
    const bAgain = acquire(
      c.group,
      "deploy",
      ref("B"),
      opts(),
      { outcome: "displaced", generation: null },
      ctx,
    );
    expect(bAgain.receipt.outcome).toBe("displaced");
    expect(bAgain.group?.pending?.ref).toEqual(ref("C"));
  });

  it("with cancel-in-progress asks the owner to cancel, deadline no earlier than its lease", () => {
    const ctx = context();
    const a = acquire(null, "deploy", ref("A"), opts(false, 1 * MIN), undefined, ctx);
    ctx.leases.set("A", 10 * MIN);
    const b = acquire(a.group, "deploy", ref("B"), opts(true), undefined, ctx);
    expect(b.signals).toContainEqual({ ref: ref("A"), kind: "cancel", generation: 1 });
    // A one-minute hold would end at minute 1; the lease granted to A runs to minute 10.
    expect(b.group?.owner).toMatchObject({ cancelRequestedAt: 0, releaseDeadline: 10 * MIN });
  });

  it("keeps the hold when it ends after the lease", () => {
    const ctx = context();
    const a = acquire(null, "deploy", ref("A"), opts(false, 30 * MIN), undefined, ctx);
    ctx.leases.set("A", 10 * MIN);
    const b = acquire(a.group, "deploy", ref("B"), opts(true), undefined, ctx);
    expect(b.group?.owner?.releaseDeadline).toBe(30 * MIN);
  });
});

describe("release", () => {
  function held(ctx: ReturnType<typeof context>): GroupState {
    let g = acquire(null, "deploy", ref("A"), opts(), undefined, ctx).group;
    g = acquire(g, "deploy", ref("B"), opts(), undefined, ctx).group;
    if (!g) throw new Error("no group");
    return g;
  }

  it("promotes the pending owner with a new generation and an acquired signal", () => {
    const ctx = context();
    const out = release(held(ctx), ref("A"), 1, ctx);
    expect(out.group?.owner).toMatchObject({ ref: ref("B"), generation: 2, holdMs: 6 * MIN });
    expect(out.group?.pending).toBeNull();
    expect(out.receipts).toEqual([
      { ref: ref("A"), receipt: { outcome: "released", generation: 1 } },
      { ref: ref("B"), receipt: { outcome: "owner", generation: 2 } },
    ]);
    expect(out.signals).toEqual([{ ref: ref("B"), kind: "acquired", generation: 2 }]);
    expect(out.leaseGrants).toEqual(["B"]);
  });

  it("frees the group when nobody waits (the row goes)", () => {
    const ctx = context();
    const g = acquire(null, "deploy", ref("A"), opts(), undefined, ctx).group;
    expect(release(g, ref("A"), 1, ctx).group).toBeNull();
  });

  it("ignores a release from an older owner or with another generation", () => {
    const ctx = context();
    const g = held(ctx);
    const stale = release(g, ref("A", "a0"), undefined, ctx);
    expect(stale.group).toEqual(g);
    expect(stale.receipts).toEqual([]);
    expect(release(g, ref("A"), 7, ctx).group).toEqual(g);
  });

  it("releases by identity without a generation: an owner promoted before its withdrawal landed", () => {
    const ctx = context();
    const promoted = release(held(ctx), ref("A"), 1, ctx).group;
    const out = release(promoted, ref("B"), undefined, ctx);
    expect(out.group).toBeNull();
    expect(out.receipts).toEqual([
      { ref: ref("B"), receipt: { outcome: "released", generation: 2 } },
    ]);
  });

  it("withdraws a pending owner", () => {
    const ctx = context();
    const out = release(held(ctx), ref("B"), undefined, ctx);
    expect(out.group?.pending).toBeNull();
    expect(out.group?.owner?.ref).toEqual(ref("A"));
    expect(out.receipts).toEqual([
      { ref: ref("B"), receipt: { outcome: "released", generation: null } },
    ]);
  });
});

describe("renew", () => {
  it("extends an owner's grant to its run's lease and reports a requested cancel", () => {
    const ctx = context();
    const g = acquire(null, "deploy", ref("A"), opts(), undefined, ctx).group;
    expect(renewScope(g, ref("A"), 1, 20 * MIN)).toEqual({
      ok: true,
      grantedUntil: 20 * MIN,
      cancelRequested: false,
    });
  });

  it("caps a cancelling owner's grant at its release deadline", () => {
    const ctx = context();
    const a = acquire(null, "deploy", ref("A"), opts(false, 1 * MIN), undefined, ctx);
    ctx.leases.set("A", 10 * MIN);
    const g = acquire(a.group, "deploy", ref("B"), opts(true), undefined, ctx).group;
    expect(renewScope(g, ref("A"), 1, 40 * MIN)).toEqual({
      ok: true,
      grantedUntil: 10 * MIN,
      cancelRequested: true,
    });
  });

  it("answers lost to anyone but the owner with its generation", () => {
    const ctx = context();
    const g = acquire(null, "deploy", ref("A"), opts(), undefined, ctx).group;
    expect(renewScope(g, ref("A"), 2, 20 * MIN)).toEqual({ ok: false });
    expect(renewScope(g, ref("Z"), 1, 20 * MIN)).toEqual({ ok: false });
    expect(renewScope(null, ref("A"), 1, 20 * MIN)).toEqual({ ok: false });
  });
});

describe("settle", () => {
  it("asks an owner whose lease expired to cancel; deadline = expiry + hold", () => {
    const ctx = context();
    const g = acquire(null, "deploy", ref("A"), opts(false, 6 * MIN), undefined, ctx).group;
    ctx.leases.set("A", 10 * MIN);
    ctx.at(10 * MIN);
    const out = settle(g, ctx);
    expect(out.signals).toEqual([{ ref: ref("A"), kind: "cancel", generation: 1 }]);
    expect(out.group?.owner).toMatchObject({
      cancelRequestedAt: 10 * MIN,
      releaseDeadline: 16 * MIN,
    });
  });

  it("does not promote while the old owner may still answer", () => {
    const ctx = context();
    let g = acquire(null, "deploy", ref("A"), opts(false, 6 * MIN), undefined, ctx).group;
    g = acquire(g, "deploy", ref("B"), opts(), undefined, ctx).group;
    ctx.leases.set("A", 10 * MIN);
    ctx.at(10 * MIN);
    g = settle(g, ctx).group;
    ctx.at(15 * MIN);
    const out = settle(g, ctx);
    expect(out.group?.owner?.ref).toEqual(ref("A"));
    expect(out.signals).toEqual([]);
  });

  it("evicts once the deadline passes and promotes the pending owner", () => {
    const ctx = context();
    let g = acquire(null, "deploy", ref("A"), opts(false, 6 * MIN), undefined, ctx).group;
    g = acquire(g, "deploy", ref("B"), opts(), undefined, ctx).group;
    ctx.leases.set("A", 10 * MIN);
    ctx.at(10 * MIN);
    g = settle(g, ctx).group;
    ctx.at(16 * MIN);
    const out = settle(g, ctx);
    expect(out.group?.owner).toMatchObject({ ref: ref("B"), generation: 2 });
    expect(out.signals).toEqual([
      { ref: ref("A"), kind: "evicted", generation: 1 },
      { ref: ref("B"), kind: "acquired", generation: 2 },
    ]);
    expect(out.receipts).toContainEqual({
      ref: ref("A"),
      receipt: { outcome: "evicted", generation: 1 },
    });
  });

  it("changes nothing for a live owner", () => {
    const ctx = context();
    const g = acquire(null, "deploy", ref("A"), opts(), undefined, ctx).group;
    ctx.leases.set("A", 10 * MIN);
    ctx.at(5 * MIN);
    expect(settle(g, ctx)).toEqual({ group: g, receipts: [], signals: [], leaseGrants: [] });
  });
});
