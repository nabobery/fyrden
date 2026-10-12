import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeEntryHeader } from "../../src/pack/entry-header.js";
import { IdxError } from "../../src/pack/idx-format.js";
import { PackWriteError } from "../../src/pack-write/errors.js";
import { PackBuilder } from "../../src/pack-write/pack-builder.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { parseBytes } from "../pack/parse-helpers.js";
import { buildRepo, packObjects } from "../pack/repo-fixture.js";
import {
  budget,
  gitIndexStrict,
  gitObjectSet,
  hex,
  memorySink,
  objectsOf,
  zlib,
} from "./support.js";

/*
 * Packs written by `PackBuilder` are judged by git: `git index-pack --strict`
 * accepts each one and writes the same `.idx` the builder wrote, the object
 * set is the one that went in, and a repository built from the pack passes
 * `git fsck` and returns every object unchanged through `git cat-file`.
 */

const sandboxes: GitSandbox[] = [];
afterAll(() => Promise.all(sandboxes.map((s) => s.dispose())));

async function sandbox(): Promise<GitSandbox> {
  const s = await createGitSandbox();
  sandboxes.push(s);
  return s;
}

/** Writes every object whole, in the given order. */
async function writeWhole(
  objects: { oid: Uint8Array; type: "commit" | "tree" | "blob" | "tag"; data: Uint8Array }[],
  chunkBytes?: number,
) {
  const sink = memorySink();
  const builder = await PackBuilder.start(objects.length, {
    sink,
    zlib,
    memory: budget(),
    ...(chunkBytes === undefined ? {} : { chunkBytes }),
  });
  for (const o of objects) await builder.addObject(o.type, o.data, o.oid);
  const done = await builder.finish();
  return { bytes: sink.bytes(), done };
}

/** Copies a pack's entries in `order` (entry indexes in pack order), reusing deltas. */
async function copyEntries(source: Uint8Array, order: number[], ofsDelta = true) {
  const { pack } = await parseBytes(source);
  const e = pack.entries;
  const sink = memorySink();
  const builder = await PackBuilder.start(order.length, {
    sink,
    zlib,
    memory: budget(),
    ofsDelta,
  });
  const written = new Map<string, number>();
  for (const i of order) {
    const offset = e.offset(i);
    const entry = {
      oid: e.oid(i),
      bytes: source.subarray(offset, offset + e.entryLength(i)),
      offset,
      crc32: e.crc32(i),
    };
    const baseOid = e.baseOid(i);
    const at = baseOid
      ? await builder.copyEntry(entry, { oid: baseOid, offset: written.get(hex(baseOid)) })
      : await builder.copyEntry(entry);
    written.set(hex(e.oid(i)), at);
  }
  const done = await builder.finish();
  pack.release();
  return { bytes: sink.bytes(), done };
}

