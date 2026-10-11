import { describe, expect, it } from "vitest";
import { PackBuilder } from "../../src/pack-write/pack-builder.js";
import { trackingBudget } from "../pack/parse-helpers.js";
import { prng } from "../pack/repo-fixture.js";
import { zlib } from "./support.js";

/*
 * Writing 10,000 objects (about 10 MB of incompressible data) holds the
 * output chunk, the per-entry table and the `.idx`, never the pack: the
 * tracked peak stays far below the pack's size, and everything is returned.
 */

const N = 10_000;
const OBJECT_BYTES = 1000;
const CHUNK = 64 * 1024;

describe("pack writer memory", () => {
  it("writes 10k objects without holding the pack", async () => {
    const memory = trackingBudget(64 * 1024 * 1024);
    const rand = prng(1);
    let written = 0;
    const builder = await PackBuilder.start(N, {
      sink: {
        async write(chunk) {
          written += chunk.length;
        },
      },
      zlib,
      memory,
      chunkBytes: CHUNK,
    });
    const data = new Uint8Array(OBJECT_BYTES);
    for (let i = 0; i < N; i++) {
      for (let b = 0; b < OBJECT_BYTES; b++) data[b] = Math.floor(rand() * 256);
      await builder.addObject("blob", data);
    }
    const done = await builder.finish();
    expect(written).toBe(done.packLength);
    expect(done.packLength).toBeGreaterThan(N * OBJECT_BYTES);

    // Entry table (32 B/entry, up to twice that while it grows), the idx
    // writer's scratch (8 B/entry) and output (28 B/entry plus 1,072 B),
    // and one output chunk.
    const bound = CHUNK + N * (2 * 32 + 8 + 28) + 2048;
    expect(memory.peak()).toBeLessThanOrEqual(bound);
    expect(memory.peak()).toBeLessThan(done.packLength / 8);
    done.release();
    expect(memory.held()).toBe(0);
  });
});
