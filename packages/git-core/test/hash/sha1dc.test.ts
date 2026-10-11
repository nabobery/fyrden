import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSha1Hasher, Sha1, Sha1CollisionError } from "../../src/hash/sha1.js";
import { compress, detectCollision, recompress } from "../../src/hash/sha1dc.js";
import { SHA1_DVS, ubcCheck } from "../../src/hash/ubc-check.js";
import { hashObject } from "../../src/object/object.js";
import { oidToHex } from "../../src/object/oid.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";

/*
 * SHA-1 collision detection (SHA-1DC). The fixtures are known collisions
 * (see fixtures/README.md); the golden checksums were computed by the
 * reference C implementation at sha1collisiondetection commit a06f1ad, with
 * a harness that runs the same seeded inputs as the tests below.
 */

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const nodeSha1 = (data: Uint8Array) => createHash("sha1").update(data).digest("hex");
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));

const shattered = [fixture("shattered-1-first-320.bin"), fixture("shattered-2-first-320.bin")];
const shambles = [fixture("sha-mbles-1.bin"), fixture("sha-mbles-2.bin")];
const fixtures = [
  { name: "shattered-1-first-320", data: shattered[0] as Uint8Array, block: 4 },
  { name: "shattered-2-first-320", data: shattered[1] as Uint8Array, block: 4 },
  { name: "sha-mbles-1", data: shambles[0] as Uint8Array, block: 9 },
  { name: "sha-mbles-2", data: shambles[1] as Uint8Array, block: 9 },
];

function digestOrError(sha: Sha1): string | Sha1CollisionError {
  try {
    return hex(sha.digest());
  } catch (error) {
    if (error instanceof Sha1CollisionError) return error;
    throw error;
  }
}

/** Splits `data` at the given sorted cut points. */
function split(data: Uint8Array, cuts: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (const cut of [...cuts, data.length]) {
    out.push(data.subarray(start, cut));
    start = cut;
  }
  return out;
}

const cutsFor = (length: number) =>
  fc
    .array(fc.integer({ min: 0, max: length }), { maxLength: 12 })
    .map((cuts) => [...cuts].sort((a, b) => a - b));

/** xorshift32, the PRNG the reference harness uses. */
function xorshift32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

const checksum = (h: number, value: number) => (Math.imul(h, 31) + (value >>> 0)) >>> 0;

describe("the fixtures", () => {
  it("are real SHA-1 collisions: different bytes, the same plain SHA-1", () => {
    for (const [a, b] of [shattered, shambles] as [Uint8Array, Uint8Array][]) {
      expect(hex(a)).not.toBe(hex(b));
      expect(nodeSha1(a)).toBe(nodeSha1(b));
    }
  });
});

