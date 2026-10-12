import { createSha1Hasher, type Hasher } from "@fyrden/git-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDigestStreamHasher } from "../../src/hash/digest-stream-hasher.js";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function digestOf(hasher: Hasher, chunks: Uint8Array[]): Promise<string> {
  for (const chunk of chunks) await hasher.update(chunk);
  return hex(await hasher.digest());
}

describe("createDigestStreamHasher (crypto.DigestStream in workerd)", () => {
  it("matches the FIPS 180 vector for 'abc'", async () => {
    expect(await digestOf(createDigestStreamHasher(), [new TextEncoder().encode("abc")])).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });

  it("gives the same digest as the pure-TypeScript hasher for any chunking", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 4096 }),
        fc.array(fc.nat(), { maxLength: 8 }),
        async (data, rawCuts) => {
          const cuts = rawCuts.map((c) => c % (data.length + 1)).sort((a, b) => a - b);
          const chunks: Uint8Array[] = [];
          let start = 0;
          for (const cut of [...cuts, data.length]) {
            chunks.push(data.subarray(start, cut));
            start = cut;
          }
          expect(await digestOf(createDigestStreamHasher(), chunks)).toBe(
            await digestOf(createSha1Hasher(), [data]),
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});
