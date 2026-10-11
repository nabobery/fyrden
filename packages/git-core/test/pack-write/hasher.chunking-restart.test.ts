import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { concatBytes } from "../../src/object/bytes.js";
import { PackBuilder } from "../../src/pack-write/pack-builder.js";
import { createGitSandbox } from "../../testing/git-cli.js";
import { buildRepo, packObjects } from "../pack/repo-fixture.js";
import { budget, hex, memorySink, objectsOf, type ParsedObjects, zlib } from "./support.js";

/*
 * Writer half of the streaming SHA-1 invariant: a pack writer that is
 * checkpointed and restarted (as an alarm-sliced writer is after an
 * eviction) produces the same bytes, trailer and `.idx` as one that runs
 * straight through, whatever the output chunk size and wherever it stops.
 * The hasher half (any chunking of the input) is in test/hash.
 */

let objects: ParsedObjects["objects"];
beforeAll(async () => {
  const repo = await createGitSandbox();
  try {
    await buildRepo(repo, { seed: 21, commits: 25, files: 5, binaryBytes: 2000 });
    ({ objects } = await objectsOf(await packObjects(repo, { ofsDelta: true })));
  } finally {
    await repo.dispose();
  }
});

async function straight(chunkBytes: number) {
  const sink = memorySink();
  const builder = await PackBuilder.start(objects.length, {
    sink,
    zlib,
    memory: budget(),
    chunkBytes,
  });
  for (const o of objects) await builder.addObject(o.type, o.data, o.oid);
  const done = await builder.finish();
  return { bytes: sink.bytes(), idx: done.idx.bytes, checksum: done.checksum };
}

describe("hasher.chunking-restart (writer)", () => {
  it("a writer restarted from checkpoints gives the same pack, trailer and .idx", async () => {
    const reference = await straight(64 * 1024);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4096 }),
        fc.uniqueArray(fc.integer({ min: 0, max: objects.length }), { maxLength: 6 }),
        async (chunkBytes, stops) => {
          const stopAt = new Set(stops);
          const parts: Uint8Array[] = [];
          let sink = memorySink();
          let builder = await PackBuilder.start(objects.length, {
            sink,
            zlib,
            memory: budget(),
            chunkBytes,
          });
          for (let i = 0; i <= objects.length; i++) {
            if (stopAt.has(i)) {
              // Persist the checkpoint as bytes, drop the builder, and resume
              // with a new sink, as after an eviction.
              const saved = new Uint8Array(await builder.checkpoint());
              parts.push(sink.bytes());
              sink = memorySink();
              builder = await PackBuilder.resume(saved, {
                sink,
                zlib,
                memory: budget(),
                chunkBytes,
              });
              expect(builder.count).toBe(i);
            }
            const o = objects[i];
            if (o) await builder.addObject(o.type, o.data, o.oid);
          }
          const done = await builder.finish();
          parts.push(sink.bytes());
          expect(hex(concatBytes(parts))).toBe(hex(reference.bytes));
          expect(hex(done.checksum)).toBe(hex(reference.checksum));
          expect(hex(done.idx.bytes)).toBe(hex(reference.idx));
        },
      ),
      { numRuns: 40 },
    );
  });

  it("the trailer does not depend on the output chunk size", async () => {
    const a = await straight(1);
    const b = await straight(3);
    const c = await straight(1 << 20);
    expect(hex(a.bytes)).toBe(hex(c.bytes));
    expect(hex(b.bytes)).toBe(hex(c.bytes));
  });

  it("rejects a damaged checkpoint with a typed error", async () => {
    const builder = await PackBuilder.start(objects.length, {
      sink: memorySink(),
      zlib,
      memory: budget(),
    });
    for (const o of objects.slice(0, 5)) await builder.addObject(o.type, o.data, o.oid);
    const saved = await builder.checkpoint();
    for (const cut of [0, 3, saved.length - 1]) {
      await expect(
        PackBuilder.resume(saved.subarray(0, cut), { sink: memorySink(), zlib, memory: budget() }),
      ).rejects.toMatchObject({ code: "bad-checkpoint" });
    }
    const wrongVersion = new Uint8Array(saved);
    wrongVersion[4] = 99;
    await expect(
      PackBuilder.resume(wrongVersion, { sink: memorySink(), zlib, memory: budget() }),
    ).rejects.toMatchObject({ code: "bad-checkpoint" });
  });

  it("refuses to checkpoint when its hasher cannot save state", async () => {
    const builder = await PackBuilder.start(1, {
      sink: memorySink(),
      zlib,
      memory: budget(),
      createHasher: () => ({ update: async () => {}, digest: async () => new Uint8Array(20) }),
    });
    await expect(builder.checkpoint()).rejects.toMatchObject({ code: "not-resumable" });
  });
});
