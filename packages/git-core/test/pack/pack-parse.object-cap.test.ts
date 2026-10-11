import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { gitAccepts, gitPackRows } from "./git-oracle.js";
import { buildPack, encodeDelta, gitOid, text } from "./pack-builder.js";
import { MiB, parseBytes, parseCode, rowsOf, spyZlib, trackingBudget } from "./parse-helpers.js";

/*
 * No object above 32 MiB is accepted, and the three sizes of an entry are
 * checked separately, before inflate, allocation or apply:
 * - entry_size, from the entry header: for a delta, the program's length;
 * - base_size and result_size, from the delta program's header.
 * Inflate never produces more than entry_size + 1 bytes.
 */

const CAP = 32 * MiB;
let sandbox: GitSandbox;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q"]);
});
afterAll(() => sandbox.dispose());

const base = text("0123456789abcdef".repeat(8)); // 128 bytes

describe("pack-parse: 32 MiB per-object cap and the three sizes", () => {
  it("rejects a real 33 MiB blob from its header, before inflating or reserving memory", async () => {
    const blob = new Uint8Array(33 * MiB); // zeros: compresses to about 33 KiB
    const { bytes } = buildPack([{ kind: "blob", data: blob }]);
    const zlib = spyZlib();
    const memory = trackingBudget(512 * MiB);
    expect(await parseCode(bytes, { zlib, memory })).toBe("object-too-large");
    expect(zlib.maxOutputs).toEqual([]);
    expect(memory.peak()).toBeLessThan(MiB);
  });

  it("rejects a declared entry size above 32 MiB even when the data is small", async () => {
    const { bytes } = buildPack([{ kind: "blob", data: text("small"), declaredSize: CAP + 1 }]);
    expect(await parseCode(bytes)).toBe("object-too-large");
    const atCap = buildPack([{ kind: "blob", data: text("small"), declaredSize: CAP }]);
    // Exactly 32 MiB is allowed by the cap, and then fails the exact-size check.
    expect(await parseCode(atCap.bytes)).toBe("size-mismatch");
  });

  it("reserves for an entry in proportion to the bytes that arrived, not its declared size", async () => {
    // 32 MiB declared, a few bytes of zlib: the whole pack is about 55 bytes.
    const { bytes } = buildPack([{ kind: "blob", data: text("small"), declaredSize: CAP }]);
    expect(bytes.length).toBeLessThan(64);
    for (const chunkSize of [7, 4096]) {
      // The production pool (72 MiB) is not tied up by a declaration.
      const memory = trackingBudget(72 * MiB);
      expect(await parseCode(bytes, { memory, chunkSize })).toBe("size-mismatch");
      expect(memory.peak()).toBeLessThan(MiB);
      expect(memory.held()).toBe(0);
    }
    // And a pool far smaller than the declared size is enough to refuse it.
    expect(await parseCode(bytes, { memory: trackingBudget(MiB) })).toBe("size-mismatch");
  });

  it("rejects a delta whose result_size is above 32 MiB before allocating the result", async () => {
    const delta = encodeDelta(base.length, CAP + 1, [{ copy: [0, 16] }]);
    const { bytes } = buildPack([
      { kind: "blob", data: base },
      { kind: "ofs", base: 0, delta },
    ]);
    const zlib = spyZlib();
    const memory = trackingBudget(512 * MiB);
    expect(await parseCode(bytes, { zlib, memory })).toBe("object-too-large");
    // Only the small program was inflated (bounded by its entry_size + 1).
    expect(Math.max(...zlib.maxOutputs)).toBeLessThanOrEqual(base.length + 1);
    expect(memory.peak()).toBeLessThan(MiB);
  });

  it("rejects a delta whose base_size is above 32 MiB", async () => {
    const delta = encodeDelta(CAP + 1, 16, [{ copy: [0, 16] }]);
    const { bytes } = buildPack([
      { kind: "blob", data: base },
      { kind: "ofs", base: 0, delta },
    ]);
    expect(await parseCode(bytes)).toBe("object-too-large");
  });

  it("bounds inflate at entry_size + 1 and rejects a bomb", async () => {
    // Declares 10 bytes; the zlib stream holds 8 MiB of zeros.
    const { bytes } = buildPack([
      { kind: "blob", data: text("0123456789"), compressed: deflateSync(new Uint8Array(8 * MiB)) },
    ]);
    const zlib = spyZlib();
    expect(await parseCode(bytes, { zlib })).toBe("inflate-bomb");
    expect(zlib.maxOutputs.every((m) => m === 11)).toBe(true);
    // One byte too many is a bomb too.
    const plusOne = buildPack([
      { kind: "blob", data: text("0123456789"), compressed: deflateSync(text("0123456789A")) },
    ]);
    expect(await parseCode(plusOne.bytes)).toBe("inflate-bomb");
    // The same for a delta program.
    const deltaBomb = buildPack([
      { kind: "blob", data: base },
      {
        kind: "ofs",
        base: 0,
        delta: encodeDelta(base.length, 16, [{ copy: [0, 16] }]),
        compressed: deflateSync(new Uint8Array(MiB)),
      },
    ]);
    expect(await parseCode(deltaBomb.bytes)).toBe("inflate-bomb");
  });

  it("rejects an entry that inflates to less than entry_size", async () => {
    const { bytes } = buildPack([
      { kind: "blob", data: text("0123456789"), compressed: deflateSync(text("012345678")) },
    ]);
    expect(await parseCode(bytes)).toBe("size-mismatch");
  });

  it("rejects a base_size that differs from the base's length, as git does", async () => {
    for (const declared of [base.length - 1, base.length + 1]) {
      const { bytes } = buildPack([
        { kind: "blob", data: base },
        { kind: "ofs", base: 0, delta: encodeDelta(declared, 16, [{ copy: [0, 16] }]) },
      ]);
      expect(await parseCode(bytes)).toBe("delta-base-size-mismatch");
      expect(await gitAccepts(sandbox, bytes)).toBe(false);
    }
  });

  it("rejects an applied length that differs from result_size, as git does", async () => {
    for (const declared of [15, 17]) {
      const { bytes } = buildPack([
        { kind: "blob", data: base },
        { kind: "ofs", base: 0, delta: encodeDelta(base.length, declared, [{ copy: [0, 16] }]) },
      ]);
      expect(await parseCode(bytes)).toBe("delta-result-size-mismatch");
      expect(await gitAccepts(sandbox, bytes)).toBe(false);
    }
  });

  it("accepts a delta where entry_size, base_size and result_size all differ", async () => {
    const result = new Uint8Array([
      ...base.subarray(0, 100),
      ...text("new tail, longer than the base"),
    ]);
    const delta = encodeDelta(base.length, result.length, [
      { copy: [0, 100] },
      { insert: text("new tail, longer than the base") },
    ]);
    // entry_size (the program) < base_size < result_size, all distinct.
    expect(new Set([delta.length, base.length, result.length]).size).toBe(3);
    const { bytes } = buildPack([
      { kind: "blob", data: base },
      { kind: "ofs", base: 0, delta },
    ]);
    const { pack, objects } = await parseBytes(bytes);
    expect(rowsOf(pack, true)).toEqual((await gitPackRows(sandbox, bytes))?.rows);
    expect(objects.get(gitOid("blob", result))?.data).toEqual(result);
    expect(pack.entries.size(1)).toBe(result.length);
    pack.release();
  });

  it("enforces the object-count ceiling from the header, before reserving memory for it", async () => {
    const { bytes } = buildPack([{ kind: "blob", data: base }], { count: 1_000_001 });
    const memory = trackingBudget(512 * MiB);
    expect(await parseCode(bytes, { memory })).toBe("too-many-objects");
    expect(memory.peak()).toBe(0);
    const small = buildPack([
      { kind: "blob", data: base },
      { kind: "blob", data: text("x") },
    ]);
    expect(await parseCode(small.bytes, { limits: { maxObjects: 1 } })).toBe("too-many-objects");
    expect(await parseCode(small.bytes, { limits: { maxObjects: 2 } })).toBe("ok");
  });

  it("caps delta chain depth (default 50, configurable)", async () => {
    const versions = Array.from({ length: 6 }, (_, i) =>
      text(`${"x".repeat(64)}${"y".repeat(i + 1)}`),
    );
    const entries = versions.map((v, i) =>
      i === 0
        ? { kind: "blob" as const, data: v }
        : {
            kind: "ofs" as const,
            base: i - 1,
            delta: encodeDelta((versions[i - 1] as Uint8Array).length, v.length, [
              { copy: [0, (versions[i - 1] as Uint8Array).length] },
              { insert: text("y") },
            ]),
          },
    );
    const { bytes } = buildPack(entries);
    expect(await parseCode(bytes, { limits: { maxDeltaDepth: 5 } })).toBe("ok");
    expect(await parseCode(bytes, { limits: { maxDeltaDepth: 4 } })).toBe("delta-too-deep");
    expect(await parseCode(bytes)).toBe("ok");
  });

  it("applies a lower configured object cap to every size", async () => {
    const limits = { maxObjectBytes: 100 };
    const whole = buildPack([{ kind: "blob", data: base }]);
    expect(await parseCode(whole.bytes, { limits })).toBe("object-too-large");
    const small = text("0123456789".repeat(9));
    const grows = buildPack([
      { kind: "blob", data: small },
      {
        kind: "ofs",
        base: 0,
        delta: encodeDelta(small.length, 101, [{ copy: [0, 90] }, { insert: new Uint8Array(11) }]),
      },
    ]);
    expect(await parseCode(grows.bytes, { limits })).toBe("object-too-large");
  });
});
