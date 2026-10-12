import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { oidFromBytes } from "../../src/object/oid.js";
import {
  decodeEntryHeader,
  decodePackHeader,
  type EntryHeaderFields,
  encodeEntryHeader,
  encodePackHeader,
} from "../../src/pack/entry-header.js";
import { PackError } from "../../src/pack/errors.js";
import { decodeDeltaSize, encodeDeltaSize } from "../../src/pack/varint.js";
import { entryHeader, ofsDistance } from "./pack-builder.js";

const MiB = 1024 * 1024;
const CAP = 32 * MiB;

function codeOf(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    if (error instanceof PackError) return error.code;
    throw error;
  }
}

const headerArb: fc.Arbitrary<{ fields: EntryHeaderFields; entryOffset: number }> = fc
  .record({
    entryOffset: fc.integer({ min: 12, max: 2 ** 40 }),
    size: fc.integer({ min: 0, max: CAP }),
    which: fc.constantFrom("commit", "tree", "blob", "tag", "ofs-delta", "ref-delta"),
    distance: fc.integer({ min: 1, max: 2 ** 40 }),
    oid: fc.uint8Array({ minLength: 20, maxLength: 20 }),
  })
  .map(({ entryOffset, size, which, distance, oid }) => {
    if (which === "ofs-delta") {
      const baseOffset = Math.max(12, entryOffset - distance);
      return {
        entryOffset: baseOffset === entryOffset ? entryOffset + 1 : entryOffset,
        fields: { kind: which, size, baseOffset },
      };
    }
    if (which === "ref-delta") {
      return { entryOffset, fields: { kind: which, size, baseOid: oidFromBytes(oid) } };
    }
    return { entryOffset, fields: { kind: which, size } };
  });

