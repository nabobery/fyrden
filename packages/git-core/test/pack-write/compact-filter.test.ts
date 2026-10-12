import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BitSet } from "../../src/graph/bitset.js";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { concatBytes } from "../../src/object/bytes.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { Compaction, type CompactionSource, compactPacks } from "../../src/pack-write/compact.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { gitAccepts } from "../pack/git-oracle.js";
import { parseBytes } from "../pack/parse-helpers.js";
import { buildRepo, packObjects } from "../pack/repo-fixture.js";
import {
  budget,
  gitIndexStrict,
  gitObjectSet,
  hex,
  memorySink,
  objectsOf,
  type ParsedObjects,
  zlib,
} from "./support.js";

/*
 * Compaction with a keep set per source: only the entries whose `.idx`
 * position is set are written (what garbage collection uses to split live
 * packs into reachable and unreachable objects). A kept delta whose base is
 * not kept is written whole, so every output is self-contained; git judges
 * each output.
 */

const sandboxes: GitSandbox[] = [];
afterAll(() => Promise.all(sandboxes.map((s) => s.dispose())));
async function sandbox(): Promise<GitSandbox> {
  const s = await createGitSandbox();
  sandboxes.push(s);
  return s;
}

type Lookup = ParsedObjects["byOid"];

async function storePacks(packs: Uint8Array[], objects: Lookup) {
  const repo = createMemoryRepoStore();
  const sources: CompactionSource[] = [];
  for (const bytes of packs) {
    const { pack } = await parseBytes(bytes, {
      externalBase: async (oid) => objects.get(hex(oid)),
    });
    const idx = await writeIdx(pack.entries, pack.checksum, {
      createHasher: () => createSha1Hasher({ detectCollisions: false }),
    });
    pack.release();
    const writer = repo.packStore.beginPack();
    await writer.write(bytes);
    const info = await writer.finish();
    sources.push({ packId: info.packId, packLength: bytes.length, idx: PackIdx.parse(idx.bytes) });
  }
  const read = repo.packStore.openRange.bind(repo.packStore);
  const resolveObject = async (oid: Uint8Array) => objects.get(hex(oid));
  return { sources, read, resolveObject };
}

/** The sources with keep sets: the positions whose object `keep` names. */
function keeping(sources: readonly CompactionSource[], keep: (oid: string) => boolean) {
  return sources.map((source) => {
    const bits = new BitSet(source.idx.count);
    for (let p = 0; p < source.idx.count; p++) if (keep(hex(source.idx.oidAt(p)))) bits.set(p);
    return { ...source, keep: bits };
  });
}

async function objectsReachable(repo: GitSandbox, ...revs: string[]): Promise<Set<string>> {
  const { stdout } = await repo.git(["rev-list", "--objects", ...revs]);
  return new Set(
    stdout
      .split("\n")
      .map((l) => l.slice(0, 40))
      .filter((l) => l.length === 40),
  );
}

