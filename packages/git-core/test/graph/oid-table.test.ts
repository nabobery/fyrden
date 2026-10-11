import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { OidTable } from "../../src/graph/oid-table.js";
import { OID_BYTES, type Oid, oidFromBytes, oidToHex } from "../../src/object/oid.js";

const oidArb = fc.uint8Array({ minLength: OID_BYTES, maxLength: OID_BYTES }).map(oidFromBytes);

describe("OidTable", () => {
  it("interns oids into dense indexes, like a Map from hex to first index", () => {
    fc.assert(
      fc.property(
        // Few distinct prefixes, so many oids share their first bytes.
        fc.array(
          fc.oneof(
            oidArb,
            fc.integer({ min: 0, max: 7 }).map((n) => {
              const bytes = new Uint8Array(OID_BYTES);
              bytes[19] = n;
              return oidFromBytes(bytes);
            }),
          ),
          { maxLength: 400 },
        ),
        (oids) => {
          const table = new OidTable();
          const model = new Map<string, number>();
          for (const oid of oids) {
            const hex = oidToHex(oid);
            expect(table.indexOf(oid)).toBe(model.get(hex) ?? -1);
            const index = table.add(oid);
            if (!model.has(hex)) model.set(hex, model.size);
            expect(index).toBe(model.get(hex));
          }
          expect(table.size).toBe(model.size);
          const listed: string[] = [];
          for (const oid of table) listed.push(oidToHex(oid));
          expect(listed).toEqual([...model.keys()]);
          for (const [hex, index] of model) {
            expect(oidToHex(table.oidAt(index))).toBe(hex);
            expect(table.has(table.oidAt(index))).toBe(true);
          }
        },
      ),
    );
  });

  it("finds an oid inside a larger buffer and copies what it returns", () => {
    const table = new OidTable(1);
    const oid = oidFromBytes(new Uint8Array(OID_BYTES).fill(7));
    table.add(oid);
    const packed = new Uint8Array(3 * OID_BYTES);
    packed.set(oid, OID_BYTES);
    expect(table.indexOf(packed, OID_BYTES)).toBe(0);
    expect(table.indexOf(packed, 0)).toBe(-1);
    const out: Oid = table.oidAt(0);
    out.fill(0);
    expect(table.oidAt(0)).toEqual(oid);
    oid.fill(1);
    expect(table.oidAt(0)[0]).toBe(7);
    expect(() => table.oidAt(1)).toThrow(RangeError);
  });

  it("stays near 28 bytes per oid plus slack", () => {
    const table = new OidTable();
    for (let i = 0; i < 100_000; i++) {
      const bytes = new Uint8Array(OID_BYTES);
      new DataView(bytes.buffer).setUint32(0, Math.imul(i, 0x9e3779b1));
      new DataView(bytes.buffer).setUint32(4, i);
      table.add(oidFromBytes(bytes));
    }
    expect(table.size).toBe(100_000);
    // 20 bytes of oid and two 4-byte slots per entry, each array at most
    // doubled by growth.
    expect(table.byteLength).toBeLessThanOrEqual(100_000 * (OID_BYTES + 8) * 2);
  });
});
