import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { hashObject, type ObjectType } from "../../src/object/object.js";
import { oidToHex } from "../../src/object/oid.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { gitPackRows } from "./git-oracle.js";
import { buildPack, gitOid, makeDelta, type PackEntrySpec, text } from "./pack-builder.js";
import { parseBytes, parseCode, rowsOf } from "./parse-helpers.js";
import { buildRepo, packObjects } from "./repo-fixture.js";

/*
 * Property: any pack `git pack-objects` writes (random repos, OFS or REF
 * deltas, depth 1 to 50) parses to exactly what `git verify-pack -v` and
 * `git show-index` report: oid, type, size, entry length, offset, chain
 * depth, base and CRC32 of every entry.
 */

const latin = (bytes: Uint8Array | undefined) => Buffer.from(bytes ?? []).toString("latin1");
const sandboxes: GitSandbox[] = [];
afterAll(() => Promise.all(sandboxes.map((s) => s.dispose())));

async function repo(
  seed: number,
  commits: number,
  files: number,
  binaryBytes = 0,
): Promise<GitSandbox> {
  const sandbox = await createGitSandbox();
  sandboxes.push(sandbox);
  await buildRepo(sandbox, { seed, commits, files, binaryBytes });
  return sandbox;
}

describe("packs written by git parse as git indexes them", () => {
  let deep: GitSandbox;
  beforeAll(async () => {
    // One long history: a single file edited 60 times gives chains up to the depth cap.
    deep = await repo(7, 60, 1);
  });

  it("matches verify-pack and show-index for random repos and pack settings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          seed: fc.integer({ min: 1, max: 1_000_000 }),
          commits: fc.integer({ min: 1, max: 25 }),
          files: fc.integer({ min: 1, max: 6 }),
          binary: fc.constantFrom(0, 3000),
          depth: fc.integer({ min: 1, max: 50 }),
          window: fc.integer({ min: 2, max: 20 }),
          ofsDelta: fc.boolean(),
          chunkSize: fc.integer({ min: 1, max: 9000 }),
        }),
        async ({ seed, commits, files, binary, depth, window, ofsDelta, chunkSize }) => {
          const sandbox = await repo(seed, commits, files, binary);
          const bytes = await packObjects(sandbox, { depth, window, ofsDelta });
          const expected = await gitPackRows(sandbox, bytes);
          const { pack, objects } = await parseBytes(bytes, { chunkSize });
          expect(rowsOf(pack, true)).toEqual(expected?.rows);
          // Every object was handed out once, with the bytes its id names.
          expect(objects.size).toBe(pack.entries.count);
          for (const [oid, { type, data }] of objects) {
            expect(oidToHex(await hashObject(createSha1Hasher, type as ObjectType, data))).toBe(
              oid,
            );
          }
          // Resolved sizes are the objects' sizes (verify-pack shows only entry sizes).
          for (let i = 0; i < pack.entries.count; i++) {
            expect(pack.entries.size(i)).toBe(
              objects.get(oidToHex(pack.entries.oid(i)))?.data.length,
            );
          }
          pack.release();
          await sandbox.dispose();
        },
      ),
      { numRuns: 12 },
    );
  }, 120_000);

  it("parses git's packs of a long history, and 50-deep chains as git indexes them", async () => {
    for (const ofsDelta of [false, true]) {
      const bytes = await packObjects(deep, { depth: 50, window: 50, ofsDelta });
      const { pack } = await parseBytes(bytes);
      expect(rowsOf(pack, true)).toEqual((await gitPackRows(deep, bytes))?.rows);
      pack.release();
    }
    // pack-objects rarely builds long chains on its own, so build them: each
    // version appends a line to the previous one and is a delta against it.
    const versions = [text("start\n")];
    for (let i = 1; i <= 51; i++) versions.push(text(`${latin(versions[i - 1])}line ${i}\n`));
    for (const kind of ["ofs", "ref"] as const) {
      const entries: PackEntrySpec[] = versions.map((v, i) => {
        if (i === 0) return { kind: "blob", data: v };
        const delta = makeDelta(versions[i - 1] as Uint8Array, v);
        return kind === "ofs"
          ? { kind, base: i - 1, delta }
          : { kind, baseOid: gitOid("blob", versions[i - 1] as Uint8Array), delta };
      });
      const fifty = buildPack(entries.slice(0, 51)).bytes;
      const { pack } = await parseBytes(fifty);
      const rows = rowsOf(pack, true);
      expect(rows).toEqual((await gitPackRows(deep, fifty))?.rows);
      expect(Math.max(...rows.map((r) => r.depth))).toBe(50);
      pack.release();
      // One more is above the default cap (git itself has no cap when indexing).
      const fiftyOne = buildPack(entries).bytes;
      expect(await parseCode(fiftyOne)).toBe("delta-too-deep");
      expect(await parseCode(fiftyOne, { limits: { maxDeltaDepth: 51 } })).toBe("ok");
    }
  }, 60_000);

  it("reports the trailer as the pack checksum and accepts pack version 3", async () => {
    const bytes = await packObjects(deep, { ofsDelta: true });
    const { pack } = await parseBytes(bytes);
    expect(pack.checksum).toEqual(bytes.subarray(bytes.length - 20));
    expect(pack.version).toBe(2);
    expect(pack.packLength).toBe(bytes.length);
    pack.release();
    // Version 3 has the same layout; git reads both. Only the header and trailer change.
    const v3 = bytes.slice(0, bytes.length - 20);
    v3[7] = 3;
    const { createHash } = await import("node:crypto");
    const withTrailer = new Uint8Array([...v3, ...createHash("sha1").update(v3).digest()]);
    const parsed = await parseBytes(withTrailer);
    expect(parsed.pack.version).toBe(3);
    expect(rowsOf(parsed.pack)).toEqual(rowsOf((await parseBytes(bytes)).pack));
  }, 60_000);
});
