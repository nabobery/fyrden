// Garbage collection as alarm slices: cut into many slices, with cursors
// lost to resets and refs moving during the run, it ends with what an
// uninterrupted run against the final refs would leave. git's
// `rev-list --objects` is the oracle.
import { LOCK_REF_COMMIT } from "@fyrden/adapters-cloudflare/git";
import { oidFromHex } from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import { DAY, expectSorted, gcRepo, minus, moveRef, objectsIn } from "./helpers/gc.js";
import { advance, runJob, setPolicy } from "./helpers/maintenance.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");

const phase = (stub: Awaited<ReturnType<typeof gcRepo>>["stub"]) =>
  inRepo(stub, ({ git }) => {
    const cursor = git.jobs.get("gc")?.cursor;
    return cursor
      ? (JSON.parse(new TextDecoder().decode(cursor)) as { phase: string }).phase
      : null;
  });

describe("garbage collection across slices", () => {
  it("cut into many slices, with lost cursors, it ends as an uncut run would", async () => {
    const { stub } = await gcRepo(fx.packs);
    await moveRef(stub, "refs/heads/side", fx.side, null);
    await moveRef(stub, "refs/heads/feature", fx.f2, fx.rewritten);
    await advance(stub, 91 * DAY);
    await setPolicy(stub, { sliceObjects: 3 });
    let saved: ArrayBuffer | null = null;
    let rolledBack = 0;
    const run = await runJob(stub, "gc", {
      max: 1_000,
      between: async (slice) => {
        await inRepo(stub, ({ git }) => {
          const job = git.jobs.get("gc");
          if (slice % 4 === 0 && saved !== null && job?.state === "queued" && job.cursor !== null) {
            git.context.storage.sql
              .exec("UPDATE jobs SET cursor = ? WHERE job_id = 'gc'", saved)
              .toArray();
            rolledBack++;
            return;
          }
          saved = job?.cursor ? new Uint8Array(job.cursor).buffer : null;
        });
      },
    });
    expect(["done", "scheduled"]).toContain(run.state);
    expect(run.slices).toBeGreaterThan(20);
    expect(rolledBack).toBeGreaterThan(3);
    expectSorted(await objectsIn(stub, "live"), fx.afterForce);
    expectSorted(await objectsIn(stub, "garbage"), minus(fx.all, fx.afterForce));
  }, 60_000);

  it("decides again when a ref moves during the run onto an object it was about to collect", async () => {
    const { stub } = await gcRepo();
    await moveRef(stub, "refs/heads/side", fx.side, null);
    await advance(stub, 91 * DAY);
    await setPolicy(stub, { sliceObjects: 3 });
    let moved = false;
    const run = await runJob(stub, "gc", {
      max: 1_000,
      between: async () => {
        if (!moved && (await phase(stub)) === "write-garbage") {
          // The run has marked and is writing the side branch's objects to garbage.
          moved = true;
          await moveRef(stub, "refs/heads/back", null, fx.side);
        }
      },
    });
    expect(moved).toBe(true);
    expect(["done", "scheduled"]).toContain(run.state);
    // Everything the refs now reach is live; only the rewritten commit (no ref, no reflog entry) is garbage.
    expectSorted(await objectsIn(stub, "live"), fx.repo.objects);
    expectSorted(await objectsIn(stub, "garbage"), minus(fx.all, fx.repo.objects));
  }, 60_000);

  // The swap's commit lock expires while it awaits R2 after its catch-up
  // walk; a push takes the lock and points a branch at an object the run
  // marked unreachable. The swap must not go ahead on its old marks.
  it("does not swap on stale marks when its lock expired and a push committed after the catch-up", async () => {
    const { stub } = await gcRepo();
    await moveRef(stub, "refs/heads/side", fx.side, null);
    await advance(stub, 91 * DAY);
    let pushed = false;
    await inRepo(stub, (repo) => {
      repo.gcHooks = {
        afterCatchUp: () => {
          if (pushed) return;
          pushed = true;
          const { git } = repo;
          const before = git.context.now;
          (git.context as { now: () => number }).now = () => before() + 31_000;
          const lock = git.locks.tryAcquire(LOCK_REF_COMMIT, "push", 30_000);
          if (!lock) throw new Error("the swap's lock did not expire");
          try {
            const result = git.refStore.commitSync({
              addPacks: [],
              removePacks: [],
              refUpdates: [{ name: "refs/heads/back", oldOid: null, newOid: oidFromHex(fx.side) }],
              expectedVersion: git.refStore.state().version,
            });
            if (!result.ok) throw new Error("the push did not commit");
          } finally {
            git.locks.release(lock);
          }
        },
      };
    });
    const run = await runJob(stub, "gc", { max: 1_000 });
    expect(pushed).toBe(true);
    expect(["done", "scheduled"]).toContain(run.state);
    // What the pushed branch reaches is live; only the rewritten commit is garbage.
    expectSorted(await objectsIn(stub, "live"), fx.repo.objects);
    expectSorted(await objectsIn(stub, "garbage"), minus(fx.all, fx.repo.objects));
  }, 60_000);
});