describe("PackBuilder output is accepted by git", () => {
  let repo: GitSandbox;
  let gitPack: Uint8Array;
  let gitPackRef: Uint8Array;
  beforeAll(async () => {
    repo = await sandbox();
    await buildRepo(repo, { seed: 11, commits: 30, files: 6, binaryBytes: 3000 });
    gitPack = await packObjects(repo, { ofsDelta: true, depth: 10 });
    gitPackRef = await packObjects(repo, { ofsDelta: false, depth: 10 });
  });

  it("writes whole objects that git indexes to the same .idx and object set", async () => {
    const { objects } = await objectsOf(gitPack);
    const { bytes, done } = await writeWhole(objects);
    const empty = await sandbox();
    await empty.git(["init", "-q"]);
    const gitIdx = await gitIndexStrict(empty, bytes);
    expect(hex(done.idx.bytes)).toBe(hex(gitIdx));
    expect(done.packLength).toBe(bytes.length);
    expect(hex(done.checksum)).toBe(hex(bytes.subarray(bytes.length - 20)));
    expect(await gitObjectSet(empty, bytes)).toEqual(await gitObjectSet(empty, gitPack));
  });

  it("property: write(parse(p)) keeps the object set, for any order and chunk size", async () => {
    const { objects } = await objectsOf(gitPack);
    const expected = await gitObjectSet(repo, gitPack);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 2 ** 31 }),
        async (chunkBytes, seed) => {
          const shuffled = shuffle(objects, seed);
          const { bytes, done } = await writeWhole(shuffled, chunkBytes);
          const gitIdx = await gitIndexStrict(repo, bytes);
          expect(hex(done.idx.bytes)).toBe(hex(gitIdx));
          expect(await gitObjectSet(repo, bytes)).toEqual(expected);
        },
      ),
      { numRuns: 6 },
    );
  });

  it("copying every entry in pack order reproduces git's pack byte for byte", async () => {
    for (const source of [gitPack, gitPackRef]) {
      const { pack } = await parseBytes(source);
      const order = Array.from({ length: pack.entries.count }, (_, i) => i);
      pack.release();
      const { bytes } = await copyEntries(source, order, source === gitPack);
      expect(hex(bytes)).toBe(hex(source));
    }
  });

  it("reused deltas whose base comes later become REF_DELTAs, and git accepts the result", async () => {
    const { pack } = await parseBytes(gitPack);
    const order = Array.from({ length: pack.entries.count }, (_, i) => pack.entries.count - 1 - i);
    pack.release();
    const { bytes, done } = await copyEntries(gitPack, order);
    expect(hex(done.idx.bytes)).toBe(hex(await gitIndexStrict(repo, bytes)));
    expect(await gitObjectSet(repo, bytes)).toEqual(await gitObjectSet(repo, gitPack));
    const reparsed = await parseBytes(bytes);
    const kinds = new Set<string>();
    for (let i = 0; i < reparsed.pack.entries.count; i++) kinds.add(reparsed.pack.entries.kind(i));
    reparsed.pack.release();
    expect(kinds.has("ref-delta")).toBe(true);
  });

  it("ofsDelta: false writes every reused delta as a REF_DELTA", async () => {
    const { pack } = await parseBytes(gitPack);
    const order = Array.from({ length: pack.entries.count }, (_, i) => i);
    pack.release();
    const { bytes } = await copyEntries(gitPack, order, false);
    await gitIndexStrict(repo, bytes);
    const reparsed = await parseBytes(bytes);
    for (let i = 0; i < reparsed.pack.entries.count; i++) {
      expect(reparsed.pack.entries.kind(i)).not.toBe("ofs-delta");
    }
    reparsed.pack.release();
  });

  it("a repository built from a written pack passes git fsck and returns every object", async () => {
    const { objects } = await objectsOf(gitPack);
    const { bytes, done } = await writeWhole(objects, 777);
    const target = await sandbox();
    await target.git(["init", "-q", "--bare", "."]);
    const packDir = join(target.dir, "objects/pack");
    await mkdir(packDir, { recursive: true });
    const name = `pack-${hex(done.checksum)}`;
    await writeFile(join(packDir, `${name}.pack`), bytes);
    await writeFile(join(packDir, `${name}.idx`), done.idx.bytes);
    const { stdout: tip } = await repo.git(["rev-parse", "main"]);
    await target.git(["update-ref", "refs/heads/main", tip.trim()]);
    await target.git(["fsck", "--strict", "--no-dangling"]);
    for (const o of objects) {
      const type = (await target.git(["cat-file", "-t", hex(o.oid)])).stdout.trim();
      expect(type).toBe(o.type);
      const body = await target.gitBytes(["cat-file", o.type, hex(o.oid)]);
      expect(hex(body)).toBe(hex(o.data));
    }
  });
});

