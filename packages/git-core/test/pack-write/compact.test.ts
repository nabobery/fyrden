import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { concatBytes } from "../../src/object/bytes.js";
import type { ObjectType } from "../../src/object/object.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { Compaction, type CompactionSource, compactPacks } from "../../src/pack-write/compact.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { gitAccepts } from "../pack/git-oracle.js";
import { buildPack, gitOid, makeDelta, type PackEntrySpec, text } from "../pack/pack-builder.js";
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
 * Compaction combines source packs into one self-contained pack without
 * delta search: entry regions copied, OFS_DELTAs kept, REF_DELTAs across
 * sources kept, objects stored twice written once, deltas whose base would
 * be missing written whole. git judges every output: `git index-pack
 * --strict` accepts it and writes the same `.idx` compaction wrote.
 */

const sandboxes: GitSandbox[] = [];
afterAll(() => Promise.all(sandboxes.map((s) => s.dispose())));
async function sandbox(): Promise<GitSandbox> {
  const s = await createGitSandbox();
  sandboxes.push(s);
  return s;
}

type Lookup = ParsedObjects["byOid"];

/** Stores packs in a memory store with an `.idx` from the engine's parser (thin packs included). */
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

async function compact(
  stored: Awaited<ReturnType<typeof storePacks>>,
  options: { resolve?: boolean; readBytes?: number } = {},
) {
  const sink = memorySink();
  const done = await compactPacks(stored.sources, {
    read: stored.read,
    sink,
    zlib,
    memory: budget(),
    ...(options.resolve === false ? {} : { resolveObject: stored.resolveObject }),
    ...(options.readBytes ? { readBytes: options.readBytes } : {}),
  });
  return { bytes: sink.bytes(), done };
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

describe("compaction of git-made packs", () => {
  let repo: GitSandbox;
  let empty: GitSandbox;
  let objects: Lookup;
  let p1: Uint8Array;
  let p2: Uint8Array;
  let p3: Uint8Array;
  beforeAll(async () => {
    repo = await sandbox();
    await buildRepo(repo, { seed: 9, commits: 30, files: 5, binaryBytes: 1500 });
    ({ byOid: objects } = await objectsOf(await packObjects(repo, { ofsDelta: true })));
    p1 = await packObjects(repo, { ofsDelta: true, revs: ["main~20"] });
    p2 = await packObjects(repo, { ofsDelta: true, thin: true, revs: ["main~10", "^main~20"] });
    p3 = await packObjects(repo, { ofsDelta: false, thin: true, revs: ["main", "^main~10"] });
    empty = await sandbox();
    await empty.git(["init", "-q"]);
  });

  it("combines three packs into one git indexes to the same .idx, holding exactly their union", async () => {
    for (const readBytes of [8 * 1024 * 1024, 97]) {
      const stored = await storePacks([p1, p2, p3], objects);
      const { bytes, done } = await compact(stored, { readBytes });
      expect(hex(done.idx.bytes)).toBe(hex(await gitIndexStrict(empty, bytes)));
      expect(new Set((await gitObjectSet(empty, bytes)).keys())).toEqual(
        await objectsReachable(repo, "main"),
      );
    }
  });

  it("keeps deltas: the output is no larger than the sources' entry regions", async () => {
    const stored = await storePacks([p1, p2, p3], objects);
    const { bytes } = await compact(stored);
    const regions = [p1, p2, p3].reduce((n, p) => n + p.length - 32, 0);
    expect(bytes.length).toBe(regions + 32);
  });

  it("writes whole the deltas whose base is outside the sources, so the output is self-contained", async () => {
    const stored = await storePacks([p2, p3], objects);
    const { bytes, done } = await compact(stored);
    // Self-contained: every delta resolves with no other objects present
    // (--strict would also want the parents and trees these commits name).
    expect(await gitAccepts(empty, bytes)).toBe(true);
    expect(hex(done.idx.bytes)).toBe(hex(await gitIndexStrict(repo, bytes)));
    const expected = await objectsReachable(repo, "main", "^main~20");
    expect(new Set((await gitObjectSet(empty, bytes)).keys())).toEqual(expected);
    await expect(compact(stored, { resolve: false })).rejects.toMatchObject({
      code: "missing-base",
    });
  });

  it("writes each object once when sources overlap", async () => {
    const pa = await packObjects(repo, { ofsDelta: true, revs: ["main~5"] });
    const pb = await packObjects(repo, { ofsDelta: true, revs: ["main"] });
    for (const order of [
      [pa, pb],
      [pb, pa],
      [pa, p3, pb],
    ]) {
      const stored = await storePacks(order, objects);
      const { bytes, done } = await compact(stored);
      expect(hex(done.idx.bytes)).toBe(hex(await gitIndexStrict(empty, bytes)));
      expect(new Set((await gitObjectSet(empty, bytes)).keys())).toEqual(
        await objectsReachable(repo, "main"),
      );
    }
  });

  it("a repository built from the compacted pack passes git fsck", async () => {
    const stored = await storePacks([p1, p2, p3], objects);
    const { bytes, done } = await compact(stored);
    const target = await sandbox();
    await target.git(["init", "-q", "--bare", "."]);
    const packDir = join(target.dir, "objects/pack");
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, `pack-${hex(done.checksum)}.pack`), bytes);
    await writeFile(join(packDir, `pack-${hex(done.checksum)}.idx`), done.idx.bytes);
    const tip = (await repo.git(["rev-parse", "main"])).stdout.trim();
    await target.git(["update-ref", "refs/heads/main", tip]);
    await target.git(["fsck", "--strict", "--no-dangling"]);
  });

  it("resumes from checkpoints to the same bytes and .idx", async () => {
    const stored = await storePacks([p1, p2, p3], objects);
    const reference = await compact(stored);
    for (const slice of [1, 7, 50]) {
      const parts: Uint8Array[] = [];
      let sink = memorySink();
      const options = () => ({
        read: stored.read,
        sink,
        zlib,
        memory: budget(),
        resolveObject: stored.resolveObject,
        readBytes: 1000,
      });
      let job = await Compaction.start(stored.sources, options());
      while (!(await job.run(slice))) {
        const saved = await job.checkpoint();
        job.release();
        parts.push(sink.bytes());
        sink = memorySink();
        job = await Compaction.resume(stored.sources, saved, options());
      }
      const done = await job.finish();
      parts.push(sink.bytes());
      expect(hex(concatBytes(parts))).toBe(hex(reference.bytes));
      expect(hex(done.idx.bytes)).toBe(hex(reference.done.idx.bytes));
    }
  });

  it("refuses a checkpoint taken over other sources", async () => {
    const stored = await storePacks([p1, p2, p3], objects);
    const other = await storePacks([p1, p2], objects);
    const job = await Compaction.start(stored.sources, {
      read: stored.read,
      sink: memorySink(),
      zlib,
      memory: budget(),
    });
    await job.run(3);
    const saved = await job.checkpoint();
    await expect(
      Compaction.resume(other.sources, saved, {
        read: other.read,
        sink: memorySink(),
        zlib,
        memory: budget(),
      }),
    ).rejects.toMatchObject({ code: "bad-checkpoint" });
  });

  it("refuses a source whose bytes no longer match its .idx CRC32", async () => {
    const damaged = new Uint8Array(p1);
    damaged[200] = (damaged[200] as number) ^ 0x40;
    const stored = await storePacks([p1], objects);
    const repo2 = createMemoryRepoStore();
    const writer = repo2.packStore.beginPack();
    await writer.write(damaged);
    const info = await writer.finish();
    const source = { ...(stored.sources[0] as CompactionSource), packId: info.packId };
    await expect(
      compactPacks([source], {
        read: repo2.packStore.openRange.bind(repo2.packStore),
        sink: memorySink(),
        zlib,
        memory: budget(),
      }),
    ).rejects.toMatchObject({ code: "corrupt-source" });
  });
});

