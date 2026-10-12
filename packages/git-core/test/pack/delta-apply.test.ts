import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyDelta, readDeltaHeader } from "../../src/pack/delta-apply.js";
import { PackError } from "../../src/pack/errors.js";
import { type DeltaOp, encodeDelta, makeDelta, text } from "./pack-builder.js";

const CAP = 32 * 1024 * 1024;

function codeOf(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    if (error instanceof PackError) return error.code;
    throw error;
  }
}

/** Random valid ops against a base, and the result they describe. */
const deltaCaseArb = fc.uint8Array({ minLength: 0, maxLength: 600 }).chain((base) =>
  fc
    .array(
      base.length > 0
        ? fc.oneof(
            fc
              .integer({ min: 0, max: base.length - 1 })
              .chain((off) =>
                fc
                  .integer({ min: 1, max: base.length - off })
                  .map((size): DeltaOp => ({ copy: [off, size] })),
              ),
            fc.uint8Array({ minLength: 1, maxLength: 300 }).map((insert): DeltaOp => ({ insert })),
          )
        : fc.uint8Array({ minLength: 1, maxLength: 300 }).map((insert): DeltaOp => ({ insert })),
      // git never writes an empty delta (diff-delta.c refuses an empty target).
      { minLength: 1, maxLength: 12 },
    )
    .map((ops) => {
      const parts: number[] = [];
      for (const op of ops) {
        if ("insert" in op) parts.push(...op.insert);
        else parts.push(...base.subarray(op.copy[0], op.copy[0] + op.copy[1]));
      }
      return { base, ops, result: new Uint8Array(parts) };
    }),
);

describe("applyDelta (git's patch-delta.c)", () => {
  it("applies any valid program and returns exactly the described result", () => {
    fc.assert(
      fc.property(deltaCaseArb, ({ base, ops, result }) => {
        const delta = encodeDelta(base.length, result.length, ops);
        expect(applyDelta(base, delta, CAP)).toEqual(result);
        expect(readDeltaHeader(delta, CAP)).toMatchObject({
          baseSize: base.length,
          resultSize: result.length,
        });
      }),
      { numRuns: 300 },
    );
  });

  it("copies 0x10000 bytes for a copy with no size bytes", () => {
    const base = new Uint8Array(0x10000 + 5).map((_, i) => i % 251);
    // 0x80 with no offset or size bits: offset 0, size 0x10000.
    const delta = new Uint8Array([...encodeDelta(base.length, 0x10000, []), 0x80]);
    expect(applyDelta(base, delta, CAP)).toEqual(base.subarray(0, 0x10000));
  });

  it("reads the copy offset and size bytes git defines (offset 4 bytes, size 3)", () => {
    const base = new Uint8Array(0x20000).map((_, i) => (i * 31) % 256);
    const delta = new Uint8Array([
      ...encodeDelta(base.length, 0x10203, []),
      0x80 | 0x02 | 0x04 | 0x10 | 0x20 | 0x40,
      0x01, // offset byte 1
      0x00, // offset byte 2 (explicit zero is allowed)
      0x03, // size byte 0
      0x02, // size byte 1
      0x01, // size byte 2
    ]);
    expect(applyDelta(base, delta, CAP)).toEqual(base.subarray(0x100, 0x100 + 0x10203));
  });

  it("rejects a delta shorter than git's minimum of 4 bytes", () => {
    expect(codeOf(() => applyDelta(new Uint8Array(0), new Uint8Array([0, 1, 1]), CAP))).toBe(
      "bad-delta",
    );
  });

  it("rejects a declared base size that differs from the base", () => {
    const base = text("hello world");
    const delta = encodeDelta(base.length + 1, 5, [{ copy: [0, 5] }]);
    expect(codeOf(() => applyDelta(base, delta, CAP))).toBe("delta-base-size-mismatch");
  });

  it("rejects a result size above the cap before allocating", () => {
    const delta = encodeDelta(0, CAP + 1, [{ insert: text("x") }]);
    expect(codeOf(() => applyDelta(new Uint8Array(0), delta, CAP))).toBe("object-too-large");
    expect(codeOf(() => readDeltaHeader(delta, CAP))).toBe("object-too-large");
  });

  it("rejects a program whose output is shorter or longer than the result size", () => {
    const base = text("0123456789");
    const short = encodeDelta(10, 8, [{ copy: [0, 5] }]);
    expect(codeOf(() => applyDelta(base, short, CAP))).toBe("delta-result-size-mismatch");
    const longCopy = encodeDelta(10, 4, [{ copy: [0, 5] }]);
    expect(codeOf(() => applyDelta(base, longCopy, CAP))).toBe("delta-result-size-mismatch");
    const longInsert = encodeDelta(10, 2, [{ insert: text("abc") }]);
    expect(codeOf(() => applyDelta(base, longInsert, CAP))).toBe("delta-result-size-mismatch");
  });

  it("rejects copies outside the base, including offset + size overflow", () => {
    const base = text("0123456789");
    expect(codeOf(() => applyDelta(base, encodeDelta(10, 5, [{ copy: [6, 5] }]), CAP))).toBe(
      "bad-delta",
    );
    const wrap = new Uint8Array([
      ...encodeDelta(10, 2, []),
      0x80 | 0x0f | 0x10,
      0xff,
      0xff,
      0xff,
      0xff,
      0x02,
    ]);
    expect(codeOf(() => applyDelta(base, wrap, CAP))).toBe("bad-delta");
  });

  it("rejects opcode 0, and copy or insert arguments past the end of the program", () => {
    const base = text("0123456789");
    const zero = new Uint8Array([...encodeDelta(10, 1, []), 0x00]);
    expect(codeOf(() => applyDelta(base, zero, CAP))).toBe("bad-delta");
    const cutCopy = new Uint8Array([...encodeDelta(10, 1, []), 0x91]); // wants 2 argument bytes
    expect(codeOf(() => applyDelta(base, cutCopy, CAP))).toBe("bad-delta");
    const cutInsert = new Uint8Array([...encodeDelta(10, 5, []), 0x05, 0x41, 0x42]);
    expect(codeOf(() => applyDelta(base, cutInsert, CAP))).toBe("bad-delta");
  });

  it("produces the target for deltas from the test helper", () => {
    const base = text("tree 1234\nparent abc\nauthor someone\n\nfirst message\n");
    const target = text("tree 1234\nparent abc\nauthor someone\n\nsecond message, longer\n");
    expect(applyDelta(base, makeDelta(base, target), CAP)).toEqual(target);
  });

  it("never throws anything but PackError on arbitrary programs", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 64 }),
        fc.uint8Array({ maxLength: 64 }),
        (base, delta) => {
          expect(codeOf(() => applyDelta(base, delta, 4096))).toBeTypeOf("string");
        },
      ),
      { numRuns: 1000 },
    );
  });
});