describe("pack entry headers", () => {
  it("round-trip: decode(encode(h)) gives h and its length", () => {
    fc.assert(
      fc.property(headerArb, fc.uint8Array({ maxLength: 4 }), ({ fields, entryOffset }, tail) => {
        const encoded = encodeEntryHeader(fields, entryOffset);
        const withTail = new Uint8Array([...encoded, ...tail]);
        const decoded = decodeEntryHeader(withTail, 0, entryOffset, CAP);
        expect(decoded).toEqual({ ...fields, length: encoded.length });
      }),
      { numRuns: 500 },
    );
  });

  it("encodes as git does (pack-objects' header and OFS distance encoders)", () => {
    fc.assert(
      fc.property(headerArb, ({ fields, entryOffset }) => {
        const encoded = [...encodeEntryHeader(fields, entryOffset)];
        const code = { commit: 1, tree: 2, blob: 3, tag: 4, "ofs-delta": 6, "ref-delta": 7 }[
          fields.kind
        ];
        const expected = entryHeader(code, fields.size);
        if (fields.kind === "ofs-delta")
          expected.push(...ofsDistance(entryOffset - fields.baseOffset));
        if (fields.kind === "ref-delta") expected.push(...fields.baseOid);
        expect(encoded).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("asks for more bytes on every proper prefix", () => {
    fc.assert(
      fc.property(headerArb, ({ fields, entryOffset }) => {
        const encoded = encodeEntryHeader(fields, entryOffset);
        for (let cut = 0; cut < encoded.length; cut++) {
          expect(decodeEntryHeader(encoded.subarray(0, cut), 0, entryOffset, CAP)).toBeUndefined();
        }
      }),
      { numRuns: 200 },
    );
  });

  it("decodes at a start position inside a larger buffer", () => {
    const bytes = new Uint8Array([9, 9, ...entryHeader(3, 1000)]);
    expect(decodeEntryHeader(bytes, 2, 100, CAP)).toEqual({ kind: "blob", size: 1000, length: 2 });
  });

  it("rejects the reserved type codes 0 and 5", () => {
    expect(codeOf(() => decodeEntryHeader(new Uint8Array([0x05]), 0, 12, CAP))).toBe(
      "bad-entry-header",
    );
    expect(codeOf(() => decodeEntryHeader(new Uint8Array([0x55]), 0, 12, CAP))).toBe(
      "bad-entry-header",
    );
  });

  it("rejects a declared size above the cap before reading further", () => {
    // 32 MiB + 1 as a blob: the header alone is enough to reject it.
    const header = new Uint8Array(entryHeader(3, CAP + 1));
    expect(codeOf(() => decodeEntryHeader(header, 0, 12, CAP))).toBe("object-too-large");
    expect(decodeEntryHeader(new Uint8Array(entryHeader(3, CAP)), 0, 12, CAP)?.size).toBe(CAP);
    // Huge sizes are rejected while decoding, not after overflowing.
    const huge = new Uint8Array([0xbf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    expect(codeOf(() => decodeEntryHeader(huge, 0, 12, CAP))).toBe("object-too-large");
  });

  it("rejects an overlong size encoding (zero continuation bytes past 64 bits)", () => {
    const overlong = new Uint8Array([0xb0, ...new Array(9).fill(0x80), 0x00]);
    expect(codeOf(() => decodeEntryHeader(overlong, 0, 12, CAP))).toBe("bad-entry-header");
    // Nine zero continuation bytes are still within git's limit.
    const padded = new Uint8Array([0xb0, ...new Array(8).fill(0x80), 0x00]);
    expect(decodeEntryHeader(padded, 0, 12, CAP)).toEqual({ kind: "blob", size: 0, length: 10 });
  });

  it("rejects an OFS_DELTA base at or before the pack header, or not before the entry", () => {
    const entry = (distance: number) =>
      new Uint8Array([...entryHeader(6, 10), ...ofsDistance(distance)]);
    expect(decodeEntryHeader(entry(100 - 12), 0, 100, CAP)).toMatchObject({ baseOffset: 12 });
    expect(codeOf(() => decodeEntryHeader(entry(100 - 11), 0, 100, CAP))).toBe(
      "bad-delta-base-offset",
    );
    expect(codeOf(() => decodeEntryHeader(entry(0), 0, 100, CAP))).toBe("bad-delta-base-offset");
    // A distance far beyond any offset is rejected without overflowing.
    const long = new Uint8Array([...entryHeader(6, 10), ...new Array(20).fill(0xff), 0x7f]);
    expect(codeOf(() => decodeEntryHeader(long, 0, 100, CAP))).toBe("bad-delta-base-offset");
  });
});

describe("pack header", () => {
  it("round-trips versions 2 and 3 and any count", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(2, 3),
        fc.integer({ min: 0, max: 2 ** 32 - 1 }),
        (version, count) => {
          expect(decodePackHeader(encodePackHeader(count, version))).toEqual({
            version,
            objectCount: count,
          });
        },
      ),
    );
  });

  it("rejects a bad signature or version", () => {
    const good = encodePackHeader(1, 2);
    const badSig = good.slice();
    badSig[0] = 0x51;
    expect(codeOf(() => decodePackHeader(badSig))).toBe("bad-header");
    for (const version of [0, 1, 4, 0xffffffff]) {
      const bad = good.slice();
      new DataView(bad.buffer).setUint32(4, version);
      expect(codeOf(() => decodePackHeader(bad))).toBe("bad-header");
    }
  });
});

describe("delta size varints", () => {
  it("round-trip", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: CAP }),
        fc.uint8Array({ maxLength: 3 }),
        (value, tail) => {
          const encoded = encodeDeltaSize(value);
          expect(decodeDeltaSize(new Uint8Array([...encoded, ...tail]), 0, CAP)).toEqual({
            value,
            next: encoded.length,
          });
        },
      ),
    );
  });

  it("rejects a value above the cap while decoding, and a varint that runs off the end", () => {
    const atCap = encodeDeltaSize(CAP);
    expect(decodeDeltaSize(atCap, 0, CAP)).toEqual({ value: CAP, next: atCap.length });
    expect(codeOf(() => decodeDeltaSize(encodeDeltaSize(CAP + 1), 0, CAP))).toBe(
      "object-too-large",
    );
    const endless = new Uint8Array(30).fill(0xff);
    expect(codeOf(() => decodeDeltaSize(endless, 0, CAP))).toBe("object-too-large");
    expect(codeOf(() => decodeDeltaSize(new Uint8Array([0x80, 0x80]), 0, CAP))).toBe("bad-delta");
    expect(codeOf(() => decodeDeltaSize(new Uint8Array([]), 0, CAP))).toBe("bad-delta");
    // Zero padding is bounded too.
    const padded = new Uint8Array([...new Array(12).fill(0x80), 0x00]);
    expect(codeOf(() => decodeDeltaSize(padded, 0, CAP))).toBe("bad-delta");
  });
});
