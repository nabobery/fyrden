import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareOids,
  isZeroOid,
  OID_BYTES,
  oidEquals,
  oidFromBytes,
  oidFromHex,
  oidToHex,
  parseOidHex,
  zeroOid,
} from "../../src/object/oid.js";

const oidBytes = fc.uint8Array({ minLength: OID_BYTES, maxLength: OID_BYTES });

describe("oid", () => {
  it("round-trips through lowercase hex", () => {
    fc.assert(
      fc.property(oidBytes, (bytes) => {
        const hex = oidToHex(oidFromBytes(bytes));
        expect(hex).toMatch(/^[0-9a-f]{40}$/);
        expect(oidFromHex(hex)).toEqual(oidFromBytes(bytes));
        expect(Buffer.from(bytes).toString("hex")).toBe(hex);
      }),
    );
  });

  it("accepts upper-case hex as git's parse_oid_hex does, and prints lower case", () => {
    const oid = oidFromHex("ABCDEF0123456789ABCDEF0123456789ABCDEF01");
    expect(oidToHex(oid)).toBe("abcdef0123456789abcdef0123456789abcdef01");
  });

  it.each([
    ["too short", "a".repeat(39)],
    ["too long", "a".repeat(41)],
    ["not hex", `${"a".repeat(39)}g`],
    ["sign", `+${"a".repeat(39)}`],
    ["space", ` ${"a".repeat(39)}`],
    ["empty", ""],
  ])("rejects %s hex", (_, hex) => {
    expect(() => oidFromHex(hex)).toThrow(RangeError);
  });

  it("reads an oid out of a larger buffer without keeping the buffer alive", () => {
    const buffer = new Uint8Array(64).map((_, i) => i);
    const oid = oidFromBytes(buffer, 10);
    expect(Array.from(oid)).toEqual(Array.from(buffer.subarray(10, 30)));
    expect(oid.buffer).not.toBe(buffer.buffer);
    expect(oid.byteLength).toBe(OID_BYTES);
    expect(() => oidFromBytes(buffer, 45)).toThrow(RangeError);
    expect(() => oidFromBytes(buffer, -1)).toThrow(RangeError);
  });

  it("copies out of a Node Buffer too, whose slice() would be a view", () => {
    const buffer = Buffer.alloc(1024, 1);
    const oid = oidFromBytes(buffer, 16);
    buffer.fill(9);
    expect(oidToHex(oid)).toBe("01".repeat(20));
    expect(oid.buffer.byteLength).toBe(OID_BYTES);
  });

  it("parses hex at an offset in bytes, for object and protocol lines", () => {
    const line = new TextEncoder().encode(`tree ${"0f".repeat(20)}\n`);
    expect(oidToHex(parseOidHex(line, 5) ?? zeroOid())).toBe("0f".repeat(20));
    expect(parseOidHex(line, 6)).toBeUndefined();
    expect(parseOidHex(line, 0)).toBeUndefined();
  });

  it("orders oids bytewise, as pack indexes do", () => {
    fc.assert(
      fc.property(oidBytes, oidBytes, (a, b) => {
        const x = oidFromBytes(a);
        const y = oidFromBytes(b);
        const byHex = oidToHex(x) < oidToHex(y) ? -1 : oidToHex(x) > oidToHex(y) ? 1 : 0;
        expect(Math.sign(compareOids(x, y))).toBe(byHex);
        expect(oidEquals(x, y)).toBe(byHex === 0);
      }),
    );
  });

  it("knows the zero oid, and hands out a fresh copy each time", () => {
    zeroOid()[0] = 1;
    expect(isZeroOid(zeroOid())).toBe(true);
    expect(isZeroOid(oidFromHex(`${"0".repeat(39)}1`))).toBe(false);
    expect(oidToHex(zeroOid())).toBe("0".repeat(40));
  });
});