describe("compaction with objects stored twice never makes a delta cycle", () => {
  // Blobs whose deltas against each other are valid both ways.
  const W = text(`${"w".repeat(200)}\n`);
  const X = text(`${"x".repeat(200)}\nshared tail of the file\n`);
  const Y = text(`${"x".repeat(200)}\nshared tail of the file, edited\n`);
  const Z = text(`${"x".repeat(150)}${"w".repeat(50)}\n`);
  const oid = {
    W: gitOid("blob", W),
    X: gitOid("blob", X),
    Y: gitOid("blob", Y),
    Z: gitOid("blob", Z),
  };
  const data = { W, X, Y, Z } as const;
  const objects: Lookup = new Map(
    Object.entries(oid).map(([k, o]) => [
      o,
      { type: "blob" as ObjectType as "blob", data: data[k as "W"] },
    ]),
  );
  const d = (from: Uint8Array, to: Uint8Array) => makeDelta(from, to);
  const pack = (entries: PackEntrySpec[]) => buildPack(entries).bytes;

  // P1: X whole, Y as a delta of X. P2 (thin): X as a delta of Y. C2: Y whole
  // (P2's completion pack). Compacting P2 first and keeping the first copy
  // of each object would make X -> Y -> X.
  const P1 = pack([
    { kind: "blob", data: X },
    { kind: "ofs", base: 0, delta: d(X, Y) },
  ]);
  const P2 = pack([{ kind: "ref", baseOid: oid.Y, delta: d(Y, X) }]);
  const C2 = pack([{ kind: "blob", data: Y }]);
  // Two packs where every copy of X and Y is a delta, each resolvable alone.
  const SA = pack([
    { kind: "blob", data: W },
    { kind: "ofs", base: 0, delta: d(W, Y) },
    { kind: "ref", baseOid: oid.Y, delta: d(Y, X) },
  ]);
  const SB = pack([
    { kind: "blob", data: Z },
    { kind: "ofs", base: 0, delta: d(Z, X) },
    { kind: "ref", baseOid: oid.X, delta: d(X, Y) },
  ]);

  // Every copy of X is a delta: PZ resolves X from Z and Y from X; P2 has
  // X as a delta of Y. Keeping P2's X (the first copy) and leaving PZ's Y
  // pointing at "X" would make Y -> X -> Y, so Y must be written whole.
  const PZ = pack([
    { kind: "blob", data: Z },
    { kind: "ofs", base: 0, delta: d(Z, X) },
    { kind: "ofs", base: 1, delta: d(X, Y) },
  ]);
  // The same through a REF_DELTA: PZR's Y names X by id.
  const PZR = pack([
    { kind: "blob", data: Z },
    { kind: "ofs", base: 0, delta: d(Z, X) },
    { kind: "ref", baseOid: oid.X, delta: d(X, Y) },
  ]);

  let empty: GitSandbox;
  beforeAll(async () => {
    empty = await sandbox();
    await empty.git(["init", "-q"]);
  });

  for (const [name, packs] of Object.entries({
    "P2 P1 C2": [P2, P1, C2],
    "P2 C2 P1": [P2, C2, P1],
    "P1 P2 C2": [P1, P2, C2],
    "C2 P2 P1": [C2, P2, P1],
    "SA SB": [SA, SB],
    "SB SA": [SB, SA],
    "P2 PZ": [P2, PZ],
    "PZ P2": [PZ, P2],
    "P2 PZR": [P2, PZR],
  })) {
    it(`order ${name}`, async () => {
      const stored = await storePacks(packs, objects);
      const { bytes, done } = await compact(stored);
      expect(hex(done.idx.bytes)).toBe(hex(await gitIndexStrict(empty, bytes)));
      const set = new Set((await gitObjectSet(empty, bytes)).keys());
      const expected = new Set<string>();
      for (const p of packs)
        for (const o of (await objectsOf(p, objects)).objects) expected.add(hex(o.oid));
      expect(set).toEqual(expected);
    });
  }
});
