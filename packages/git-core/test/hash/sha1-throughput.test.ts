import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha1 } from "../../src/hash/sha1.js";

/*
 * Throughput of the pure-TypeScript SHA-1 with and without collision
 * detection, against node:crypto for scale. It reports numbers and asserts
 * nothing about them, so it only runs on request:
 *
 *   FYRDEN_BENCH=1 npx vitest run test/hash/sha1-throughput.test.ts
 */

const MIB = 1024 * 1024;
const SIZE = 16 * MIB;
const CHUNK = 64 * 1024;

function megabytesPerSecond(hash: (data: Uint8Array) => void, data: Uint8Array): number {
  hash(data.subarray(0, 2 * MIB)); // warm up the JIT
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    hash(data);
    best = Math.min(best, performance.now() - start);
  }
  return data.length / MIB / (best / 1000);
}

function sha1(detectCollisions: boolean) {
  return (data: Uint8Array) => {
    const sha = new Sha1({ detectCollisions });
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      sha.update(data.subarray(offset, offset + CHUNK));
    }
    sha.digest();
  };
}

describe.skipIf(!process.env.FYRDEN_BENCH)("SHA-1 throughput (16 MiB, best of 3)", () => {
  it("reports MB/s with collision detection on and off", () => {
    const data = new Uint8Array(SIZE);
    // Deterministic, non-repeating bytes (an LCG), so no block is special.
    let x = 1;
    for (let i = 0; i < data.length; i++) {
      x = (Math.imul(x, 1103515245) + 12345) | 0;
      data[i] = x >>> 24;
    }
    const results = {
      detectionOn: megabytesPerSecond(sha1(true), data),
      detectionOff: megabytesPerSecond(sha1(false), data),
      nodeCrypto: megabytesPerSecond((d) => createHash("sha1").update(d).digest(), data),
    };
    console.log(
      Object.entries(results)
        .map(([name, mbps]) => `${name}: ${mbps.toFixed(0)} MB/s`)
        .join(", "),
    );
    expect(results.detectionOn).toBeGreaterThan(0);
  });
});
