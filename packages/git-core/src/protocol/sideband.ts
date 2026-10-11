import { concatBytes } from "../object/bytes.js";
import { ProtocolError } from "./errors.js";
import { MAX_PKT_LINE_LENGTH, type PktLineSource } from "./pktline.js";

/**
 * Side-band multiplexing (gitprotocol-pack, gitprotocol-capabilities): each
 * pkt-line payload starts with a band byte. Band 1 carries pack data, band
 * 2 progress text and band 3 a fatal error message.
 */
export type SidebandBand = 1 | 2 | 3;

export const SIDEBAND_DATA = 1;
export const SIDEBAND_PROGRESS = 2;
export const SIDEBAND_ERROR = 3;

/**
 * Most payload bytes per side-band-64k packet: 65520 less four length
 * digits and the band byte. This is what git sends (`send_sideband` with
 * LARGE_PACKET_MAX in git v2.53.0 sideband.c, verified). gitprotocol-pack
 * says "up to 65519 data bytes", which cannot fit in a 65520-byte line.
 */
export const SIDEBAND_64K_MAX_PAYLOAD = MAX_PKT_LINE_LENGTH - 5;

export interface SidebandFrame {
  readonly band: SidebandBand;
  readonly payload: Uint8Array;
}

const encoder = new TextEncoder();
const HEX = "0123456789abcdef";

function checkBand(band: number): void {
  if (band !== 1 && band !== 2 && band !== 3) throw new RangeError(`no side-band ${band}`);
}

function checkMaxPayload(maxPayload: number): void {
  if (!Number.isInteger(maxPayload) || maxPayload < 1 || maxPayload > SIDEBAND_64K_MAX_PAYLOAD) {
    throw new RangeError(`side-band payload limit must be 1 to ${SIDEBAND_64K_MAX_PAYLOAD}`);
  }
}

function framePacket(band: SidebandBand, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = payload.length + 5;
  const out = new Uint8Array(length);
  out[0] = HEX.charCodeAt((length >> 12) & 15);
  out[1] = HEX.charCodeAt((length >> 8) & 15);
  out[2] = HEX.charCodeAt((length >> 4) & 15);
  out[3] = HEX.charCodeAt(length & 15);
  out[4] = band;
  out.set(payload, 5);
  return out;
}

/**
 * The packets that carry `data` on `band`, at most `maxPayload` bytes each
 * (995 gives the old 1000-byte side-band). Empty data gives one empty
 * packet, which on band 2 is the keepalive `0005\2`. Strings are UTF-8.
 */
export function* sidebandPackets(
  band: SidebandBand,
  data: Uint8Array | string,
  maxPayload = SIDEBAND_64K_MAX_PAYLOAD,
): Generator<Uint8Array<ArrayBuffer>> {
  checkBand(band);
  checkMaxPayload(maxPayload);
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  if (bytes.length === 0) {
    yield framePacket(band, bytes);
    return;
  }
  for (let at = 0; at < bytes.length; at += maxPayload) {
    yield framePacket(band, bytes.subarray(at, at + maxPayload));
  }
}

/** `sidebandPackets` joined into one buffer. */
export function encodeSideband(
  band: SidebandBand,
  data: Uint8Array | string,
  maxPayload = SIDEBAND_64K_MAX_PAYLOAD,
): Uint8Array<ArrayBuffer> {
  return concatBytes([...sidebandPackets(band, data, maxPayload)]);
}

/**
 * Frames a byte stream (a pack) on one band, chunk by chunk, without
 * buffering it. Empty chunks are skipped. The caller writes the flush.
 */
export async function* encodeSidebandStream(
  source: AsyncIterable<Uint8Array>,
  band: SidebandBand = SIDEBAND_DATA,
  maxPayload = SIDEBAND_64K_MAX_PAYLOAD,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  checkBand(band);
  checkMaxPayload(maxPayload);
  for await (const chunk of source) {
    if (chunk.length > 0) yield* sidebandPackets(band, chunk, maxPayload);
  }
}

/** Splits one packet's payload into band and data, as git's `demultiplex_sideband` does. */
export function decodeSidebandPacket(data: Uint8Array): SidebandFrame {
  if (data.length === 0) {
    throw new ProtocolError("missing-band", "protocol error: missing sideband designator");
  }
  const band = data[0] as number;
  if (band !== 1 && band !== 2 && band !== 3) {
    throw new ProtocolError("bad-band", `protocol error: bad band #${band}`);
  }
  return { band, payload: data.subarray(1) };
}

/**
 * Reads side-band packets up to the flush that ends the stream. The packet
 * limit (65520 bytes) bounds each payload; band 3 frames are returned, not
 * thrown, so the caller can report the peer's message.
 */
export async function* demultiplexSideband(
  source: PktLineSource,
): AsyncGenerator<SidebandFrame, void, undefined> {
  for (;;) {
    const pkt = await source.read();
    if (pkt === undefined) {
      throw new ProtocolError("truncated", "unexpected disconnect while reading sideband packet");
    }
    if (pkt.kind === "flush") return;
    if (pkt.kind !== "data") {
      throw new ProtocolError(
        "unexpected-packet",
        `protocol error: unexpected ${pkt.kind} packet in side-band stream`,
      );
    }
    yield decodeSidebandPacket(pkt.data);
  }
}