describe("PackBuilder refuses packs git would reject", () => {
  const blob = new TextEncoder().encode("hello\n");

  it("refuses more objects than the header declares", async () => {
    const builder = await PackBuilder.start(1, { sink: memorySink(), zlib, memory: budget() });
    await builder.addObject("blob", blob);
    await expect(builder.addObject("blob", new Uint8Array([1]))).rejects.toMatchObject({
      code: "object-count",
    });
  });

  it("refuses to finish with fewer objects than the header declares", async () => {
    const builder = await PackBuilder.start(2, { sink: memorySink(), zlib, memory: budget() });
    await builder.addObject("blob", blob);
    await expect(builder.finish()).rejects.toBeInstanceOf(PackWriteError);
  });

  it("refuses a REF_DELTA whose base is not in the pack", async () => {
    const repo = await sandbox();
    await buildRepo(repo, { seed: 3, commits: 6, files: 1 });
    const source = await packObjects(repo, { ofsDelta: false });
    const { pack } = await parseBytes(source);
    const e = pack.entries;
    const delta = Array.from({ length: e.count }, (_, i) => i).find(
      (i) => e.kind(i) === "ref-delta",
    ) as number;
    const sink = memorySink();
    const builder = await PackBuilder.start(1, { sink, zlib, memory: budget() });
    await builder.copyEntry(
      {
        oid: e.oid(delta),
        bytes: source.subarray(e.offset(delta), e.offset(delta) + e.entryLength(delta)),
        offset: e.offset(delta),
        crc32: e.crc32(delta),
      },
      { oid: e.baseOid(delta) as Uint8Array },
    );
    await expect(builder.finish()).rejects.toMatchObject({ code: "missing-base" });
    // Nothing after the entries reached the sink: no trailer for a broken pack.
    expect(sink.bytes().length).toBe(e.entryLength(delta) + 12);
    pack.release();
  });

  it("refuses the same object twice, as git index-pack --strict does", async () => {
    const builder = await PackBuilder.start(2, { sink: memorySink(), zlib, memory: budget() });
    await builder.addObject("blob", blob);
    await builder.addObject("blob", blob);
    await expect(builder.finish()).rejects.toBeInstanceOf(IdxError);
  });

  it("refuses a copied entry whose bytes do not match its CRC32", async () => {
    const builder = await PackBuilder.start(1, { sink: memorySink(), zlib, memory: budget() });
    const header = encodeEntryHeader({ kind: "blob", size: blob.length }, 12);
    const bytes = new Uint8Array([...header, ...zlib.deflate(blob)]);
    await expect(
      builder.copyEntry({ oid: new Uint8Array(20), bytes, offset: 12, crc32: 1234 }),
    ).rejects.toMatchObject({ code: "corrupt-source" });
  });

  it("refuses a delta without its base, and an OFS base at or after the entry", async () => {
    const repo = await sandbox();
    await buildRepo(repo, { seed: 4, commits: 6, files: 1 });
    const source = await packObjects(repo, { ofsDelta: true });
    const { pack } = await parseBytes(source);
    const e = pack.entries;
    const i = Array.from({ length: e.count }, (_, k) => k).find(
      (k) => e.kind(k) === "ofs-delta",
    ) as number;
    const entry = {
      oid: e.oid(i),
      bytes: source.subarray(e.offset(i), e.offset(i) + e.entryLength(i)),
      offset: e.offset(i),
    };
    const builder = await PackBuilder.start(3, { sink: memorySink(), zlib, memory: budget() });
    await expect(builder.copyEntry(entry)).rejects.toBeInstanceOf(RangeError);
    await expect(
      builder.copyEntry(entry, { oid: e.baseOid(i) as Uint8Array, offset: 12 }),
    ).rejects.toBeInstanceOf(RangeError);
    pack.release();
  });

  it("writes an empty pack git accepts", async () => {
    const repo = await sandbox();
    await repo.git(["init", "-q"]);
    const sink = memorySink();
    const builder = await PackBuilder.start(0, { sink, zlib, memory: budget() });
    const done = await builder.finish();
    expect(hex(done.idx.bytes)).toBe(hex(await gitIndexStrict(repo, sink.bytes())));
  });
});

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let a = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    const j = a % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
