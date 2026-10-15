// Workers memory is 128 MB per isolate and shared by every request a Durable
// Object serves, so heavy operations reserve from the object's operation
// pool first. Overlapping maximum-size operations must wait or spill, never
// run together past the pool, and never reset the object.
import { DO_MEMORY, withReservation } from "@fyrden/adapters-cloudflare/git";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
// biome-ignore lint/style/noRestrictedImports: the wait keeps a reservation held while the others queue; how long it lasts does not change the outcome (one at a time).
import { inRepo, newRepo, signal, sleep } from "./helpers/repo-git.js";

const POOL = DO_MEMORY.operationPoolBytes;

/** Marks the live instance, so a reset (a new instance) is detectable. */
const marks = new WeakMap<RepoDO, string>();

describe("RepoDO memory admission", () => {
  it("runs overlapping maximum-size operations one at a time, allocating for real", async () => {
    const { stub } = await newRepo();
    const mark = crypto.randomUUID();
    await inRepo(stub, (repo) => {
      marks.set(repo, mark);
    });
    let running = 0;
    let mostAtOnce = 0;
    const operation = () =>
      inRepo(stub, (repo) =>
        withReservation(repo.git.memory, POOL, 30_000, async () => {
          running++;
          mostAtOnce = Math.max(mostAtOnce, running);
          // The reserved bytes, actually allocated and touched.
          const working = new Uint8Array(POOL);
          working.fill(1);
          await sleep(10);
          running--;
          return working.length;
        }),
      );
    const results = await Promise.all([operation(), operation(), operation()]);
    expect(results).toEqual(Array(3).fill({ admitted: true, value: POOL }));
    expect(mostAtOnce).toBe(1);
    const after = await inRepo(stub, (repo) => ({
      sameInstance: marks.get(repo) === mark,
      stats: repo.git.memory.stats(),
    }));
    expect(after.sameInstance).toBe(true);
    expect(after.stats).toEqual({
      totalBytes: POOL,
      reservedBytes: 0,
      peakBytes: POOL,
      waiting: 0,
    });
  });

  it("lets an operation spill instead of waiting when the pool is full", async () => {
    const { stub } = await newRepo();
    const holding = signal();
    const done = signal();
    const big = inRepo(stub, (repo) =>
      withReservation(repo.git.memory, POOL, 0, async () => {
        holding.open();
        await done.wait();
        return "ran";
      }),
    );
    await holding.wait();
    const [spilled, timedOut] = await Promise.all([
      inRepo(stub, (repo) => withReservation(repo.git.memory, POOL / 2, 0, async () => "ran")),
      inRepo(stub, (repo) => withReservation(repo.git.memory, POOL / 2, 20, async () => "ran")),
    ]);
    expect(spilled).toEqual({ admitted: false });
    expect(timedOut).toEqual({ admitted: false });
    done.open();
    expect(await big).toEqual({ admitted: true, value: "ran" });
    // With the pool free again, the same operation is admitted.
    expect(
      await inRepo(stub, (repo) =>
        withReservation(repo.git.memory, POOL / 2, 0, async () => "ran"),
      ),
    ).toEqual({ admitted: true, value: "ran" });
  });

  it("refuses a reservation larger than the pool instead of attempting it", async () => {
    const { stub } = await newRepo();
    await expect(
      inRepo(stub, (repo) => withReservation(repo.git.memory, POOL + 1, 0, async () => "ran")),
    ).rejects.toThrow(/exceed the whole budget/);
  });
});
