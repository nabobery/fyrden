import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSha1Hasher, Sha1 } from "../../src/hash/sha1.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const nodeSha1 = (data: Uint8Array) => createHash("sha1").update(data).digest("hex");

/** Data plus sorted cut points that split it into chunks (some empty). */
const chunkedData = fc
  .uint8Array({ maxLength: 4096 })
  .chain((data) =>
    fc
      .array(fc.integer({ min: 0, max: data.length }), { maxLength: 12 })
      .map((cuts) => ({ data, cuts: [...cuts].sort((a, b) => a - b) })),
  );

function chunks({ data, cuts }: { data: Uint8Array; cuts: number[] }): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (const cut of [...cuts, data.length]) {
    out.push(data.subarray(start, cut));
    start = cut;
  }
  return out;
}

describe("Sha1 (pure TypeScript)", () => {
  it.each([
    ["", "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
    ["abc", "a9993e364706816aba3e25717850c26c9cd0d89d"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
    ],
  ])("matches the FIPS 180 vector for %j", (input, expected) => {
    expect(hex(new Sha1().update(new TextEncoder().encode(input)).digest())).toBe(expected);
  });

  it("matches the one-million-'a' vector across block boundaries", () => {
    const sha = new Sha1();
    const chunk = new Uint8Array(1000).fill(0x61);
    for (let i = 0; i < 1000; i++) sha.update(chunk);
    expect(hex(sha.digest())).toBe("34aa973cd4c4daa4f61eeb2bdbad27316534016f");
  });

  it("gives the same digest as node:crypto for any chunking", () => {
    fc.assert(
      fc.property(chunkedData, (input) => {
        const sha = new Sha1();
        for (const chunk of chunks(input)) sha.update(chunk);
        expect(hex(sha.digest())).toBe(nodeSha1(input.data));
      }),
    );
  });

  it("gives the same digest after saving and restoring its state at any point", () => {
    fc.assert(
      fc.property(chunkedData, (input) => {
        let sha = new Sha1();
        for (const chunk of chunks(input)) {
          sha.update(chunk);
          // A writer evicted mid-stream resumes from the saved state alone.
          sha = Sha1.fromState(sha.saveState());
        }
        expect(hex(sha.digest())).toBe(nodeSha1(input.data));
      }),
    );
  });

  it("keeps hashing after a digest, so a digest can be taken mid-stream", () => {
    const sha = new Sha1().update(new TextEncoder().encode("ab"));
    expect(hex(sha.digest())).toBe(nodeSha1(new TextEncoder().encode("ab")));
    sha.update(new TextEncoder().encode("c"));
    expect(hex(sha.digest())).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it("rejects a malformed saved state", () => {
    const state = new Sha1().update(new Uint8Array(70)).saveState();
    expect(() => Sha1.fromState(state.subarray(0, state.length - 1))).toThrow(RangeError);
    expect(() => Sha1.fromState(new Uint8Array([9, ...state.subarray(1)]))).toThrow(RangeError);
    expect(() => Sha1.fromState(new Uint8Array(0))).toThrow(RangeError);
    const tooLong = new Uint8Array([...state, 0]);
    expect(() => Sha1.fromState(tooLong)).toThrow(RangeError);
  });

  it("does not depend on later changes to the bytes it was given", () => {
    const data = new Uint8Array(100).fill(7);
    const sha = new Sha1().update(data.subarray(0, 30));
    data.fill(9);
    sha.update(new Uint8Array(70).fill(7));
    expect(hex(sha.digest())).toBe(nodeSha1(new Uint8Array(100).fill(7)));
  });
});

describe("createSha1Hasher (the Hasher port over Sha1)", () => {
  it("gives the same digest as node:crypto for any chunking, and resumes from saved state", async () => {
    await fc.assert(
      fc.asyncProperty(chunkedData, async (input) => {
        let hasher = createSha1Hasher();
        for (const chunk of chunks(input)) {
          await hasher.update(chunk);
          hasher = createSha1Hasher(hasher.saveState());
        }
        expect(hex(await hasher.digest())).toBe(nodeSha1(input.data));
      }),
    );
  });
});
