import { describe, expect, it } from "vitest";
import { PackBuilder } from "../../src/pack-write/pack-builder.js";
import type { MemoryBudget } from "../../src/ports/memory-budget.js";
import { text } from "../pack/pack-builder.js";
import { trackingBudget } from "../pack/parse-helpers.js";
import { zlib } from "./support.js";

/*
 * A writer that fails while it is being set up never reaches its caller, so
 * it must return what it reserved itself: a resume whose table restore
 * cannot get memory, or a start whose header write fails, leaves the shared
 * pool as it found it, and a retry against the same pool succeeds.
 */

const sink = { async write() {} };

/** A budget whose `reserve` fails once, on call number `failAt` (1-based). */
function failingOnce(inner: MemoryBudget, failAt: number): MemoryBudget {
  let calls = 0;
  return {
    async reserve(bytes, signal) {
      calls++;
      if (calls === failAt) throw new Error("the repository is busy");
      return inner.reserve(bytes, signal);
    },
    tryReserve: (bytes) => inner.tryReserve(bytes),
  };
}

async function checkpointOfThree(): Promise<Uint8Array> {
  const memory = trackingBudget(1024 * 1024);
  const builder = await PackBuilder.start(5, { sink, zlib, memory, chunkBytes: 4096 });
  for (const name of ["a", "b", "c"]) await builder.addObject("blob", text(name));
  const saved = await builder.checkpoint();
  builder.release();
  expect(memory.held()).toBe(0);
  return saved;
}

describe("pack writer: failed setup", () => {
  it.each([
    ["the entry table", 2],
    ["the output chunk", 1],
  ])("resume returns its reservations when %s cannot be reserved", async (_, failAt) => {
    const saved = await checkpointOfThree();
    const pool = trackingBudget(1024 * 1024);
    const options = { sink, zlib, chunkBytes: 4096 };
    await expect(
      PackBuilder.resume(saved, { ...options, memory: failingOnce(pool, failAt) }),
    ).rejects.toThrow("busy");
    expect(pool.held()).toBe(0);

    const retried = await PackBuilder.resume(saved, { ...options, memory: pool });
    expect(retried.count).toBe(3);
    retried.release();
    expect(pool.held()).toBe(0);
  });

  it("start returns its reservation when the header cannot be written", async () => {
    const pool = trackingBudget(1024 * 1024);
    const broken = {
      async write(): Promise<void> {
        throw new Error("store unavailable");
      },
    };
    await expect(
      PackBuilder.start(1, { sink: broken, zlib, memory: pool, chunkBytes: 12 }),
    ).rejects.toThrow("store unavailable");
    expect(pool.held()).toBe(0);
  });
});
