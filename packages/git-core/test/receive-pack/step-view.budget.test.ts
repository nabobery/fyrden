import { describe, expect, it } from "vitest";
import { OID_BYTES, type Oid } from "../../src/object/oid.js";
import { IDX_OIDS_START } from "../../src/pack/idx-format.js";
import { RangedPackIdx } from "../../src/pack/idx-range-read.js";
import type { PackId } from "../../src/ports/pack-store.js";
import type { RepoView } from "../../src/reader/view.js";
import { StepView } from "../../src/receive-pack/step-view.js";

/*
 * A connect slice's store calls include every `.idx` read its lookups make
 * (each an R2 GET in production). The index here is logically large, a
 * million entries, but never held: a synthetic reader computes the bytes
 * of each range it is asked for and counts the reads.
 */

const COUNT = 1 << 20;
const PER_BUCKET = COUNT / 256;
const CRC32S_AT = IDX_OIDS_START + COUNT * OID_BYTES;
const OFFSETS_AT = CRC32S_AT + COUNT * 4;
const PACK_ID = "01J9Z8Y7X6W5V4T3S2R1Q0P0N0" as PackId;

/** The oid at a position: its index spread over the first 20 bits, so the table is sorted. */
function oidAt(position: number): Oid {
  const oid = new Uint8Array(OID_BYTES) as Oid;
  oid[0] = position >>> 12;
  oid[1] = (position >>> 4) & 0xff;
  oid[2] = (position & 0x0f) << 4;
  return oid;
}

/** Pack offset of the entry at a position (small, so no 64-bit offsets). */
const offsetOf = (position: number) => 12 + position;

function syntheticIdx() {
  let reads = 0;
  const byteAt = (x: number): number => {
    if (x < CRC32S_AT) {
      const entry = Math.floor((x - IDX_OIDS_START) / OID_BYTES);
      const k = (x - IDX_OIDS_START) % OID_BYTES;
      return k === 0
        ? entry >>> 12
        : k === 1
          ? (entry >>> 4) & 0xff
          : k === 2
            ? (entry & 0x0f) << 4
            : 0;
    }
    if (x < OFFSETS_AT) return 0;
    const entry = Math.floor((x - OFFSETS_AT) / 4);
    return (offsetOf(entry) >>> (8 * (3 - ((x - OFFSETS_AT) % 4)))) & 0xff;
  };
  const read = async (offset: number, length: number) => {
    reads++;
    expect(offset).toBeGreaterThanOrEqual(IDX_OIDS_START);
    expect(offset + length).toBeLessThanOrEqual(OFFSETS_AT + COUNT * 4);
    return Uint8Array.from({ length }, (_, i) => byteAt(offset + i));
  };
  const fanout = Uint32Array.from({ length: 256 }, (_, b) => (b + 1) * PER_BUCKET);
  return { idx: RangedPackIdx.withFanout(read, fanout), reads: () => reads };
}

function stepOver(idx: RangedPackIdx): StepView {
  const view: RepoView = { scope: "test", packs: [{ packId: PACK_ID, bytes: 1 << 30, idx }] };
  return new StepView(view, {
    openRange: () => {
      throw new Error("no pack reads here");
    },
  });
}

/** 512 positions spread over every fanout bucket: two per bucket. */
const positions = Array.from({ length: 512 }, (_, k) => k * (COUNT / 512) + 7);
const oids = positions.map(oidAt);

describe("StepView call accounting", () => {
  it("counts every index read a batched lookup makes", async () => {
    const { idx, reads } = syntheticIdx();
    const step = stepOver(idx);
    const packs = await step.locateMany(oids);
    expect(packs.every((pack) => pack?.packId === PACK_ID)).toBe(true);
    // Many oid-table spans, then CRC32 and offset spans: far more than three reads.
    expect(reads()).toBeGreaterThan(20);
    expect(step.calls).toBe(reads());
    // The answers are remembered: a reader's lookup costs nothing more.
    const found = await step.view.packs[0]?.idx.lookup(oids[100] as Uint8Array);
    expect(found).toEqual({
      position: positions[100],
      offset: offsetOf(positions[100] as number),
      crc32: 0,
    });
    expect(step.calls).toBe(reads());
  });

  it("stops a batched lookup before its call allowance and keeps what it answered", async () => {
    const { idx, reads } = syntheticIdx();
    const step = stepOver(idx);
    const packs = await step.locateMany(oids, 10);
    expect(reads()).toBeLessThanOrEqual(10);
    expect(step.calls).toBe(reads());
    const answered = packs.filter((pack) => pack !== null);
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.length).toBeLessThan(oids.length);
    expect(answered.every((pack) => pack?.packId === PACK_ID)).toBe(true);
    // A later step finishes the rest.
    const rest = oids.filter((_, i) => packs[i] === null);
    const later = await stepOver(idx).locateMany(rest);
    expect(later.every((pack) => pack?.packId === PACK_ID)).toBe(true);
  });

  it("answers an oid absent from a read span as absent, not as unanswered", async () => {
    const { idx } = syntheticIdx();
    const missing = oidAt(5);
    missing[19] = 1;
    const packs = await stepOver(idx).locateMany([missing], 10);
    expect(packs).toEqual([undefined]);
  });
});
