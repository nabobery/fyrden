import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdxError } from "../../src/pack/idx-format.js";
import { type IdxEntry, PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { buildPack, type PackEntrySpec, text } from "../pack/pack-builder.js";
import { MiB, parseBytes, trackingBudget } from "../pack/parse-helpers.js";
import { buildRepo, packObjects } from "../pack/repo-fixture.js";
import { gitIndexPack, gitVerifyPack, hex, idxHasher } from "./support.js";

/*
 * git is the oracle: for the same pack, the `.idx` we write from the
 * parser's entries must be byte-identical to what `git index-pack` writes
 * (git's index-pack output is deterministic), and `git verify-pack` must
 * accept the pack with our `.idx`.
 */

const sandboxes: GitSandbox[] = [];
afterAll(() => Promise.all(sandboxes.map((s) => s.dispose())));

async function sandbox(): Promise<GitSandbox> {
  const s = await createGitSandbox();
  sandboxes.push(s);
  await s.git(["init", "-q"]);
  return s;
}

/** Parses the pack with our parser and writes its `.idx`. */
async function ourIdx(pack: Uint8Array, strict = false): Promise<Uint8Array> {
  const { pack: parsed } = await parseBytes(pack);
  try {
    const written = await writeIdx(parsed.entries, parsed.checksum, {
      createHasher: idxHasher,
      strict,
    });
    return written.bytes;
  } finally {
    parsed.release();
  }
}

describe("idx v2 writer matches git index-pack byte for byte", () => {
  let oracle: GitSandbox;
  beforeAll(async () => {
    oracle = await sandbox();
  });

  it("for packs git pack-objects writes (random repos, OFS and REF deltas)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          seed: fc.integer({ min: 1, max: 1_000_000 }),
          commits: fc.integer({ min: 1, max: 30 }),
          files: fc.integer({ min: 1, max: 8 }),
          binary: fc.constantFrom(0, 5000),
          depth: fc.integer({ min: 1, max: 50 }),
          ofsDelta: fc.boolean(),
        }),
        async ({ seed, commits, files, binary, depth, ofsDelta }) => {
          const repo = await createGitSandbox();
          try {
            await buildRepo(repo, { seed, commits, files, binaryBytes: binary });
            const pack = await packObjects(repo, { depth, ofsDelta });
            const expected = await gitIndexPack(repo, pack);
            expect(expected).toBeDefined();
            const ours = await ourIdx(pack);
            expect(hex(ours)).toBe(hex(expected as Uint8Array));
            await gitVerifyPack(repo, pack, ours);
          } finally {
            await repo.dispose();
          }
        },
      ),
      { numRuns: 10 },
    );
  }, 120_000);

  it("for a larger repo whose oids fill every fanout bucket", async () => {
    const repo = await sandbox();
    await buildRepo(repo, { seed: 99, commits: 300, files: 40 });
    const pack = await packObjects(repo, { ofsDelta: true });
    const ours = await ourIdx(pack);
    const idx = PackIdx.parse(ours);
    expect(idx.count).toBeGreaterThan(600);
    expect(hex(ours)).toBe(hex((await gitIndexPack(repo, pack)) as Uint8Array));
    const verified = await gitVerifyPack(repo, pack, ours);
    expect(verified).toContain(": ok");
  }, 60_000);

  it("for an empty pack", async () => {
    const pack = buildPack([]).bytes;
    const ours = await ourIdx(pack);
    expect(ours.length).toBe(8 + 1024 + 40);
    expect(hex(ours)).toBe(hex((await gitIndexPack(oracle, pack)) as Uint8Array));
  });

  it("for a pack with duplicate objects: same entries, copies in pack order", async () => {
    // As git's t5308-pack-detect-duplicates: two objects in one fanout
    // bucket, each stored many times. git keeps every copy but sorts with
    // libc qsort, so the order of equal oids (and with it the checksum)
    // depends on the platform; ours puts copies in offset order.
    const lo = text("lo\n");
    const entries: PackEntrySpec[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push({ kind: "blob", data: lo }, { kind: "blob", data: new Uint8Array(0) });
    }
    const pack = buildPack(entries).bytes;
    const gitBytes = (await gitIndexPack(oracle, pack)) as Uint8Array;
    const expected = PackIdx.parse(gitBytes);
    const ours = await ourIdx(pack);
    const idx = PackIdx.parse(ours);
    expect(idx.count).toBe(40);
    expect(idx.fanout).toEqual(expected.fanout);
    expect(hex(idx.oidTable())).toBe(hex(expected.oidTable()));
    expect(idx.packChecksum()).toEqual(expected.packChecksum());
    const rows = (i: PackIdx) =>
      [...i.entries()].map((e) => `${hex(e.oid)} ${e.offset} ${e.crc32}`).sort();
    expect(rows(idx)).toEqual(rows(expected));
    const listed = [...idx.entries()];
    for (let p = 1; p < listed.length; p++) {
      const [a, b] = [listed[p - 1], listed[p]] as [IdxEntry, IdxEntry];
      if (hex(a.oid) === hex(b.oid)) expect(a.offset).toBeLessThan(b.offset);
    }
    // Lookups find the copy that comes first in the pack.
    expect(idx.find(idx.oidAt(0))).toBe(0);
    expect(idx.lookup(idx.oidAt(39))?.offset).toBe(
      Math.min(...listed.filter((e) => hex(e.oid) === hex(idx.oidAt(39))).map((e) => e.offset)),
    );
    // git reads our idx as the same entries (verify-pack is always strict,
    // so it rejects git's own idx for this pack too).
    const shown = async (bytes: Uint8Array) =>
      (await oracle.git(["show-index"], { input: bytes })).stdout.trim().split("\n").sort();
    expect(await shown(ours)).toEqual(await shown(gitBytes));
  });

  it("strict mode rejects duplicates, as git index-pack --strict does", async () => {
    const pack = buildPack([
      { kind: "blob", data: text("a") },
      { kind: "blob", data: text("a") },
    ]).bytes;
    expect(await gitIndexPack(oracle, pack, ["--strict"])).toBeUndefined();
    await expect(ourIdx(pack, true)).rejects.toSatisfy(
      (e) => e instanceof IdxError && e.code === "duplicate-object",
    );
    // Without --strict both git and we accept it.
    expect(await gitIndexPack(oracle, pack)).toBeDefined();
    expect((await ourIdx(pack)).length).toBeGreaterThan(0);
  });
});

describe("writer accounting", () => {
  it("reserves its scratch and output from the memory budget and returns them", async () => {
    const repo = await sandbox();
    await buildRepo(repo, { seed: 5, commits: 20, files: 4 });
    const pack = await packObjects(repo);
    const { pack: parsed } = await parseBytes(pack, { memory: createMemoryBudget(64 * MiB) });
    const memory = trackingBudget(64 * MiB);
    const written = await writeIdx(parsed.entries, parsed.checksum, {
      createHasher: idxHasher,
      memory,
    });
    expect(memory.peak()).toBeGreaterThanOrEqual(written.bytes.length);
    expect(memory.held()).toBe(written.bytes.length);
    written.release();
    expect(memory.held()).toBe(0);
    parsed.release();
  });
});