describe("Sha1 with collision detection", () => {
  it.each(fixtures)("detects the collision in $name, on by default", ({ data }) => {
    const error = digestOrError(new Sha1().update(data));
    expect(error).toBeInstanceOf(Sha1CollisionError);
    expect((error as Sha1CollisionError).name).toBe("Sha1CollisionError");
    // git's message, with the plain SHA-1 (git turns SHA-1DC's "safe hash" off).
    expect((error as Sha1CollisionError).message).toBe(
      `SHA-1 appears to be part of a collision attack: ${nodeSha1(data)}`,
    );
    expect(hex((error as Sha1CollisionError).digest)).toBe(nodeSha1(data));
    expect(digestOrError(new Sha1({ detectCollisions: true }).update(data))).toBeInstanceOf(
      Sha1CollisionError,
    );
  });

  it.each(fixtures)("gives the plain SHA-1 of $name with detection off", ({ data }) => {
    expect(hex(new Sha1({ detectCollisions: false }).update(data).digest())).toBe(nodeSha1(data));
  });

  it("detects the collision for any chunking and any data after it", () => {
    const inputs = fc
      .constantFrom(...fixtures)
      .chain(({ data }) =>
        fc.uint8Array({ maxLength: 200 }).map((suffix) => new Uint8Array([...data, ...suffix])),
      )
      .chain((input) => cutsFor(input.length).map((cuts) => ({ input, cuts })));
    fc.assert(
      fc.property(inputs, ({ input, cuts }) => {
        const sha = new Sha1();
        for (const chunk of split(input, cuts)) sha.update(chunk);
        expect(digestOrError(sha)).toBeInstanceOf(Sha1CollisionError);
      }),
    );
  });

  it("still detects the collision after saving and restoring at any point, mid-block included", () => {
    fc.assert(
      fc.property(fc.constantFrom(...fixtures), cutsFor(640), ({ data }, cuts) => {
        let sha = new Sha1();
        // Cut points past a 320-byte fixture are dropped.
        for (const chunk of split(
          data,
          cuts.filter((cut) => cut <= data.length),
        )) {
          sha.update(chunk);
          sha = Sha1.fromState(sha.saveState());
        }
        expect(digestOrError(sha)).toBeInstanceOf(Sha1CollisionError);
      }),
    );
  });

  it("keeps reporting a detected collision: after more data, a digest, or a restore", () => {
    const sha = new Sha1().update(shattered[0] as Uint8Array);
    expect(digestOrError(sha)).toBeInstanceOf(Sha1CollisionError);
    sha.update(new Uint8Array(100));
    expect(digestOrError(sha)).toBeInstanceOf(Sha1CollisionError);
    expect(digestOrError(Sha1.fromState(sha.saveState()))).toBeInstanceOf(Sha1CollisionError);
  });

  it("keeps detection off across a restore when it was off", () => {
    const data = shattered[0] as Uint8Array;
    const sha = Sha1.fromState(new Sha1({ detectCollisions: false }).update(data).saveState());
    expect(hex(sha.digest())).toBe(nodeSha1(data));
  });

  it("does not report a collision for data that only shares the prefix before the collision blocks", () => {
    const prefix = (shattered[0] as Uint8Array).subarray(0, 256);
    expect(hex(new Sha1().update(prefix).digest())).toBe(nodeSha1(prefix));
  });

  it("gives node:crypto's SHA-1 for non-colliding data of any length and chunking", () => {
    fc.assert(
      fc.property(
        fc
          .uint8Array({ maxLength: 4096 })
          .chain((data) => cutsFor(data.length).map((cuts) => ({ data, cuts }))),
        fc.boolean(),
        ({ data, cuts }, detectCollisions) => {
          const sha = new Sha1({ detectCollisions });
          for (const chunk of split(data, cuts)) sha.update(chunk);
          expect(hex(sha.digest())).toBe(nodeSha1(data));
        },
      ),
    );
  });
});

describe("createSha1Hasher with collision detection", () => {
  it.each(fixtures)("rejects $name by default and resumes with detection on", async ({ data }) => {
    const first = createSha1Hasher();
    await first.update(data.subarray(0, 290));
    const resumed = createSha1Hasher(first.saveState());
    await resumed.update(data.subarray(290));
    await expect(resumed.digest()).rejects.toBeInstanceOf(Sha1CollisionError);
  });

  it("takes options, and resumes with the options it was saved with", async () => {
    const data = shambles[0] as Uint8Array;
    const off = createSha1Hasher({ detectCollisions: false });
    await off.update(data.subarray(0, 100));
    const resumed = createSha1Hasher(off.saveState());
    await resumed.update(data.subarray(100));
    expect(hex(await resumed.digest())).toBe(nodeSha1(data));
    const on = createSha1Hasher({ detectCollisions: true });
    await on.update(data);
    await expect(on.digest()).rejects.toBeInstanceOf(Sha1CollisionError);
  });
});

describe("saved state with collision detection", () => {
  const saved = (options: { detectCollisions: boolean }, data: Uint8Array) =>
    new Sha1(options).update(data).saveState();

  it("rejects states of the old format and unknown or inconsistent flags", () => {
    const state = saved({ detectCollisions: true }, new Uint8Array(70));
    const withByte = (index: number, value: number) => {
      const copy = state.slice();
      copy[index] = value;
      return copy;
    };
    // Version 1 had no flags: resuming it could skip detection for earlier blocks.
    expect(() => Sha1.fromState(withByte(0, 1))).toThrow(RangeError);
    expect(() => Sha1.fromState(withByte(1, 0b100))).toThrow(RangeError);
    // A collision recorded while detection was off cannot happen.
    expect(() => Sha1.fromState(withByte(1, 0b10))).toThrow(RangeError);
    expect(() => Sha1.fromState(state.subarray(0, 2))).toThrow(RangeError);
  });

  it("round-trips the detection flag and a detected collision", () => {
    const data = shambles[1] as Uint8Array;
    expect(saved({ detectCollisions: true }, data)[1]).toBe(0b11);
    expect(saved({ detectCollisions: true }, data.subarray(0, 64))[1]).toBe(0b01);
    expect(saved({ detectCollisions: false }, data)[1]).toBe(0b00);
  });
});

