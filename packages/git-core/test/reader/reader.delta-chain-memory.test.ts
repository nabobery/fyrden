import { describe, expect, it } from "vitest";
import type { Zlib } from "../../src/ports/zlib.js";
import { ObjectReader } from "../../src/reader/object-reader.js";
import type { RepoView } from "../../src/reader/view.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { buildPack, encodeDelta, gitOid, type PackEntrySpec, text } from "../pack/pack-builder.js";
import { trackingBudget } from "../pack/parse-helpers.js";
import { hex, loadPack, toOid } from "./support.js";

/*
 * A cold read of a deep delta chain holds one delta program at a time: the
 * chain is found through entry headers, then each program is inflated,
 * applied and dropped, bottom up. A large program is reserved from the
 * memory budget while it is held. The chain here has eight deltas that each
 * insert just over 1 MiB of literal bytes (a pack of a few KiB, since the
 * bytes compress well); holding them all at once would be 8 MiB against a
 * 1 KiB cache.
 */

const DEPTH = 8;
/** Above the large-object size (1 MiB), from which a program is reserved on its own. */
const PROGRAM = 1024 * 1024 + 64 * 1024;
const CACHE = 1024;

/** A zlib port that records, for each inflate, its output size and the bytes reserved then. */
function watchedZlib(held: () => number): Zlib & { inflates: { size: number; held: number }[] } {
  const zlib = createNodeZlib();
  const inflates: { size: number; held: number }[] = [];
  return {
    inflates,
    inflate(input, options) {
      const out = zlib.inflate(input, options);
      inflates.push({ size: out.output.length, held: held() });
      return out;
    },
    deflate: (input, options) => zlib.deflate(input, options),
  };
}

describe("reader: deep delta chain memory", () => {
  it("inflates and applies one reserved delta program at a time", async () => {
    const base = text("base\n");
    const entries: PackEntrySpec[] = [{ kind: "blob", data: base }];
    let previous = base;
    for (let d = 1; d <= DEPTH; d++) {
      const result = new Uint8Array(PROGRAM).fill(0x60 + d);
      entries.push({
        kind: "ofs",
        base: d - 1,
        delta: encodeDelta(previous.length, result.length, [{ insert: result }]),
      });
      previous = result;
    }
    const tip = previous;
    const { bytes } = buildPack(entries);
    expect(bytes.length).toBeLessThan(64 * 1024);

    const repo = createMemoryRepoStore();
    const viewPack = await loadPack(repo.packStore, bytes);
    const view: RepoView = { scope: "net-chain", packs: [viewPack] };
    const memory = trackingBudget(64 * 1024 * 1024);
    const zlib = watchedZlib(memory.held);
    const reader = await ObjectReader.open({
      view,
      packStore: repo.packStore,
      zlib,
      memory,
      limits: { deltaBaseCacheBytes: CACHE },
    });
    try {
      const object = await reader.readObject(toOid(gitOid("blob", tip)));
      expect(hex(object?.bytes ?? new Uint8Array())).toBe(hex(tip));
    } finally {
      reader.release();
    }

    const programs = zlib.inflates.filter((i) => i.size > PROGRAM);
    expect(programs).toHaveLength(DEPTH);
    // Each program was reserved before it was inflated...
    for (const program of programs)
      expect(program.held).toBeGreaterThanOrEqual(CACHE + program.size);
    // ...and released after it was applied: never two programs at once.
    expect(memory.peak()).toBeLessThan(CACHE + 2 * PROGRAM);
    expect(memory.held()).toBe(0);
  });
});
