import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_PKT_LINE_LENGTH,
  PktLineReader,
  PktLineStreamReader,
} from "../../src/protocol/pktline.js";
import {
  decodeSidebandPacket,
  demultiplexSideband,
  encodeSideband,
  encodeSidebandStream,
  SIDEBAND_64K_MAX_PAYLOAD,
  type SidebandFrame,
  sidebandPackets,
} from "../../src/protocol/sideband.js";
import { bin, chunked, collect, concat, expectCode, str } from "./helpers.js";

async function demuxAll(bytes: Uint8Array): Promise<SidebandFrame[]> {
  const frames: SidebandFrame[] = [];
  for await (const frame of demultiplexSideband(new PktLineReader(bytes))) frames.push(frame);
  return frames;
}

/** The pkt-line lengths in `bytes`, read from their headers. */
function packetLengths(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (let at = 0; at < bytes.length; ) {
    const len = Number.parseInt(str(bytes.subarray(at, at + 4)), 16);
    out.push(len);
    at += len === 0 ? 4 : len;
  }
  return out;
}

describe("side-band-64k encoding", () => {
  it("allows 65515 payload bytes per packet, as git's send_sideband (LARGE_PACKET_MAX - 5)", () => {
    expect(SIDEBAND_64K_MAX_PAYLOAD).toBe(65515);
    const one = encodeSideband(1, new Uint8Array(65515));
    expect(packetLengths(one)).toEqual([MAX_PKT_LINE_LENGTH]);
    expect(str(one.subarray(0, 5))).toBe("fff0\x01");
  });

  it("splits larger data into full packets and a remainder", () => {
    const data = Uint8Array.from({ length: 140_000 }, (_, i) => i & 0xff);
    const bytes = encodeSideband(1, data);
    expect(packetLengths(bytes)).toEqual([65520, 65520, 140_000 - 2 * 65515 + 5]);
  });

  it("writes an empty progress packet as the keepalive 0005\\2", () => {
    expect(str(encodeSideband(2, new Uint8Array()))).toBe("0005\x02");
  });

  it("encodes text as UTF-8 on the progress and error bands", () => {
    expect(str(encodeSideband(2, "Counting objects\r"))).toBe("0016\x02Counting objects\r");
    expect(str(encodeSideband(3, "boom\n"))).toBe("000a\x03boom\n");
  });

  it("honours a smaller packet size, as the 1000-byte side-band", () => {
    expect(packetLengths(encodeSideband(1, new Uint8Array(2000), 995))).toEqual([1000, 1000, 15]);
  });

  it("refuses a payload limit outside 1 to 65515 and an unknown band", () => {
    expect(() => encodeSideband(1, bin("x"), 65516)).toThrow(RangeError);
    expect(() => encodeSideband(1, bin("x"), 0)).toThrow(RangeError);
    expect(() => encodeSideband(4 as 1, bin("x"))).toThrow(RangeError);
  });

  it("yields the same packets one at a time", () => {
    const data = new Uint8Array(70_000);
    expect(concat(...sidebandPackets(1, data))).toEqual(encodeSideband(1, data));
  });

  it("frames a stream chunk by chunk, skipping empty chunks", async () => {
    const data = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 13) & 0xff);
    const framed = await collect(encodeSidebandStream(chunked(data, [0, 10, 10, 100_000])));
    expect(packetLengths(framed).every((n) => n > 5 && n <= MAX_PKT_LINE_LENGTH)).toBe(true);
    const frames = await demuxAll(concat(framed, bin("0000")));
    expect(concat(...frames.map((f) => f.payload))).toEqual(data);
  });
});

describe("side-band decoding", () => {
  it("splits a packet into band and payload", () => {
    expect(decodeSidebandPacket(bin("\x01PACK"))).toEqual({ band: 1, payload: bin("PACK") });
    expect(decodeSidebandPacket(bin("\x02"))).toEqual({ band: 2, payload: new Uint8Array() });
  });

  it("rejects a packet without a band byte", async () => {
    await expectCode(() => decodeSidebandPacket(new Uint8Array()), "missing-band");
  });

  it.each([0, 4, 0x41, 0xff])("rejects band %i", async (band) => {
    await expectCode(() => decodeSidebandPacket(Uint8Array.of(band, 1, 2)), "bad-band");
  });

  it("demultiplexes until the flush packet", async () => {
    const bytes = concat(
      encodeSideband(2, "Enumerating objects: 3, done.\n"),
      encodeSideband(1, bin("PACK")),
      encodeSideband(3, "fatal\n"),
      bin("0000trailing"),
    );
    const reader = new PktLineReader(bytes);
    const frames: SidebandFrame[] = [];
    for await (const f of demultiplexSideband(reader)) frames.push(f);
    expect(frames.map((f) => [f.band, str(f.payload)])).toEqual([
      [2, "Enumerating objects: 3, done.\n"],
      [1, "PACK"],
      [3, "fatal\n"],
    ]);
    expect(str(reader.rest())).toBe("trailing");
  });

  it("rejects a stream that ends before the flush", async () => {
    await expectCode(() => demuxAll(encodeSideband(1, bin("PACK"))), "truncated");
  });

  it("rejects delim and response-end packets inside the stream", async () => {
    await expectCode(() => demuxAll(bin("0006\x01a0001")), "unexpected-packet");
    await expectCode(() => demuxAll(bin("0002")), "unexpected-packet");
  });

  it("round-trips any data on any band through a stream", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<1 | 2 | 3>(1, 2, 3),
        fc.uint8Array({ maxLength: 3000 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.array(fc.nat(), { maxLength: 5 }),
        async (band, data, max, cuts) => {
          const bytes = concat(encodeSideband(band, data, max), bin("0000"));
          const reader = new PktLineStreamReader(
            chunked(
              bytes,
              cuts.map((c) => c % bytes.length),
            ),
          );
          const frames: SidebandFrame[] = [];
          for await (const f of demultiplexSideband(reader)) frames.push(f);
          expect(frames.every((f) => f.band === band && f.payload.length <= max)).toBe(true);
          expect(concat(...frames.map((f) => f.payload))).toEqual(data);
        },
      ),
    );
  });
});