describe("the SHA-1DC port against the reference C implementation", () => {
  /** Runs the compression over every full block, with and without the UBC filter. */
  function blockDetections(data: Uint8Array, useUbc: boolean) {
    const h = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0);
    const w = new Int32Array(80);
    const states = new Int32Array(10);
    const found: { block: number; dv: string }[] = [];
    const ws: Int32Array[] = [];
    for (let offset = 0; offset + 64 <= data.length; offset += 64) {
      compress(h, w, states, data, offset);
      ws.push(w.slice());
      const dv = detectCollision(h, w, states, useUbc);
      if (dv)
        found.push({ block: offset / 64, dv: `${dv.type === 1 ? "I" : "II"}(${dv.k},${dv.b})` });
    }
    return { found, ws };
  }

  it.each(fixtures)(
    "finds DV II(52,0) in the last block of $name, with or without UBC",
    ({ data, block }) => {
      const expected = [{ block, dv: "II(52,0)" }];
      expect(blockDetections(data, true).found).toEqual(expected);
      expect(blockDetections(data, false).found).toEqual(expected);
    },
  );

  it("has the reference's 32 disturbance vectors, one mask bit each", () => {
    expect(SHA1_DVS).toHaveLength(32);
    expect(SHA1_DVS.map((dv) => dv.maskb)).toEqual([...Array(32).keys()]);
    for (const dv of SHA1_DVS) {
      expect(dv.dm).toHaveLength(80);
      expect([58, 65]).toContain(dv.testt);
    }
  });

  it("computes the reference ubc_check masks for mutated collision blocks and random input", () => {
    const bases = fixtures.flatMap(({ data }) => blockDetections(data, true).ws);
    expect(bases).toHaveLength(30);
    const next = xorshift32(0x12345678);
    let h = 0;
    let nonzero = 0;
    const run = (w: Int32Array) => {
      const mask = ubcCheck(w);
      h = checksum(h, mask);
      if (mask !== 0) nonzero++;
    };
    for (let i = 0; i < 20000; i++) {
      const w = (bases[i % bases.length] as Int32Array).slice();
      const flips = next() % 4;
      for (let k = 0; k < flips; k++) {
        const word = next() % 80;
        const bit = next() % 32;
        w[word] = (w[word] as number) ^ (1 << bit);
      }
      run(w);
    }
    for (let i = 0; i < 2000; i++) run(Int32Array.from({ length: 80 }, next));
    expect({ checksum: h.toString(16), nonzero }).toEqual({ checksum: "6bb1aaec", nonzero: 14578 });
  });

  it("computes the reference ubc_check masks around an input that passes each vector's conditions", () => {
    // fixtures/ubc-dv-inputs.bin: W[35..64] for each of the 32 vectors in turn.
    const inputs = fixture("ubc-dv-inputs.bin");
    const view = new DataView(inputs.buffer, inputs.byteOffset, inputs.byteLength);
    const bases = SHA1_DVS.map((dv, d) => {
      const w = new Int32Array(80);
      for (let j = 35; j <= 64; j++) w[j] = view.getInt32((d * 30 + j - 35) * 4);
      expect(ubcCheck(w) & (1 << dv.maskb)).not.toBe(0);
      return w;
    });
    let single = 0;
    let singleNonzero = 0;
    for (const base of bases) {
      for (let j = 35; j <= 64; j++) {
        for (let bit = 0; bit < 32; bit++) {
          const w = base.slice();
          w[j] = (w[j] as number) ^ (1 << bit);
          const mask = ubcCheck(w);
          single = checksum(single, mask);
          if (mask !== 0) singleNonzero++;
        }
      }
    }
    const next = xorshift32(0x0badcafe);
    let multi = 0;
    let multiNonzero = 0;
    for (let i = 0; i < 20000; i++) {
      const w = (bases[next() % 32] as Int32Array).slice();
      const flips = 2 + (next() % 3);
      for (let k = 0; k < flips; k++) {
        const word = 35 + (next() % 30);
        w[word] = (w[word] as number) ^ (1 << (next() % 32));
      }
      const mask = ubcCheck(w);
      multi = checksum(multi, mask);
      if (mask !== 0) multiNonzero++;
    }
    expect({ single: single.toString(16), singleNonzero }).toEqual({
      single: "f6fb5abe",
      singleNonzero: 30228,
    });
    expect({ multi: multi.toString(16), multiNonzero }).toEqual({
      multi: "f300f624",
      multiNonzero: 19058,
    });
  });

  it("detects each of the 32 disturbance vectors, with and without the UBC filter", () => {
    // For each vector: an expanded message that passes its unavoidable bit
    // conditions, random saved states, and the output chaining value that
    // recompressing with that vector's difference reproduces. detectCollision
    // must name exactly that vector, and nothing once one bit of it changes.
    const inputs = fixture("ubc-dv-inputs.bin");
    const view = new DataView(inputs.buffer, inputs.byteOffset, inputs.byteLength);
    const next = xorshift32(0x2468ace0);
    const me2 = new Int32Array(80);
    const ihvIn = new Int32Array(5);
    const ihvOut = new Int32Array(5);
    for (const [d, dv] of SHA1_DVS.entries()) {
      const w = new Int32Array(80);
      for (let j = 35; j <= 64; j++) w[j] = view.getInt32((d * 30 + j - 35) * 4);
      const states = Int32Array.from({ length: 10 }, next);
      for (let j = 0; j < 80; j++) me2[j] = (w[j] as number) ^ (dv.dm[j] as number);
      recompress(dv.testt, me2, states, ihvIn, ihvOut);
      const ihv = Uint32Array.from(ihvOut);
      expect(detectCollision(ihv, w, states, true)).toBe(dv);
      expect(detectCollision(ihv, w, states, false)).toBe(dv);
      ihv[d % 5] = (ihv[d % 5] as number) ^ 1;
      expect(detectCollision(ihv, w, states, true)).toBeUndefined();
      expect(detectCollision(ihv, w, states, false)).toBeUndefined();
    }
  });

  it("recompresses like the reference for every disturbance vector", () => {
    const next = xorshift32(0x9e3779b9);
    const w = new Int32Array(80);
    const states = new Int32Array(10);
    const me2 = new Int32Array(80);
    const ihvIn = new Int32Array(5);
    const ihvOut = new Int32Array(5);
    let sum = 0;
    for (let i = 0; i < 500; i++) {
      const h = Uint32Array.from({ length: 5 }, next);
      const block = new Uint8Array(64);
      const view = new DataView(block.buffer);
      for (let t = 0; t < 16; t++) view.setUint32(t * 4, next());
      compress(h, w, states, block, 0);
      for (const value of h) sum = checksum(sum, value);
      for (const dv of SHA1_DVS) {
        for (let j = 0; j < 80; j++) me2[j] = (w[j] as number) ^ (dv.dm[j] as number);
        recompress(dv.testt, me2, states, ihvIn, ihvOut);
        for (const value of ihvIn) sum = checksum(sum, value);
        for (const value of ihvOut) sum = checksum(sum, value);
      }
    }
    expect(sum.toString(16)).toBe("bfc3e149");
  });

  it("only recompresses from the steps whose states the compression keeps", () => {
    const scratch = new Int32Array(80);
    expect(() =>
      recompress(57, scratch, new Int32Array(10), new Int32Array(5), new Int32Array(5)),
    ).toThrow(RangeError);
  });
});

