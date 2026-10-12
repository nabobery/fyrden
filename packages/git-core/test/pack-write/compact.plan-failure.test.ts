import { describe, expect, it } from "vitest";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { Compaction, type CompactionSource } from "../../src/pack-write/compact.js";
import type { PackRangeRead } from "../../src/pack-write/window-reader.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { buildPack, text } from "../pack/pack-builder.js";
import { parseBytes, trackingBudget } from "../pack/parse-helpers.js";
import { memorySink, zlib } from "./support.js";

/*
 * Planning a compaction reads the entry headers of objects stored in more
 * than one source, through the compaction's read window. When that read
 * fails, the caller gets no compaction to release, so the factory returns
 * the window's memory itself; a retry against the same pool then succeeds
 * and gives everything back.
 */

async function overlappingSources() {
  const repo = createMemoryRepoStore();
  const sources: CompactionSource[] = [];
  for (const names of [
    ["shared", "one"],
    ["shared", "two"],
  ]) {
    const bytes = buildPack(
      names.map((n) => ({ kind: "blob" as const, data: text(`${n}\n`) })),
    ).bytes;
    const { pack } = await parseBytes(bytes);
    const idx = await writeIdx(pack.entries, pack.checksum, {
      createHasher: () => createSha1Hasher({ detectCollisions: false }),
    });
    pack.release();
    const writer = repo.packStore.beginPack();
    await writer.write(bytes);
    const info = await writer.finish();
    sources.push({ packId: info.packId, packLength: bytes.length, idx: PackIdx.parse(idx.bytes) });
  }
  const read: PackRangeRead = (packId, offset, length) =>
    repo.packStore.openRange(packId, offset, length);
  return { sources, read };
}

describe("compaction: planning failure", () => {
  it("returns the read window when a duplicate's header cannot be read, for start and resume", async () => {
    const { sources, read } = await overlappingSources();
    const pool = trackingBudget(64 * 1024 * 1024);
    const failing: PackRangeRead = async () => {
      throw new Error("R2 unavailable");
    };
    const options = { sink: memorySink(), zlib, memory: pool, readBytes: 4096 };

    await expect(Compaction.start(sources, { ...options, read: failing })).rejects.toThrow(
      "R2 unavailable",
    );
    expect(pool.held()).toBe(0);

    const first = await Compaction.start(sources, { ...options, read });
    const checkpoint = await first.checkpoint();
    first.release();
    expect(pool.held()).toBe(0);

    await expect(
      Compaction.resume(sources, checkpoint, { ...options, read: failing }),
    ).rejects.toThrow("R2 unavailable");
    expect(pool.held()).toBe(0);

    const retried = await Compaction.start(sources, { ...options, read });
    expect(await retried.run()).toBe(true);
    const done = await retried.finish();
    expect(done.objectCount).toBe(3);
    done.release();
    expect(pool.held()).toBe(0);
  });
});
