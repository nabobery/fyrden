import { afterEach, describe, expect, it } from "vitest";
import type { MemoryBudget, MemoryReservation } from "../../src/ports/memory-budget.js";
import { fetchPlanMemoryBytes, planFetch } from "../../src/upload-pack/fetch.js";
import {
  commit,
  fetchArgs,
  hexOid,
  openUploadPackRepo,
  Scratch,
  serve,
  sourceRepo,
} from "./support.js";

/*
 * A fetch plan's share of memory (`fetchPlanMemoryBytes`), which the
 * repository object reserves before the plan holds anything: what the plan
 * holds at once besides its tables and the packs' indexes.
 */

const MiB = 1024 * 1024;
const scratch = new Scratch();
afterEach(() => scratch.cleanup());

/** `memory`, recording the most it held at once. */
function recording(memory: MemoryBudget) {
  let held = 0;
  let peak = 0;
  const tracked = (reservation: MemoryReservation): MemoryReservation => {
    held += reservation.bytes;
    peak = Math.max(peak, held);
    let released = false;
    return {
      bytes: reservation.bytes,
      release() {
        if (released) return;
        released = true;
        held -= reservation.bytes;
        reservation.release();
      },
    };
  };
  const budget: MemoryBudget = {
    reserve: async (bytes, signal) => tracked(await memory.reserve(bytes, signal)),
    tryReserve: (bytes) => {
      const reservation = memory.tryReserve(bytes);
      return reservation && tracked(reservation);
    },
  };
  return { budget, peak: () => peak };
}

describe("a fetch plan's share of memory", () => {
  it("is the reader's delta-base cache, a regenerated pack's range and its writer's chunk", () => {
    expect(fetchPlanMemoryBytes()).toBe(16 * MiB + 8 * MiB + 1 * MiB);
    expect(fetchPlanMemoryBytes({ rangeBytes: MiB })).toBe(18 * MiB);
  });

  it("covers what a regenerated plan holds at once, but for its small tables", async () => {
    const source = await sourceRepo(scratch);
    await commit(source, { "a.txt": "1\n", "dir/b.txt": "b\n" }, "one");
    const second = await commit(source, { "a.txt": "2\n" }, "two");
    const tip = await commit(source, { "a.txt": "3\n", "dir/c.txt": "c\n" }, "three");
    const loaded = await openUploadPackRepo(await serve(scratch, source));
    const memory = recording(loaded.repository.memory);
    const args = fetchArgs({ wants: [hexOid(tip)], haves: [hexOid(second)] });
    const plan = await planFetch({ ...loaded.repository, memory: memory.budget }, args, {
      framing: "transport",
    });
    expect(plan.pack?.kind).toBe("regenerated");
    expect(memory.peak()).toBeGreaterThanOrEqual(fetchPlanMemoryBytes());
    expect(memory.peak() - fetchPlanMemoryBytes()).toBeLessThan(64 * 1024);
  });
});
