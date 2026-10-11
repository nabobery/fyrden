import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { isObjectType, type ObjectType } from "../../src/object/object.js";
import { type Oid, oidFromHex, oidToHex } from "../../src/object/oid.js";
import { PackExistenceSummary } from "../../src/pack/existence-summary.js";
import { PackIdx } from "../../src/pack/idx-read.js";
import { writeIdx } from "../../src/pack/idx-write.js";
import { type ExternalBaseLookup, parsePack } from "../../src/pack/parse.js";
import type { BlockCache } from "../../src/ports/block-cache.js";
import type { PackId, PackStore } from "../../src/ports/pack-store.js";
import type { ViewPack } from "../../src/reader/view.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import type { GitSandbox } from "../../testing/git-cli.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { chunked } from "../pack/pack-builder.js";

export const MiB = 1024 * 1024;
export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** One `openRange` call as the store saw it. */
export interface RangeCall {
  readonly packId: PackId;
  readonly offset: number;
  readonly length: number;
}

/** Wraps a pack store, recording every `openRange` call. */
export function countingPackStore(inner: PackStore): PackStore & { calls: RangeCall[] } {
  const calls: RangeCall[] = [];
  return {
    calls,
    listPacks: () => inner.listPacks(),
    beginPack: () => inner.beginPack(),
    openRange(packId, offset, length) {
      calls.push({ packId, offset, length });
      return inner.openRange(packId, offset, length);
    },
  };
}

/** Wraps a block cache, recording the scope and pack of every call. */
export function spyBlockCache(
  inner: BlockCache,
): BlockCache & { gets: [string, PackId, number][]; puts: [string, PackId, number][] } {
  const gets: [string, PackId, number][] = [];
  const puts: [string, PackId, number][] = [];
  return {
    gets,
    puts,
    get(scope, packId, blockIndex) {
      gets.push([scope, packId, blockIndex]);
      return inner.get(scope, packId, blockIndex);
    },
    put(scope, packId, blockIndex, block) {
      puts.push([scope, packId, blockIndex]);
      return inner.put(scope, packId, blockIndex, block);
    },
  };
}

/**
 * Stores a pack the way the receive path does: our parser checks it and
 * gives the entries, our writer makes the `.idx`, and the bytes go into the
 * pack store. Returns the view entry for it (in-memory idx and summary).
 */
export async function loadPack(
  store: PackStore,
  bytes: Uint8Array,
  externalBase?: ExternalBaseLookup,
): Promise<ViewPack> {
  const parsed = await parsePack(chunked(bytes, 64 * 1024), {
    zlib: createNodeZlib(),
    memory: createMemoryBudget(1024 * MiB),
    readRange: async (offset, length) => bytes.subarray(offset, offset + length),
    ...(externalBase ? { externalBase } : {}),
  });
  const written = await writeIdx(parsed.entries, parsed.checksum, {
    createHasher: () => createSha1Hasher({ detectCollisions: false }),
  });
  parsed.release();
  const idx = PackIdx.parse(written.bytes);
  const writer = store.beginPack();
  await writer.write(bytes);
  const info = await writer.finish();
  return {
    packId: info.packId,
    bytes: info.bytes,
    idx,
    summary: PackExistenceSummary.fromIdx(idx),
  };
}

/** Every oid of an in-memory idx, in oid order. */
export function idxOids(idx: PackIdx): Oid[] {
  return [...idx.entries()].map((e) => e.oid);
}

export interface GitObject {
  readonly type: ObjectType;
  readonly bytes: Uint8Array;
}

/** `git cat-file --batch` for the given oids (or every object): the oracle's view of each object. */
export async function catFileBatch(
  sandbox: GitSandbox,
  oids?: readonly string[],
): Promise<Map<string, GitObject>> {
  const out = oids
    ? await sandbox.gitBytes(["cat-file", "--batch"], { input: `${oids.join("\n")}\n` })
    : await sandbox.gitBytes(["cat-file", "--batch-all-objects", "--batch"]);
  const objects = new Map<string, GitObject>();
  let at = 0;
  while (at < out.length) {
    const nl = out.indexOf(10, at);
    const [oid, type, size] = Buffer.from(out.subarray(at, nl)).toString("latin1").split(" ");
    if (!oid || !type || !isObjectType(type)) throw new Error(`unexpected batch line at ${at}`);
    const start = nl + 1;
    const end = start + Number(size);
    objects.set(oid, { type, bytes: out.slice(start, end) });
    at = end + 1;
  }
  return objects;
}

/** The single pack `git repack -adf` leaves in the sandbox repo. */
export async function repackedPack(sandbox: GitSandbox): Promise<Uint8Array> {
  await sandbox.git(["repack", "-adf", "-q", "--depth=50", "--window=250"]);
  const dir = join(sandbox.dir, ".git/objects/pack");
  const packs = (await readdir(dir)).filter((name) => name.endsWith(".pack"));
  if (packs.length !== 1) throw new Error(`expected one pack, found ${packs.length}`);
  return new Uint8Array(await readFile(join(dir, packs[0] as string)));
}

export function toOid(hexText: string): Oid {
  return oidFromHex(hexText);
}

export { oidToHex };

/** Deterministic Fisher-Yates shuffle. */
export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
