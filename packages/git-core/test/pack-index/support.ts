import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSha1Hasher } from "../../src/hash/sha1.js";
import { OID_BYTES } from "../../src/object/oid.js";
import type { IdxRangeReader } from "../../src/pack/idx-range-read.js";
import type { IdxWriteInput } from "../../src/pack/idx-write.js";
import type { GitSandbox } from "../../testing/git-cli.js";
import { prng } from "../pack/repo-fixture.js";

/** The `.idx` checksum hasher: Fyrden writes the idx itself, so no collision detection. */
export const idxHasher = () => createSha1Hasher({ detectCollisions: false });

/** `count` pseudo-random oids from a seed, packed 20 bytes each. */
export function randomOids(count: number, seed: number): Uint8Array {
  const rand = prng(seed);
  const oids = new Uint8Array(count * OID_BYTES);
  for (let i = 0; i < oids.length; i += 4) {
    const word = Math.floor(rand() * 2 ** 32);
    oids[i] = word >>> 24;
    oids[i + 1] = (word >>> 16) & 0xff;
    oids[i + 2] = (word >>> 8) & 0xff;
    oids[i + 3] = word & 0xff;
  }
  return oids;
}

/**
 * Synthetic index entries: the given oids in "pack order", with ascending
 * offsets starting at 12 (as in a real pack) and pseudo-random CRC32s.
 */
export function syntheticEntries(oids: Uint8Array, seed = 1): IdxWriteInput {
  const count = oids.length / OID_BYTES;
  const rand = prng(seed);
  const offsets = new Float64Array(count);
  const crc32s = new Uint32Array(count);
  let offset = 12;
  for (let i = 0; i < count; i++) {
    offsets[i] = offset;
    offset += 20 + Math.floor(rand() * 4000);
    crc32s[i] = Math.floor(rand() * 2 ** 32);
  }
  return { count, oids, offsets, crc32s };
}

let counter = 0;

/**
 * What `git index-pack` writes for a pack: the `.idx` bytes, or undefined
 * when it rejects the pack.
 */
export async function gitIndexPack(
  sandbox: GitSandbox,
  pack: Uint8Array,
  flags: readonly string[] = [],
): Promise<Uint8Array | undefined> {
  const name = join(sandbox.dir, `.git/idx-oracle-${process.pid}-${counter++}`);
  await writeFile(`${name}.pack`, pack);
  try {
    await sandbox.git(["index-pack", ...flags, "-o", `${name}.idx`, `${name}.pack`]);
    return new Uint8Array(await readFile(`${name}.idx`));
  } catch {
    return undefined;
  } finally {
    await rm(`${name}.pack`, { force: true });
    await rm(`${name}.idx`, { force: true });
  }
}

/** Runs `git verify-pack -v` on a pack with the given `.idx`; returns its stdout. */
export async function gitVerifyPack(
  sandbox: GitSandbox,
  pack: Uint8Array,
  idx: Uint8Array,
): Promise<string> {
  const name = join(sandbox.dir, `.git/verify-${process.pid}-${counter++}`);
  await writeFile(`${name}.pack`, pack);
  await writeFile(`${name}.idx`, idx);
  try {
    return (await sandbox.git(["verify-pack", "-v", `${name}.idx`])).stdout;
  } finally {
    await rm(`${name}.pack`, { force: true });
    await rm(`${name}.idx`, { force: true });
  }
}

/** A range reader over in-memory bytes that counts calls and bytes read. */
export function countingReader(bytes: Uint8Array): IdxRangeReader & {
  calls: number;
  bytesRead: number;
} {
  const reader = Object.assign(
    async (offset: number, length: number) => {
      reader.calls++;
      reader.bytesRead += length;
      return bytes.subarray(offset, offset + length);
    },
    { calls: 0, bytesRead: 0 },
  );
  return reader;
}

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
