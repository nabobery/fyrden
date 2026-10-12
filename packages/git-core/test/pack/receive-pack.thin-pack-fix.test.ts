import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { isObjectType, type ObjectType } from "../../src/object/object.js";
import { type Oid, oidToHex } from "../../src/object/oid.js";
import { PackError } from "../../src/pack/errors.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import type { ExternalBaseLookup } from "../../src/pack/parse.js";
import { compactPacks } from "../../src/pack-write/compact.js";
import { createMemoryRepoStore } from "../../testing/fakes/memory-repo-store.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { budget, gitIndexStrict, hex, memorySink, zlib } from "../pack-write/support.js";
import { gitPackRows } from "./git-oracle.js";
import { buildPack, gitOid, makeDelta, type WholeType } from "./pack-builder.js";
import { parseBytes, rowsOf } from "./parse-helpers.js";
import { buildRepo, packObjects } from "./repo-fixture.js";

/*
 * Parser half of thin-pack completion. A thin pack (what `git push` sends)
 * has REF_DELTAs against objects the receiver already has. The parser
 * resolves them through an external lookup and reports exactly which bases
 * it used, so the receive path can write them whole into a completion pack.
 * `git index-pack --fix-thin` is the oracle: the objects it appends are the
 * bases we must report.
 */

let sandbox: GitSandbox;
let thin: Uint8Array;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  await buildRepo(sandbox, { seed: 99, commits: 12, files: 4, binaryBytes: 2000 });
  // What a push of the last three commits sends to a server that has main~3.
  thin = await packObjects(sandbox, { thin: true, revs: ["main", "^main~3"], window: 20 });
});
afterAll(() => sandbox.dispose());

/** Looks objects up in the sandbox repo, counting calls. */
function repoLookup(
  skip: ReadonlySet<string> = new Set(),
): ExternalBaseLookup & { asked: string[] } {
  const asked: string[] = [];
  const lookup = async (oid: Oid) => {
    const hex = oidToHex(oid);
    asked.push(hex);
    if (skip.has(hex)) return undefined;
    try {
      const type = (await sandbox.git(["cat-file", "-t", hex])).stdout.trim();
      if (!isObjectType(type)) return undefined;
      return { type, data: await sandbox.gitBytes(["cat-file", type, hex]) };
    } catch {
      return undefined;
    }
  };
  return Object.assign(lookup, { asked });
}

describe("receive-pack: thin pack resolution (parser half)", () => {
  it("resolves every object through the repo and reports exactly the bases git --fix-thin appends", async () => {
    const fixed = await gitPackRows(sandbox, thin, { fixThin: true });
    expect(fixed).toBeDefined();
    const trailerOffset = thin.length - 20;
    const appended = fixed?.rows.filter((r) => r.offset >= trailerOffset) ?? [];
    const original = fixed?.rows.filter((r) => r.offset < trailerOffset) ?? [];
    expect(appended.length).toBeGreaterThan(0);

    const lookup = repoLookup();
    const { pack, objects } = await parseBytes(thin, { externalBase: lookup, chunkSize: 1000 });
    expect(pack.thinBases.map(oidToHex).sort()).toEqual(appended.map((r) => r.oid).sort());
    // Entries keep git's oids, types, sizes, offsets and CRC32s.
    expect(rowsOf(pack, true)).toEqual(original);
    expect([...objects.keys()].sort()).toEqual(original.map((r) => r.oid).sort());
    // Each base is asked for once.
    expect(new Set(lookup.asked).size).toBe(lookup.asked.length);
    pack.release();
  });

  it("forms a pack unit with a completion pack holding exactly the missing bases", async () => {
    const { pack } = await parseBytes(thin, { externalBase: repoLookup() });
    const bases = await Promise.all(
      pack.thinBases.map(async (oid) => {
        const hex = oidToHex(oid);
        const type = (await sandbox.git(["cat-file", "-t", hex])).stdout.trim() as WholeType;
        return { kind: type, data: await sandbox.gitBytes(["cat-file", type, hex]) };
      }),
    );
    const completion = buildPack(bases);
    const unit = await parseBytes(completion.bytes);
    expect([...unit.objects.keys()].sort()).toEqual(pack.thinBases.map(oidToHex).sort());
    // The thin pack resolves against the completion pack alone: the unit is self-contained.
    const fromUnit: ExternalBaseLookup = async (oid) => {
      const found = unit.objects.get(oidToHex(oid));
      return found && { type: found.type as ObjectType, data: found.data };
    };
    const again = await parseBytes(thin, { externalBase: fromUnit });
    expect(rowsOf(again.pack)).toEqual(rowsOf(pack));
    // And git agrees: the completion pack with the thin pack's objects is a complete closure.
    const fixed = await gitPackRows(sandbox, thin, { fixThin: true });
    const all = new Set([...again.objects.keys(), ...unit.objects.keys()]);
    expect([...all].sort()).toEqual(fixed?.rows.map((r) => r.oid).sort());
  });

  it("asks again for an external base dropped from the cache, and rejects one that vanished", async () => {
    // Base x is outside the pack; d1 and d3 are deltas against it, d2 against d1.
    const x = new Uint8Array(2000).map((_, i) => (i * 7) % 251);
    const d1 = new Uint8Array([...x.subarray(0, 1500), 1, 2, 3]);
    const d2 = new Uint8Array([...d1, 4, 5, 6]);
    const d3 = new Uint8Array([...x.subarray(0, 1000), 9]);
    const { bytes } = buildPack([
      { kind: "ref", baseOid: gitOid("blob", x), delta: makeDelta(x, d1) },
      { kind: "ofs", base: 0, delta: makeDelta(d1, d2) },
      { kind: "ref", baseOid: gitOid("blob", x), delta: makeDelta(x, d3) },
    ]);
    let calls = 0;
    const lookup: ExternalBaseLookup = async () => {
      calls++;
      return { type: "blob", data: x };
    };
    const tight = { deltaBaseCacheBytes: 1 };
    const { pack } = await parseBytes(bytes, { externalBase: lookup, limits: tight });
    expect(pack.thinBases.map(oidToHex)).toEqual([gitOid("blob", x)]);
    expect(rowsOf(pack).map((r) => r.oid)).toEqual([d1, d2, d3].map((d) => gitOid("blob", d)));
    // Dropped while d1's subtree was resolved, x was asked for again for d3.
    expect(calls).toBe(2);
    calls = 0;
    const roomy = await parseBytes(bytes, { externalBase: lookup });
    expect(calls).toBe(1);
    expect(rowsOf(roomy.pack, true)).toEqual(rowsOf(pack, true));

    let asked = 0;
    const forgetful: ExternalBaseLookup = async () =>
      asked++ === 0 ? { type: "blob", data: x } : undefined;
    await expect(
      parseBytes(bytes, { externalBase: forgetful, limits: tight }),
    ).rejects.toMatchObject({
      code: "bad-external-base",
    });
  });

  it("rejects a thin pack when there is no external lookup", async () => {
    await expect(parseBytes(thin)).rejects.toMatchObject({ code: "missing-base" });
  });

  it("rejects a thin pack when one external base is missing, naming it", async () => {
    const { pack } = await parseBytes(thin, { externalBase: repoLookup() });
    const missing = oidToHex(pack.thinBases[0] as Oid);
    const error = await parseBytes(thin, { externalBase: repoLookup(new Set([missing])) }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PackError);
    expect((error as PackError).code).toBe("missing-base");
    expect((error as PackError).message).toContain(missing);
  });

  it("rejects an external base whose bytes do not match its oid", async () => {
    const liar: ExternalBaseLookup = async () => ({
      type: "blob",
      data: new Uint8Array([1, 2, 3]),
    });
    await expect(parseBytes(thin, { externalBase: liar })).rejects.toMatchObject({
      code: "bad-external-base",
    });
  });

  it("does not ask the external lookup for bases inside the pack", async () => {
    const full = await packObjects(sandbox, { window: 20 });
    const lookup = repoLookup();
    const { pack } = await parseBytes(full, { externalBase: lookup });
    expect(lookup.asked).toEqual([]);
    expect(pack.thinBases).toEqual([]);
  });
});