describe("compaction with keep sets", () => {
  let repo: GitSandbox;
  let empty: GitSandbox;
  let objects: Lookup;
  let all: Set<string>;
  let p1: Uint8Array;
  let p2: Uint8Array;
  let p3: Uint8Array;
  beforeAll(async () => {
    repo = await sandbox();
    await buildRepo(repo, { seed: 21, commits: 30, files: 5, binaryBytes: 1500 });
    ({ byOid: objects } = await objectsOf(await packObjects(repo, { ofsDelta: true })));
    // Every object the three packs below hold (the tag on main is in none of them).
    all = await objectsReachable(repo, "main");
    p1 = await packObjects(repo, { ofsDelta: true, revs: ["main~20"] });
    p2 = await packObjects(repo, { ofsDelta: true, thin: true, revs: ["main~10", "^main~20"] });
    p3 = await packObjects(repo, { ofsDelta: false, thin: true, revs: ["main", "^main~10"] });
    empty = await sandbox();
    await empty.git(["init", "-q"]);
  });

  it("writes exactly the kept objects; the kept closure passes index-pack --strict alone", async () => {
    const stored = await storePacks([p1, p2, p3], objects);
    const old = await objectsReachable(repo, "main~15");
    const sink = memorySink();
    const done = await compactPacks(
      keeping(stored.sources, (oid) => old.has(oid)),
      { read: stored.read, sink, zlib, memory: budget(), resolveObject: stored.resolveObject },
    );
    const bytes = sink.bytes();
    expect(done.objectCount).toBe(old.size);
    expect(hex(done.idx.bytes)).toBe(hex(await gitIndexStrict(empty, bytes)));
    expect(new Set((await gitObjectSet(empty, bytes)).keys())).toEqual(old);
  });

  it("writes the complement self-contained: deltas against dropped bases are written whole", async () => {
    const stored = await storePacks([p1, p2, p3], objects);
    const old = await objectsReachable(repo, "main~15");
    const sink = memorySink();
    const done = await compactPacks(
      keeping(stored.sources, (oid) => !old.has(oid)),
      { read: stored.read, sink, zlib, memory: budget(), resolveObject: stored.resolveObject },
    );
    const bytes = sink.bytes();
    expect(await gitAccepts(empty, bytes)).toBe(true);
    const set = new Set((await gitObjectSet(empty, bytes)).keys());
    expect(set).toEqual(new Set([...all].filter((o) => !old.has(o))));
    expect(done.objectCount).toBe(set.size);
  });

  it("any keep set gives a self-contained pack of exactly the kept objects", async () => {
    const stored = await storePacks([p1, p2, p3], objects);
    const list = [...all].sort();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: list.length, maxLength: list.length }),
        async (flags) => {
          const chosen = new Set(list.filter((_, i) => flags[i]));
          const sink = memorySink();
          const done = await compactPacks(
            keeping(stored.sources, (oid) => chosen.has(oid)),
            {
              read: stored.read,
              sink,
              zlib,
              memory: budget(),
              resolveObject: stored.resolveObject,
            },
          );
          expect(done.objectCount).toBe(chosen.size);
          const set = new Set((await gitObjectSet(empty, sink.bytes())).keys());
          expect(set).toEqual(chosen);
        },
      ),
      { numRuns: 12 },
    );
  });

  it("keeps one copy of an object stored twice when one source drops it", async () => {
    const pa = await packObjects(repo, { ofsDelta: true, revs: ["main~5"] });
    const pb = await packObjects(repo, { ofsDelta: true, revs: ["main"] });
    const stored = await storePacks([pa, pb], objects);
    const old = await objectsReachable(repo, "main~5");
    // The first source keeps nothing; the second keeps everything.
    const sources = stored.sources.map((s, i) => {
      const bits = new BitSet(s.idx.count);
      if (i === 1) for (let p = 0; p < s.idx.count; p++) bits.set(p);
      return { ...s, keep: bits };
    });
    const sink = memorySink();
    const done = await compactPacks(sources, {
      read: stored.read,
      sink,
      zlib,
      memory: budget(),
      resolveObject: stored.resolveObject,
    });
    expect(hex(done.idx.bytes)).toBe(hex(await gitIndexStrict(empty, sink.bytes())));
    expect(old.size).toBeLessThan(all.size);
    expect(new Set((await gitObjectSet(empty, sink.bytes())).keys())).toEqual(
      await objectsReachable(repo, "main"),
    );
  });

  it("resumes a filtered compaction from checkpoints to the same bytes", async () => {
    const stored = await storePacks([p1, p2, p3], objects);
    const old = await objectsReachable(repo, "main~12");
    const sources = keeping(stored.sources, (oid) => !old.has(oid));
    const reference = memorySink();
    const options = (sink: ReturnType<typeof memorySink>) => ({
      read: stored.read,
      sink,
      zlib,
      memory: budget(),
      resolveObject: stored.resolveObject,
      readBytes: 1000,
    });
    const whole = await compactPacks(sources, options(reference));
    const parts: Uint8Array[] = [];
    let sink = memorySink();
    let job = await Compaction.start(sources, options(sink));
    while (!(await job.run(5))) {
      const saved = await job.checkpoint();
      job.release();
      parts.push(sink.bytes());
      sink = memorySink();
      job = await Compaction.resume(sources, saved, options(sink));
    }
    const done = await job.finish();
    parts.push(sink.bytes());
    expect(hex(concatBytes(parts))).toBe(hex(reference.bytes()));
    expect(hex(done.idx.bytes)).toBe(hex(whole.idx.bytes));
  });

  it("refuses a keep set whose size is not the source's object count", async () => {
    const stored = await storePacks([p1], objects);
    const source = { ...(stored.sources[0] as CompactionSource), keep: new BitSet(1) };
    await expect(
      compactPacks([source], { read: stored.read, sink: memorySink(), zlib, memory: budget() }),
    ).rejects.toThrow(RangeError);
  });
});
