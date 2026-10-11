import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ENTRY_RECORD_BYTES } from "../../src/pack/index-state.js";
import {
  buildPack,
  entryHeader,
  makeDelta,
  ofsDistance,
  text,
  withTrailer,
} from "./pack-builder.js";
import { MiB, parseBytes, parseCode, trackingBudget } from "./parse-helpers.js";

/*
 * Memory bound: indexing keeps flat per-entry records, not objects. The
 * reserved peak for a 100,000-object pack stays within the records' size
 * (twice that while the arrays grow) plus the delta-base cache reservation. The
 * per-object budget in production is tuned separately; this pins the shape.
 */

const COUNT = 100_000;

/** 100,000 small blobs; every fourth entry is an OFS_DELTA against the entry before it. */
function bigPack(): Uint8Array {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  new DataView(header.buffer).setUint32(8, COUNT);
  parts.push(header);
  let offset = 12;
  let previous = new Uint8Array(0);
  let previousOffset = 0;
  for (let i = 0; i < COUNT; i++) {
    const data = new TextEncoder().encode(
      `blob number ${i} with some shared text to delta against\n`,
    );
    const isDelta = i % 4 === 3;
    const body = isDelta ? makeDelta(previous, data) : data;
    const head = isDelta
      ? [...entryHeader(6, body.length), ...ofsDistance(offset - previousOffset)]
      : entryHeader(3, body.length);
    const entry = new Uint8Array([...head, ...deflateSync(body, { level: 1 })]);
    parts.push(entry);
    previous = data;
    previousOffset = offset;
    offset += entry.length;
  }
  const body = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return withTrailer(body);
}

describe("pack-parse memory bound", () => {
  it("indexes 100,000 objects within the records' size plus the base cache", async () => {
    const bytes = bigPack();
    const cache = 64 * 1024;
    const memory = trackingBudget(16 * MiB);
    let objects = 0;
    const { pack } = await parseBytes(bytes, {
      memory,
      chunkSize: 1024 * 1024,
      limits: { deltaBaseCacheBytes: cache },
      onObject: () => {
        objects++;
      },
    });
    expect(objects).toBe(COUNT);
    expect(pack.entries.count).toBe(COUNT);
    const records = COUNT * ENTRY_RECORD_BYTES;
    // Growing the arrays holds the old and new copies for a moment; the child
    // lists of the second pass take 4 bytes per entry and per delta.
    expect(memory.peak()).toBeLessThanOrEqual(2 * records + 4 * (COUNT + 1) + 4 * COUNT + cache);
    // Afterwards only the records stay reserved, at their final size.
    expect(memory.held()).toBe(records);
    pack.release();
    expect(memory.held()).toBe(0);
  }, 60_000);

  it("refuses with a PackError when an entry needs more than the whole budget", async () => {
    // Incompressible, so its zlib stream is as long as the blob: 4 MiB in,
    // 4 MiB out, more than a 3 MiB pool holds at all.
    const { bytes } = buildPack([{ kind: "blob", data: noise(4 * MiB) }]);
    const memory = trackingBudget(3 * MiB);
    expect(await parseCode(bytes, { memory, chunkSize: 64 * 1024 })).toBe("exceeds-memory-budget");
    expect(memory.held()).toBe(0);
  });

  it("refuses with a PackError when the entry records need more than the whole budget", async () => {
    // One entry's record is ENTRY_RECORD_BYTES.
    const { bytes } = buildPack([{ kind: "blob", data: text("one") }]);
    const memory = trackingBudget(ENTRY_RECORD_BYTES - 1);
    expect(await parseCode(bytes, { memory })).toBe("exceeds-memory-budget");
    expect(memory.held()).toBe(0);
  });
});

/** `length` bytes that do not compress (xorshift32). */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}
