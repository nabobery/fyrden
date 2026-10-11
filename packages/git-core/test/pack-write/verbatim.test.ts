import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatBytes } from "../../src/object/bytes.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import {
  duplicateObjectCount,
  type PackRangeStream,
  planVerbatimPack,
  rangeStreamFromStore,
  streamVerbatimPack,
  type VerbatimSource,
} from "../../src/pack-write/verbatim.js";
import type { PackId } from "../../src/ports/pack-store.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { gitAccepts } from "../pack/git-oracle.js";
import { buildRepo, packObjects } from "../pack/repo-fixture.js";
import { collect, gitIndexStrict, gitObjectSet, hex } from "./support.js";

/*
 * Verbatim streaming for clones: one stored pack goes out as it is; several
 * are stitched into one pack (new header, each entry region copied, new
 * trailer). git is the judge: the stitched stream of git-made packs (OFS
 * deltas inside each, thin REF deltas across them) is a valid pack holding
 * exactly their union.
 */

const sandboxes: GitSandbox[] = [];
afterAll(() => Promise.all(sandboxes.map((s) => s.dispose())));

interface StoredPack {
  source: VerbatimSource;
  bytes: Uint8Array;
}

async function store(packs: Uint8Array[]) {
  const repo = createMemoryRepoStore();
  const stored: StoredPack[] = [];
  for (const bytes of packs) {
    const writer = repo.packStore.beginPack();
    await writer.write(bytes);
    const info = await writer.finish();
    const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8);
    stored.push({
      source: { packId: info.packId, packLength: bytes.length, objectCount: count },
      bytes,
    });
  }
  return { repo, stored };
}

/** A range stream over in-memory packs that cuts its output at random points. */
function randomChunks(packs: Map<PackId, Uint8Array>, seed: number): PackRangeStream {
  let a = seed >>> 0;
  return async function* (packId, offset, length) {
    const bytes = packs.get(packId) as Uint8Array;
    let at = offset;
    while (at < offset + length) {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      const n = Math.min(1 + (a % 9000), offset + length - at);
      yield bytes.subarray(at, at + n);
      at += n;
    }
  };
}

describe("verbatim pack streaming", () => {
  let repo: GitSandbox;
  let packs: Uint8Array[];
  let union: Set<string>;
  beforeAll(async () => {
    repo = await createGitSandbox();
    sandboxes.push(repo);
    await buildRepo(repo, { seed: 5, commits: 30, files: 5, binaryBytes: 1500 });
    packs = [
      await packObjects(repo, { ofsDelta: true, revs: ["main~20"] }),
      await packObjects(repo, { ofsDelta: true, thin: true, revs: ["main~10", "^main~20"] }),
      await packObjects(repo, { ofsDelta: false, thin: true, revs: ["main", "^main~10"] }),
    ];
    union = await objectsReachable("main");
  });

  async function objectsReachable(rev: string): Promise<Set<string>> {
    const { stdout } = await repo.git(["rev-list", "--objects", rev]);
    return new Set(
      stdout
        .split("\n")
        .map((l) => l.slice(0, 40))
        .filter((l) => l.length === 40),
    );
  }

  it("the later packs are thin: they hold REF_DELTAs against the earlier ones", async () => {
    expect(await gitAccepts(repo, packs[1] as Uint8Array)).toBe(false);
    expect(await gitAccepts(repo, packs[2] as Uint8Array)).toBe(false);
  });

  it("one pack is planned as-is and streamed without hashing", async () => {
    const { repo: store1, stored } = await store([packs[0] as Uint8Array]);
    const plan = planVerbatimPack([(stored[0] as StoredPack).source]);
    expect(plan.kind).toBe("as-is");
    let hashers = 0;
    const out = await collect(
      streamVerbatimPack(plan, rangeStreamFromStore(store1.packStore, 1000), {
        createHasher: () => {
          hashers++;
          throw new Error("no hashing for an as-is pack");
        },
      }),
    );
    expect(hex(out)).toBe(hex(packs[0] as Uint8Array));
    expect(hashers).toBe(0);
  });

  it("stitches 2 and 3 git packs into a valid pack holding exactly their union", async () => {
    const empty = await createGitSandbox();
    sandboxes.push(empty);
    await empty.git(["init", "-q"]);
    for (const n of [2, 3]) {
      const { repo: s, stored } = await store(packs.slice(0, n));
      const plan = planVerbatimPack(stored.map((p) => p.source));
      expect(plan.kind).toBe("stitched");
      const out = await collect(streamVerbatimPack(plan, rangeStreamFromStore(s.packStore)));
      expect(out.length).toBe(plan.length);
      await gitIndexStrict(empty, out);
      const set = await gitObjectSet(empty, out);
      expect(new Set(set.keys())).toEqual(n === 3 ? union : await objectsReachable("main~10"));
      expect(set.size).toBe(stored.reduce((sum, p) => sum + p.source.objectCount, 0));
    }
  });

  it("the stitched bytes and trailer do not depend on how the sources are chunked", async () => {
    const { stored } = await store(packs);
    const byId = new Map(stored.map((p) => [p.source.packId, p.bytes]));
    const plan = planVerbatimPack(stored.map((p) => p.source));
    const reference = await collect(streamVerbatimPack(plan, randomChunks(byId, 1)));
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2 ** 31 }),
        fc.integer({ min: 1, max: 100_000 }),
        async (seed, minChunkBytes) => {
          const chunks: Uint8Array[] = [];
          for await (const c of streamVerbatimPack(plan, randomChunks(byId, seed), {
            minChunkBytes,
          })) {
            chunks.push(new Uint8Array(c));
          }
          // Coalesced: every chunk but the last is at least minChunkBytes.
          for (const c of chunks.slice(0, -1))
            expect(c.length).toBeGreaterThanOrEqual(minChunkBytes);
          expect(hex(concatBytes(chunks))).toBe(hex(reference));
        },
      ),
      { numRuns: 25 },
    );
  });

  it("counts objects shared between packs, and git --strict refuses a stitch that repeats one", async () => {
    const overlapping = [
      await packObjects(repo, { ofsDelta: true, revs: ["main~5"] }),
      await packObjects(repo, { ofsDelta: true, revs: ["main"] }),
    ];
    const idx = await Promise.all(
      overlapping.map(async (p) => PackIdx.parse(await gitIndexStrict(repo, p))),
    );
    const tables = idx.map((i) => i.oidTable());
    expect(duplicateObjectCount(tables)).toBe((idx[0] as PackIdx).count);
    const disjoint = await Promise.all(
      packs.slice(0, 1).map(async (p) => PackIdx.parse(await gitIndexStrict(repo, p)).oidTable()),
    );
    expect(duplicateObjectCount([...disjoint, new Uint8Array(0)])).toBe(0);

    const { repo: s, stored } = await store(overlapping);
    const out = await collect(
      streamVerbatimPack(
        planVerbatimPack(stored.map((p) => p.source)),
        rangeStreamFromStore(s.packStore),
      ),
    );
    expect(await gitAccepts(repo, out)).toBe(true);
    await expect(gitIndexStrict(repo, out)).rejects.toThrow(/appears twice/);
  });

  it("refuses an empty plan and a total count above 2^32 - 1", () => {
    expect(() => planVerbatimPack([])).toThrow(RangeError);
    const big = {
      packId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as PackId,
      packLength: 32,
      objectCount: 2 ** 31,
    };
    expect(() => planVerbatimPack([big, big])).toThrow(RangeError);
    expect(() => planVerbatimPack([{ ...big, packLength: 31 }])).toThrow(RangeError);
  });
});
