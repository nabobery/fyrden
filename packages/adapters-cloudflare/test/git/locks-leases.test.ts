import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LOCK_REF_COMMIT } from "../../src/git/index.js";
import { inProbe, newProbe } from "./harness.js";

// biome-ignore lint/style/noRestrictedGlobals: these tests are of lock and lease timeouts themselves; each wait outlasts the timeout under test, so a slow runner only lengthens it.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("RepoLocks", () => {
  it("grants a lock to one holder at a time and fences released handles", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, ({ git }) => {
      const a = git.locks.tryAcquire(LOCK_REF_COMMIT, "a", 60_000);
      const b = git.locks.tryAcquire(LOCK_REF_COMMIT, "b", 60_000);
      const heldBefore = a ? git.locks.isHeld(a) : false;
      if (a) git.locks.release(a);
      const c = git.locks.tryAcquire(LOCK_REF_COMMIT, "c", 60_000);
      return {
        a: !!a,
        b: !!b,
        heldBefore,
        heldAfter: a ? git.locks.isHeld(a) : true,
        renewReleased: a ? git.locks.renew(a, 60_000) : "n/a",
        c: !!c,
      };
    });
    expect(result).toEqual({
      a: true,
      b: false,
      heldBefore: true,
      heldAfter: false,
      renewReleased: undefined,
      c: true,
    });
  });

  it("hands the lock to waiters in arrival order, and times out cleanly", async () => {
    const { stub } = await newProbe();
    const order = await inProbe(stub, async ({ git }) => {
      const order: string[] = [];
      const first = git.locks.tryAcquire(LOCK_REF_COMMIT, "first", 60_000);
      const waiter = (name: string, waitMs: number) =>
        git.locks.acquire(LOCK_REF_COMMIT, name, { ttlMs: 60_000, waitMs }).then((handle) => {
          order.push(handle ? name : `${name}:busy`);
          // biome-ignore lint/style/noRestrictedGlobals: holds the lock a moment so the next waiter queues; the order asserted does not depend on how long.
          if (handle) setTimeout(() => git.locks.release(handle), 5);
        });
      const all = [
        waiter("w1", 5_000),
        waiter("w2", 5_000),
        waiter("impatient", 0),
        waiter("short", 20),
      ];
      await sleep(50);
      if (first) git.locks.release(first);
      await Promise.all(all);
      return order;
    });
    expect(order).toEqual(["impatient:busy", "short:busy", "w1", "w2"]);
  });

  it("survives eviction: a dead holder's lock blocks until it expires", async () => {
    const { stub } = await newProbe();
    // A TTL far longer than the test, so a slow run cannot let the lock
    // expire before the first check; the clock is then moved to just before
    // the expiry, and the waiter waits out the rest.
    const dead = await inProbe(
      stub,
      ({ git }) => git.locks.tryAcquire(LOCK_REF_COMMIT, "dies", 10 * 60_000)?.expiresAt,
    );
    if (dead === undefined) throw new Error("lock not taken");
    await evictDurableObject(stub);
    const result = await inProbe(stub, async ({ git }) => {
      const now = git.locks.tryAcquire(LOCK_REF_COMMIT, "next", 60_000);
      const offset = dead - 50 - Date.now();
      (git.context as { now: () => number }).now = () => Date.now() + offset;
      const later = await git.locks.acquire(LOCK_REF_COMMIT, "next", {
        ttlMs: 60_000,
        waitMs: 5_000,
      });
      return { now: !!now, later: later?.holder };
    });
    expect(result).toEqual({ now: false, later: "next" });
  });

  it("withLock releases even when the work throws", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      let threw = false;
      try {
        await git.locks.withLock("maintenance", "job", { ttlMs: 60_000, waitMs: 0 }, async () => {
          throw new Error("boom");
        });
      } catch {
        threw = true;
      }
      return { threw, free: !!git.locks.tryAcquire("maintenance", "next", 1_000) };
    });
    expect(result).toEqual({ threw: true, free: true });
  });
});

describe("PackLeases", () => {
  it("leases readable packs, refuses condemned ones, and expires", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const writer = git.packStore.beginPack();
      await writer.finish();
      const pending = git.packStore.beginPack();
      const lease = git.leases.grant("read", [writer.packId], "clone-1", 50);
      const leasedNow = git.leases.leased([writer.packId]).has(writer.packId);
      const unreadable = git.leases.grant("read", [pending.packId], "clone-1", 50);
      await sleep(80);
      const leasedLater = git.leases.leased([writer.packId]).has(writer.packId);
      const renewExpired = lease.ok ? git.leases.renew(lease.leaseId, 1_000) : "n/a";
      git.registry.transition(writer.packId, ["indexing"], "condemned");
      const condemned = git.leases.grant("read", [writer.packId], "clone-2", 1_000);
      return { lease: lease.ok, leasedNow, unreadable, leasedLater, renewExpired, condemned };
    });
    expect(result.lease).toBe(true);
    expect(result.leasedNow).toBe(true);
    expect(result.unreadable).toMatchObject({ ok: false, reason: "unreadable" });
    expect(result.leasedLater).toBe(false);
    expect(result.renewExpired).toBeUndefined();
    expect(result.condemned).toMatchObject({ ok: false, reason: "condemned" });
  });
});