describe("receive-pack: compaction of a thin pack unit", () => {
  it("compacts the received thin pack and its completion pack into one pack git verify-pack accepts, with git's .idx", async () => {
    // The pack unit a push leaves: the thin pack, and a completion pack
    // holding the bases it deltas against.
    const { pack } = await parseBytes(thin, { externalBase: repoLookup() });
    const bases = await Promise.all(
      pack.thinBases.map(async (oid) => {
        const id = oidToHex(oid);
        const type = (await sandbox.git(["cat-file", "-t", id])).stdout.trim() as WholeType;
        return { kind: type, data: await sandbox.gitBytes(["cat-file", type, id]) };
      }),
    );
    pack.release();
    const completion = buildPack(bases).bytes;
    const completed = await parseBytes(completion);
    const fromCompletion: ExternalBaseLookup = async (oid) => {
      const found = completed.objects.get(oidToHex(oid));
      return found && { type: found.type as ObjectType, data: found.data };
    };

    // Each stored with its `.idx`, as indexing stores them.
    const repo = createMemoryRepoStore();
    const sources = [];
    const unitOids = new Set<string>();
    for (const bytes of [thin, completion]) {
      const parsed = await parseBytes(bytes, { externalBase: fromCompletion });
      for (const id of parsed.objects.keys()) unitOids.add(id);
      const idx = await writeIdx(parsed.pack.entries, parsed.pack.checksum, {
        createHasher: () => createSha1Hasher({ detectCollisions: false }),
      });
      parsed.pack.release();
      const writer = repo.packStore.beginPack();
      await writer.write(bytes);
      const info = await writer.finish();
      sources.push({
        packId: info.packId,
        packLength: bytes.length,
        idx: PackIdx.parse(idx.bytes),
      });
    }

    // No outside lookup: the unit as a whole is self-contained.
    const sink = memorySink();
    const done = await compactPacks(sources, {
      read: repo.packStore.openRange.bind(repo.packStore),
      sink,
      zlib,
      memory: budget(),
    });
    const output = sink.bytes();

    // git verify-pack checks the pack against the `.idx` compaction wrote.
    const name = join(sandbox.dir, `.git/unit-${process.pid}`);
    await writeFile(`${name}.pack`, output);
    await writeFile(`${name}.idx`, done.idx.bytes);
    let verified: string;
    try {
      verified = (await sandbox.git(["verify-pack", "-v", `${name}.idx`])).stdout;
      expect(new Uint8Array(await readFile(`${name}.idx`))).toEqual(done.idx.bytes);
    } finally {
      await rm(`${name}.pack`, { force: true });
      await rm(`${name}.idx`, { force: true });
    }
    const listed = verified
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((id) => /^[0-9a-f]{40}$/.test(id));
    // Exactly the unit's objects, each once: what git index-pack --fix-thin completes the thin pack to.
    expect(listed.sort()).toEqual([...unitOids].sort());
    const fixed = await gitPackRows(sandbox, thin, { fixThin: true });
    expect(listed.sort()).toEqual(fixed?.rows.map((r) => r.oid).sort());
    // git index-pack --strict (links checked in the repository) writes the same `.idx`.
    expect(hex(done.idx.bytes)).toBe(hex(await gitIndexStrict(sandbox, output)));
    done.release();
  });
});
