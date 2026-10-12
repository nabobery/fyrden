import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MIN_PART_BYTES } from "../../src/git/r2-pack-store.js";
import { type PackUploadState, ResumablePackUpload } from "../../src/git/resumable-pack-upload.js";
import { inProbe, newProbe } from "./harness.js";

/*
 * A pack maintenance writes across alarm slices: whole parts go to R2 as
 * they fill, the state and the bytes after the last part survive in the
 * caller's hands, and a new instance continues from them.
 */

function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

async function storedBytes(key: string): Promise<Uint8Array> {
  const object = await env.GIT.get(key);
  if (!object) throw new Error(`${key} is missing`);
  return new Uint8Array(await object.arrayBuffer());
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

describe("ResumablePackUpload", () => {
  it("writes a multipart pack across saved states, in whole parts, and completes it", async () => {
    const { stub } = await newProbe();
    const bytes = noise(2 * MIN_PART_BYTES + 123_457, 7);
    const result = await inProbe(stub, async ({ git }) => {
      let upload = ResumablePackUpload.begin(git, "compact", { partBytes: MIN_PART_BYTES });
      const cuts = [1_000_000, 5_300_000, 9_000_000, bytes.length];
      let at = 0;
      const tails: number[] = [];
      for (const cut of cuts) {
        await upload.write(bytes.subarray(at, cut));
        at = cut;
        if (cut === bytes.length) break;
        const saved = upload.save();
        tails.push(saved.tail.length);
        // A new instance, as after an eviction.
        upload = ResumablePackUpload.resume(git, saved.state, saved.tail);
      }
      const info = await upload.finish();
      const row = git.registry.get(info.packId);
      return { info, row, tails };
    });
    expect(result.info.bytes).toBe(bytes.length);
    expect(result.row).toMatchObject({ state: "indexing", bytes: bytes.length, kind: "compact" });
    // Only the bytes after the last whole part are carried between instances.
    expect(result.tails.every((t) => t < MIN_PART_BYTES)).toBe(true);
    expect(equal(await storedBytes(result.row?.r2Key as string), bytes)).toBe(true);
  });

  it("stores a pack of less than one part with a single PUT", async () => {
    const { stub } = await newProbe();
    const bytes = noise(70_000, 3);
    const key = await inProbe(stub, async ({ git }) => {
      const upload = ResumablePackUpload.begin(git, "gc", { partBytes: MIN_PART_BYTES });
      await upload.write(bytes.subarray(0, 10));
      const saved = upload.save();
      const again = ResumablePackUpload.resume(git, saved.state, saved.tail);
      await again.write(bytes.subarray(10));
      const info = await again.finish();
      return git.registry.get(info.packId)?.r2Key as string;
    });
    expect(equal(await storedBytes(key), bytes)).toBe(true);
  });

  it("redone from an older state (a reset lost the newer one), uploads the same parts again", async () => {
    const { stub } = await newProbe();
    const bytes = noise(2 * MIN_PART_BYTES + 99, 11);
    const key = await inProbe(stub, async ({ git }) => {
      const upload = ResumablePackUpload.begin(git, "compact", { partBytes: MIN_PART_BYTES });
      await upload.write(bytes.subarray(0, 3_000_000));
      const older: { state: PackUploadState; tail: Uint8Array } = upload.save();
      await upload.write(bytes.subarray(3_000_000, 8_000_000));
      upload.save(); // never kept
      const redo = ResumablePackUpload.resume(git, older.state, older.tail);
      await redo.write(bytes.subarray(3_000_000));
      const info = await redo.finish();
      return git.registry.get(info.packId)?.r2Key as string;
    });
    expect(equal(await storedBytes(key), bytes)).toBe(true);
  });

  it("abort discards the pack; a saved state for a pack no longer pending is refused", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const upload = ResumablePackUpload.begin(git, "compact", { partBytes: MIN_PART_BYTES });
      await upload.write(noise(MIN_PART_BYTES + 10, 1));
      const saved = upload.save();
      await upload.abort();
      let refused = false;
      try {
        ResumablePackUpload.resume(git, saved.state, saved.tail);
      } catch {
        refused = true;
      }
      return { state: git.registry.get(upload.packId)?.state, refused };
    });
    expect(result).toEqual({ state: "discarded", refused: true });
  });
});