describe("collision detection against git", () => {
  let sandbox: GitSandbox;
  beforeAll(async () => {
    sandbox = await createGitSandbox();
    await sandbox.git(["init", "-q", "-b", "main"]);
  });
  afterAll(() => sandbox.dispose());

  /*
   * git hashes a blob as `blob <size>\0` + body, which shifts the collision
   * blocks off the 64-byte block boundaries and changes the chaining value,
   * so neither git nor Fyrden sees a collision in a blob made from these
   * files. That is the only comparison `git hash-object` allows; detection on
   * the raw bytes is checked against the reference C above.
   */
  it.each(fixtures)("agrees with git hash-object --stdin on $name", async ({ data }) => {
    const { stdout, stderr } = await sandbox.git(["hash-object", "--stdin"], {
      input: data,
      okExitCodes: [0, 128],
    });
    const gitDetected = stderr.includes("collision attack");
    let ours: string | Sha1CollisionError;
    try {
      ours = oidToHex(await hashObject(createSha1Hasher, "blob", data));
    } catch (error) {
      if (!(error instanceof Sha1CollisionError)) throw error;
      ours = error;
    }
    expect(ours instanceof Sha1CollisionError).toBe(gitDetected);
    if (!gitDetected) expect(ours).toBe(stdout.trim());
  });
});
