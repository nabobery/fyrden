import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { concatBytes } from "../../src/object/bytes.js";
import { frameSidebandData, sidebandFramedLength } from "../../src/pack-write/sideband-frame.js";
import { flushPkt, PktLineReader } from "../../src/protocol/pktline.js";
import { demultiplexSideband, SIDEBAND_64K_MAX_PAYLOAD } from "../../src/protocol/sideband.js";
import { collect, hex } from "./support.js";

/*
 * A pack framed once for side-band-64k and stored, so a Worker can later
 * pipe it to a client without touching the bytes. The framing must be a
 * function of the pack and the frame size only, whatever chunks the pack
 * arrives in, or two runs would store different objects for one pack.
 */

async function* pieces(bytes: Uint8Array, cuts: number[]): AsyncGenerator<Uint8Array> {
  let at = 0;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    if (cut > at && cut < bytes.length) {
      yield bytes.subarray(at, cut);
      at = cut;
    }
  }
  yield bytes.subarray(at);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

async function frames(framed: Uint8Array) {
  const out: { band: number; length: number; payload: Uint8Array }[] = [];
  const reader = new PktLineReader(concatBytes([framed, flushPkt()]), { maxLines: 1e6 });
  for await (const frame of demultiplexSideband(reader)) {
    out.push({ band: frame.band, length: frame.payload.length, payload: frame.payload });
  }
  return out;
}

describe("side-band pre-framing", () => {
  it("frames at fixed payload boundaries whatever the input chunking", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 0, maxLength: 3000 }),
        fc.array(fc.integer({ min: 0, max: 3000 })),
        fc.integer({ min: 1, max: 700 }),
        fc.integer({ min: 1, max: 5000 }),
        async (data, cuts, payloadBytes, outputBytes) => {
          const framed = await collect(
            frameSidebandData(pieces(data, cuts), { payloadBytes, outputBytes }),
          );
          const reference = await collect(frameSidebandData(once(data), { payloadBytes }));
          expect(hex(framed)).toBe(hex(reference));
          expect(framed.length).toBe(sidebandFramedLength(data.length, payloadBytes));
          const decoded = await frames(framed);
          expect(decoded.every((f) => f.band === 1)).toBe(true);
          expect(decoded.slice(0, -1).every((f) => f.length === payloadBytes)).toBe(true);
          expect(hex(concatBytes(decoded.map((f) => f.payload)))).toBe(hex(data));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("uses side-band-64k's largest payload by default", async () => {
    const data = new Uint8Array(3 * SIDEBAND_64K_MAX_PAYLOAD + 7).map((_, i) => i);
    const decoded = await frames(await collect(frameSidebandData(once(data))));
    expect(decoded.map((f) => f.length)).toEqual([
      SIDEBAND_64K_MAX_PAYLOAD,
      SIDEBAND_64K_MAX_PAYLOAD,
      SIDEBAND_64K_MAX_PAYLOAD,
      7,
    ]);
  });

  it("rejects a payload size side-band-64k cannot carry", () => {
    expect(() => frameSidebandData(once(new Uint8Array(1)), { payloadBytes: 65516 })).toThrow(
      RangeError,
    );
    expect(() => sidebandFramedLength(10, 0)).toThrow(RangeError);
  });
});
